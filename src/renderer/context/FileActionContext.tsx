/**
 * FileActionContext — provides inline-code path checking and context menu actions.
 *
 * Used by markdown InlineCode to detect real file/folder paths in AI output
 * and offer quick actions (preview, reference, open-in-finder).
 *
 * Only provided inside Chat; Settings / other pages get null from useFileAction().
 */
import { AtSign, Copy, ExternalLink, Eye, FolderOpen, LocateFixed } from 'lucide-react';
import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import ContextMenu from '@/components/ContextMenu';
import type { ContextMenuItem } from '@/components/ContextMenu';
import { useToastOptional } from '@/components/Toast';
import { useImagePreview } from '@/context/ImagePreviewContext';
import { useWorkspaceFileService } from '@/hooks/useWorkspaceFileService';
import { getRichDocKind, isImageFile, isPreviewable, type RichDocKind } from '../../shared/fileTypes';
import type { FilePreviewFocusTarget } from '@/types/filePreview';
import { resolveWorkspaceFileLinkTarget } from '@/utils/workspaceFileLinks';

// Lazy load FilePreviewModal (heavy: includes SyntaxHighlighter + Monaco)
const FilePreviewModal = lazy(() => import('@/components/FilePreviewModal'));

// ---------- Types ----------

interface PathInfo {
  exists: boolean;
  type: 'file' | 'dir';
}

export interface FileActionContextValue {
  /** Synchronous cache lookup. Returns cached result or null (pending / not yet requested). */
  checkPath: (path: string) => PathInfo | null;
  /** Incremented each time the cache is updated, so consumers can re-render. */
  cacheVersion: number;
  /** Open the context menu for a resolved path. `path` is the normalized form
   *  used for backend actions; `displayPath` is the verbatim text shown to the
   *  user (what 「复制」 copies) — defaults to `path` when omitted. */
  openFileMenu: (x: number, y: number, path: string, pathType: 'file' | 'dir', displayPath?: string) => void;
  /** Workspace root, for resolving workspace-relative paths to absolute (e.g. the
   *  inline audio play button, whose player needs an absolute path). May be null
   *  outside a workspace. */
  workspacePath: string | null;
}

export interface FileLinkActionContextValue {
  /** Claims and previews a Markdown link when it targets a file in the active workspace. */
  openFileLink: (href: string) => boolean;
}

interface FileActionProviderProps {
  children: ReactNode;
  /** Workspace path for resolving relative paths (Phase D.5: was previously
   *  inferred from sidecar's `currentAgentDir`; now passed explicitly so the
   *  Provider doesn't depend on a sidecar). */
  workspacePath: string | null;
  /** Callback to insert @-reference into the chat input. */
  onInsertReference?: (paths: string[]) => void;
  /** When this value changes, the path cache is cleared (e.g. toolCompleteCount). */
  refreshTrigger?: number;
  /** When provided, "预览" routes to this callback (split-view) instead of fullscreen modal. */
  onFilePreviewExternal?: (file: {
    name: string;
    content: string;
    size: number;
    path: string;
    richDocKind?: RichDocKind;
    initialLineNumber?: number;
    focusTarget?: FilePreviewFocusTarget;
  }) => void;
  /** Append `@<path> ` to chat input — wired to FilePreviewModal's「引用文件」button.
   *  Distinct from `onInsertReference` (cursor-insert, no trailing space) — the toolbar
   *  button always appends to end with trailing space, matching the「丢进对话框继续聊」 UX. */
  onQuoteFile?: (path: string) => void;
  /** Append `@<path>#L<start>[-L<end>] ` to chat input — wired to FilePreviewModal's
   *  Monaco selection-quote affordance. */
  onQuoteSelection?: (path: string, startLine: number, endLine: number) => void;
  /** Reveal a workspace-relative path in the right-side directory tree (expand
   *  ancestors + select + scroll into view). Reuses the same mechanism as the
   *  search panel's「在文件目录中展示」. When omitted, the menu item is hidden. */
  onRevealInTree?: (path: string) => void;
}

// ---------- Context ----------

const FileActionContext = createContext<FileActionContextValue | null>(null);
const FileLinkActionContext = createContext<FileLinkActionContextValue | null>(null);

export function useFileAction(): FileActionContextValue | null {
  return useContext(FileActionContext);
}

export function useFileLinkAction(): FileLinkActionContextValue | null {
  return useContext(FileLinkActionContext);
}

// ---------- Provider ----------

const BATCH_DELAY_MS = 50;

export function FileActionProvider({ children, workspacePath, onInsertReference, refreshTrigger, onFilePreviewExternal, onQuoteFile, onQuoteSelection, onRevealInTree }: FileActionProviderProps) {
  const fileService = useWorkspaceFileService(workspacePath);
  const { openPreview: openImagePreview } = useImagePreview();

  // Optional so the Provider has no hard dependency on a ToastProvider above
  // (isolated component tests mount it without one). Held in a ref per the
  // project's React-stability rules so handlers don't re-bind on toast changes.
  const toast = useToastOptional();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // Stabilise callbacks via refs
  const onInsertReferenceRef = useRef(onInsertReference);
  onInsertReferenceRef.current = onInsertReference;

  const onFilePreviewExternalRef = useRef(onFilePreviewExternal);
  onFilePreviewExternalRef.current = onFilePreviewExternal;

  const onRevealInTreeRef = useRef(onRevealInTree);
  onRevealInTreeRef.current = onRevealInTree;

  // Stabilise fileService so async closures see the latest service without
  // re-binding callbacks. Mirrors the React-stability rules pattern used
  // elsewhere (toastRef, apiPostRef in legacy code).
  const fileServiceRef = useRef(fileService);
  fileServiceRef.current = fileService;

  // Guard against setState after unmount
  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  // ---------- Path cache ----------
  const pathCacheRef = useRef<Map<string, PathInfo>>(new Map());
  const pendingPathsRef = useRef<Set<string>>(new Set());
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [cacheVersion, setCacheVersion] = useState(0);

  // Clear cache when refreshTrigger changes
  useEffect(() => {
    pathCacheRef.current.clear();
    pendingPathsRef.current.clear();
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }
    setCacheVersion(v => v + 1);
  }, [refreshTrigger]);

  // Clean up batch timer on unmount
  useEffect(() => {
    return () => {
      if (batchTimerRef.current) {
        clearTimeout(batchTimerRef.current);
        batchTimerRef.current = null;
      }
    };
  }, []);

  // Flush pending paths to the backend (Rust workspace_files::check_paths
  // since Phase D.5 — used to be sidecar `/agent/check-paths`).
  const flushPendingPaths = useCallback(() => {
    const paths = Array.from(pendingPathsRef.current);
    pendingPathsRef.current.clear();
    batchTimerRef.current = null;

    if (paths.length === 0) return;
    if (!fileServiceRef.current.isAvailable) return;

    void (async () => {
      try {
        const resp = await fileServiceRef.current.checkPaths({ paths });
        if (!isMountedRef.current) return;
        if (resp?.results) {
          for (const [p, info] of Object.entries(resp.results)) {
            pathCacheRef.current.set(p, info);
          }
          setCacheVersion(v => v + 1);
        }
      } catch {
        // Silently ignore — paths will stay un-cached and remain as plain <code>
      }
    })();
  }, []);

  const checkPath = useCallback((path: string): PathInfo | null => {
    const cached = pathCacheRef.current.get(path);
    if (cached) return cached;

    // Already queued
    if (pendingPathsRef.current.has(path)) return null;

    // Enqueue
    pendingPathsRef.current.add(path);
    if (!batchTimerRef.current) {
      batchTimerRef.current = setTimeout(flushPendingPaths, BATCH_DELAY_MS);
    }
    return null;
  }, [flushPendingPaths]);

  // ---------- Context menu ----------
  const [menuState, setMenuState] = useState<{
    x: number;
    y: number;
    path: string;
    pathType: 'file' | 'dir';
    displayPath: string;
  } | null>(null);

  const openFileMenu = useCallback((x: number, y: number, path: string, pathType: 'file' | 'dir', displayPath?: string) => {
    setMenuState({ x, y, path, pathType, displayPath: displayPath ?? path });
  }, []);

  const closeMenu = useCallback(() => setMenuState(null), []);

  // ---------- Preview state ----------
  const [previewFile, setPreviewFile] = useState<{
    name: string;
    content: string;
    size: number;
    path: string;
    richDocKind?: RichDocKind;
    initialLineNumber?: number;
    focusTarget?: FilePreviewFocusTarget;
    isLoading: boolean;
    error: string | null;
  } | null>(null);

  const previewFocusRequestIdRef = useRef(0);

  const createFocusTarget = useCallback((lineNumber?: number) => {
    if (!lineNumber) return undefined;
    return {
      requestId: ++previewFocusRequestIdRef.current,
      lineNumber,
    } satisfies FilePreviewFocusTarget;
  }, []);

  const handlePreview = useCallback((path: string, options?: { initialLineNumber?: number }): boolean => {
    const fileName = path.split(/[/\\]/).pop() ?? path;
    const svc = fileServiceRef.current;
    if (!svc.isAvailable) return false;
    const focusTarget = createFocusTarget(options?.initialLineNumber);

    const richDocKind = getRichDocKind(fileName);
    if (richDocKind) {
      const fileData = {
        name: fileName,
        content: '',
        size: 0,
        path,
        richDocKind,
        initialLineNumber: options?.initialLineNumber,
        focusTarget,
      };
      if (onFilePreviewExternalRef.current) {
        onFilePreviewExternalRef.current(fileData);
      } else {
        setPreviewFile({ ...fileData, isLoading: false, error: null });
      }
      return true;
    }

    if (isImageFile(fileName)) {
      void (async () => {
        let handle: { blobUrl: string; revoke: () => void } | null = null;
        try {
          handle = await svc.readFileAsBlobUrl({ path });
          if (!isMountedRef.current) {
            handle.revoke();
            return;
          }
          // Convert blob URL → data URL for the image preview overlay.
          // The preview component caches the data URL, so we can release
          // the blob URL immediately afterwards.
          const resp = await fetch(handle.blobUrl);
          const blob = await resp.blob();
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(new Error('FileReader failed'));
            reader.readAsDataURL(blob);
          });
          if (!isMountedRef.current) return;
          openImagePreview(dataUrl, fileName);
        } catch (err) {
          console.error('[FileAction] Failed to load image:', err);
        } finally {
          if (handle) handle.revoke();
        }
      })();
      return true;
    }

    if (!isPreviewable(fileName)) return false;

    // Route to split-view if external handler provided
    if (onFilePreviewExternalRef.current) {
      void (async () => {
        try {
          const resp = await svc.readPreview({ path });
          if (!isMountedRef.current) return;
          onFilePreviewExternalRef.current?.({
            name: resp.name,
            content: resp.content,
            size: resp.size,
            path,
            initialLineNumber: options?.initialLineNumber,
            focusTarget,
          });
        } catch (err) {
          if (!isMountedRef.current) return;
          console.error('[FileAction] Failed to load preview:', err);
          setPreviewFile({
            name: fileName,
            content: '',
            size: 0,
            path,
            initialLineNumber: options?.initialLineNumber,
            focusTarget,
            isLoading: false,
            error: err instanceof Error ? err.message : 'Failed to load file',
          });
        }
      })();
      return true;
    }

    // Fallback: show fullscreen modal immediately in loading state
    setPreviewFile({
      name: fileName,
      content: '',
      size: 0,
      path,
      initialLineNumber: options?.initialLineNumber,
      focusTarget,
      isLoading: true,
      error: null,
    });

    void (async () => {
      try {
        const resp = await svc.readPreview({ path });
        if (!isMountedRef.current) return;
        setPreviewFile(prev => prev ? { ...prev, content: resp.content, size: resp.size, name: resp.name, isLoading: false } : null);
      } catch (err) {
        if (!isMountedRef.current) return;
        setPreviewFile(prev => prev ? { ...prev, isLoading: false, error: err instanceof Error ? err.message : 'Failed to load file' } : null);
      }
    })();
    return true;
  }, [createFocusTarget, openImagePreview]);

  const openFileLink = useCallback((href: string): boolean => {
    if (!fileServiceRef.current.isAvailable) return false;
    const target = resolveWorkspaceFileLinkTarget(href, workspacePath);
    if (!target) return false;
    if (handlePreview(target.path, { initialLineNumber: target.initialLineNumber })) {
      return true;
    }
    void fileServiceRef.current.openWithDefault({ path: target.path }).catch((err) => {
      console.error('[FileAction] Failed to open file link with default app:', err);
    });
    return true;
  }, [handlePreview, workspacePath]);

  const handleReference = useCallback((path: string) => {
    onInsertReferenceRef.current?.([path]);
  }, []);

  // Copy the path VERBATIM — exactly the text shown in the chip (所见所得),
  // whatever the model wrote (relative or absolute). The menu's `path` is the
  // normalized action form; copy uses the separate `displayPath` instead.
  const handleCopyPath = useCallback((displayPath: string) => {
    void navigator.clipboard.writeText(displayPath).then(
      () => toastRef.current?.success('已复制'),
      () => toastRef.current?.error('复制失败'),
    );
  }, []);

  const handleOpenWithDefault = useCallback((path: string) => {
    void fileServiceRef.current.openWithDefault({ path }).catch(() => {});
  }, []);

  const handleOpenInFinder = useCallback((path: string) => {
    void fileServiceRef.current.openInFinder({ path }).catch(() => {});
  }, []);

  const handleRevealInTree = useCallback((path: string) => {
    onRevealInTreeRef.current?.(path);
  }, []);

  // Build menu items
  const menuItems = useMemo((): ContextMenuItem[] => {
    if (!menuState) return [];
    const { path, pathType, displayPath } = menuState;
    const fileName = path.split('/').pop() ?? path;
    const items: ContextMenuItem[] = [];

    if (pathType === 'file') {
      const canPreview = isPreviewable(fileName) || isImageFile(fileName) || !!getRichDocKind(fileName);
      items.push({
        label: '预览',
        icon: <Eye className="h-4 w-4" />,
        disabled: !canPreview,
        onClick: () => handlePreview(path),
      });
    }

    items.push({
      label: '复制',
      icon: <Copy className="h-4 w-4" />,
      onClick: () => handleCopyPath(displayPath),
    });

    items.push({
      label: '引用',
      icon: <AtSign className="h-4 w-4" />,
      onClick: () => handleReference(path),
    });

    items.push({
      label: '打开',
      icon: <ExternalLink className="h-4 w-4" />,
      onClick: () => handleOpenWithDefault(path),
    });

    items.push({
      label: '打开所在文件夹',
      icon: <FolderOpen className="h-4 w-4" />,
      onClick: () => handleOpenInFinder(path),
    });

    // Reveal in the right-side directory tree — only when the host wired it up
    // (i.e. a workspace tree exists to reveal into). Works for files and dirs.
    if (onRevealInTreeRef.current) {
      items.push({
        label: '在文件目录中展示',
        icon: <LocateFixed className="h-4 w-4" />,
        onClick: () => handleRevealInTree(path),
      });
    }

    return items;
  }, [menuState, handlePreview, handleCopyPath, handleReference, handleOpenWithDefault, handleOpenInFinder, handleRevealInTree]);

  // ---------- Context value ----------
  const contextValue = useMemo<FileActionContextValue>(() => ({
    checkPath,
    cacheVersion,
    openFileMenu,
    workspacePath,
  }), [checkPath, cacheVersion, openFileMenu, workspacePath]);

  const linkActionValue = useMemo<FileLinkActionContextValue>(() => ({
    openFileLink,
  }), [openFileLink]);

  return (
    <FileActionContext.Provider value={contextValue}>
      <FileLinkActionContext.Provider value={linkActionValue}>
        {children}

        {/* Context menu */}
        {menuState && (
          <ContextMenu
            x={menuState.x}
            y={menuState.y}
            items={menuItems}
            onClose={closeMenu}
          />
        )}

        {/* File preview modal (lazy loaded) */}
        {previewFile && (
          <Suspense fallback={null}>
            <FilePreviewModal
              name={previewFile.name}
              content={previewFile.content}
              size={previewFile.size}
              path={previewFile.path}
              richDocKind={previewFile.richDocKind}
              isLoading={previewFile.isLoading}
              error={previewFile.error}
              // Phase D.5: thread the absolute workspace root so rendered
              // markdown can load relative-path images via fileService.
              // Without this, MarkdownImage's hook gets `null` and silently
              // skips the fetch (preview text/code still works).
              workspacePath={workspacePath}
              initialLineNumber={previewFile.initialLineNumber}
              focusTarget={previewFile.focusTarget}
              onClose={() => setPreviewFile(null)}
              onRenamed={(newPath, newName) => {
                // Update local preview state so subsequent saves target the new
                // location. The fs watcher refreshes the directory tree.
                setPreviewFile((prev) =>
                  prev ? { ...prev, path: newPath, name: newName } : prev,
                );
              }}
              // Phase D.5: route reveal-in-finder through fileService rather
              // than letting the modal fall back to sidecar `/agent/open-in-finder`.
              onRevealFile={async () => {
                const p = previewFile.path;
                await fileServiceRef.current.openInFinder({ path: p });
              }}
              onQuoteFile={onQuoteFile}
              onQuoteSelection={onQuoteSelection}
            />
          </Suspense>
        )}
      </FileLinkActionContext.Provider>
    </FileActionContext.Provider>
  );
}
