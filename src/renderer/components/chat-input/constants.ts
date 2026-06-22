import type { SlashCommand } from '../SlashCommandMenu';
import { USER_IMAGE_ATTACHMENT_MAX_BYTES } from '../../../shared/fileTypes';

export const BUILTIN_FALLBACK_SLASH_COMMANDS: SlashCommand[] = [
  { name: 'compact', description: '压缩对话历史，释放上下文空间', source: 'builtin' },
  { name: 'context', description: '显示或管理当前上下文', source: 'builtin' },
  { name: 'cost', description: '查看 token 使用量和费用', source: 'builtin' },
  { name: 'init', description: '初始化项目配置 (.CLAUDE.md)', source: 'builtin' },
  { name: 'pr-comments', description: '生成 Pull Request 评论', source: 'builtin' },
  { name: 'release-notes', description: '根据最近提交生成发布说明', source: 'builtin' },
  { name: 'review', description: '对代码进行审查', source: 'builtin' },
  { name: 'security-review', description: '进行安全相关的代码审查', source: 'builtin' },
];

export const LINE_HEIGHT = 26;
export const MAX_LINES = 9;
export const LAUNCHER_MIN_LINES = 3;
export const MAX_IMAGES = 5;
export const MAX_IMAGE_SIZE = USER_IMAGE_ATTACHMENT_MAX_BYTES;
