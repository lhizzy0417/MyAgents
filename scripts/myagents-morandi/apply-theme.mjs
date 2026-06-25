#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const repoArg = process.argv[2];
if (!repoArg) {
  console.error('Usage: node scripts/myagents-morandi/apply-theme.mjs /path/to/MyAgents');
  process.exit(1);
}

const repoRoot = path.resolve(repoArg);

const files = {
  indexCss: path.join(repoRoot, 'src/renderer/index.css'),
  terminalPanel: path.join(repoRoot, 'src/renderer/components/TerminalPanel.tsx'),
  introPanel: path.join(repoRoot, 'src/renderer/components/IntroductionPanel.tsx'),
  agentCapabilities: path.join(repoRoot, 'src/renderer/components/AgentCapabilitiesPanel.tsx'),
  skillsCommands: path.join(repoRoot, 'src/renderer/components/SkillsCommandsList.tsx'),
  systemPrompts: path.join(repoRoot, 'src/renderer/components/SystemPromptsPanel.tsx'),
  recentTasks: path.join(repoRoot, 'src/renderer/components/launcher/RecentTasks.tsx'),
};

for (const [label, filePath] of Object.entries({ indexCss: files.indexCss, terminalPanel: files.terminalPanel })) {
  if (!fs.existsSync(filePath)) {
    console.error(`Missing required file for ${label}: ${filePath}`);
    process.exit(1);
  }
}

function replaceOrThrow(source, pattern, replacement, label) {
  const next = source.replace(pattern, replacement);
  if (next === source) {
    if (source.includes(replacement)) {
      return source;
    }
    throw new Error(`Pattern not found while patching ${label}`);
  }
  return next;
}

function patchIndexCss(source) {
  let next = source;
  const replacements = [
    [/--ink:\s*#[0-9a-fA-F]{6};/, '--ink: #22312a;'],
    [/--ink-secondary:\s*#[0-9a-fA-F]{6};/, '--ink-secondary: #34453c;'],
    [/--ink-muted:\s*#[0-9a-fA-F]{6};/, '--ink-muted: #62786b;'],
    [/--ink-subtle:\s*#[0-9a-fA-F]{6};/, '--ink-subtle: #92a79a;'],
    [/--ink-faint:\s*#[0-9a-fA-F]{6};/, '--ink-faint: #bacbc1;'],
    [/--paper:\s*#[0-9a-fA-F]{6};/, '--paper: #edf3ee;'],
    [/--paper-elevated:\s*#[0-9a-fA-F]{6};/, '--paper-elevated: #f8fbf8;'],
    [/--paper-inset:\s*#[0-9a-fA-F]{6};/, '--paper-inset: #d6e1d8;'],
    [/--paper-a0:\s*rgb\([^)]+\);/, '--paper-a0: rgb(237 243 238 / 0);'],
    [/--paper-elevated-a0:\s*rgb\([^)]+\);/, '--paper-elevated-a0: rgb(248 251 248 / 0);'],
    [/--paper-inset-a0:\s*rgb\([^)]+\);/, '--paper-inset-a0: rgb(214 225 216 / 0);'],
    [/--hover-bg:\s*rgba\([^)]+\);/, '--hover-bg: rgba(104, 138, 116, 0.10);'],
    [/--accent:\s*#[0-9a-fA-F]{6};/, '--accent: #688a74;'],
    [/--accent-warm:\s*#[0-9a-fA-F]{6};/, '--accent-warm: #688a74;'],
    [/--accent-warm-hover:\s*#[0-9a-fA-F]{6};/, '--accent-warm-hover: #7ca08a;'],
    [/--accent-warm-subtle:\s*rgba\([^)]+\);/, '--accent-warm-subtle: rgba(104, 138, 116, 0.12);'],
    [/--accent-warm-muted:\s*rgba\([^)]+\);/, '--accent-warm-muted: rgba(104, 138, 116, 0.22);'],
    [/--accent-cool:\s*#[0-9a-fA-F]{6};/, '--accent-cool: #4f6f60;'],
    [/--accent-cool-hover:\s*#[0-9a-fA-F]{6};/, '--accent-cool-hover: #628271;'],
    [/--success:\s*#[0-9a-fA-F]{6};/, '--success: #5c8468;'],
    [/--success-bg:\s*#[0-9a-fA-F]{6};/, '--success-bg: #e1ece4;'],
    [/--accent-warm-subtle-a0:\s*rgba\([^)]+\);/, '--accent-warm-subtle-a0: rgba(104, 138, 116, 0);'],
    [/--button-primary-bg:\s*#[0-9a-fA-F]{6};/, '--button-primary-bg: #688a74;'],
    [/--button-primary-bg-hover:\s*#[0-9a-fA-F]{6};/, '--button-primary-bg-hover: #5a7a65;'],
    [/--button-dark-bg:\s*#[0-9a-fA-F]{6};/, '--button-dark-bg: #22312a;'],
    [/--button-dark-bg-hover:\s*#[0-9a-fA-F]{6};/, '--button-dark-bg-hover: #304139;'],
    [/--button-secondary-bg:\s*#[0-9a-fA-F]{6};/, '--button-secondary-bg: #d6e1d8;'],
    [/--button-secondary-bg-hover:\s*#[0-9a-fA-F]{6};/, '--button-secondary-bg-hover: #cad8cd;'],
    [/--button-secondary-text:\s*#[0-9a-fA-F]{6};/, '--button-secondary-text: #22312a;'],
    [/--line:\s*rgb\([^)]+\);/, '--line: rgb(34 49 42 / 0.10);'],
    [/--line-strong:\s*rgb\([^)]+\);/, '--line-strong: rgb(34 49 42 / 0.18);'],
    [/--line-subtle:\s*rgb\([^)]+\);/, '--line-subtle: rgb(34 49 42 / 0.06);'],
    [/--focus-border:\s*#[0-9a-fA-F]{6};/, '--focus-border: #4f6f60;'],
    [/--toggle-off-bg:\s*rgb\([^)]+\);/, '--toggle-off-bg: rgb(34 49 42 / 0.18);'],
  ];

  for (const [pattern, replacement] of replacements) {
    next = replaceOrThrow(next, pattern, replacement, 'light theme tokens');
  }

  const darkStart = next.indexOf('.dark {');
  const darkEnd = next.indexOf('color-scheme: dark;');
  if (darkStart === -1 || darkEnd === -1) {
    throw new Error('Dark theme block markers not found');
  }
  const darkBlock = next.slice(darkStart, darkEnd);
  const darkReplacements = [
    [/--ink:\s*#[0-9a-fA-F]{6};/, '--ink: #e6eee8;'],
    [/--ink-secondary:\s*#[0-9a-fA-F]{6};/, '--ink-secondary: #c8d5cd;'],
    [/--ink-muted:\s*#[0-9a-fA-F]{6};/, '--ink-muted: #96a89b;'],
    [/--ink-subtle:\s*#[0-9a-fA-F]{6};/, '--ink-subtle: #607266;'],
    [/--ink-faint:\s*#[0-9a-fA-F]{6};/, '--ink-faint: #435248;'],
    [/--paper:\s*#[0-9a-fA-F]{6};/, '--paper: #18211b;'],
    [/--paper-elevated:\s*#[0-9a-fA-F]{6};/, '--paper-elevated: #212b24;'],
    [/--paper-inset:\s*#[0-9a-fA-F]{6};/, '--paper-inset: #121813;'],
    [/--paper-a0:\s*rgb\([^)]+\);/, '--paper-a0: rgb(24 33 27 / 0);'],
    [/--paper-elevated-a0:\s*rgb\([^)]+\);/, '--paper-elevated-a0: rgb(33 43 36 / 0);'],
    [/--paper-inset-a0:\s*rgb\([^)]+\);/, '--paper-inset-a0: rgb(18 24 19 / 0);'],
    [/--hover-bg:\s*rgba\([^)]+\);/, '--hover-bg: rgba(151, 181, 163, 0.16);'],
    [/--accent:\s*#[0-9a-fA-F]{6};/, '--accent: #97b5a3;'],
    [/--accent-warm:\s*#[0-9a-fA-F]{6};/, '--accent-warm: #97b5a3;'],
    [/--accent-warm-hover:\s*#[0-9a-fA-F]{6};/, '--accent-warm-hover: #aac4b4;'],
    [/--accent-warm-subtle:\s*rgba\([^)]+\);/, '--accent-warm-subtle: rgba(151, 181, 163, 0.16);'],
    [/--accent-warm-muted:\s*rgba\([^)]+\);/, '--accent-warm-muted: rgba(151, 181, 163, 0.24);'],
    [/--accent-cool:\s*#[0-9a-fA-F]{6};/, '--accent-cool: #769483;'],
    [/--accent-cool-hover:\s*#[0-9a-fA-F]{6};/, '--accent-cool-hover: #8cac9a;'],
    [/--success:\s*#[0-9a-fA-F]{6};/, '--success: #8fb89d;'],
    [/--success-bg:\s*rgba\([^)]+\);/, '--success-bg: rgba(143, 184, 157, 0.18);'],
    [/--accent-warm-subtle-a0:\s*rgba\([^)]+\);/, '--accent-warm-subtle-a0: rgba(151, 181, 163, 0);'],
    [/--button-primary-bg:\s*#[0-9a-fA-F]{6};/, '--button-primary-bg: #97b5a3;'],
    [/--button-primary-bg-hover:\s*#[0-9a-fA-F]{6};/, '--button-primary-bg-hover: #83a190;'],
    [/--button-dark-bg:\s*#[0-9a-fA-F]{6};/, '--button-dark-bg: #324038;'],
    [/--button-dark-bg-hover:\s*#[0-9a-fA-F]{6};/, '--button-dark-bg-hover: #405047;'],
    [/--button-secondary-bg:\s*#[0-9a-fA-F]{6};/, '--button-secondary-bg: #273029;'],
    [/--button-secondary-bg-hover:\s*#[0-9a-fA-F]{6};/, '--button-secondary-bg-hover: #313b34;'],
    [/--button-secondary-text:\s*#[0-9a-fA-F]{6};/, '--button-secondary-text: #e6eee8;'],
    [/--line:\s*rgb\([^)]+\);/, '--line: rgb(230 238 232 / 0.10);'],
    [/--line-strong:\s*rgb\([^)]+\);/, '--line-strong: rgb(230 238 232 / 0.18);'],
    [/--line-subtle:\s*rgb\([^)]+\);/, '--line-subtle: rgb(230 238 232 / 0.06);'],
    [/--toggle-thumb:\s*#[0-9a-fA-F]{6};/, '--toggle-thumb: #e6eee8;'],
    [/--toggle-off-bg:\s*rgb\([^)]+\);/, '--toggle-off-bg: rgb(230 238 232 / 0.18);'],
  ];
  let patchedDark = darkBlock;
  for (const [pattern, replacement] of darkReplacements) {
    patchedDark = replaceOrThrow(patchedDark, pattern, replacement, 'dark theme tokens');
  }
  next = next.slice(0, darkStart) + patchedDark + next.slice(darkEnd);

  next = next.replace(
    /radial-gradient\(1200px 700px at 82% -10%,\s*#[0-9a-fA-F]{6}\s*0%,\s*rgb\([^)]+\)\s*55%\),\s*radial-gradient\(900px 600px at -10% 110%,\s*#[0-9a-fA-F]{6}\s*0%,\s*rgb\([^)]+\)\s*55%\)/,
    'radial-gradient(1200px 700px at 82% -10%, #d7e4da 0%, rgb(215 228 218 / 0) 55%),\n    radial-gradient(900px 600px at -10% 110%, #c1d4c7 0%, rgb(193 212 199 / 0) 55%)',
  );
  next = next.replace(
    /radial-gradient\(1200px 700px at 82% -10%,\s*#[0-9a-fA-F]{6}\s*0%,\s*rgb\([^)]+\)\s*55%\),\s*radial-gradient\(900px 600px at -10% 110%,\s*#[0-9a-fA-F]{6}\s*0%,\s*rgb\([^)]+\)\s*55%\),\s*var\(--paper\)/,
    'radial-gradient(1200px 700px at 82% -10%, #24332a 0%, rgb(36 51 42 / 0) 55%),\n    radial-gradient(900px 600px at -10% 110%, #1a2a20 0%, rgb(26 42 32 / 0) 55%),\n    var(--paper)',
  );

  return next;
}

function patchTerminalPanel(source) {
  let next = source;
  next = next.replace("background: '#1a1614'", "background: '#18211b'");
  next = next.replace("cursor: '#c26d3a'", "cursor: '#688a74'");
  next = next.replace("selectionBackground: 'rgba(194, 109, 58, 0.25)'", "selectionBackground: 'rgba(104, 138, 116, 0.25)'");
  next = next.replace("selectionInactiveBackground: 'rgba(194, 109, 58, 0.15)'", "selectionInactiveBackground: 'rgba(104, 138, 116, 0.15)'");
  next = next.replace("background: '#f0ebe3'", "background: '#e6efe8'");
  next = next.replace("cursor: '#c26d3a'", "cursor: '#97b5a3'");
  next = next.replace("selectionBackground: 'rgba(194, 109, 58, 0.18)'", "selectionBackground: 'rgba(104, 138, 116, 0.18)'");
  next = next.replace("selectionInactiveBackground: 'rgba(194, 109, 58, 0.10)'", "selectionInactiveBackground: 'rgba(104, 138, 116, 0.10)'");
  return next;
}

function patchSimpleIconFile(source) {
  return source
    .replaceAll('text-amber-500', 'text-[var(--accent-warm)]')
    .replaceAll('text-amber-500/70', 'text-[var(--accent-warm)]/70');
}

const patchers = [
  [files.indexCss, patchIndexCss],
  [files.terminalPanel, patchTerminalPanel],
  [files.introPanel, patchSimpleIconFile],
  [files.agentCapabilities, patchSimpleIconFile],
  [files.skillsCommands, patchSimpleIconFile],
  [files.systemPrompts, patchSimpleIconFile],
  [files.recentTasks, patchSimpleIconFile],
];

for (const [filePath, patcher] of patchers) {
  if (!fs.existsSync(filePath)) {
    console.log(`Skipped missing optional file ${path.relative(repoRoot, filePath)}`);
    continue;
  }
  const original = fs.readFileSync(filePath, 'utf8');
  const patched = patcher(original);
  fs.writeFileSync(filePath, patched);
  console.log(`Patched ${path.relative(repoRoot, filePath)}`);
}

console.log('\nMorandi theme applied.');
