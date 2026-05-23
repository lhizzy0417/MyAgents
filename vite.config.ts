import { readFileSync } from 'fs';
import { resolve } from 'path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Read version info from package.json and Cargo.toml at build time
function getBuildVersions() {
  const packageJson = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));
  const cargoToml = readFileSync(resolve(__dirname, 'src-tauri/Cargo.toml'), 'utf-8');

  // Extract Claude Agent SDK version
  const claudeAgentSdkVersion = packageJson.dependencies?.['@anthropic-ai/claude-agent-sdk']?.replace('^', '') || 'unknown';

  // Extract bundled Node.js version from scripts/download_nodejs.sh (NODE_VERSION="x.y.z")
  const nodeScript = (() => {
    try {
      return readFileSync(resolve(__dirname, 'scripts/download_nodejs.sh'), 'utf-8');
    } catch { return ''; }
  })();
  const nodeMatch = nodeScript.match(/NODE_VERSION\s*=\s*"([^"]+)"/);
  const nodeVersion = nodeMatch ? nodeMatch[1] : 'unknown';

  // Extract Tauri version from Cargo.toml (look for: tauri = { version = "2.9.5", ... })
  const tauriMatch = cargoToml.match(/tauri\s*=\s*\{\s*version\s*=\s*"([^"]+)"/);
  const tauriVersion = tauriMatch ? tauriMatch[1] : 'unknown';

  return {
    claudeAgentSdk: claudeAgentSdkVersion,
    node: nodeVersion,
    tauri: tauriVersion,
  };
}

const buildVersions = getBuildVersions();

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: '@', replacement: resolve(__dirname, 'src/renderer') },
      // Force pdf.js's LEGACY (polyfilled) build everywhere. The modern build
      // calls `Map.prototype.getOrInsertComputed` (a 2024 TC39 proposal) which the
      // macOS WKWebView (JavaScriptCore) doesn't implement, so every page.render()
      // threw "getOrInsertComputed is not a function" → blank PDF. The legacy bundle
      // ships the polyfill (pdf.js's documented path for older engines). Regex so
      // ONLY the bare `pdfjs-dist` specifier is rewritten — subpath imports like
      // `pdfjs-dist/legacy/build/pdf.worker.min.mjs?url` must pass through untouched.
      { find: /^pdfjs-dist$/, replacement: resolve(__dirname, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs') },
    ]
  },
  // Define environment variables for client code
  define: {
    // DEBUG_MODE: true when VITE_DEBUG_MODE is set or in dev server mode
    '__DEBUG_MODE__': JSON.stringify(process.env.VITE_DEBUG_MODE === 'true'),
    // Build-time version info for developer mode
    '__BUILD_VERSIONS__': JSON.stringify(buildVersions),
  },
  server: {
    port: 5173,
    proxy: {
      // All API endpoints under /api/ (excludes source files like /api/*.ts)
      '^/api/(?!.*\\.(ts|tsx|js|jsx)$)': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path, // Keep path as-is
      },
      '/chat': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/agent': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/sessions': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      }
    }
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    // Suppress warning about large chunks
    // index.js is ~2100KB due to heavy visualization libs (mermaid, cytoscape)
    chunkSizeWarningLimit: 2500
  }
});
