import { useEffect, useMemo, useRef, useState } from 'react';
import { Cloud, Hash, Loader2, Paperclip, Plus, X } from 'lucide-react';

import { spaceErrorMessage, type SpaceTag } from '@/api/spaceCloud';
import CustomSelect, { type SelectOption } from '@/components/CustomSelect';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useToast } from '@/components/Toast';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import type { IssueQueryParams } from '@/pages/space/spaceHelpers';
import { SPACE_VISIBLE_REFRESH_TTL_MS, type SpaceActions } from '@/pages/space/spaceStore';

const CREATE_TAG_OPTION_VALUE = '__create_tag__';

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function CreateIssueDialog({
  admin,
  tags,
  actions,
  issueQuery,
  onClose,
  onCreated,
}: {
  admin: boolean;
  tags: SpaceTag[];
  actions: SpaceActions;
  issueQuery: IssueQueryParams;
  onClose: () => void;
  onCreated: (keepOpen: boolean) => void;
}) {
  const toast = useToast();
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const newTagInputRef = useRef<HTMLInputElement | null>(null);
  const submittingRef = useRef(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tagId, setTagId] = useState(tags[0]?.id ?? '');
  const [newTagOpen, setNewTagOpen] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [creatingTag, setCreatingTag] = useState(false);
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [continuous, setContinuous] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  useCloseLayer(() => {
    onClose();
    return true;
  }, 220);

  useEffect(() => {
    window.setTimeout(() => titleInputRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (!newTagOpen) return;
    window.setTimeout(() => newTagInputRef.current?.focus(), 0);
  }, [newTagOpen]);

  useEffect(() => {
    if (tagId && !tags.some((item) => item.id === tagId)) {
      setTagId(tags[0]?.id ?? '');
    }
  }, [tagId, tags]);

  const tagOptions = useMemo<SelectOption[]>(
    () => [
      ...(admin
        ? [{
            value: CREATE_TAG_OPTION_VALUE,
            label: '新 tag',
            icon: <Plus className="h-3.5 w-3.5 text-[var(--accent-warm)]" />,
          }]
        : []),
      { value: '', label: '无标签' },
      ...tags.map((item) => ({ value: item.id, label: item.name })),
    ],
    [admin, tags],
  );

  const handleTagChange = (value: string) => {
    if (value === CREATE_TAG_OPTION_VALUE) {
      setNewTagOpen(true);
      return;
    }
    setTagId(value);
  };

  const pickFiles = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ multiple: true, directory: false, title: '选择 Issue 附件' });
      const next = Array.isArray(selected) ? selected : selected ? [selected] : [];
      if (next.length > 0) {
        setFilePaths((current) => Array.from(new Set([...current, ...next])));
      }
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    }
  };

  const createTag = async () => {
    const name = newTagName.trim();
    if (!admin || !name || creatingTag) return;
    setCreatingTag(true);
    try {
      const created = await actions.createTag({ name });
      setTagId(created.id);
      setNewTagName('');
      setNewTagOpen(false);
      toast.success(`已创建 tag：${created.name}`);
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setCreatingTag(false);
    }
  };

  const submit = async () => {
    if (submittingRef.current) return;
    if (!title.trim() || !body.trim()) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const issue = await actions.createIssue({ title: title.trim(), body: body.trim(), tags: tagId ? [tagId] : [] });
      if (filePaths.length > 0) {
        await actions.uploadIssueAttachments(issue.id, filePaths);
      }
      toast.success(filePaths.length > 0 ? `已创建 Issue 并上传 ${filePaths.length} 个附件` : '已创建 Issue');
      await actions.refreshIssues(issueQuery, { maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS, force: true, silent: true });
      if (continuous) {
        setTitle('');
        setBody('');
        setFilePaths([]);
        window.setTimeout(() => titleInputRef.current?.focus(), 0);
        onCreated(true);
      } else {
        onCreated(false);
      }
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <OverlayBackdrop onClose={onClose} className="z-[220] items-center justify-center bg-black/30 p-8 backdrop-blur-sm">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="grid h-[min(660px,calc(100vh-112px))] min-h-[500px] w-[min(980px,calc(100vw-160px))] max-w-full grid-rows-[auto_minmax(0,1fr)_auto] rounded-[var(--radius-2xl)] border border-[var(--line)] bg-[var(--paper-elevated)]/95 px-5 py-4 shadow-xl"
      >
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
          <div className="flex min-h-[34px] items-center gap-2.5 text-base font-medium text-[var(--ink-muted)]">
            <span className="grid h-6 w-6 place-items-center rounded-lg border border-[var(--accent-warm-muted)] bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]">
              <Cloud className="h-3.5 w-3.5" />
            </span>
            <span>MyAgents社区</span>
            <span>›</span>
            <strong className="font-semibold text-[var(--ink)]">New issue</strong>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-3 px-2 pb-4 pt-4">
          <input
            ref={titleInputRef}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="w-full border-0 bg-transparent text-2xl font-semibold leading-snug text-[var(--ink)] outline-none placeholder:text-[var(--ink-muted)]/60"
            placeholder="Issue title"
          />
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            className="h-full min-h-0 w-full resize-none border-0 bg-transparent p-0 text-base leading-7 text-[var(--ink-secondary)] outline-none placeholder:text-[var(--ink-muted)]/60"
            placeholder="Add description..."
          />
          {filePaths.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {filePaths.map((path) => (
                <span key={path} className="inline-flex items-center gap-1 rounded-full bg-[var(--paper-inset)] px-2 py-1 text-xs text-[var(--ink-secondary)]">
                  <Paperclip className="h-3.5 w-3.5" />
                  {basename(path)}
                  <button
                    type="button"
                    onClick={() => setFilePaths((current) => current.filter((item) => item !== path))}
                    className="ml-0.5 grid h-4 w-4 place-items-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--paper-elevated)] hover:text-[var(--ink)]"
                    aria-label={`移除 ${basename(path)}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-4 max-lg:grid-cols-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void pickFiles()}
              className="inline-flex h-10 items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--paper-elevated)]/80 px-3 text-sm font-semibold text-[var(--ink-muted)] shadow-sm transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
              aria-label="添加附件"
            >
              <Paperclip className="h-4 w-4" />
              附件
            </button>
            <span className="inline-flex min-h-10 items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--paper-elevated)]/70 px-3 text-sm font-medium text-[var(--ink-muted)] shadow-sm">
              <Hash className="h-4 w-4" />
              <CustomSelect value={tagId} options={tagOptions} onChange={handleTagChange} compact className="w-36 [&>button]:border-0 [&>button]:bg-transparent [&>button]:p-0 [&>button]:shadow-none" />
            </span>
            {admin && newTagOpen && (
              <span className="inline-flex h-10 items-center gap-1 rounded-full border border-[var(--accent-warm-muted)] bg-[var(--accent-warm-subtle)] px-2 shadow-sm">
                <input
                  ref={newTagInputRef}
                  value={newTagName}
                  onChange={(event) => setNewTagName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void createTag();
                    }
                  }}
                  className="h-8 w-28 border-0 bg-transparent px-1 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-muted)]"
                  placeholder="tag 名称"
                />
                <button
                  type="button"
                  disabled={creatingTag || !newTagName.trim()}
                  onClick={() => void createTag()}
                  className="grid h-7 w-7 place-items-center rounded-full text-[var(--accent-warm)] transition-colors hover:bg-[var(--paper-inset)] disabled:cursor-wait disabled:opacity-60"
                  aria-label="创建 tag"
                >
                  {creatingTag ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setNewTagOpen(false);
                    setNewTagName('');
                  }}
                  className="grid h-7 w-7 place-items-center rounded-full text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                  aria-label="取消创建 tag"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            )}
          </div>
          <div className="flex items-center gap-3.5 pb-0.5">
            <button
              type="button"
              aria-pressed={continuous}
              onClick={() => setContinuous((value) => !value)}
              className="inline-flex items-center gap-2 rounded-full px-1 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
            >
              <span className={`h-6 w-11 rounded-full p-0.5 transition-colors ${continuous ? 'bg-[var(--accent-warm)]' : 'bg-[var(--line-strong)]'}`}>
                <span className={`block h-5 w-5 rounded-full bg-[var(--paper-elevated)] shadow-sm transition-transform ${continuous ? 'translate-x-5' : ''}`} />
              </span>
              持续创建
            </button>
            <button
              type="submit"
              disabled={submitting || !title.trim() || !body.trim()}
              className="flex h-11 items-center gap-2 rounded-full bg-[var(--button-primary-bg)] px-6 text-sm font-semibold text-[var(--button-primary-text)] shadow-sm transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              创建
            </button>
          </div>
        </div>
      </form>
    </OverlayBackdrop>
  );
}
