// LauncherInputContextRow — small chip row below the launcher input.
// PRD 0.2.7 D7 / Phase F: hosts a workspace chip + (when the multiAgentRuntime
// gate is on) a runtime chip in the same screen slot the thought-mode
// `RecentThoughtsRow` uses (`absolute left-0 right-0 top-full mt-3`). Moving
// these two controls out of the input toolbar de-clutters the launcher input.
//
// Visual: the inner buttons (`WorkspaceSelector`, `RuntimeSelector`) are
// reused as-is — they already carry the chevron / icon / hover-text-color
// styling needed in the chat-tab toolbar. We layer a subtle resting
// background on top via a wrapper so the chips read as distinct affordances
// against the launcher's cream background. The inner button's
// `hover:bg-[var(--hover-bg)]` cleanly overrides the wrapper's lighter
// resting tint on hover; the user perceives one chip with a deepening bg.
// Pre-PRD-0.2.7 polish iteration removed the "Agent 工作区" / "Runtime"
// text labels — the icons + content already convey what each chip is.

import { memo } from 'react';

import RuntimeSelector from '@/components/RuntimeSelector';
import type { Project } from '@/config/types';
import type { RuntimeType, RuntimeDetections } from '../../../shared/types/runtime';

import WorkspaceSelector from './WorkspaceSelector';

interface LauncherInputContextRowProps {
  // Workspace
  projects: Project[];
  selectedProject: Project | null;
  defaultWorkspacePath?: string;
  onSelectWorkspace: (project: Project) => void;
  onAddFolder: () => void;
  /** Promote a project to default workspace via the dropdown's hover-only
   *  "设为默认" button. Threaded straight through to WorkspaceSelector. */
  onSetDefaultWorkspace?: (project: Project) => void;

  // Runtime (only rendered when multiAgentRuntime gate is on AND callers
  // supply onRuntimeChange — keeps the chip out of the row entirely if the
  // experimental feature is off).
  showRuntime: boolean;
  runtime?: RuntimeType;
  runtimeDetections?: RuntimeDetections;
  onRuntimeChange?: (runtime: RuntimeType) => void;
}

// Resting → hover deepening contract: chip starts on the lighter `--hover-bg`
// (7% warm-brown tint) so it's barely there but distinguishable from the
// cream page; hover lands on the heavier `--paper-inset` (solid beige). The
// inner button's hardcoded `hover:bg-[var(--hover-bg)]` would normally
// paint over the wrapper's bg on hover, defeating the deepening — we
// override with `[&_button:hover]:!bg-transparent` so the wrapper's hover
// bg is what the user sees. `!` forces precedence over the button's class.
//
// `shadow-md` matches the input panel above (`SimpleChatInput.tsx`'s root
// `shadow-md`) so the chip row reads as the same elevation tier — without
// it the chips appear "flat against the page" while the input "floats",
// breaking the unified-surface feel.
const CHIP_WRAPPER_CLASS =
  'inline-flex items-center rounded-lg bg-[var(--hover-bg)] shadow-md transition-colors hover:bg-[var(--paper-inset)] [&_button:hover]:!bg-transparent';

export default memo(function LauncherInputContextRow({
  projects,
  selectedProject,
  defaultWorkspacePath,
  onSelectWorkspace,
  onAddFolder,
  onSetDefaultWorkspace,
  showRuntime,
  runtime,
  runtimeDetections,
  onRuntimeChange,
}: LauncherInputContextRowProps) {
  return (
    <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
      <div className={CHIP_WRAPPER_CLASS}>
        <WorkspaceSelector
          projects={projects}
          selectedProject={selectedProject}
          defaultWorkspacePath={defaultWorkspacePath}
          onSelect={onSelectWorkspace}
          onAddFolder={onAddFolder}
          onSetDefault={onSetDefaultWorkspace}
        />
      </div>
      {showRuntime && runtime && runtimeDetections && onRuntimeChange && (
        <div className={CHIP_WRAPPER_CLASS}>
          <RuntimeSelector
            value={runtime}
            detections={runtimeDetections}
            onChange={onRuntimeChange}
            variant="toolbar"
          />
        </div>
      )}
    </div>
  );
});
