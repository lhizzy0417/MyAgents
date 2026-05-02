import type { EditInput, ToolUseSimple } from '@/types/chat';

import { getToolSummaryNode } from './toolBadgeConfig';
import { ExpandableContainer, ExpandableResult, FilePath, ToolHeader } from './utils';

interface EditToolProps {
  tool: ToolUseSimple;
}

export default function EditTool({ tool }: EditToolProps) {
  const input = tool.parsedInput as (EditInput & {
    cwd?: string;
    changes?: Array<{ path: string; kind?: string }>;
  }) | undefined;

  let fallbackInput: { file_path?: string; changes?: Array<{ path: string; kind?: string }> } | null = null;
  if (!input && tool.inputJson) {
    try {
      const parsed = JSON.parse(tool.inputJson) as { file_path?: string; changes?: Array<{ path: string; kind?: string }> };
      fallbackInput = parsed;
    } catch {
      fallbackInput = null;
    }
  }
  const filePath = input?.file_path || fallbackInput?.file_path;
  const changePaths = input?.changes || fallbackInput?.changes || [];

  if (!input && !fallbackInput) {
    return (
      <div className="my-0.5">
        <ToolHeader tool={tool} toolName={tool.name} />
      </div>
    );
  }

  const summary = getToolSummaryNode(tool);
  const hasDiff = input?.old_string !== undefined || input?.new_string !== undefined;

  return (
    <div className="space-y-2">
      {/* Inner header (B2): full path + summary chip + replace_all badge — no tool name (already in outer ProcessRow) */}
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        {filePath && <FilePath path={filePath} />}
        {!filePath && changePaths.map(change => (
          <FilePath key={`${change.kind ?? 'change'}:${change.path}`} path={change.path} />
        ))}
        {summary}
        {input?.replace_all && (
          <span className="rounded border border-[var(--warning)]/30 bg-[var(--warning-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--warning)]">
            replace all
          </span>
        )}
      </div>

      {/* Diff (C1): stacked old/new — flat sibling of header, height-clamped.
          gradientFrom must match the surrounding panel bg (paper-elevated/50 from
          ProcessRow body) so the fade is invisible against the actual background. */}
      {hasDiff ? (
        <ExpandableContainer gradientFrom="from-[var(--paper-elevated)]">
          <div className="space-y-1.5">
            <pre className="overflow-x-auto rounded bg-[var(--error-bg)] px-2 py-1 font-mono text-sm break-words whitespace-pre-wrap text-[var(--error)] select-text">
              {input?.old_string || ''}
            </pre>
            <pre className="overflow-x-auto rounded bg-[var(--success-bg)] px-2 py-1 font-mono text-sm break-words whitespace-pre-wrap text-[var(--success)] select-text">
              {input?.new_string || ''}
            </pre>
          </div>
        </ExpandableContainer>
      ) : tool.result ? (
        <ExpandableResult
          content={tool.result}
          className="rounded bg-[var(--paper-inset)]/50 px-2 py-1 break-words text-[var(--ink-secondary)]"
        />
      ) : null}
    </div>
  );
}
