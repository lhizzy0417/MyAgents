import type { ToolUseSimple } from '@/types/chat';
import { CollapsibleTool } from './CollapsibleTool';
import { ToolHeader, unwrapMcpResult } from './utils';
import AudioPlayerBar from './AudioPlayerBar';

interface EdgeTtsToolProps {
  tool: ToolUseSimple;
}

/** Parse structured fields from the tool result text */
function parseToolResult(result: string | undefined): {
  filePath?: string;
  voice?: string;
  duration?: string;
  format?: string;
  size?: string;
  rate?: string;
  volume?: string;
  pitch?: string;
  textPreview?: string;
  error?: string;
  isVoiceList: boolean;
} {
  if (!result) return { isVoiceList: false };

  // Unwrap JSON-encoded MCP content array if present
  const unwrapped = unwrapMcpResult(result);
  if (unwrapped !== result) return parseToolResult(unwrapped);

  // Check if it's a voice list result
  if (result.includes('Found ') && result.includes('voice(s)')) {
    return { isVoiceList: true };
  }

  // Check for errors
  if (result.startsWith('Error')) {
    return { error: result, isVoiceList: false };
  }

  const lines = result.split('\n');
  const fields: Record<string, string> = {};

  for (const line of lines) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match) {
      fields[match[1]] = match[2].trim();
    }
  }

  return {
    filePath: fields['filePath'],
    voice: fields['voice'],
    duration: fields['duration'],
    format: fields['format'],
    size: fields['size'],
    rate: fields['rate'],
    volume: fields['volume'],
    pitch: fields['pitch'],
    textPreview: fields['textPreview'],
    error: undefined,
    isVoiceList: false,
  };
}

export default function EdgeTtsTool({ tool }: EdgeTtsToolProps) {
  const parsed = parseToolResult(tool.result);

  const isListVoices = tool.name.includes('list_voices');
  const toolLabel = isListVoices ? '查询语音' : '语音合成';
  const isGenerating = !tool.result;

  // PRD 0.2.30 — when the audio is surfaced via the first-class attachment
  // pipeline (ToolAttachmentGallery renders the player in-flow below this card),
  // the card keeps meta + file path only. Older history results carry no
  // attachments → keep the embedded player as a legacy fallback.
  const hasAttachments = (tool.attachments?.length ?? 0) > 0;

  const collapsedContent = (
    <div className="flex items-center gap-1.5">
      <ToolHeader tool={tool} toolName={tool.name} label={toolLabel} />
      {isGenerating && (
        <span className="text-[10px] text-[var(--ink-muted)] animate-pulse">
          {isListVoices ? '查询中...' : '生成中...'}
        </span>
      )}
      {parsed.voice && (
        <span className="rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-[10px] text-[var(--ink-muted)] font-mono">
          {parsed.voice}
        </span>
      )}
      {parsed.duration && (
        <span className="text-[10px] text-[var(--ink-muted)]">{parsed.duration}</span>
      )}
      {parsed.textPreview && (
        <span className="truncate text-[10px] text-[var(--ink-muted)] max-w-[300px]">
          {parsed.textPreview}
        </span>
      )}
    </div>
  );

  const expandedContent = (
    <div className="space-y-2 mt-1">
      {/* Parameters */}
      {tool.inputJson && (
        <div className="text-[10px] text-[var(--ink-muted)] font-mono">
          {(() => {
            try {
              const input = JSON.parse(tool.inputJson);
              return (
                <div className="space-y-0.5">
                  {input.text && (
                    <div>
                      <span className="opacity-60">text:</span>{' '}
                      {input.text.length > 100 ? input.text.substring(0, 100) + '...' : input.text}
                    </div>
                  )}
                  {input.voice && <div><span className="opacity-60">voice:</span> {input.voice}</div>}
                  {input.rate && <div><span className="opacity-60">rate:</span> {input.rate}</div>}
                  {input.volume && <div><span className="opacity-60">volume:</span> {input.volume}</div>}
                  {input.pitch && <div><span className="opacity-60">pitch:</span> {input.pitch}</div>}
                  {input.language && <div><span className="opacity-60">language:</span> {input.language}</div>}
                  {input.gender && <div><span className="opacity-60">gender:</span> {input.gender}</div>}
                </div>
              );
            } catch {
              return <pre className="break-words whitespace-pre-wrap">{tool.inputJson}</pre>;
            }
          })()}
        </div>
      )}

      {/* Audio player — legacy fallback only (no attachments). New results play
          in-flow via ToolAttachmentGallery → ToolAudioAttachment below the card. */}
      {parsed.filePath && !parsed.error && !hasAttachments && (
        <div className="mt-2">
          <AudioPlayerBar filePath={parsed.filePath} />
        </div>
      )}

      {/* Metadata */}
      {parsed.filePath && !parsed.error && (
        <div className="text-[10px] text-[var(--ink-muted)] space-y-0.5 mt-1">
          {parsed.voice && <div>语音: {parsed.voice}</div>}
          {parsed.duration && <div>时长: {parsed.duration}</div>}
          {parsed.format && parsed.size && <div>格式: {parsed.format} | 大小: {parsed.size}</div>}
          {parsed.rate && parsed.rate !== '0%' && <div>语速: {parsed.rate}</div>}
          {parsed.volume && parsed.volume !== '0%' && <div>音量: {parsed.volume}</div>}
          {parsed.pitch && parsed.pitch !== '+0Hz' && <div>音调: {parsed.pitch}</div>}
          <div className="font-mono opacity-60 break-all">文件: {parsed.filePath}</div>
        </div>
      )}

      {/* Voice list result */}
      {parsed.isVoiceList && tool.result && (
        <pre className="overflow-x-auto overflow-y-auto max-h-[300px] rounded bg-[var(--paper-inset)]/50 px-2 py-1.5 font-mono text-[10px] whitespace-pre-wrap text-[var(--ink-secondary)]">
          {tool.result}
        </pre>
      )}

      {/* Error display */}
      {parsed.error && (
        <pre className="overflow-x-auto rounded bg-[var(--error-bg)] px-2 py-1 font-mono text-xs break-words whitespace-pre-wrap text-[var(--error)]">
          {parsed.error}
        </pre>
      )}
    </div>
  );

  return <CollapsibleTool collapsedContent={collapsedContent} expandedContent={expandedContent} />;
}
