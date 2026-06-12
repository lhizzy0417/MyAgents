
import type { BashInput, ToolUseSimple } from '@/types/chat';

import { Loader2 } from 'lucide-react';
import { ExpandableResult } from './utils';

/** Try to parse SDK bash result JSON: {"stdout":"...","stderr":"...","interrupted":false} */
function parseBashResult(result: string): { stdout: string; stderr: string } | null {
  try {
    const parsed = JSON.parse(result);
    if (typeof parsed === 'object' && parsed !== null && ('stdout' in parsed || 'stderr' in parsed)) {
      return {
        stdout: typeof parsed.stdout === 'string' ? parsed.stdout : '',
        stderr: typeof parsed.stderr === 'string' ? parsed.stderr : '',
      };
    }
  } catch { /* not JSON, fall through */ }
  return null;
}

type BashDisplayInput = BashInput & {
  cwd?: string;
  commandActions?: unknown[];
};

function parseBashInput(tool: ToolUseSimple): BashDisplayInput | null {
  if (tool.parsedInput && typeof tool.parsedInput === 'object') {
    return tool.parsedInput as BashDisplayInput;
  }
  if (!tool.inputJson) return null;
  try {
    const parsed = JSON.parse(tool.inputJson);
    if (parsed && typeof parsed === 'object') {
      return parsed as BashDisplayInput;
    }
  } catch {
    // Older Codex mapping stored the raw command string instead of JSON.
    return { command: tool.inputJson } as BashDisplayInput;
  }
  return null;
}

function formatDuration(durationMs?: number | null): string | null {
  if (!durationMs || durationMs <= 0) return null;
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainSeconds}s`;
}

function buildTerminalOutput(tool: ToolUseSimple): string | null {
  if (!tool.result) return null;

  const parsed = parseBashResult(tool.result);
  if (!parsed) return tool.result;

  const sections: string[] = [];
  if (parsed.stdout) sections.push(parsed.stdout);
  if (parsed.stderr) sections.push(parsed.stdout ? `[stderr]\n${parsed.stderr}` : parsed.stderr);

  return sections.join('\n\n') || '(no output)';
}

interface BashToolProps {
  tool: ToolUseSimple;
}

export default function BashTool({ tool }: BashToolProps) {
  const input = parseBashInput(tool);
  const durationLabel = formatDuration(tool.resultMeta?.durationMs);
  const hasDisplayableInput = !!input?.command;
  const output = buildTerminalOutput(tool);
  const metaItems = [
    input?.cwd || tool.resultMeta?.cwd,
    durationLabel,
    tool.resultMeta?.processId ? `PID ${tool.resultMeta.processId}` : null,
    tool.resultMeta?.exitCode != null ? `exit ${tool.resultMeta.exitCode}` : null,
  ].filter(Boolean) as string[];

  if (!hasDisplayableInput && !output) {
    return (
      <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
        <Loader2 className="size-3 animate-spin" />
        <span>Initializing terminal...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 font-sans select-none">
      {hasDisplayableInput && (
        <div className="flex flex-col gap-2">
          <div className="px-1 text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]">Input</div>
          <div className="relative overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--code-bg)] px-4 py-3 text-[var(--code-text)] shadow-sm">
            <pre className="overflow-x-auto font-mono text-sm whitespace-pre-wrap break-all select-text">
              <span className="font-semibold text-[var(--success)]">$ </span>
              {input.command}
            </pre>
            {input.run_in_background && (
              <div className="absolute right-3 top-3 rounded-md border border-[var(--line)] bg-[var(--code-header-bg)] px-1.5 py-0.5 text-xs font-medium uppercase tracking-wider text-[var(--code-line-number)]">
                Background
              </div>
            )}
          </div>
        </div>
      )}

      {metaItems.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 font-mono text-xs text-[var(--ink-muted)]">
          {metaItems.map(item => (
            <span key={item}>{item}</span>
          ))}
        </div>
      )}

      {output && (
        <div className="flex flex-col gap-2">
          <div className="px-1 text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]">Output</div>
          <ExpandableResult
            content={output}
            wrapperClassName="rounded-xl border border-[var(--line)] bg-[var(--code-bg)] shadow-sm"
            className="px-4 py-3 text-sm text-[var(--code-text)]"
            fade="code-bg"
          />
        </div>
      )}

      {!output && tool.isLoading && (
        <div className="flex flex-col gap-1.5">
          <div className="px-1 text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]">Output</div>
          <div className="flex items-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--code-bg)] px-4 py-3 font-mono text-sm text-[var(--code-text)]">
            <Loader2 className="size-3.5 animate-spin text-[var(--code-line-number)]" />
            <span>Running...</span>
          </div>
        </div>
      )}
    </div>
  );
}
