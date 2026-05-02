import type { ToolUseSimple, WriteInput } from '@/types/chat';

import { getToolSummaryNode } from './toolBadgeConfig';
import { ExpandableContainer, FilePath, ToolHeader } from './utils';

interface WriteToolProps {
  tool: ToolUseSimple;
}

export default function WriteTool({ tool }: WriteToolProps) {
  const input = tool.parsedInput as WriteInput;

  if (!input) {
    return (
      <div className="my-0.5">
        <ToolHeader tool={tool} toolName={tool.name} />
      </div>
    );
  }

  const summary = getToolSummaryNode(tool);

  return (
    <div className="space-y-2">
      {/* Inner header (B2): path + summary chip, no tool name */}
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <FilePath path={input.file_path} />
        {summary}
      </div>

      {/* File content — height-clamped */}
      <ExpandableContainer>
        <pre className="overflow-x-auto rounded bg-[var(--paper-inset)]/50 px-2 py-1 font-mono text-sm break-words whitespace-pre-wrap text-[var(--ink-secondary)] select-text">
          {input.content || ''}
        </pre>
      </ExpandableContainer>
    </div>
  );
}
