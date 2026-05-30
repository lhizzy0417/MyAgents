/**
 * Canonical session-title derivation, shared by the sidecar (storage layer,
 * agent-session.ts / external-session.ts) and the renderer (display layer,
 * sessionDisplay.ts).
 *
 * WHY THIS IS SHARED (the bug it fixes):
 * The storage layer used to set a session's title to `rawMessage.slice(0, 40)`.
 * For a cron / heartbeat / system turn the first message is wrapped, e.g.
 *   `<system-reminder>\n<CRON_TASK>\n执行任务：请你帮 Ethan 查收今天的邮件…\n</CRON_TASK>\n</system-reminder>`
 * The wrapper alone (`<system-reminder>` + `<CRON_TASK>` + `执行任务：`) is ~35
 * chars, so a blind 40-char slice stored `…执行任务：请你帮 E...` — the real task
 * text was destroyed BEFORE it could be unwrapped. The renderer's stripper then
 * could only recover the scrap "请你帮 E...". Fix: strip the wrapper FIRST, then
 * truncate — and use the SAME stripper on both sides so they can't drift.
 */

/**
 * Remove MyAgents system wrappers from a raw message and recover the meaningful
 * title text. Handles `<system-reminder>` envelopes (even when truncated before
 * the closing tag), strips `<CRON_TASK>` / `<HEARTBEAT>` / `<MEMORY_UPDATE>`
 * markers, collapses whitespace, and extracts the `执行任务：<name>` task title
 * when present. Returns '' if nothing meaningful remains.
 */
export function stripSystemWrapper(raw: string): string {
  let text = (raw ?? '').trim();
  if (!text) return '';

  if (text.startsWith('<system-reminder>')) {
    const closeTag = '</system-reminder>';
    const closeIdx = text.indexOf(closeTag);
    if (closeIdx >= 0) {
      const tail = text.slice(closeIdx + closeTag.length).trim();
      text = tail || text.slice('<system-reminder>'.length, closeIdx).trim();
    } else {
      // Truncated before the closing tag (the storage-truncation bug): keep the body.
      text = text.slice('<system-reminder>'.length).trim();
    }
  }

  // The `执行任务：<name>` extraction is a CRON-specific convention. Gate it on an
  // actual <CRON_TASK> marker so a normal user message that merely contains
  // "执行任务：" (e.g. "请解释这段日志：执行任务：#123 …") is NOT silently rewritten
  // to the regex capture. Run it on the PRE-collapse text so the `\n` boundary in
  // the char-class is honored (a multiline cron prompt stops at the first line
  // instead of bleeding the body into the title). [adversarial-review fixes #1/#3]
  if (/<CRON_TASK>/.test(text)) {
    const taskTitle = text.match(/执行任务[:：]\s*#?\s*([^。；;\n]+)/);
    if (taskTitle?.[1]?.trim()) {
      return taskTitle[1].trim();
    }
  }

  return text
    .replace(/<\/?(?:CRON_TASK|HEARTBEAT|MEMORY_UPDATE)>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Truncate to `maxLen` CODE POINTS (not UTF-16 units), appending '...' only when
 * actually shortened. Spreading to code points means the cut never splits a
 * surrogate pair (an emoji straddling the cap would otherwise leave a lone
 * surrogate that renders as "�"). Shared by the storage cap (deriveSessionTitle)
 * and the renderer display cap so both are surrogate-safe. [adversarial-review #2]
 */
export function capWithEllipsis(str: string, maxLen: number): string {
  const codePoints = [...str];
  return codePoints.length > maxLen ? `${codePoints.slice(0, maxLen).join('')}...` : str;
}

/**
 * Derive a clean, length-capped session title from a raw first message.
 * Strips the system wrapper BEFORE truncating, so the cap applies to real
 * content. Returns '' when the message has no meaningful text (caller supplies
 * its own fallback, e.g. '图片消息' / 'New Chat').
 *
 * @param maxLen storage cap (default 40). The renderer applies its own (smaller)
 *               display cap on top, so this only bounds what we persist.
 */
export function deriveSessionTitle(rawMessage: string | null | undefined, maxLen = 40): string {
  const stripped = stripSystemWrapper(rawMessage ?? '');
  if (!stripped) return '';
  return capWithEllipsis(stripped, maxLen);
}
