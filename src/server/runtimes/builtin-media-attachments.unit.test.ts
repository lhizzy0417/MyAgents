import { describe, it, expect } from 'vitest';
import { parseBuiltinMediaToolResult } from './builtin-media-attachments';

const EDGE_TTS = 'mcp__edge-tts__text_to_speech';
const GEMINI_GEN = 'mcp__gemini-image__generate_image';
const GEMINI_EDIT = 'mcp__gemini-image__edit_image';

const EDGE_TTS_RESULT = [
  '语音已生成。',
  '',
  'filePath: /Users/me/.myagents/generated_audio/tts_abc12345.mp3',
  'voice: zh-CN-XiaoxiaoNeural',
  'duration: 23.1s',
  'format: mp3',
  'size: 135.4KB',
  'rate: 0%',
  'volume: 0%',
  'pitch: +0Hz',
  'textPreview: 夏天赖着不走 蝉把整个下午锯成...',
].join('\n');

const GEMINI_RESULT = [
  '图片已生成。',
  '',
  'contextId: imgctx_abcd',
  'filePath: /Users/me/.myagents/generated/imgctx_abcd_0.png',
  'resolution: 1K | aspectRatio: auto',
  'model: gemini-2.5-flash-image',
  '',
  '图片描述: a serene mountain lake at dawn',
  '',
  '如需修改此图片，请使用 edit_image 工具并传入 contextId: imgctx_abcd',
].join('\n');

describe('parseBuiltinMediaToolResult', () => {
  it('parses edge-tts audio result', () => {
    const specs = parseBuiltinMediaToolResult(EDGE_TTS, EDGE_TTS_RESULT);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      filePath: '/Users/me/.myagents/generated_audio/tts_abc12345.mp3',
      mimeType: 'audio/mpeg',
      kind: 'audio',
      producedBy: 'mcp.edge-tts.text_to_speech',
    });
    expect(specs[0].caption).toContain('zh-CN-XiaoxiaoNeural');
    expect(specs[0].caption).toContain('夏天赖着不走');
  });

  it('parses gemini generate_image result with description as caption', () => {
    const specs = parseBuiltinMediaToolResult(GEMINI_GEN, GEMINI_RESULT);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      filePath: '/Users/me/.myagents/generated/imgctx_abcd_0.png',
      mimeType: 'image/png',
      kind: 'image',
      caption: 'a serene mountain lake at dawn',
      producedBy: 'mcp.gemini-image.generate_image',
    });
  });

  it('tags edit_image with the edit producedBy', () => {
    const editResult = GEMINI_RESULT.replace('图片已生成。', '图片已编辑（第 2 次修改）。');
    const specs = parseBuiltinMediaToolResult(GEMINI_EDIT, editResult);
    expect(specs[0].producedBy).toBe('mcp.gemini-image.edit_image');
    expect(specs[0].kind).toBe('image');
  });

  it('infers jpg mime from extension', () => {
    const r = GEMINI_RESULT.replace('imgctx_abcd_0.png', 'imgctx_abcd_0.jpg');
    expect(parseBuiltinMediaToolResult(GEMINI_GEN, r)[0].mimeType).toBe('image/jpeg');
  });

  it('unwraps MCP content-array JSON form', () => {
    const wrapped = JSON.stringify([{ type: 'text', text: EDGE_TTS_RESULT }], null, 2);
    const specs = parseBuiltinMediaToolResult(EDGE_TTS, wrapped);
    expect(specs).toHaveLength(1);
    expect(specs[0].kind).toBe('audio');
    expect(specs[0].filePath).toMatch(/tts_abc12345\.mp3$/);
  });

  it('returns [] for non-media tools', () => {
    expect(parseBuiltinMediaToolResult('Bash', 'filePath: /x.mp3')).toEqual([]);
    expect(parseBuiltinMediaToolResult('mcp__cron-tools__create', GEMINI_RESULT)).toEqual([]);
  });

  it('returns [] for error results', () => {
    expect(parseBuiltinMediaToolResult(EDGE_TTS, 'Error: Text cannot be empty.')).toEqual([]);
    expect(parseBuiltinMediaToolResult(GEMINI_GEN, 'Error generating image: quota exceeded')).toEqual([]);
  });

  it('returns [] when filePath is missing', () => {
    expect(parseBuiltinMediaToolResult(EDGE_TTS, 'voice: x\nformat: mp3')).toEqual([]);
    expect(parseBuiltinMediaToolResult(EDGE_TTS, '')).toEqual([]);
  });

  it('handles windows absolute paths (drive colon in value)', () => {
    const win = EDGE_TTS_RESULT.replace(
      '/Users/me/.myagents/generated_audio/tts_abc12345.mp3',
      'C:\\Users\\me\\.myagents\\generated_audio\\tts_abc12345.mp3',
    );
    const specs = parseBuiltinMediaToolResult(EDGE_TTS, win);
    expect(specs[0].filePath).toBe('C:\\Users\\me\\.myagents\\generated_audio\\tts_abc12345.mp3');
  });
});
