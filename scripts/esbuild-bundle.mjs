// Cross-platform esbuild driver for the three Node bundles we ship
// (server, plugin-bridge, CLI).
//
// Why this script exists: the previous inline `npm run build:*` commands
// embedded the esbuild banner via `--banner:js='...'` with single quotes.
// That worked under bash/zsh on macOS/Linux but **broke under Windows
// `cmd.exe`**, which doesn't recognise single quotes — it just split the
// banner arg on whitespace, and esbuild aborted with:
//
//   ✘ ERROR  Must use "outdir" when there are multiple input files
//
// Switching to the JS API removes shell-quoting entirely and gives us
// one source of truth for everything that defines a Node bundle: entry,
// banner, format, externals, sourcemap. Per-target post-build steps
// (e.g. CLI launcher copy, server-side hardcoded-path validation) live
// here too — used to be duplicated across build_macos.sh / build_linux.sh
// / build_windows.ps1, now centralised so a missed update can't ship a
// half-fixed bundle.

import { build } from 'esbuild';
import { copyFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// Read package.json version once and inject as a compile-time constant.
// This is the ONLY way `myagents version` can show the real shipped
// version in production: the runtime `process.env.npm_package_version`
// is set by `npm run …` (dev), not by Tauri's sidecar spawn (prod), so
// without compile-time injection the admin-api falls back to a stale
// hardcoded string. Issue #149 follow-up — users couldn't tell whether
// they were running the patched build.
const PKG_VERSION = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
).version;

// Banner content kept as plain string literals here — no shell parsing
// involved, so single/double quotes mean what they say.
//
// Aliasing `createRequire` here is load-bearing, not stylistic: at least one
// bundled source file (`src/server/utils/imageResize.ts`) uses
// `import { createRequire } from 'module'` at top level, and esbuild keeps
// that import literally in the output. If our banner *also* binds the bare
// name `createRequire`, Node ≥22's ESM loader rejects the module on first
// load with `SyntaxError: Identifier 'createRequire' has already been
// declared` — Sidecar dies before answering /health, the renderer hangs at
// "loading history". A unique alias here permanently sidesteps the
// collision regardless of how many depths-deep deps re-import the symbol.
const ESM_INTEROP_BANNER =
  'import { createRequire as __myAgentsCreateRequire } from "module"; const require = __myAgentsCreateRequire(import.meta.url);';
const CLI_SHEBANG_BANNER = '#!/usr/bin/env node';

const TARGETS = {
  server: {
    entryPoints: ['src/server/index.ts'],
    outfile: 'src-tauri/resources/server-dist.js',
    format: 'esm',
    sourcemap: true,
    banner: { js: ESM_INTEROP_BANNER },
    /** Post-build: catch hardcoded `__dirname = "<dev-machine path>"` leaks.
     *  esbuild treats a top-level `__dirname` as a compile-time constant; the
     *  source must use `import.meta.url` / `getScriptDir()` instead. If anyone
     *  regresses that contract, fail the build here so the bad bundle never
     *  ships (used to be a separate `grep` step in each .sh / .ps1 build
     *  script — three near-identical copies before the consolidation).
     */
    postBuild: async (outfile) => {
      const code = await readFile(outfile, 'utf8');
      // Match Mac/Linux absolute (`/Users/...`, `/home/...`) and Windows
      // (`C:\...` or forward-slash form `C:/...`, both upper- and lower-
      // case drives) — esbuild has been observed to emit either slash
      // style on Windows depending on path-normalize internals.
      const m = code.match(/var __dirname = "((?:\/Users|\/home|[A-Za-z]:[\\/])[^"]+)"/);
      if (m) {
        console.error(
          `✘ ${outfile}: hardcoded __dirname → ${m[1]}\n` +
            `  Source must use import.meta.url / utils.getScriptDir(), not __dirname.`,
        );
        process.exit(1);
      }
    },
  },
  bridge: {
    entryPoints: ['src/server/plugin-bridge/index.ts'],
    // `.mjs` is load-bearing, not stylistic. Plugin Bridge is spawned with
    // `--import tsx/esm` so tsx's loader hooks see every module load. When
    // the bundle lives somewhere with no `package.json` above declaring
    // `"type": "module"` (e.g. a Windows production install at
    // `C:\Users\hackl\AppData\Local\MyAgents\`), Node's default classifier
    // returns `format: "commonjs"` for the `.js` entry. tsx's hook then
    // detects ESM syntax in the CJS-classified file, transpiles it to CJS
    // via esbuild, and re-serves it as a `data:text/javascript` URL — which
    // ends up triggering an ERR_REQUIRE_CYCLE_MODULE on the still-loading
    // entry. Renaming the output to `.mjs` short-circuits the whole path:
    // Node treats `.mjs` as ESM unconditionally per spec, tsx's CJS branch
    // never fires. Verified against a real Windows 0.2.0 install log.
    // server-dist.js stays `.js` because the sidecar spawn doesn't pass
    // `--import` (no tsx in the chain), so the same trap doesn't apply.
    outfile: 'src-tauri/resources/plugin-bridge-dist.mjs',
    format: 'esm',
    sourcemap: true,
    banner: { js: ESM_INTEROP_BANNER },
    external: ['openclaw'],
  },
  cli: {
    entryPoints: ['src/cli/myagents.ts'],
    outfile: 'src-tauri/resources/cli/myagents.js',
    format: 'cjs',
    sourcemap: false,
    banner: { js: CLI_SHEBANG_BANNER },
    /** Post-build: drop the Windows launcher next to the bundle. Rust's
     *  `cmd_sync_cli` reads `resources/cli/myagents.js` AND `myagents.cmd`,
     *  so both have to be present in every release artifact regardless of
     *  the host OS doing the build. Doing the copy here means a single
     *  `npm run build:cli` invocation produces a complete CLI deliverable —
     *  no follow-up shell step in mac/linux/windows builders.
     */
    postBuild: async () => {
      const src = 'src/cli/myagents.cmd';
      const dst = 'src-tauri/resources/cli/myagents.cmd';
      await copyFile(src, dst);
      console.log(`  ↳ copied ${src} → ${dst}`);
    },
  },
};

const targetName = process.argv[2];
const cfg = TARGETS[targetName];
if (!cfg) {
  const known = Object.keys(TARGETS).join(', ');
  console.error(`Usage: node scripts/esbuild-bundle.mjs <${known}>`);
  process.exit(1);
}

// Ensure the outfile's directory exists. esbuild creates the file but
// requires the parent dir; on a clean checkout (or after `cargo clean`
// nuked target/), `src-tauri/resources/cli/` may not exist yet.
await mkdir(dirname(cfg.outfile), { recursive: true });

await build({
  bundle: true,
  platform: 'node',
  target: 'node22',
  define: {
    // Compile-time version constant. Replaces `process.env.npm_package_version`
    // fallbacks across the codebase so `myagents version` reports the real
    // shipped build instead of a stale hardcoded string in production.
    __MYAGENTS_VERSION__: JSON.stringify(PKG_VERSION),
  },
  // `postBuild` is our own hook — strip it before handing config to esbuild.
  ...(({ postBuild: _strip, ...rest }) => rest)(cfg),
});

if (cfg.postBuild) {
  await cfg.postBuild(cfg.outfile);
}

console.log(`✓ ${targetName} → ${cfg.outfile}`);
