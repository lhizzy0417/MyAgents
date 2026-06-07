import { cloneElement, isValidElement, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { useFileAction } from '@/context/FileActionContext';
import type { ToolUseSimple } from '@/types/chat';
import { resolveActionPath } from '@/utils/workspaceFileLinks';

import {
  getThinkingBadgeConfig,
  getThinkingExpandedLabel,
  getToolBadgeConfig,
  getToolExpandedLabel
} from './toolBadgeConfig';

// (MCP content-array unwrapping now lives in the shared single-source parser
//  `src/shared/builtinMediaResult.ts::unwrapMcpResult` — the local copy here was
//  dead after GeminiImageTool/EdgeTtsTool migrated to it.)

// Legacy function for backward compatibility - now uses unified config
export function getToolColors(toolName: string): {
  text: string;
  icon: string;
} {
  const config = getToolBadgeConfig(toolName);
  return {
    text: config.colors.text,
    icon: config.colors.iconColor
  };
}

interface ToolHeaderProps {
  icon?: ReactNode;
  label?: string;
  toolName?: string;
  tool?: ToolUseSimple;
}

export function ToolHeader({ icon, label, toolName, tool }: ToolHeaderProps) {
  const config = toolName ? getToolBadgeConfig(toolName) : null;
  // Always use icon from unified config if toolName is provided (single source of truth)
  // Otherwise fall back to passed icon for backward compatibility
  let displayIcon = config?.icon || icon;

  // Config icons carry a flat `size-4` class; resize to size-3 for the denser header.
  // This ensures icons match between badge and header while maintaining readability.
  if (config?.icon && isValidElement(displayIcon)) {
    const element = displayIcon as React.ReactElement<{ className?: string }>;
    const existingProps = element.props as { className?: string };
    const existingClassName = existingProps?.className || '';
    // Replace any size-* with size-3, or add size-3 if no size class exists
    const newClassName =
      existingClassName ? existingClassName.replace(/size-\d+(\.\d+)?/g, 'size-3') : 'size-3';
    displayIcon = cloneElement(element, {
      ...existingProps,
      className: newClassName
    });
  }

  // Use unified expanded label if tool is provided, otherwise use passed label or toolName
  const displayLabel = tool ? getToolExpandedLabel(tool) : label || toolName || '';

  return (
    <div
      className={`flex items-center gap-1.5 text-sm font-medium ${config?.colors.text || 'text-[var(--ink-muted)]'}`}
    >
      {displayIcon && (
        <span
          className={`flex h-4 w-4 items-center justify-center ${config?.colors.iconColor || 'text-[var(--ink-muted)]'}`}
        >
          {displayIcon}
        </span>
      )}
      <span className="tracking-tight">{displayLabel}</span>
    </div>
  );
}

const MONO_BASE_CLASS = 'font-mono text-sm tracking-tight text-[var(--ink)]';

export function MonoText({
  children,
  className = ''
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <code className={`${MONO_BASE_CLASS} ${className}`}>
      {children}
    </code>
  );
}

const FILE_PATH_BOX_CLASS = 'rounded border border-[var(--line-subtle)] bg-[var(--paper-inset)]/50 px-1.5 py-0.5';

/**
 * File-path chip rendered by file tools (Write / Edit / Read / NotebookEdit).
 *
 * When rendered inside a Chat (FileActionContext available) and the path
 * resolves to a real file/folder, the chip becomes interactive — dashed
 * underline + click / right-click context menu (预览 / 引用 / 打开 / 打开所在文件夹),
 * matching how inline file paths in AI text behave (see markdown/InlineCode.tsx,
 * which shares the same FileActionContext). Outside Chat, or while the path is
 * still unresolved / does not exist, it renders as a plain monospace chip.
 */
export function FilePath({ path }: { path: string }) {
  const fileAction = useFileAction(); // null outside Chat
  // File tools (Write/Edit/Read/NotebookEdit) emit ABSOLUTE `file_path` values,
  // but the workspace existence-check + read commands only accept
  // workspace-relative paths (Rust `resolve_inside_workspace` rejects absolute
  // paths outright → the chip would always collapse to a plain box). Normalize
  // an in-workspace absolute path to the same relative form inline AI-text
  // paths already use, so the existence check resolves and the menu actions
  // (预览/引用/打开/打开所在文件夹) work. Falls back to the raw path — which stays
  // a plain chip — when it's outside the workspace or no workspace is known.
  const actionPath = resolveActionPath(path, fileAction?.workspacePath);
  // Triggers a batched existence check; returns cached result or null (pending).
  const pathInfo = fileAction?.checkPath(actionPath) ?? null;

  if (!fileAction || !pathInfo?.exists) {
    return <MonoText className={FILE_PATH_BOX_CLASS}>{path}</MonoText>;
  }

  const openMenu = (x: number, y: number) =>
    fileAction.openFileMenu(x, y, actionPath, pathInfo.type, path);

  return (
    <code
      className={`${MONO_BASE_CLASS} ${FILE_PATH_BOX_CLASS} cursor-pointer underline decoration-dashed decoration-[var(--ink-muted)] underline-offset-2 transition-colors hover:border-[var(--ink-muted)] hover:bg-[var(--accent-warm-subtle)]`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        openMenu(rect.left, rect.bottom + 4);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.clientX, e.clientY);
      }}
      title={pathInfo.type === 'dir' ? `文件夹: ${path}` : `文件: ${path}`}
    >
      {path}
    </code>
  );
}

export function InlineCode({ children }: { children: ReactNode }) {
  return (
    <MonoText className="rounded border border-[var(--line-subtle)] bg-[var(--paper-inset)]/50 px-1.5 py-0.5">
      {children}
    </MonoText>
  );
}

/**
 * Unwrap SDK tool result JSON wrappers into displayable plain text.
 *
 * The SDK wraps tool results in JSON with metadata:
 *   Bash:  {"stdout":"...","stderr":"...","interrupted":false}
 *   Read:  {"type":"text","file":{"filePath":"...","content":"..."}}
 *   Grep:  {"mode":"content","numFiles":0,"filenames":[],"content":"1142:function..."}
 *   Glob:  {"mode":"files_with_matches","filenames":["a.ts","b.ts"],"content":"a.ts\nb.ts"}
 *
 * This extracts the meaningful text and unescapes \n so it renders properly.
 * Falls back to the original string if it's not recognized JSON.
 */
export function unwrapSdkResult(result: string): string {
  const trimmed = result.trimStart();
  if (!trimmed.startsWith('{')) return result;
  try {
    const parsed = JSON.parse(trimmed);

    // Bash format: {"stdout":"...","stderr":"..."}
    if ('stdout' in parsed && typeof parsed.stdout === 'string') {
      let output = parsed.stdout;
      if (parsed.stderr && typeof parsed.stderr === 'string') {
        output += (output ? '\n\n' : '') + '[stderr]\n' + parsed.stderr;
      }
      return output || '(no output)';
    }

    // Read format: {"type":"text","file":{"filePath":"...","content":"..."}}
    if (parsed.type === 'text' && parsed.file?.content && typeof parsed.file.content === 'string') {
      return parsed.file.content;
    }

    // Grep/Glob format: {"mode":"...","content":"..."}
    if ('content' in parsed && typeof parsed.content === 'string') {
      return parsed.content;
    }

    // Unknown JSON — return as-is (let specialized components handle it)
    return result;
  } catch {
    return result;
  }
}

/**
 * Generic height-clamp container — `max-h-96` by default + gradient fade + "展开全部" button.
 * Accepts arbitrary children (ReactNode), so tools with non-string bodies (Edit diff,
 * NotebookEdit cell content, multi-pre layouts) can share the same overflow UX.
 *
 * Watches both ResizeObserver and MutationObserver on the clamped wrapper, so
 * re-measurement fires reliably during streaming (content grows under a fixed
 * max-h, where scrollHeight changes but clientHeight stays).
 */
interface ExpandableContainerProps {
  children: ReactNode;
  /** className applied to the outer relative wrapper (e.g. for shared border/bg) */
  wrapperClassName?: string;
  /** Gradient fade color — must match the actual content background for a smooth fade. */
  gradientFrom?: string;
}

export function ExpandableContainer({
  children,
  wrapperClassName = '',
  gradientFrom = 'from-[var(--paper-inset)]'
}: ExpandableContainerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [needsExpand, setNeedsExpand] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || isExpanded) return;
    const measure = () => {
      setNeedsExpand(el.scrollHeight > el.clientHeight);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const mo = new MutationObserver(measure);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [isExpanded]);

  return (
    <div className={`relative ${wrapperClassName}`}>
      <div
        ref={ref}
        className={`${isExpanded ? '' : 'max-h-96'} overflow-hidden`}
      >
        {children}
      </div>
      {needsExpand && !isExpanded && (
        <div className={`absolute bottom-0 left-0 right-0 flex justify-center bg-gradient-to-t ${gradientFrom} to-transparent pb-2 pt-8`}>
          <button
            type="button"
            onClick={() => setIsExpanded(true)}
            className="rounded-full border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-1 text-xs text-[var(--ink-muted)] shadow-sm hover:text-[var(--ink-secondary)] transition-colors"
          >
            展开全部
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Expandable result container for plain string output — wraps {@link ExpandableContainer}
 * with a `<pre>` and SDK-result unwrapping. Kept as the path of least resistance for
 * tools whose result is just text (Read, Grep, Glob, Skill, BashOutput, Bash, Task).
 */
interface ExpandableResultProps {
  content: string;
  className?: string;
  /** Additional wrapper className (e.g. for terminal-style bg) */
  wrapperClassName?: string;
  /** Gradient fade color — must match the actual background for smooth fade.
   *  Defaults to paper-inset; BashTool passes code-bg or error-bg. */
  gradientFrom?: string;
}

export function ExpandableResult({ content: rawContent, className = '', wrapperClassName = '', gradientFrom = 'from-[var(--paper-inset)]' }: ExpandableResultProps) {
  // Auto-unwrap SDK JSON wrappers so all tools display clean text
  const content = unwrapSdkResult(rawContent);
  return (
    <ExpandableContainer wrapperClassName={wrapperClassName} gradientFrom={gradientFrom}>
      <pre className={`overflow-x-auto font-mono text-sm whitespace-pre-wrap select-text ${className}`}>
        {content}
      </pre>
    </ExpandableContainer>
  );
}

interface ThinkingHeaderProps {
  isComplete: boolean;
  durationMs?: number;
}

export function ThinkingHeader({ isComplete, durationMs }: ThinkingHeaderProps) {
  const config = getThinkingBadgeConfig();
  const label = getThinkingExpandedLabel(isComplete, durationMs);

  // Resize the icon's flat size class to size-3 for header visibility
  let displayIcon = config.icon;
  if (isValidElement(displayIcon)) {
    const element = displayIcon as React.ReactElement<{ className?: string }>;
    const existingProps = element.props as { className?: string };
    const existingClassName = existingProps?.className || '';
    const newClassName =
      existingClassName ? existingClassName.replace(/size-\d+(\.\d+)?/g, 'size-3') : 'size-3';
    displayIcon = cloneElement(element, {
      ...existingProps,
      className: newClassName
    });
  }

  return (
    <div className={`flex items-center gap-1.5 text-sm font-medium ${config.colors.text}`}>
      {displayIcon && (
        <span className={`flex h-4 w-4 items-center justify-center ${config.colors.iconColor}`}>
          {displayIcon}
        </span>
      )}
      <span className="tracking-wide">{label}</span>
    </div>
  );
}
