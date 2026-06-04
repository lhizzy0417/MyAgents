/**
 * builtin-media-attachments — 把内置 in-process MCP 工具产出的媒体文件归一化为
 * `ToolAttachment[]`，走与 Codex external runtime 同一条一等公民管道。
 *
 * PRD 0.2.30 §3.1。本期定向接入两个**结果文本里带 `filePath:` 的**内置工具：
 *   - `mcp__edge-tts__text_to_speech`  → audio
 *   - `mcp__gemini-image__{generate,edit}_image` → image
 *
 * 设计要点：
 *  - 解析（`parseBuiltinMediaToolResult`）是**纯函数**，单测覆盖；IO（读文件 + 落盘）
 *    隔离在 `buildBuiltinMediaAttachments`。
 *  - 落盘走 `saveToolAttachment({ kind:'base64' })` → **复制进 trusted root**
 *    （`~/.myagents/generated/tool-attachments/<sid>/<tid>/<file>`）。理由见 PRD §3.1：
 *    端点按路径直接拼接解析 → sidecar 重启后历史媒体仍可渲染，无需 resume 时
 *    `rebuildAttachmentRegistryFromBlocks`；且自包含、与未来 GC 一致、规避
 *    external-path allow-list 不含任意 workspace 的限制。原始生成路径仍在工具卡 meta 显示。
 *  - 任一文件失败 → log + 跳过该条（graceful：工具卡仍显示路径，不影响 turn）。
 *
 * 安全：源文件是**我方内置工具**的输出（非模型可控），但仍做防御性校验：必须是绝对路径、
 * 落在已知 generated 目录下、`lstat` 拒 symlink leaf 且为 regular file。大小上限由
 * `saveToolAttachment` 的 base64 分支兜（25MB）。
 */

import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import { saveToolAttachment } from './tool-attachments';
import { MAX_TOOL_ATTACHMENT_BYTES, type ToolAttachment, type ToolAttachmentKind } from '../../shared/types/tool-attachment';

const EDGE_TTS_TOOL = 'mcp__edge-tts__text_to_speech';
const GEMINI_GENERATE = 'mcp__gemini-image__generate_image';
const GEMINI_EDIT = 'mcp__gemini-image__edit_image';

const MEDIA_TOOLS = new Set<string>([EDGE_TTS_TOOL, GEMINI_GENERATE, GEMINI_EDIT]);

/** 内置工具产出的 generated 目录段名（`~/.myagents/<name>` 或 `<ws>/myagents_files/<name>`）。 */
const GENERATED_DIR_NAMES = ['generated_audio', 'generated_images', 'generated'];

const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  webm: 'audio/webm',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
};

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

export interface BuiltinMediaSpec {
  filePath: string;
  mimeType: string;
  kind: ToolAttachmentKind;
  caption?: string;
  producedBy: string;
}

export interface BuiltinAttachmentCtxBase {
  sessionId: string;
  /** 用作 attachment 路径命名空间的 turn 段；唯一即可，这里用 toolUseId。 */
  toolUseId: string;
}

/**
 * Server 端镜像 frontend `unwrapMcpResult`：MCP 工具结果在 agent-session 里常被
 * `JSON.stringify(content)` 成 `[{"type":"text","text":"..."}]` 形态，先抽回纯文本。
 * 不是数组形态（直接字符串结果）则原样返回。
 */
function unwrapMcpText(result: string): string {
  const trimmed = result.trimStart();
  if (!trimmed.startsWith('[')) return result;
  try {
    const parsed = JSON.parse(trimmed) as unknown[];
    const texts = parsed
      .filter(
        (c): c is { text: string } =>
          typeof c === 'object' &&
          c !== null &&
          'text' in c &&
          typeof (c as { text: unknown }).text === 'string',
      )
      .map(c => c.text);
    if (texts.length > 0) return texts.join('\n');
  } catch {
    /* not JSON — fall through */
  }
  return result;
}

/** 解析 `key: value` 行（value 取整行剩余，路径含空格/盘符冒号也安全）。 */
function parseFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match) fields[match[1]] = match[2].trim();
  }
  return fields;
}

function extOf(p: string): string {
  return p.split('.').pop()?.toLowerCase() ?? '';
}

/** Gemini 结果里的「图片描述: ...」段（与 frontend GeminiImageTool 同一正则）。 */
function extractGeminiDescription(text: string): string | undefined {
  const m = text.match(/图片描述:\s*(.+?)(?:\n\n|$)/s);
  return m?.[1]?.trim() || undefined;
}

/**
 * 纯函数：从内置媒体工具的结果文本解析出 attachment 规格。
 * 非媒体工具 / 错误结果 / 无 filePath → `[]`。
 */
export function parseBuiltinMediaToolResult(toolName: string, contentStr: string): BuiltinMediaSpec[] {
  if (!contentStr || !MEDIA_TOOLS.has(toolName)) return [];

  const text = unwrapMcpText(contentStr);
  // 内置工具的错误分支：edge-tts 返回 "Error: ..."，gemini 返回 "Error ..."。
  if (text.trimStart().startsWith('Error')) return [];

  const fields = parseFields(text);
  const filePath = fields['filePath'];
  if (!filePath) return [];

  if (toolName === EDGE_TTS_TOOL) {
    const mimeType = AUDIO_MIME[extOf(filePath)] ?? 'audio/mpeg';
    // caption = 合成文本预览 + voice（工具卡 meta 已含 voice/duration，这里偏「这是什么音频」）
    const caption = [fields['voice'], fields['textPreview']].filter(Boolean).join(' · ') || undefined;
    return [{ filePath, mimeType, kind: 'audio', caption, producedBy: 'mcp.edge-tts.text_to_speech' }];
  }

  // gemini-image generate / edit
  const mimeType = IMAGE_MIME[extOf(filePath)] ?? 'image/png';
  const caption = extractGeminiDescription(text) ?? fields['description'];
  return [
    {
      filePath,
      mimeType,
      kind: 'image',
      caption,
      producedBy: toolName === GEMINI_EDIT ? 'mcp.gemini-image.edit_image' : 'mcp.gemini-image.generate_image',
    },
  ];
}

/** 防御性：路径必须落在某个已知 generated 目录段下。 */
function isUnderKnownGeneratedDir(absPath: string): boolean {
  const norm = path.normalize(absPath);
  return GENERATED_DIR_NAMES.some(name => norm.includes(`${path.sep}${name}${path.sep}`));
}

/**
 * 读取内置工具产出的媒体文件并落盘为 `ToolAttachment[]`（复制进 trusted root）。
 * 失败逐条吞掉（log + skip），返回成功的那些。非媒体工具返回 `[]`。
 */
export async function buildBuiltinMediaAttachments(
  toolName: string,
  contentStr: string,
  ctxBase: BuiltinAttachmentCtxBase,
): Promise<ToolAttachment[]> {
  const specs = parseBuiltinMediaToolResult(toolName, contentStr);
  if (specs.length === 0) return [];

  const out: ToolAttachment[] = [];
  for (const spec of specs) {
    try {
      if (!path.isAbsolute(spec.filePath)) {
        console.warn(`[builtin-media] non-absolute path, skip: ${spec.filePath}`);
        continue;
      }
      if (!isUnderKnownGeneratedDir(spec.filePath)) {
        console.warn(`[builtin-media] path not under a known generated dir, skip: ${spec.filePath}`);
        continue;
      }
      const st = await lstat(spec.filePath);
      if (st.isSymbolicLink() || !st.isFile()) {
        console.warn(`[builtin-media] not a regular file (symlink?), skip: ${spec.filePath}`);
        continue;
      }
      // Size gate BEFORE readFile (review #4): saveToolAttachment enforces the
      // 25MB cap, but only AFTER we've read the whole file + base64-expanded it
      // (~1.33x), so an oversized file would briefly peak at ~2.3x its size in
      // memory before being rejected. We already have `st` from lstat — reject
      // up front so a pathological file never gets fully loaded.
      if (st.size > MAX_TOOL_ATTACHMENT_BYTES) {
        console.warn(`[builtin-media] file exceeds ${MAX_TOOL_ATTACHMENT_BYTES} bytes (${st.size}), skip: ${spec.filePath}`);
        continue;
      }
      const bytes = await readFile(spec.filePath);
      const attachment = await saveToolAttachment(
        { kind: 'base64', data: bytes.toString('base64') },
        {
          sessionId: ctxBase.sessionId,
          turnId: ctxBase.toolUseId,
          toolUseId: ctxBase.toolUseId,
          mimeType: spec.mimeType,
          kind: spec.kind,
          caption: spec.caption,
          producedBy: spec.producedBy,
        },
      );
      out.push(attachment);
    } catch (err) {
      console.warn(
        `[builtin-media] failed to build attachment for ${toolName}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return out;
}
