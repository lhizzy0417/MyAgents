/**
 * AgentCards - Reusable agent card components for list views
 */
import { Bot } from 'lucide-react';

import type { AgentItem } from '../../shared/agentTypes';

// AgentCard — V2 "compact" layout matching SkillCard/CommandCard:
//   • borderless + shadow-on-hover (the prior `border + translate-y` was
//     a holdover from the pre-v0.1.69 card style)
//   • px-3.5 py-3, title 14px
//   • scope + synced badges move INLINE with the title row, in place of
//     the prior footer. No toggle here — Agents are scope-gated, not
//     enable/disable-gated, so no switch in this card variant.
export function AgentCard({ agent, onClick }: { agent: AgentItem; onClick: () => void }) {
    return (
        <div
            className="group flex cursor-pointer flex-col gap-1.5 rounded-xl bg-[var(--paper-elevated)] px-3.5 py-3 transition-shadow hover:shadow-sm"
            onClick={onClick}
        >
            <div className="flex items-center gap-2">
                <h4 className="min-w-0 flex-1 truncate text-md font-semibold text-[var(--ink)]">
                    {agent.name}
                </h4>
                <Bot className="h-3.5 w-3.5 shrink-0 text-violet-500" />
                <span className="shrink-0 rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-medium tracking-[0.04em] text-[var(--ink-muted)]">
                    {agent.scope === 'user' ? '全局' : '项目'}
                </span>
                {agent.synced && (
                    <span className="shrink-0 rounded-full bg-[var(--info-bg)] px-2 py-0.5 text-xs font-medium tracking-[0.04em] text-[var(--info)]">
                        Claude Code
                    </span>
                )}
            </div>
            <p className="line-clamp-2 min-h-[2.6em] text-sm leading-relaxed text-[var(--ink-muted)]">
                {agent.description || '暂无描述'}
            </p>
        </div>
    );
}
