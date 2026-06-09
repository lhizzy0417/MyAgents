/**
 * ModelManagementPanel - Unified overlay for managing provider models
 *
 * Upper section: Active models — hover "设为首选", delete any model, add custom ID
 * Lower section: Discover more — single-click "添加" per row, no multi-select
 */
import { X, Search, Loader2, RefreshCw, AlertCircle, Plus, Trash2, Settings2 } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useCloseLayer } from '@/hooks/useCloseLayer';
import {
  EDITABLE_MODALITIES,
  MODALITY_LABELS,
  discoveredModelWritePlan,
  initialModalitySelection,
  isModalitySelectionValid,
  parseContextWindowInput,
  resolveModalitiesToSave,
  type EditableModality,
} from '@/utils/modelSettingsForm';
import { PRESET_PROVIDERS, type Provider, type ModelEntity, type AppConfig } from '@/config/types';
import {
  fetchProviderModels,
  toModelEntity,
  formatTokenCount,
  supportsModelDiscovery,
  synthesizeModalitiesFromDiscovered,
  type DiscoveredModel,
} from '@/config/services/modelDiscoveryService';
import { atomicModifyConfig } from '@/config/configService';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { ModalityBadges } from '@/components/ModalityBadges';

interface ModelManagementPanelProps {
  provider: Provider;
  apiKey: string | undefined;
  config: AppConfig;
  onClose: () => void;
  onSaveCustomModels: (providerId: string, models: ModelEntity[]) => Promise<void>;
  onUpdateCustomProvider?: (provider: Provider) => Promise<void>;
  onSetPrimaryModel: (providerId: string, modelId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}

export default function ModelManagementPanel({
  provider,
  apiKey,
  config,
  onClose,
  onSaveCustomModels,
  onUpdateCustomProvider,
  onSetPrimaryModel,
  onRefresh,
}: ModelManagementPanelProps) {
  // ===== Discovery state =====
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[]>([]);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [customInput, setCustomInput] = useState('');
  // #325 — which model row has its inline settings editor expanded.
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const fetchIdRef = useRef(0);

  const primaryModel = provider.primaryModel;

  // Active model IDs set
  const activeModelIds = useMemo(
    () => new Set(provider.models.map(m => m.model)),
    [provider.models],
  );

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  useCloseLayer(() => { onClose(); return true; }, 200);

  // ===== Discovery fetch =====
  const canDiscover = !!apiKey && supportsModelDiscovery(provider);

  const doFetch = useCallback(async () => {
    if (!canDiscover) return;
    setDiscoveryLoading(true);
    setDiscoveryError(null);
    const thisId = ++fetchIdRef.current;
    try {
      const result = await fetchProviderModels(provider, apiKey);
      if (!isMountedRef.current || thisId !== fetchIdRef.current) return;
      setDiscoveredModels(result);
    } catch (e) {
      if (!isMountedRef.current || thisId !== fetchIdRef.current) return;
      setDiscoveryError(e instanceof Error ? e.message : String(e));
    } finally {
      if (isMountedRef.current && thisId === fetchIdRef.current) {
        setDiscoveryLoading(false);
      }
    }
  }, [provider, apiKey, canDiscover]);

  useEffect(() => { doFetch(); }, [doFetch]);

  // ===== Actions =====
  const handleSetPrimary = useCallback(async (modelId: string) => {
    await onSetPrimaryModel(provider.id, modelId);
    await onRefresh();
  }, [provider.id, onSetPrimaryModel, onRefresh]);

  const handleDeleteModel = useCallback(async (modelId: string) => {
    if (provider.isBuiltin) {
      // For preset models: add to presetRemovedModels
      // For user-added models: remove from presetCustomModels
      const customModels = config.presetCustomModels?.[provider.id] ?? [];
      const isUserAdded = customModels.some(m => m.model === modelId);
      if (isUserAdded) {
        await onSaveCustomModels(provider.id, customModels.filter(m => m.model !== modelId));
      } else {
        // Preset model — add to removed list
        await atomicModifyConfig(c => {
          const removed = c.presetRemovedModels?.[provider.id] ?? [];
          if (removed.includes(modelId)) return c;
          return {
            ...c,
            presetRemovedModels: { ...c.presetRemovedModels, [provider.id]: [...removed, modelId] },
          };
        });
      }
    } else if (onUpdateCustomProvider) {
      const updatedModels = provider.models.filter(m => m.model !== modelId);
      await onUpdateCustomProvider({ ...provider, models: updatedModels });
    }
    if (modelId === primaryModel) {
      const remaining = provider.models.filter(m => m.model !== modelId);
      if (remaining.length > 0) {
        await onSetPrimaryModel(provider.id, remaining[0].model);
      }
    }
    await onRefresh();
  }, [provider, config.presetCustomModels, primaryModel, onSaveCustomModels, onUpdateCustomProvider, onSetPrimaryModel, onRefresh]);

  const handleAddCustomModel = useCallback(async () => {
    const id = customInput.trim();
    if (!id || activeModelIds.has(id)) return;

    const entity: ModelEntity = {
      model: id, modelName: id,
      modelSeries: provider.vendor.toLowerCase(),
      source: 'manual',
    };

    if (provider.isBuiltin) {
      const existing = config.presetCustomModels?.[provider.id] ?? [];
      await onSaveCustomModels(provider.id, [...existing, entity]);
    } else if (onUpdateCustomProvider) {
      await onUpdateCustomProvider({ ...provider, models: [...provider.models, entity] });
    }
    setCustomInput('');
    await onRefresh();
  }, [customInput, activeModelIds, provider, config.presetCustomModels, onSaveCustomModels, onUpdateCustomProvider, onRefresh]);

  // #325 — which rows get the ⚙ settings button. On a custom provider every
  // model lives in the provider file → all editable. On a builtin (preset)
  // provider only USER-ADDED models are editable; bundled preset models are
  // hand-curated by the app and stay read-only by design.
  //
  // Membership in `presetCustomModels` alone is NOT the right gate (codex
  // review): re-adding a previously removed BUNDLED preset also writes an
  // entry into presetCustomModels (see handleAddDiscoveredModel), so a bundled
  // row could acquire the gear. Editing that duplicate would diverge the two
  // registries — the renderer merge is preset-wins (mergePresetCustomModels
  // only fills gaps) while the sidecar registry ingests presetCustomModels
  // BEFORE bundled presets with first-wins, so the edit would silently apply
  // on the sidecar but never show in the UI. Exclude bundled IDs explicitly.
  // Hand-curated bundled model ids for this builtin provider — shared by the
  // editability gate below and the re-add write plan in
  // handleAddDiscoveredModel (both must agree on what "bundled" means).
  const bundledModelIds = useMemo(
    () => new Set(
      provider.isBuiltin
        ? PRESET_PROVIDERS.find(p => p.id === provider.id)?.models.map(m => m.model) ?? []
        : [],
    ),
    [provider.isBuiltin, provider.id],
  );

  const editableModelIds = useMemo(() => {
    if (!provider.isBuiltin) return activeModelIds;
    return new Set(
      (config.presetCustomModels?.[provider.id] ?? [])
        .map(m => m.model)
        .filter(id => !bundledModelIds.has(id)),
    );
  }, [provider.isBuiltin, provider.id, activeModelIds, config.presetCustomModels, bundledModelIds]);

  const handleToggleEdit = useCallback((modelId: string) => {
    setEditingModelId(prev => (prev === modelId ? null : modelId));
  }, []);

  const handleCancelEdit = useCallback(() => setEditingModelId(null), []);

  // #325 — persist edited model-level params through the SAME write paths the
  // add/delete actions use, so the sidecar capability registry picks the change
  // up via its existing mtime invalidation (providers dir / config.json).
  const handleSaveModelSettings = useCallback(async (modelId: string, patch: Partial<ModelEntity>) => {
    const applyPatch = (m: ModelEntity): ModelEntity => {
      if (m.model !== modelId) return m;
      const next = { ...m, ...patch };
      // `undefined` patch values mean "clear" — drop the keys so the stored
      // JSON stays minimal and the registry falls back per its source chain.
      for (const key of Object.keys(patch) as Array<keyof ModelEntity>) {
        if (patch[key] === undefined) delete next[key];
      }
      return next;
    };
    if (provider.isBuiltin) {
      const customModels = config.presetCustomModels?.[provider.id] ?? [];
      await onSaveCustomModels(provider.id, customModels.map(applyPatch));
    } else if (onUpdateCustomProvider) {
      await onUpdateCustomProvider({ ...provider, models: provider.models.map(applyPatch) });
    }
    setEditingModelId(null);
    await onRefresh();
  }, [provider, config.presetCustomModels, onSaveCustomModels, onUpdateCustomProvider, onRefresh]);

  const handleAddDiscoveredModel = useCallback(async (model: DiscoveredModel) => {
    if (activeModelIds.has(model.id)) return;
    const entity = toModelEntity(model, provider);

    if (provider.isBuiltin) {
      // Also remove from presetRemovedModels if re-adding a previously removed preset
      await atomicModifyConfig(c => {
        const removed = c.presetRemovedModels?.[provider.id];
        if (!removed?.includes(model.id)) return c;
        return {
          ...c,
          presetRemovedModels: {
            ...c.presetRemovedModels,
            [provider.id]: removed.filter(id => id !== model.id),
          },
        };
      });
      // Re-adding a BUNDLED preset stops here: un-removing makes the preset
      // resurface by itself. Appending a duplicate into presetCustomModels
      // would diverge the registries (renderer merge is preset-wins, sidecar
      // ingest is first-wins over presetCustomModels) — see
      // discoveredModelWritePlan + its regression tests.
      const plan = discoveredModelWritePlan(bundledModelIds, model.id);
      if (plan.appendToCustomModels) {
        const existing = config.presetCustomModels?.[provider.id] ?? [];
        await onSaveCustomModels(provider.id, [...existing, entity]);
      }
    } else if (onUpdateCustomProvider) {
      await onUpdateCustomProvider({ ...provider, models: [...provider.models, entity] });
    }
    await onRefresh();
  }, [activeModelIds, provider, config.presetCustomModels, bundledModelIds, onSaveCustomModels, onUpdateCustomProvider, onRefresh]);

  // ===== Filtered discovery (exclude already-added) =====
  const filteredDiscovered = useMemo(() => {
    let list = discoveredModels.filter(m => !activeModelIds.has(m.id));
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(m =>
        m.id.toLowerCase().includes(q) ||
        m.displayName?.toLowerCase().includes(q) ||
        m.ownedBy?.toLowerCase().includes(q)
      );
    }
    return list;
  }, [discoveredModels, activeModelIds, search]);

  const allAdded = discoveredModels.length > 0 && discoveredModels.every(m => activeModelIds.has(m.id));

  return createPortal(
    <OverlayBackdrop onClose={onClose} className="z-[200]">
      <div
        className="relative flex h-[85vh] w-[620px] max-w-[90vw] flex-col overflow-hidden rounded-2xl bg-[var(--paper-elevated)] shadow-2xl"
      >
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-[var(--line)] px-5 py-3.5">
          <h2 className="text-[15px] font-semibold text-[var(--ink)]">
            管理可用模型
            <span className="ml-2 text-sm font-normal text-[var(--ink-muted)]">{provider.name}</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          {/* ===== Upper: Active Models ===== */}
          <div className="border-b border-[var(--line-subtle)] px-5 py-4">
            <h3 className="mb-2.5 text-xs font-semibold text-[var(--ink-muted)]">
              可用模型
              {provider.models.length > 0 && (
                <span className="ml-1.5 font-normal text-[var(--ink-subtle)]">{provider.models.length}</span>
              )}
            </h3>

            {provider.models.length === 0 ? (
              <p className="py-4 text-center text-sm text-[var(--ink-muted)]">暂无模型，请在下方发现或手动添加</p>
            ) : (
              <div>
                {provider.models.map(model => (
                  // relative wrapper anchors the settings popover to its row
                  <div key={model.model} className="relative">
                    <ActiveModelRow
                      model={model}
                      isPrimary={model.model === primaryModel}
                      editable={editableModelIds.has(model.model)}
                      isEditing={editingModelId === model.model}
                      onSetPrimary={handleSetPrimary}
                      onDelete={handleDeleteModel}
                      onToggleEdit={handleToggleEdit}
                    />
                    {editingModelId === model.model && (
                      <ModelSettingsEditor
                        model={model}
                        onCancel={handleCancelEdit}
                        onSave={handleSaveModelSettings}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Add custom model input */}
            <div className="mt-3 flex gap-2">
              <input
                type="text"
                value={customInput}
                onChange={(e) => setCustomInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddCustomModel(); } }}
                placeholder="输入模型 ID，按 Enter 添加"
                className="flex-1 rounded-lg border border-[var(--line)] bg-transparent px-3 py-1.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-subtle)] focus:border-[var(--ink-muted)] focus:outline-none"
              />
              <button
                type="button"
                onClick={handleAddCustomModel}
                disabled={!customInput.trim() || activeModelIds.has(customInput.trim())}
                className="rounded-lg bg-[var(--paper-inset)] px-2.5 py-1.5 text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)] disabled:opacity-40"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* ===== Lower: Discover Models ===== */}
          <div className="px-5 py-4">
            <div className="mb-2.5 flex items-center justify-between">
              <h3 className="text-xs font-semibold text-[var(--ink-muted)]">
                发现更多模型
              </h3>
              {canDiscover && discoveredModels.length > 0 && (
                <button
                  type="button"
                  onClick={doFetch}
                  disabled={discoveryLoading}
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-50"
                >
                  <RefreshCw className={`h-3 w-3 ${discoveryLoading ? 'animate-spin' : ''}`} />
                  刷新
                </button>
              )}
            </div>

            {/* Search — always visible once models have been loaded (avoids layout jump on refresh) */}
            {canDiscover && !discoveryError && discoveredModels.length > 0 && (
              <div className="relative mb-3">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ink-subtle)]" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索模型..."
                  className="w-full rounded-lg border border-[var(--line)] bg-transparent py-1.5 pl-8 pr-3 text-sm text-[var(--ink)] placeholder:text-[var(--ink-subtle)] focus:border-[var(--ink-muted)] focus:outline-none"
                />
              </div>
            )}

            {/* States */}
            {!canDiscover && !apiKey && (
              <p className="py-6 text-center text-sm text-[var(--ink-muted)]">请先配置 API Key</p>
            )}
            {!canDiscover && apiKey && (
              <p className="py-6 text-center text-sm text-[var(--ink-muted)]">当前供应商不支持发现模型</p>
            )}

            {canDiscover && discoveryLoading && discoveredModels.length === 0 && (
              <div className="flex flex-col items-center justify-center py-8 text-[var(--ink-muted)]">
                <Loader2 className="h-5 w-5 animate-spin" />
                <p className="mt-2 text-sm">正在拉取模型列表...</p>
              </div>
            )}

            {canDiscover && discoveryError && (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <AlertCircle className="h-5 w-5 text-[var(--error)]" />
                <p className="mt-2 text-sm text-[var(--ink)]">无法拉取模型列表</p>
                <p className="mt-1 max-w-md text-xs text-[var(--ink-muted)]">{discoveryError}</p>
                <button
                  type="button"
                  onClick={doFetch}
                  className="mt-3 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent-warm-subtle)]"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  重试
                </button>
              </div>
            )}

            {canDiscover && !discoveryLoading && !discoveryError && allAdded && (
              <p className="py-6 text-center text-sm text-[var(--ink-muted)]">所有可用模型已在上方列表中</p>
            )}

            {canDiscover && !discoveryLoading && !discoveryError && !allAdded && filteredDiscovered.length === 0 && search && (
              <p className="py-6 text-center text-sm text-[var(--ink-muted)]">没有匹配的模型</p>
            )}

            {canDiscover && !discoveryLoading && !discoveryError && discoveredModels.length === 0 && (
              <p className="py-6 text-center text-sm text-[var(--ink-muted)]">该供应商未返回可用模型</p>
            )}

            {/* Model list — no checkboxes, just rows with hover "添加" */}
            {filteredDiscovered.length > 0 && (
              <div>
                {filteredDiscovered.map(m => (
                  <DiscoveredModelRow
                    key={m.id}
                    model={m}
                    onAdd={handleAddDiscoveredModel}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-shrink-0 items-center justify-end border-t border-[var(--line)] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            完成
          </button>
        </div>
      </div>
    </OverlayBackdrop>,
    document.body,
  );
}

// ===== ActiveModelRow =====

const ActiveModelRow = React.memo(function ActiveModelRow({
  model,
  isPrimary,
  editable,
  isEditing,
  onSetPrimary,
  onDelete,
  onToggleEdit,
}: {
  model: ModelEntity;
  isPrimary: boolean;
  editable: boolean;
  isEditing: boolean;
  onSetPrimary: (id: string) => void;
  onDelete: (id: string) => void;
  onToggleEdit: (id: string) => void;
}) {
  const handleSetPrimary = useCallback(() => { if (!isPrimary) onSetPrimary(model.model); }, [isPrimary, onSetPrimary, model.model]);
  const handleDelete = useCallback(() => onDelete(model.model), [onDelete, model.model]);
  const handleToggleEdit = useCallback(() => onToggleEdit(model.model), [onToggleEdit, model.model]);

  const displayName = model.modelName && model.modelName !== model.model ? model.modelName : null;

  const title = displayName ?? model.model;
  const subtitle = displayName ? model.model : null;

  return (
    <div className={`group flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-[var(--hover-bg)] ${isPrimary ? 'bg-[var(--accent-warm-subtle)]' : ''}`}>
      {/* Model info — unified: title always same style, subtitle always same style */}
      <div className="min-w-0 flex-1">
        <span className="text-[13px] font-medium text-[var(--ink)]">{title}</span>
        {subtitle && (
          <span className="ml-2 font-mono text-[11px] text-[var(--ink-subtle)]">{subtitle}</span>
        )}
      </div>

      {/* Modality badges (image / video / audio — text-only models render nothing) */}
      <ModalityBadges modalities={model.inputModalities} className="flex-shrink-0" />

      {/* Context length */}
      {model.contextLength ? (
        <span className="flex-shrink-0 text-[10px] text-[var(--ink-subtle)]">
          {formatTokenCount(model.contextLength)}
        </span>
      ) : null}

      {/* #325 — per-model settings (user-added / custom-provider models only;
          bundled preset models are app-curated and read-only) */}
      {editable && (
        <button
          type="button"
          onClick={handleToggleEdit}
          title="模型参数设置"
          data-model-gear
          className={`flex-shrink-0 rounded p-1 transition-all hover:text-[var(--accent)] ${
            isEditing
              ? 'text-[var(--accent)] opacity-100'
              : 'text-[var(--ink-subtle)] opacity-0 group-hover:opacity-100'
          }`}
        >
          <Settings2 className="h-3 w-3" />
        </button>
      )}

      {/* Primary badge or hover action */}
      {isPrimary ? (
        <span className="flex-shrink-0 rounded-full bg-[var(--accent-warm-muted)] px-2 py-0.5 text-[10px] font-medium text-[var(--accent)]">
          首选
        </span>
      ) : (
        <button
          type="button"
          onClick={handleSetPrimary}
          className="flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium text-[var(--ink-subtle)] opacity-0 transition-all hover:bg-[var(--paper-inset)] hover:text-[var(--accent)] group-hover:opacity-100"
        >
          设为首选
        </button>
      )}

      {/* Delete */}
      <button
        type="button"
        onClick={handleDelete}
        className="flex-shrink-0 rounded p-1 text-[var(--ink-subtle)] opacity-0 transition-all hover:text-[var(--error)] group-hover:opacity-100"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
});

// ===== ModelSettingsEditor (#325 — anchored per-model parameter popover) =====
//
// A small card anchored under the row's ⚙ button (rendered inside the row's
// `relative` wrapper) so the model list never shifts. Edits the three fields
// that actually have consumers (see utils/modelSettingsForm.ts header for the
// audit; model-level maxOutputTokens is deliberately absent — it has none).
//
// Dismissal: outside-click + Escape (ContextMenu pattern) and Cmd+W via
// useCloseLayer at 210 — above the panel's own 200, so Cmd+W closes the
// popover before the panel. Mousedown on any row's ⚙ is exempt from
// outside-close: closing here would race the gear's own click-toggle and
// reopen immediately. The toggle alone decides (same row → close; another
// row → editingModelId switches and this instance unmounts).

const ModelSettingsEditor = function ModelSettingsEditor({
  model,
  onCancel,
  onSave,
}: {
  model: ModelEntity;
  onCancel: () => void;
  onSave: (modelId: string, patch: Partial<ModelEntity>) => Promise<void>;
}) {
  const [nameDraft, setNameDraft] = useState(model.modelName ?? model.model);
  const [contextDraft, setContextDraft] = useState(
    model.contextLength ? String(model.contextLength) : '',
  );
  const [modalities, setModalities] = useState<EditableModality[]>(
    () => initialModalitySelection(model.inputModalities),
  );
  const [modalitiesTouched, setModalitiesTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[data-model-gear]')) return;
      onCancelRef.current();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancelRef.current();
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);
  useCloseLayer(() => { onCancelRef.current(); return true; }, 210);

  const parsedContext = parseContextWindowInput(contextDraft);
  const contextInvalid = parsedContext === 'invalid';
  const modalitiesInvalid = !isModalitySelectionValid(modalities);
  const canSave = !contextInvalid && !modalitiesInvalid && !saving;

  const toggleModality = (kind: EditableModality) => {
    setModalitiesTouched(true);
    setModalities(prev => (
      prev.includes(kind)
        ? prev.filter(m => m !== kind)
        : EDITABLE_MODALITIES.filter(m => prev.includes(m) || m === kind)
    ));
  };

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      // `canSave` guard above already excluded 'invalid' (TS narrows via the
      // aliased condition), so parsedContext is number | null here.
      await onSave(model.model, {
        modelName: nameDraft.trim() || model.model,
        contextLength: parsedContext ?? undefined,
        inputModalities: resolveModalitiesToSave(modalitiesTouched, model.inputModalities, modalities),
      });
    } finally {
      setSaving(false);
    }
  };

  // Live hint: parsed-value echo when valid, error when invalid, default otherwise.
  const hint = contextInvalid
    ? '格式无效 — 输入 token 数，可带 k / m 后缀（上限 20m）'
    : modalitiesInvalid
      ? '至少选择一种模态'
      : typeof parsedContext === 'number'
        ? `≈ ${formatTokenCount(parsedContext)} tokens · 下一轮对话生效`
        : '未设窗口按 200K 估算 · 下一轮对话生效';

  const inputBase =
    'w-full rounded-lg border bg-[var(--paper)] px-2.5 py-1.5 text-xs text-[var(--ink)] outline-none transition-all placeholder:text-[var(--ink-faint)] focus:bg-[var(--paper-elevated)]';
  const inputOk =
    'border-[var(--line)] focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-warm-subtle)]';
  const inputErr = 'border-[var(--error)] focus:shadow-[0_0_0_3px_rgba(220,38,38,0.07)]';

  return (
    <div
      ref={popoverRef}
      className="absolute right-0 top-[calc(100%+8px)] z-20 w-[360px] max-w-full origin-top-right animate-[popoverIn_0.22s_cubic-bezier(0.3,1.2,0.4,1)] rounded-[14px] border border-[var(--line-subtle)] bg-[var(--paper-elevated)] p-4 shadow-[var(--shadow-lg)]"
    >
      {/* 箭头 — 指向行尾的 ⚙ 区域 */}
      <div className="absolute -top-[5px] right-14 h-2.5 w-2.5 rotate-45 border-l border-t border-[var(--line-subtle)] bg-[var(--paper-elevated)]" />

      {/* 标题带模型 ID，防止改错对象 */}
      <div className="mb-3 flex items-baseline gap-2">
        <span className="flex-shrink-0 text-xs font-semibold text-[var(--ink)]">模型参数</span>
        <code className="truncate font-mono text-[10px] text-[var(--ink-subtle)]">{model.model}</code>
      </div>

      {/* 显示名称 */}
      <div className="mb-2.5">
        <label className="mb-1 block text-[10px] font-medium tracking-wide text-[var(--ink-muted)]">显示名称</label>
        <input
          type="text"
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          placeholder={model.model}
          className={`${inputBase} ${inputOk}`}
        />
      </div>

      {/* 上下文窗口 */}
      <div className="mb-2.5">
        <label className="mb-1 block text-[10px] font-medium tracking-wide text-[var(--ink-muted)]">上下文窗口</label>
        <input
          type="text"
          value={contextDraft}
          onChange={(e) => setContextDraft(e.target.value)}
          placeholder="如 128000 · 支持 128k / 1m"
          className={`${inputBase} font-mono placeholder:font-sans ${contextInvalid ? inputErr : inputOk}`}
        />
      </div>

      {/* 输入模态 */}
      <div>
        <label className="mb-1 block text-[10px] font-medium tracking-wide text-[var(--ink-muted)]">输入模态</label>
        <div className="flex gap-1.5 pt-0.5">
          {EDITABLE_MODALITIES.map(kind => {
            const selected = modalities.includes(kind);
            return (
              <button
                key={kind}
                type="button"
                onClick={() => toggleModality(kind)}
                className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                  selected
                    ? 'border-transparent bg-[var(--accent-warm-muted)] font-medium text-[var(--accent)]'
                    : 'border-[var(--line)] text-[var(--ink-muted)] hover:border-[var(--ink-subtle)]'
                }`}
              >
                {selected && <span className="mr-1 text-[9px]">✓</span>}
                {MODALITY_LABELS[kind]}
              </button>
            );
          })}
        </div>
      </div>

      <p className={`mt-2 text-[10px] leading-relaxed ${contextInvalid || modalitiesInvalid ? 'text-[var(--error)]' : 'text-[var(--ink-subtle)]'}`}>
        {hint}
      </p>

      {/* Actions */}
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 text-xs text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
        >
          取消
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={!canSave}
          className="rounded-lg bg-[var(--button-primary-bg)] px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-40"
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
};

// ===== DiscoveredModelRow (lower section — light row with hover "添加") =====

const DiscoveredModelRow = React.memo(function DiscoveredModelRow({
  model,
  onAdd,
}: {
  model: DiscoveredModel;
  onAdd: (model: DiscoveredModel) => void;
}) {
  const handleAdd = useCallback(() => onAdd(model), [onAdd, model]);
  const displayName = model.displayName && model.displayName !== model.id ? model.displayName : null;
  const title = displayName ?? model.id;
  const subtitle = displayName ? model.id : null;

  // Synthesize modalities via the shared helper so this preview row stays in
  // sync with `toModelEntity` (the persisted form). Returns undefined when
  // discovery exposed no flags either way — the badge component then renders
  // nothing, matching how an unknown / future-modality model would appear.
  const discoveredModalities = synthesizeModalitiesFromDiscovered(model);

  return (
    <div className="group flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-[var(--hover-bg)]">
      {/* Model info — same style as ActiveModelRow */}
      <div className="min-w-0 flex-1">
        <span className="text-[13px] font-medium text-[var(--ink)]">{title}</span>
        {subtitle && (
          <span className="ml-2 font-mono text-[11px] text-[var(--ink-subtle)]">{subtitle}</span>
        )}
      </div>

      {/* Modality badges — text-only models render nothing */}
      <ModalityBadges modalities={discoveredModalities} className="flex-shrink-0" />

      {/* Metadata */}
      {model.contextLength ? (
        <span className="flex-shrink-0 text-[10px] text-[var(--ink-subtle)]">
          {formatTokenCount(model.contextLength)}
        </span>
      ) : null}

      {/* Add button — visible on hover */}
      <button
        type="button"
        onClick={handleAdd}
        className="flex-shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium text-[var(--accent)] opacity-0 transition-all hover:bg-[var(--accent-warm-subtle)] group-hover:opacity-100"
      >
        添加
      </button>
    </div>
  );
});
