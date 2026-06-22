import { open } from '@tauri-apps/plugin-dialog';
import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';

import type { Provider } from '@/config/types';
import { modelSupportsModality } from '@/config/services/providerService';
import { isTauriEnvironment } from '@/utils/browserMock';
import { renameIfBareClipboardImage } from '@/utils/clipboardImage';
import { isDebugMode } from '@/utils/debug';
import { resolveAttachmentUrl } from '@/utils/attachmentUrl';
import { ALLOWED_IMAGE_MIME_TYPES, isChatImageFile, isImageMimeType } from '@/../shared/fileTypes';
import type { FileReferenceUndoAction } from '@/hooks/useUndoStack';

import type { ImageAttachment } from '../types';
import { MAX_IMAGES, MAX_IMAGE_SIZE } from '../constants';

interface PreparedImageAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  relativePath: string;
}

interface WorkspaceCopyResult {
  success: boolean;
  copiedFiles?: Array<{ targetPath: string }>;
}

interface AttachmentFileService {
  isAvailable: boolean;
  importBase64Files(input: {
    files: Array<{ name: string; content: string }>;
    targetDir: string;
  }): Promise<{ success: boolean; files?: string[] }>;
  addGitignore(input: { pattern: string }): Promise<unknown>;
  prepareUserImageAttachments(input: {
    sessionId: string;
    paths: string[];
  }): Promise<{
    attachments: PreparedImageAttachment[];
    errors: Array<{ code?: string; path: string }>;
  }>;
  copyPaths(input: {
    sourcePaths: string[];
    targetDir: string;
    autoRename: boolean;
  }): Promise<WorkspaceCopyResult>;
}

interface AttachmentUndoStack {
  generateBatchId: () => string;
  push: (action: FileReferenceUndoAction) => void;
}

interface AttachmentToast {
  warning: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  success: (message: string) => void;
}

interface UseAttachmentHandlingParams {
  fileService: AttachmentFileService;
  workspacePath?: string | null;
  provider?: Provider | null;
  currentModelId?: string | null;
  isExternalRuntime: boolean;
  attachmentSessionId?: string | null;
  inputValueRef: MutableRefObject<string>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  toastRef: MutableRefObject<AttachmentToast>;
  undoStack: AttachmentUndoStack;
  setInputValue: Dispatch<SetStateAction<string>>;
  setShowPlusMenu: Dispatch<SetStateAction<boolean>>;
  onWorkspaceRefresh?: () => void;
}

export function useAttachmentHandling({
  fileService,
  workspacePath,
  provider,
  currentModelId,
  isExternalRuntime,
  attachmentSessionId,
  inputValueRef,
  textareaRef,
  fileInputRef,
  toastRef,
  undoStack,
  setInputValue,
  setShowPlusMenu,
  onWorkspaceRefresh,
}: UseAttachmentHandlingParams) {
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const mountedRef = useRef(true);
  const activeReadersRef = useRef<Set<FileReader>>(new Set());

  useEffect(
    () => {
      mountedRef.current = true;
      const activeReaders = activeReadersRef.current;
      return () => {
        mountedRef.current = false;
        for (const reader of activeReaders) {
          if (reader.readyState === FileReader.LOADING) {
            reader.abort();
          }
        }
        activeReaders.clear();
      };
    },
    [],
  );

  const forgetReader = useCallback((reader: FileReader) => {
    activeReadersRef.current.delete(reader);
  }, []);

  const insertReferenceText = useCallback((paths: string[]): number => {
    const currentInput = inputValueRef.current;
    const cursorPos = Math.min(
      textareaRef.current?.selectionStart ?? currentInput.length,
      currentInput.length,
    );
    const references = paths.map(path => `@${path}`).join(' ');

    const before = currentInput.slice(0, cursorPos);
    const after = currentInput.slice(cursorPos);
    const insertedText = references + ' ';
    const newValue = before + insertedText + after;

    inputValueRef.current = newValue;
    setInputValue(newValue);
    return cursorPos;
  }, [inputValueRef, setInputValue, textareaRef]);

  const addImage = useCallback((file: File) => {
    if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.type)) {
      toastRef.current.warning('不支持的图片格式，请使用 PNG/JPG/GIF/WebP');
      return;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      toastRef.current.warning('图片大小不能超过 10MB');
      return;
    }

    const reader = new FileReader();
    activeReadersRef.current.add(reader);
    reader.onload = (e) => {
      forgetReader(reader);
      if (!mountedRef.current) return;
      const dataUrl = e.target?.result as string;
      setImages((prev) => {
        if (prev.length >= MAX_IMAGES) {
          toastRef.current.warning(`最多只能上传 ${MAX_IMAGES} 张图片`);
          return prev;
        }
        return [...prev, {
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          file,
          preview: dataUrl,
          source: 'inline_base64',
          name: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
        }];
      });
    };
    reader.onerror = () => forgetReader(reader);
    reader.onabort = () => forgetReader(reader);
    reader.readAsDataURL(file);
  }, [forgetReader, toastRef]);

  const addPreparedImageAttachment = useCallback((attachment: PreparedImageAttachment) => {
    const preview = resolveAttachmentUrl({ relativePath: attachment.relativePath });
    if (!preview) {
      toastRef.current.warning(`图片 "${attachment.name}" 预览地址生成失败`);
      return;
    }
    setImages((prev) => {
      if (prev.length >= MAX_IMAGES) {
        toastRef.current.warning(`最多只能上传 ${MAX_IMAGES} 张图片`);
        return prev;
      }
      return [...prev, {
        id: attachment.id,
        file: new File([], attachment.name, { type: attachment.mimeType }),
        preview,
        source: 'attachment_ref',
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        relativePath: attachment.relativePath,
      }];
    });
  }, [toastRef]);

  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  const fileToBase64 = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      activeReadersRef.current.add(reader);
      reader.onload = () => {
        forgetReader(reader);
        if (!mountedRef.current) {
          reject(new Error('read cancelled'));
          return;
        }
        const result = reader.result as string;
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = () => {
        forgetReader(reader);
        reject(reader.error ?? new Error('file read failed'));
      };
      reader.onabort = () => {
        forgetReader(reader);
        reject(new Error('read cancelled'));
      };
      reader.readAsDataURL(file);
    });
  }, [forgetReader]);

  const processDroppedFiles = useCallback(async (files: File[]) => {
    if (isDebugMode()) {
      console.log('[SimpleChatInput] processDroppedFiles called with', files.length, 'files:', files.map(f => f.name));
    }

    const imageFiles: File[] = [];
    const otherFiles: File[] = [];

    for (const file of files) {
      if (isChatImageFile(file.name) || isImageMimeType(file.type)) {
        imageFiles.push(file);
      } else {
        otherFiles.push(file);
      }
    }

    const userIntendedFileCount = otherFiles.length;

    const oversizedImageFiles = imageFiles.filter((file) => file.size > MAX_IMAGE_SIZE);
    if (oversizedImageFiles.length > 0) {
      toastRef.current.warning(
        oversizedImageFiles.length === 1
          ? '图片超过 10MB，请使用“上传文件”或从文件夹拖入以作为 @文件 引用'
          : `${oversizedImageFiles.length} 张图片超过 10MB，请使用“上传文件”或从文件夹拖入以作为 @文件 引用`,
      );
      for (const img of oversizedImageFiles) {
        const idx = imageFiles.indexOf(img);
        if (idx >= 0) imageFiles.splice(idx, 1);
      }
    }

    const fallbackImagesToFiles =
      imageFiles.length > 0 &&
      !isExternalRuntime &&
      !modelSupportsModality(provider, currentModelId, 'image');

    if (fallbackImagesToFiles) {
      toastRef.current.info(
        '当前模型不支持图片输入，已转为文件存入工作区供模型读取',
      );
      for (const img of imageFiles) {
        otherFiles.push(renameIfBareClipboardImage(img));
      }
      imageFiles.length = 0;
    }

    for (const file of imageFiles) {
      addImage(file);
    }

    if (otherFiles.length > 0) {
      if (!fileService.isAvailable) {
        console.error('[SimpleChatInput] workspace file service unavailable');
        toastRef.current.error(
          workspacePath
            ? '无法上传文件：当前为浏览器开发模式，请使用桌面应用'
            : '无法上传文件：请先选择工作区',
        );
        return;
      }
      try {
        const base64Files = await Promise.all(
          otherFiles.map(async (file) => ({
            name: file.name,
            content: await fileToBase64(file),
          }))
        );

        const result = await fileService.importBase64Files({
          files: base64Files,
          targetDir: 'myagents_files',
        });
        if (!mountedRef.current) return;

        if (!result.success || !result.files || result.files.length === 0) {
          throw new Error('上传失败');
        }

        try {
          await fileService.addGitignore({ pattern: 'myagents_files/' });
        } catch {
          // Non-fatal, continue silently.
        }

        if (!mountedRef.current) return;
        const cursorPos = insertReferenceText(result.files);

        const batchId = undoStack.generateBatchId();

        for (const filePath of result.files) {
          undoStack.push({
            type: 'file-reference',
            batchId,
            insertedText: `@${filePath} `,
            insertPosition: cursorPos,
            copiedFilePath: filePath,
          });
        }

        if (userIntendedFileCount > 0) {
          toastRef.current.success(`已添加 ${userIntendedFileCount} 个文件到工作区`);
        }

        onWorkspaceRefresh?.();
      } catch (err) {
        if (!mountedRef.current) return;
        console.error('[SimpleChatInput] File upload error:', err);
        toastRef.current.error(err instanceof Error ? err.message : '文件上传失败');
      }
    }
  }, [fileService, workspacePath, addImage, undoStack, fileToBase64, onWorkspaceRefresh, provider, currentModelId, isExternalRuntime, toastRef, insertReferenceText]);

  const processDroppedFilePaths = useCallback(async (paths: string[]) => {
    if (isDebugMode()) {
      console.log('[SimpleChatInput] processDroppedFilePaths called with', paths.length, 'paths:', paths);
    }

    if (!fileService.isAvailable) {
      console.error('[SimpleChatInput] workspace file service unavailable for path drop');
      toastRef.current.error(
        workspacePath
          ? '无法处理文件：当前为浏览器开发模式，请使用桌面应用'
          : '无法处理文件：请先选择工作区',
      );
      return;
    }

    const imagePaths: string[] = [];
    const otherPaths: string[] = [];

    for (const path of paths) {
      const filename = path.split(/[\\/]/).pop() || path;
      if (isChatImageFile(filename)) {
        imagePaths.push(path);
      } else {
        otherPaths.push(path);
      }
    }

    const fallbackImagesToFiles =
      imagePaths.length > 0 &&
      !isExternalRuntime &&
      !modelSupportsModality(provider, currentModelId, 'image');

    const userIntendedPathCount = otherPaths.length;

    if (fallbackImagesToFiles) {
      toastRef.current.info(
        '当前模型不支持图片输入，已转为文件存入工作区供模型读取',
      );
      otherPaths.push(...imagePaths);
      imagePaths.length = 0;
    }

    if (imagePaths.length > 0) {
      if (!attachmentSessionId) {
        toastRef.current.error('无法添加图片：当前会话尚未就绪');
        return;
      }
      const pendingFileReferencePaths: string[] = [];
      let oversizedCount = 0;
      try {
        const prepared = await fileService.prepareUserImageAttachments({
          sessionId: attachmentSessionId,
          paths: imagePaths,
        });
        if (!mountedRef.current) return;
        for (const attachment of prepared.attachments) {
          addPreparedImageAttachment(attachment);
        }
        for (const err of prepared.errors) {
          if (err.code === 'too_large') {
            oversizedCount += 1;
          } else if (isDebugMode()) {
            console.warn('[SimpleChatInput] Failed to prepare image attachment, treating as file:', err);
          }
          pendingFileReferencePaths.push(err.path);
        }
      } catch (err) {
        if (!mountedRef.current) return;
        if (isDebugMode()) {
          console.warn('[SimpleChatInput] Failed to prepare image attachments, treating as regular files:', err);
        }
        pendingFileReferencePaths.push(...imagePaths);
      }

      if (oversizedCount > 0) {
        toastRef.current.info(
          oversizedCount === 1
            ? '图片超过 10MB，已作为文件引用添加'
            : `${oversizedCount} 张图片超过 10MB，已作为文件引用添加`,
        );
      }
      otherPaths.push(...pendingFileReferencePaths);
      imagePaths.length = 0;
    }

    if (otherPaths.length > 0) {
      try {
        const result = await fileService.copyPaths({
          sourcePaths: otherPaths,
          targetDir: 'myagents_files',
          autoRename: true,
        });
        if (!mountedRef.current) return;

        if (!result.success) {
          throw new Error('复制失败');
        }

        const successfulCopies = result.copiedFiles || [];
        if (successfulCopies.length === 0) {
          throw new Error('没有文件被成功复制');
        }

        try {
          await fileService.addGitignore({ pattern: 'myagents_files/' });
        } catch {
          // Non-fatal, continue silently.
        }

        if (!mountedRef.current) return;
        const cursorPos = insertReferenceText(successfulCopies.map(f => f.targetPath));

        const batchId = undoStack.generateBatchId();

        for (const file of successfulCopies) {
          undoStack.push({
            type: 'file-reference',
            batchId,
            insertedText: `@${file.targetPath} `,
            insertPosition: cursorPos,
            copiedFilePath: file.targetPath,
          });
        }

        if (userIntendedPathCount > 0) {
          if (successfulCopies.length < otherPaths.length) {
            toastRef.current.warning(`已添加 ${successfulCopies.length}/${otherPaths.length} 个文件到工作区`);
          } else {
            toastRef.current.success(`已添加 ${userIntendedPathCount} 个文件到工作区`);
          }
        }

        onWorkspaceRefresh?.();
      } catch (err) {
        if (!mountedRef.current) return;
        console.error('[SimpleChatInput] Tauri file copy error:', err);
        toastRef.current.error(err instanceof Error ? err.message : '文件复制失败');
      }
    }
  }, [fileService, workspacePath, addPreparedImageAttachment, undoStack, onWorkspaceRefresh, provider, currentModelId, isExternalRuntime, attachmentSessionId, toastRef, insertReferenceText]);

  const handleUploadButtonClick = useCallback(async () => {
    setShowPlusMenu(false);
    if (isTauriEnvironment()) {
      try {
        const selected = await open({
          multiple: true,
          directory: false,
          title: '选择文件',
        });
        if (!mountedRef.current) return;
        const paths = Array.isArray(selected)
          ? selected.filter((path): path is string => typeof path === 'string')
          : (typeof selected === 'string' ? [selected] : []);
        if (paths.length > 0) {
          await processDroppedFilePaths(paths);
        }
      } catch (err) {
        if (!mountedRef.current) return;
        console.error('[SimpleChatInput] File picker error:', err);
        toastRef.current.error('选择文件失败');
      }
      return;
    }
    fileInputRef.current?.click();
  }, [processDroppedFilePaths, setShowPlusMenu, fileInputRef, toastRef]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      void processDroppedFiles(Array.from(files));
    }
    e.target.value = '';
    setShowPlusMenu(false);
  }, [processDroppedFiles, setShowPlusMenu]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) {
      return;
    }

    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }

    if (files.length > 0) {
      if (isDebugMode()) {
        console.log('[SimpleChatInput] Processing', files.length, 'pasted files');
      }
      e.preventDefault();
      void processDroppedFiles(files);
    }
  }, [processDroppedFiles]);

  return {
    images,
    setImages,
    removeImage,
    processDroppedFiles,
    processDroppedFilePaths,
    handleUploadButtonClick,
    handleFileChange,
    handlePaste,
  };
}
