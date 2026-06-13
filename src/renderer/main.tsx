import React from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

import AppErrorBoundary from './components/AppErrorBoundary';
import { ConfigProvider } from './config/ConfigProvider';
import { ToastProvider } from './components/Toast';
import { ImagePreviewProvider } from './context/ImagePreviewContext';
import { initFrontendLogger } from './utils/frontendLogger';
import { installMacFunctionKeyGuard } from './utils/macFunctionKeyGuard';

import './index.css';

// Initialize frontend logger to capture React console logs
initFrontendLogger();

// Block macOS WKWebView's NSEvent function-key tofu leak globally —
// see utils/macFunctionKeyGuard.ts. Must run before React mounts so the
// document-level capture handler is attached when the first input fires.
installMacFunctionKeyGuard();

// Block native "Reload / Inspect Element" context menu in production.
// Keep native menu for: input fields, text selection, contenteditable, links, images, media.
if (!import.meta.env.DEV) {
  document.addEventListener('contextmenu', (e) => {
    const el = e.target as HTMLElement;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'A' || tag === 'IMG'
      || tag === 'VIDEO' || tag === 'AUDIO' || el.isContentEditable) return;
    if (window.getSelection()?.toString()) return;
    e.preventDefault();
  });
}

const root = createRoot(document.getElementById('root')!);

// Floating ball windows (PRD 0.2.35): the ball + companion are separate Tauri
// WebviewWindows loading this same bundle. Route by window label — they mount
// their own minimal trees (no App / ConfigProvider; they read config via the
// service layer directly). App itself is lazy so the two tiny fb windows never
// parse/execute the multi-MB main-app chunk (and the main window pays only a
// microtask + local chunk fetch).
let tauriWindowLabel: string | undefined;
try {
  tauriWindowLabel = getCurrentWebviewWindow().label;
} catch {
  tauriWindowLabel = undefined; // browser dev mode — no Tauri runtime
}

if (tauriWindowLabel === 'fb-ball') {
  const BallWindow = React.lazy(() => import('./floating-ball/BallWindow'));
  document.documentElement.classList.add('fb-transparent');
  root.render(
    <AppErrorBoundary>
      <React.Suspense fallback={null}>
        <BallWindow />
      </React.Suspense>
    </AppErrorBoundary>
  );
} else if (tauriWindowLabel === 'fb-companion') {
  const CompanionWindow = React.lazy(() => import('./floating-ball/CompanionWindow'));
  document.documentElement.classList.add('fb-transparent');
  root.render(
    <AppErrorBoundary>
      <ToastProvider>
        <ImagePreviewProvider>
          <React.Suspense fallback={null}>
            <CompanionWindow />
          </React.Suspense>
        </ImagePreviewProvider>
      </ToastProvider>
    </AppErrorBoundary>
  );
} else {
  const App = React.lazy(() => import('./App'));
  // Note: React.StrictMode removed to prevent double-rendering of SSE effects in development
  // StrictMode causes useEffect to run twice, which duplicates SSE events and thinking blocks
  root.render(
    <AppErrorBoundary>
      <ConfigProvider>
        <ToastProvider>
          <ImagePreviewProvider>
            <React.Suspense fallback={null}>
              <App />
            </React.Suspense>
          </ImagePreviewProvider>
        </ToastProvider>
      </ConfigProvider>
    </AppErrorBoundary>
  );
}
