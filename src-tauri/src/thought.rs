//! Thought store for Task Center (v0.1.69).
//!
//! Thoughts are user-level freeform notes, not bound to any workspace. Each thought
//! is stored as a single `.md` file under `~/.myagents/thoughts/<YYYY-MM>/<id>.md`
//! with YAML-ish frontmatter followed by a Markdown body.
//!
//! Storage format:
//! ```text
//! ---
//! id: 7f3a9c2e-...
//! createdAt: 1745000000000
//! updatedAt: 1745000000100
//! tags: [MyAgents, 维护]
//! images: []
//! convertedTaskIds: []
//! ---
//!
//! 帮我把 OpenClaw 的 lark 适配器升一下版本，#MyAgents #维护
//! ```
//!
//! Atomic writes via tmp+rename (mirrors `cron_task.rs` pattern). In-memory index
//! is rebuilt on startup by scanning the month-subdirectories; no watcher yet —
//! all mutations go through this manager.
//!
//! Tags in the body (matches `#xxx` — ASCII letters/digits/underscores and common
//! CJK codepoints) are parsed on save and stored in the frontmatter, so downstream
//! filtering and Tantivy indexing don't need to re-parse.

use chrono::{DateTime, Datelike, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::{ulog_debug, ulog_info, ulog_warn};

/// A freeform user note. See PRD §3.1.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thought {
    pub id: String,
    pub content: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub images: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub converted_task_ids: Vec<String>,
    /// "Soft-hide" flag — archived thoughts don't appear in the default
    /// ThoughtPanel list / Launcher 想法条 / `#` picker, but search still
    /// returns them (mailbox-archive semantics, v0.2.16 PRD).
    #[serde(default, skip_serializing_if = "is_false")]
    pub archived: bool,
}

fn is_false(v: &bool) -> bool {
    !*v
}

impl Thought {
    fn new(content: String, images: Vec<String>) -> Self {
        let now = now_ms();
        let tags = parse_tags(&content);
        Self {
            id: Uuid::new_v4().to_string(),
            content,
            tags,
            images,
            created_at: now,
            updated_at: now,
            converted_task_ids: Vec::new(),
            archived: false,
        }
    }
}

/// View filter for `list()`. `None` == `Active` — default behavior is to
/// hide archived thoughts unless the caller explicitly opts in.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThoughtArchiveFilter {
    Active,
    Archived,
    All,
}

/// Payload for `create`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThoughtCreateInput {
    pub content: String,
    #[serde(default)]
    pub images: Vec<String>,
}

/// Payload for `update`. All fields optional — only present keys are applied.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThoughtUpdateInput {
    pub id: String,
    pub content: Option<String>,
    pub images: Option<Vec<String>>,
    pub converted_task_ids: Option<Vec<String>>,
}

/// One source whose physical delete failed during a `merge` call.
/// The merged thought is committed regardless; the renderer surfaces this
/// list as a partial-success toast so the user can manually re-try cleanup.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeSourceDeleteFailure {
    pub id: String,
    pub error: String,
}

/// Result of a `merge` call. `merged` is always present (the new thought
/// is created atomically and never rolls back on source-delete failure —
/// that would risk losing already-deleted source content). `failed_source_deletes`
/// is empty in the happy path; non-empty signals partial cleanup failure.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub merged: Thought,
    pub failed_source_deletes: Vec<MergeSourceDeleteFailure>,
}

/// Filters accepted by `list`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThoughtListFilter {
    /// If set, only thoughts containing this tag (case-insensitive) are returned.
    pub tag: Option<String>,
    /// Free-text substring search over `content`. Case-insensitive.
    pub query: Option<String>,
    /// If set, cap the number of returned rows (most recent first).
    pub limit: Option<usize>,
    /// Archive-state filter. `None` (default) == `Active` — old callers
    /// that don't know about archiving naturally get the "hide archived"
    /// behavior the PRD specifies.
    #[serde(default)]
    pub archived: Option<ThoughtArchiveFilter>,
}

/// In-memory + on-disk thought store. Singleton managed by Tauri.
pub struct ThoughtStore {
    /// id → (thought, absolute path to .md file)
    inner: Arc<RwLock<HashMap<String, (Thought, PathBuf)>>>,
    /// `~/.myagents/thoughts/` — parent dir; month subdirs are created lazily.
    root: PathBuf,
}

impl ThoughtStore {
    /// Create a new store, scan disk, and return a handle.
    ///
    /// Safe to call both from sync contexts (Tauri `setup()`) and tokio contexts —
    /// disk scan runs synchronously and seeds the map before the `RwLock` is wrapped,
    /// so there is no `.blocking_*` call inside a runtime and no lock contention
    /// during init.
    pub fn new(root: PathBuf) -> Self {
        if let Err(e) = fs::create_dir_all(&root) {
            ulog_warn!("[thought] failed to ensure root dir: {}", e);
        }
        let initial = Self::scan_disk(&root);
        Self {
            inner: Arc::new(RwLock::new(initial)),
            root,
        }
    }

    fn scan_disk(root: &PathBuf) -> HashMap<String, (Thought, PathBuf)> {
        let mut out: HashMap<String, (Thought, PathBuf)> = HashMap::new();
        let Ok(entries) = fs::read_dir(root) else {
            ulog_debug!("[thought] no thoughts dir yet; starting empty");
            return out;
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            // month subdir like `2026-04`
            let Ok(month_entries) = fs::read_dir(&path) else { continue };
            for mentry in month_entries.flatten() {
                let fpath = mentry.path();
                if !fpath.is_file() {
                    continue;
                }
                if fpath.extension().and_then(|e| e.to_str()) != Some("md") {
                    continue;
                }
                match fs::read_to_string(&fpath)
                    .map_err(|e| e.to_string())
                    .and_then(|s| parse_thought_file(&s))
                {
                    Ok(t) => {
                        out.insert(t.id.clone(), (t, fpath));
                    }
                    Err(e) => {
                        ulog_warn!(
                            "[thought] skipped malformed file {}: {}",
                            fpath.display(),
                            e
                        );
                    }
                }
            }
        }
        ulog_info!("[thought] loaded {} thought(s) from disk", out.len());
        out
    }

    fn month_dir_for(&self, ts_ms: i64) -> PathBuf {
        let dt = DateTime::<Utc>::from_timestamp_millis(ts_ms).unwrap_or_else(Utc::now);
        self.root.join(format!("{:04}-{:02}", dt.year(), dt.month()))
    }

    fn file_path_for(&self, t: &Thought) -> PathBuf {
        self.month_dir_for(t.created_at).join(format!("{}.md", t.id))
    }

    fn write_atomic(&self, path: &PathBuf, content: &str) -> Result<(), String> {
        use std::fs::OpenOptions;
        use std::io::Write;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create thought dir: {}", e))?;
        }
        let tmp = path.with_extension("md.tmp");
        let write_res = (|| -> Result<(), String> {
            let mut file = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&tmp)
                .map_err(|e| format!("open thought tmp: {}", e))?;
            file.write_all(content.as_bytes())
                .map_err(|e| format!("write thought tmp: {}", e))?;
            file.flush()
                .map_err(|e| format!("flush thought tmp: {}", e))?;
            file.sync_all()
                .map_err(|e| format!("sync thought tmp: {}", e))?;
            Ok(())
        })();
        if let Err(e) = write_res {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
        if let Err(e) = fs::rename(&tmp, path) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("Failed to rename thought file: {}", e));
        }
        Ok(())
    }

    // ================ Public async API ================

    pub async fn create(&self, input: ThoughtCreateInput) -> Result<Thought, String> {
        let t = Thought::new(input.content, input.images);
        let path = self.file_path_for(&t);
        let serialized = serialize_thought(&t);
        self.write_atomic(&path, &serialized)?;

        let mut inner = self.inner.write().await;
        inner.insert(t.id.clone(), (t.clone(), path));
        ulog_info!("[thought] created id={} tags={:?}", t.id, t.tags);
        Ok(t)
    }

    pub async fn list(&self, filter: ThoughtListFilter) -> Vec<Thought> {
        let inner = self.inner.read().await;
        let mut thoughts: Vec<Thought> = inner.values().map(|(t, _)| t.clone()).collect();

        // Archive filter first — narrows the candidate set before any
        // tag/query scan. Default (None) is Active, so any historical
        // caller that doesn't know about this field gets the "hide
        // archived" behavior the PRD requires.
        let archive_mode = filter.archived.unwrap_or(ThoughtArchiveFilter::Active);
        match archive_mode {
            ThoughtArchiveFilter::Active => thoughts.retain(|t| !t.archived),
            ThoughtArchiveFilter::Archived => thoughts.retain(|t| t.archived),
            ThoughtArchiveFilter::All => {}
        }

        if let Some(tag) = filter.tag.as_deref() {
            let needle = tag.to_lowercase();
            thoughts.retain(|t| t.tags.iter().any(|x| x.to_lowercase() == needle));
        }
        if let Some(q) = filter.query.as_deref() {
            let needle = q.to_lowercase();
            thoughts.retain(|t| t.content.to_lowercase().contains(&needle));
        }

        thoughts.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

        if let Some(limit) = filter.limit {
            thoughts.truncate(limit);
        }
        thoughts
    }

    /// Toggle archive state for a thought. Disk write goes through the
    /// same atomic tmp+rename path as `update`, so a crash midway can't
    /// produce a half-written frontmatter.
    pub async fn set_archived(&self, id: &str, archived: bool) -> Result<Thought, String> {
        let mut inner = self.inner.write().await;
        let (existing, path) = inner
            .get(id)
            .ok_or_else(|| format!("Thought not found: {}", id))?
            .clone();

        let mut updated = existing;
        if updated.archived == archived {
            return Ok(updated); // idempotent — no-op
        }
        updated.archived = archived;
        updated.updated_at = now_ms();

        let serialized = serialize_thought(&updated);
        self.write_atomic(&path, &serialized)?;
        inner.insert(updated.id.clone(), (updated.clone(), path));
        ulog_info!(
            "[thought] {} id={}",
            if archived { "archived" } else { "unarchived" },
            id
        );
        Ok(updated)
    }

    pub async fn get(&self, id: &str) -> Option<Thought> {
        let inner = self.inner.read().await;
        inner.get(id).map(|(t, _)| t.clone())
    }

    pub async fn update(&self, input: ThoughtUpdateInput) -> Result<Thought, String> {
        let mut inner = self.inner.write().await;
        let (existing, path) = inner
            .get(&input.id)
            .ok_or_else(|| format!("Thought not found: {}", input.id))?
            .clone();

        let mut updated = existing;
        if let Some(content) = input.content {
            updated.tags = parse_tags(&content);
            updated.content = content;
        }
        if let Some(images) = input.images {
            updated.images = images;
        }
        if let Some(tids) = input.converted_task_ids {
            updated.converted_task_ids = tids;
        }
        updated.updated_at = now_ms();

        let serialized = serialize_thought(&updated);
        self.write_atomic(&path, &serialized)?;
        inner.insert(updated.id.clone(), (updated.clone(), path));
        Ok(updated)
    }

    /// Append `task_id` to a thought's `convertedTaskIds` (idempotent).
    pub async fn link_task(&self, thought_id: &str, task_id: &str) -> Result<Thought, String> {
        let mut inner = self.inner.write().await;
        let (existing, path) = inner
            .get(thought_id)
            .ok_or_else(|| format!("Thought not found: {}", thought_id))?
            .clone();
        let mut updated = existing;
        if !updated.converted_task_ids.iter().any(|x| x == task_id) {
            updated.converted_task_ids.push(task_id.to_string());
            updated.updated_at = now_ms();
            let serialized = serialize_thought(&updated);
            self.write_atomic(&path, &serialized)?;
            inner.insert(updated.id.clone(), (updated.clone(), path));
        }
        Ok(updated)
    }

    /// Remove `task_id` from a thought's `convertedTaskIds` if present.
    pub async fn unlink_task(&self, thought_id: &str, task_id: &str) -> Result<(), String> {
        let mut inner = self.inner.write().await;
        if let Some((existing, path)) = inner.get(thought_id).cloned() {
            let mut updated = existing;
            let before = updated.converted_task_ids.len();
            updated.converted_task_ids.retain(|x| x != task_id);
            if updated.converted_task_ids.len() != before {
                updated.updated_at = now_ms();
                let serialized = serialize_thought(&updated);
                self.write_atomic(&path, &serialized)?;
                inner.insert(updated.id.clone(), (updated, path));
            }
        }
        Ok(())
    }

    /// Absolute path to the `~/.myagents/thoughts/` root. Used by
    /// `cmd_thought_open_dir` to reveal the directory in Finder/Explorer
    /// without exposing the raw path to the renderer layer.
    pub fn root_dir(&self) -> &PathBuf {
        &self.root
    }

    /// Merge multiple thoughts into a brand-new thought, then delete the
    /// originals. The merged thought is created fresh (new id, new
    /// `created_at`) so the result is a clean replacement rather than an
    /// in-place mutation of any source — see PRD 0.2.4 §需求 2.
    ///
    /// Composition rules (locked at PRD design time):
    /// * `content` = `sources` joined by `\n—\n` (Em Dash, U+2014). Order
    ///   follows the input vec; the renderer sends ids in the on-screen
    ///   list order so a top-down read of the merged note matches what the
    ///   user saw in the panel.
    /// * `tags` = union of source `tags`, dedup preserving first-seen order
    ///   across sources.
    /// * `images` = concatenation of source `images`, dedup preserving
    ///   first-seen order.
    /// * `converted_task_ids` = union, dedup preserving first-seen order.
    ///
    /// **Atomicity strategy** (revised in v0.2.4 after cross-review):
    /// 1. **Pre-flight**: verify every source still exists in memory AND on
    ///    disk before any write. Fails fast with a single error.
    /// 2. **Create**: write the merged thought atomically (tmp + rename).
    ///    If this fails, no source is touched — caller sees a clean error.
    /// 3. **Best-effort source delete**: iterate sources; collect per-id
    ///    failures. We **do not roll back the merged thought** on partial
    ///    delete failure because that would lose data: any source whose
    ///    delete already succeeded is gone, and rolling back the merge
    ///    would leave the user with neither the merge nor that source's
    ///    content. Instead, we surface the partial-failure list so the
    ///    UI can prompt the user to re-try cleanup.
    pub async fn merge(&self, source_ids: Vec<String>) -> Result<MergeResult, String> {
        if source_ids.len() < 2 {
            return Err("merge requires at least 2 source thoughts".to_string());
        }

        // ── 1. Snapshot + pre-flight ─────────────────────────────────────
        // Hold a single read lock to atomically:
        //   - confirm every source id is registered
        //   - probe filesystem reachability (fs::metadata)
        // If anything fails here, NO disk mutation has happened yet.
        let snapshots: Vec<Thought> = {
            let inner = self.inner.read().await;
            let mut out: Vec<Thought> = Vec::with_capacity(source_ids.len());
            for id in &source_ids {
                let (t, path) = inner
                    .get(id)
                    .ok_or_else(|| format!("Thought not found: {}", id))?;
                if let Err(e) = fs::metadata(path) {
                    return Err(format!(
                        "source {} unreachable on disk, refusing to merge: {}",
                        id, e
                    ));
                }
                out.push(t.clone());
            }
            out
        };

        // ── 2. Compose merged thought ────────────────────────────────────
        let separator = "\n—\n";
        let merged_content: String = snapshots
            .iter()
            .map(|t| t.content.as_str())
            .collect::<Vec<_>>()
            .join(separator);
        let merged_tags = dedup_preserving_order(snapshots.iter().flat_map(|t| t.tags.clone()));
        let merged_images =
            dedup_preserving_order(snapshots.iter().flat_map(|t| t.images.clone()));
        let merged_converted = dedup_preserving_order(
            snapshots.iter().flat_map(|t| t.converted_task_ids.clone()),
        );

        // Build directly so we can override `tags` — `Thought::new` would
        // re-parse `merged_content` for `#xxx` tags, but we want the union
        // of source frontmatter tags (some may live only in frontmatter).
        let now = now_ms();
        let new_thought = Thought {
            id: Uuid::new_v4().to_string(),
            content: merged_content,
            tags: merged_tags,
            images: merged_images,
            created_at: now,
            updated_at: now,
            converted_task_ids: merged_converted,
            // Merge always produces a fresh, active note — archived state
            // is intentionally not propagated (see PRD §2.2 decision 2).
            archived: false,
        };
        let new_path = self.file_path_for(&new_thought);
        let serialized = serialize_thought(&new_thought);

        // ── 3. Atomic create ─────────────────────────────────────────────
        // tmp + rename; on failure, nothing has been touched on disk.
        self.write_atomic(&new_path, &serialized)?;
        {
            let mut inner = self.inner.write().await;
            inner.insert(new_thought.id.clone(), (new_thought.clone(), new_path.clone()));
        }

        // ── 4. Best-effort source delete ─────────────────────────────────
        // Run each delete; collect failures. Continue past failures so a
        // permission flip on one file doesn't strand the others as orphans.
        let mut failed_source_deletes: Vec<MergeSourceDeleteFailure> = Vec::new();
        for id in &source_ids {
            if let Err(e) = self.delete(id).await {
                ulog_warn!(
                    "[thought] merge: source {} delete failed (merged={} kept): {}",
                    id, new_thought.id, e
                );
                failed_source_deletes.push(MergeSourceDeleteFailure {
                    id: id.clone(),
                    error: e,
                });
            }
        }

        if failed_source_deletes.is_empty() {
            ulog_info!(
                "[thought] merged sources={:?} into new={}",
                source_ids, new_thought.id
            );
        } else {
            ulog_warn!(
                "[thought] merged into {} but {}/{} source deletes failed; UI should prompt user",
                new_thought.id,
                failed_source_deletes.len(),
                source_ids.len(),
            );
        }

        Ok(MergeResult {
            merged: new_thought,
            failed_source_deletes,
        })
    }

    pub async fn delete(&self, id: &str) -> Result<(), String> {
        let mut inner = self.inner.write().await;
        // Peek without removing — we want disk-first so a failed unlink doesn't
        // cause the in-memory copy to diverge from a thought that's still on disk
        // (which would then resurrect on next restart via scan_disk).
        let Some((_, path)) = inner.get(id).cloned() else {
            return Ok(()); // idempotent
        };
        if path.exists() {
            if let Err(e) = fs::remove_file(&path) {
                return Err(format!(
                    "Failed to delete thought file {}: {}",
                    path.display(),
                    e
                ));
            }
        }
        inner.remove(id);
        ulog_info!("[thought] deleted id={}", id);
        Ok(())
    }
}

// ================ Helpers ================

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// Collect into a Vec keeping first occurrence of each item, dropping
/// later duplicates. Used by `ThoughtStore::merge` to fuse `tags` /
/// `images` / `converted_task_ids` without changing the user's intent
/// about ordering (which sees the first source's items first).
fn dedup_preserving_order<I, T>(iter: I) -> Vec<T>
where
    I: IntoIterator<Item = T>,
    T: Eq + std::hash::Hash + Clone,
{
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for item in iter {
        if seen.insert(item.clone()) {
            out.push(item);
        }
    }
    out
}

/// Parse inline `#xxx` tags. A tag starts at `#` that is either at the beginning
/// of the string or preceded by a "separator" char (whitespace / ASCII opener /
/// CJK punctuation). The tag body accepts ASCII letters/digits/underscore/dash
/// plus CJK ideographs and Hiragana/Katakana. Preserves original case.
/// De-duplicates preserving first-occurrence order.
pub fn parse_tags(content: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Walk char by char. Track the previous char so `prev_ok` can compare against
    // multi-byte codepoints like `。` (U+3002) and `，` (U+FF0C) — the earlier
    // byte-level check was dead code for CJK punctuation (cross-review found this).
    let chars: Vec<(usize, char)> = content.char_indices().collect();
    let mut idx = 0usize;
    while idx < chars.len() {
        let (byte_pos, ch) = chars[idx];
        if ch == '#' {
            let prev_ok = idx == 0 || is_tag_boundary_char(chars[idx - 1].1);
            if !prev_ok {
                idx += 1;
                continue;
            }
            // Scan tag body chars starting at idx+1.
            let mut j = idx + 1;
            while j < chars.len() && is_tag_char(chars[j].1) {
                j += 1;
            }
            if j > idx + 1 {
                let start = byte_pos + ch.len_utf8(); // byte offset of first tag body char
                let end = if j < chars.len() {
                    chars[j].0
                } else {
                    content.len()
                };
                let tag = content[start..end].to_string();
                if !seen.contains(&tag) {
                    seen.insert(tag.clone());
                    out.push(tag);
                }
                idx = j;
                continue;
            }
        }
        idx += 1;
    }
    out
}

/// Chars that legally precede a `#` and allow the next run to be treated as a tag.
fn is_tag_boundary_char(c: char) -> bool {
    c.is_whitespace()
        || matches!(
            c,
            '(' | '[' | '{' | ',' | '，' | '。' | '、' | '：' | ':' | ';' | '；' | '（' | '【'
        )
}

fn is_tag_char(c: char) -> bool {
    c.is_ascii_alphanumeric()
        || c == '_'
        || c == '-'
        // CJK unified ideographs
        || ('\u{4E00}'..='\u{9FFF}').contains(&c)
        // CJK extension A
        || ('\u{3400}'..='\u{4DBF}').contains(&c)
        // Hiragana / Katakana — tolerate Japanese tags too
        || ('\u{3040}'..='\u{30FF}').contains(&c)
}

fn serialize_thought(t: &Thought) -> String {
    // Hand-rolled tiny YAML. We control the schema so we don't need a full YAML lib.
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("id: {}\n", t.id));
    out.push_str(&format!("createdAt: {}\n", t.created_at));
    out.push_str(&format!("updatedAt: {}\n", t.updated_at));
    out.push_str(&format!("tags: {}\n", encode_string_list(&t.tags)));
    out.push_str(&format!("images: {}\n", encode_string_list(&t.images)));
    out.push_str(&format!(
        "convertedTaskIds: {}\n",
        encode_string_list(&t.converted_task_ids)
    ));
    // `archived: false` is the implicit default — omit it so existing
    // frontmatter doesn't grow a useless field for every thought ever
    // written. Only emit when the flag is actually set.
    if t.archived {
        out.push_str("archived: true\n");
    }
    out.push_str("---\n\n");
    out.push_str(&t.content);
    if !t.content.ends_with('\n') {
        out.push('\n');
    }
    out
}

fn encode_string_list(items: &[String]) -> String {
    // JSON-array subset is valid YAML flow sequence. We round-trip via serde_json to
    // get proper escaping for commas / quotes / unicode.
    serde_json::to_string(items).unwrap_or_else(|_| "[]".to_string())
}

fn parse_thought_file(raw: &str) -> Result<Thought, String> {
    // Split frontmatter
    let (fm, body) = extract_frontmatter(raw)
        .ok_or_else(|| "missing frontmatter".to_string())?;

    let mut id: Option<String> = None;
    let mut created_at: Option<i64> = None;
    let mut updated_at: Option<i64> = None;
    let mut tags: Vec<String> = Vec::new();
    let mut images: Vec<String> = Vec::new();
    let mut converted_task_ids: Vec<String> = Vec::new();
    let mut archived = false;

    for line in fm.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some((k, v)) = line.split_once(':') else { continue };
        let key = k.trim();
        let value = v.trim();
        match key {
            "id" => id = Some(value.to_string()),
            "createdAt" => created_at = value.parse::<i64>().ok(),
            "updatedAt" => updated_at = value.parse::<i64>().ok(),
            "tags" => tags = decode_string_list(value).unwrap_or_default(),
            "images" => images = decode_string_list(value).unwrap_or_default(),
            "convertedTaskIds" => {
                converted_task_ids = decode_string_list(value).unwrap_or_default()
            }
            "archived" => archived = value == "true",
            _ => {}
        }
    }

    let id = id.ok_or("missing id")?;
    let created_at = created_at.ok_or("missing createdAt")?;
    let updated_at = updated_at.unwrap_or(created_at);

    // Body starts with the blank line that conventionally separates frontmatter
    // from content. Strip leading newlines (not arbitrary whitespace — indentation
    // may be semantic in Markdown).
    let content = body
        .trim_start_matches(['\n', '\r'])
        .trim_end()
        .to_string();

    Ok(Thought {
        id,
        content,
        tags,
        images,
        created_at,
        updated_at,
        converted_task_ids,
        archived,
    })
}

fn extract_frontmatter(raw: &str) -> Option<(&str, &str)> {
    let rest = raw.strip_prefix("---\n").or_else(|| raw.strip_prefix("---\r\n"))?;
    // Find closing "---" on its own line.
    for end_marker in ["\n---\n", "\n---\r\n"] {
        if let Some(pos) = rest.find(end_marker) {
            let fm = &rest[..pos];
            let body = &rest[pos + end_marker.len()..];
            return Some((fm, body));
        }
    }
    None
}

fn decode_string_list(raw: &str) -> Result<Vec<String>, String> {
    // Accepts either JSON array `["a","b"]` or unquoted YAML flow `[a, b]`.
    let trimmed = raw.trim();
    if let Ok(v) = serde_json::from_str::<Vec<String>>(trimmed) {
        return Ok(v);
    }
    if let Some(inner) = trimmed.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
        let items: Vec<String> = inner
            .split(',')
            .map(|s| s.trim().trim_matches('"').to_string())
            .filter(|s| !s.is_empty())
            .collect();
        return Ok(items);
    }
    Ok(Vec::new())
}

// ================ Static access for Management API ================

static THOUGHT_STORE: std::sync::OnceLock<Arc<ThoughtStore>> = std::sync::OnceLock::new();

pub fn set_thought_store(store: Arc<ThoughtStore>) {
    let _ = THOUGHT_STORE.set(store);
}

pub fn get_thought_store() -> Option<&'static Arc<ThoughtStore>> {
    THOUGHT_STORE.get()
}

// ================ Tauri commands ================

pub type ManagedThoughtStore = Arc<ThoughtStore>;

#[tauri::command]
pub async fn cmd_thought_create(
    state: tauri::State<'_, ManagedThoughtStore>,
    input: ThoughtCreateInput,
) -> Result<Thought, String> {
    state.create(input).await
}

#[tauri::command]
pub async fn cmd_thought_list(
    state: tauri::State<'_, ManagedThoughtStore>,
    filter: Option<ThoughtListFilter>,
) -> Result<Vec<Thought>, String> {
    Ok(state.list(filter.unwrap_or_default()).await)
}

#[tauri::command]
pub async fn cmd_thought_get(
    state: tauri::State<'_, ManagedThoughtStore>,
    id: String,
) -> Result<Option<Thought>, String> {
    Ok(state.get(&id).await)
}

#[tauri::command]
pub async fn cmd_thought_update(
    state: tauri::State<'_, ManagedThoughtStore>,
    input: ThoughtUpdateInput,
) -> Result<Thought, String> {
    state.update(input).await
}

#[tauri::command]
pub async fn cmd_thought_delete(
    state: tauri::State<'_, ManagedThoughtStore>,
    id: String,
) -> Result<(), String> {
    state.delete(&id).await
}

/// Toggle a thought's archive flag. Idempotent — re-archiving an
/// already-archived thought is a no-op. v0.2.16 PRD.
#[tauri::command]
pub async fn cmd_thought_set_archived(
    state: tauri::State<'_, ManagedThoughtStore>,
    id: String,
    archived: bool,
) -> Result<Thought, String> {
    state.set_archived(&id, archived).await
}

/// Merge `sourceIds` into a single new thought, then delete the sources.
/// See `ThoughtStore::merge` for composition semantics. The renderer
/// passes ids in on-screen list order (top → bottom).
#[tauri::command]
pub async fn cmd_thought_merge(
    state: tauri::State<'_, ManagedThoughtStore>,
    source_ids: Vec<String>,
) -> Result<MergeResult, String> {
    state.merge(source_ids).await
}

/// Reveal `~/.myagents/thoughts/` in the OS file manager so users can
/// inspect / back-up the raw `.md` files. The path is sourced from the
/// managed `ThoughtStore`, so the renderer can't coerce us into opening
/// an arbitrary directory. Creates the dir on demand — a fresh install
/// has no thoughts root until the first create.
#[tauri::command]
pub async fn cmd_thought_open_dir(
    state: tauri::State<'_, ManagedThoughtStore>,
) -> Result<(), String> {
    let dir = state.root_dir().clone();
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir thought dir: {}", e))?;
    let path = dir.to_string_lossy().to_string();

    // OS openers via process_cmd::new — see task.rs:cmd_task_open_docs_dir
    // for rationale (CREATE_NO_WINDOW is a no-op for these GUI binaries,
    // so wrapping is consistent without behavior change).
    #[cfg(target_os = "macos")]
    {
        crate::process_cmd::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("open finder: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        crate::process_cmd::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("open explorer: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        crate::process_cmd::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("xdg-open: {}", e))?;
    }
    Ok(())
}

// ================ Tests ================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn parse_tags_ascii() {
        let tags = parse_tags("hello #foo world #bar #foo");
        assert_eq!(tags, vec!["foo".to_string(), "bar".to_string()]);
    }

    #[test]
    fn parse_tags_cjk() {
        let tags = parse_tags("升级 #MyAgents #维护 适配器");
        assert_eq!(tags, vec!["MyAgents".to_string(), "维护".to_string()]);
    }

    #[test]
    fn parse_tags_after_cjk_punctuation() {
        // Regression: earlier byte-level check compared against multi-byte
        // punctuation codepoints and never matched. Tags after `。` / `，` /
        // `：` / `、` must now be recognized.
        assert_eq!(parse_tags("你好。#话题"), vec!["话题".to_string()]);
        assert_eq!(parse_tags("你好，#话题"), vec!["话题".to_string()]);
        assert_eq!(parse_tags("标签：#重要"), vec!["重要".to_string()]);
        assert_eq!(
            parse_tags("列表、#甲、#乙"),
            vec!["甲".to_string(), "乙".to_string()]
        );
    }

    #[test]
    fn parse_tags_ignores_mid_word_hashes() {
        // `a#b` should not produce a tag `b`
        let tags = parse_tags("url?x=a#b");
        assert!(tags.is_empty());
    }

    #[test]
    fn parse_tags_empty() {
        assert!(parse_tags("just text").is_empty());
        assert!(parse_tags("").is_empty());
        assert!(parse_tags("# ").is_empty()); // bare hash
    }

    #[test]
    fn frontmatter_roundtrip() {
        let t = Thought {
            id: "abc-123".to_string(),
            content: "hi #world".to_string(),
            tags: vec!["world".to_string()],
            images: vec![],
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
            converted_task_ids: vec![],
            archived: false,
        };
        let s = serialize_thought(&t);
        let parsed = parse_thought_file(&s).unwrap();
        assert_eq!(parsed.id, t.id);
        assert_eq!(parsed.content, t.content);
        assert_eq!(parsed.tags, t.tags);
        assert_eq!(parsed.created_at, t.created_at);
    }

    #[tokio::test]
    async fn crud_cycle() {
        let dir = tempdir().unwrap();
        let store = ThoughtStore::new(dir.path().to_path_buf());

        let created = store.create(ThoughtCreateInput {
            content: "note with #tag1 and #tag2".to_string(),
            images: vec![],
        }).await.unwrap();
        assert_eq!(created.tags, vec!["tag1".to_string(), "tag2".to_string()]);

        let listed = store.list(ThoughtListFilter::default()).await;
        assert_eq!(listed.len(), 1);

        let updated = store.update(ThoughtUpdateInput {
            id: created.id.clone(),
            content: Some("now has #tag3".to_string()),
            images: None,
            converted_task_ids: None,
        }).await.unwrap();
        assert_eq!(updated.tags, vec!["tag3".to_string()]);

        let filtered = store.list(ThoughtListFilter {
            tag: Some("tag3".to_string()),
            ..Default::default()
        }).await;
        assert_eq!(filtered.len(), 1);

        store.link_task(&created.id, "task-1").await.unwrap();
        let linked = store.get(&created.id).await.unwrap();
        assert_eq!(linked.converted_task_ids, vec!["task-1".to_string()]);
        // Idempotent
        store.link_task(&created.id, "task-1").await.unwrap();
        let still_linked = store.get(&created.id).await.unwrap();
        assert_eq!(still_linked.converted_task_ids, vec!["task-1".to_string()]);

        store.unlink_task(&created.id, "task-1").await.unwrap();
        let unlinked = store.get(&created.id).await.unwrap();
        assert!(unlinked.converted_task_ids.is_empty());

        store.delete(&created.id).await.unwrap();
        assert!(store.get(&created.id).await.is_none());
    }

    #[tokio::test]
    async fn list_filter_limit_and_sort() {
        let dir = tempdir().unwrap();
        let store = ThoughtStore::new(dir.path().to_path_buf());

        for i in 0..5 {
            store.create(ThoughtCreateInput {
                content: format!("note {}", i),
                images: vec![],
            }).await.unwrap();
            // Ensure updated_at differs
            tokio::time::sleep(tokio::time::Duration::from_millis(2)).await;
        }

        let all = store.list(ThoughtListFilter::default()).await;
        assert_eq!(all.len(), 5);
        // Descending by updated_at → last created first
        assert!(all[0].updated_at >= all[4].updated_at);

        let limited = store.list(ThoughtListFilter {
            limit: Some(2),
            ..Default::default()
        }).await;
        assert_eq!(limited.len(), 2);
    }

    #[tokio::test]
    async fn reload_from_disk_preserves_data() {
        let dir = tempdir().unwrap();
        {
            let store = ThoughtStore::new(dir.path().to_path_buf());
            store.create(ThoughtCreateInput {
                content: "persistent #save".to_string(),
                images: vec![],
            }).await.unwrap();
        }
        // New store reads from disk
        let store2 = ThoughtStore::new(dir.path().to_path_buf());
        let listed = store2.list(ThoughtListFilter::default()).await;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].content, "persistent #save");
        assert_eq!(listed[0].tags, vec!["save".to_string()]);
    }

    #[tokio::test]
    async fn merge_creates_new_thought_and_drops_sources() {
        let dir = tempdir().unwrap();
        let store = ThoughtStore::new(dir.path().to_path_buf());

        let a = store.create(ThoughtCreateInput {
            content: "first body #alpha".to_string(),
            images: vec!["a.png".to_string()],
        }).await.unwrap();
        // Tiny sleep so updated_at differs deterministically
        tokio::time::sleep(tokio::time::Duration::from_millis(2)).await;
        let b = store.create(ThoughtCreateInput {
            content: "second body #beta".to_string(),
            images: vec!["b.png".to_string(), "a.png".to_string()],
        }).await.unwrap();
        tokio::time::sleep(tokio::time::Duration::from_millis(2)).await;
        let c = store.create(ThoughtCreateInput {
            content: "third body #alpha #gamma".to_string(),
            images: vec![],
        }).await.unwrap();
        store.link_task(&a.id, "task-1").await.unwrap();
        store.link_task(&b.id, "task-2").await.unwrap();
        store.link_task(&c.id, "task-1").await.unwrap();

        let result = store
            .merge(vec![a.id.clone(), b.id.clone(), c.id.clone()])
            .await
            .unwrap();
        assert!(result.failed_source_deletes.is_empty());
        let merged = result.merged;

        // Combined body uses Em-dash separator joining sources in input order.
        assert_eq!(
            merged.content,
            "first body #alpha\n—\nsecond body #beta\n—\nthird body #alpha #gamma"
        );
        // Tags from frontmatter unioned, dedup preserving first-seen order.
        assert_eq!(merged.tags, vec!["alpha", "beta", "gamma"]);
        // Images dedup'd, preserving first-seen order.
        assert_eq!(merged.images, vec!["a.png", "b.png"]);
        // Converted task ids unioned and dedup'd.
        assert_eq!(merged.converted_task_ids, vec!["task-1", "task-2"]);
        // Source thoughts deleted.
        assert!(store.get(&a.id).await.is_none());
        assert!(store.get(&b.id).await.is_none());
        assert!(store.get(&c.id).await.is_none());
        // Merged is the only thought left.
        let listed = store.list(ThoughtListFilter::default()).await;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, merged.id);
    }

    #[tokio::test]
    async fn merge_rejects_lt_two_sources() {
        let dir = tempdir().unwrap();
        let store = ThoughtStore::new(dir.path().to_path_buf());
        let a = store.create(ThoughtCreateInput {
            content: "alone".to_string(),
            images: vec![],
        }).await.unwrap();
        let err = store.merge(vec![a.id.clone()]).await.unwrap_err();
        assert!(err.contains("at least 2"));
        // Source untouched.
        assert!(store.get(&a.id).await.is_some());
    }

    #[tokio::test]
    async fn archive_round_trip_persists_in_frontmatter() {
        let dir = tempdir().unwrap();
        let id;
        {
            let store = ThoughtStore::new(dir.path().to_path_buf());
            let t = store
                .create(ThoughtCreateInput {
                    content: "to be archived".to_string(),
                    images: vec![],
                })
                .await
                .unwrap();
            id = t.id.clone();
            assert!(!t.archived);
            let archived = store.set_archived(&id, true).await.unwrap();
            assert!(archived.archived);
            // Idempotent re-archive — no failure.
            let again = store.set_archived(&id, true).await.unwrap();
            assert!(again.archived);
        }
        // Re-open the store; archived flag survives disk round-trip.
        let store2 = ThoughtStore::new(dir.path().to_path_buf());
        let reloaded = store2.get(&id).await.unwrap();
        assert!(reloaded.archived, "archived flag lost across reload");
        // Unarchive flips it back.
        let unarchived = store2.set_archived(&id, false).await.unwrap();
        assert!(!unarchived.archived);
    }

    #[tokio::test]
    async fn list_filter_archive_partitions() {
        let dir = tempdir().unwrap();
        let store = ThoughtStore::new(dir.path().to_path_buf());
        let a = store
            .create(ThoughtCreateInput {
                content: "alpha".to_string(),
                images: vec![],
            })
            .await
            .unwrap();
        let b = store
            .create(ThoughtCreateInput {
                content: "beta".to_string(),
                images: vec![],
            })
            .await
            .unwrap();
        store.set_archived(&b.id, true).await.unwrap();

        // Default (None) hides archived
        let default_list = store.list(ThoughtListFilter::default()).await;
        assert_eq!(default_list.len(), 1);
        assert_eq!(default_list[0].id, a.id);

        // Explicit Active mirrors default
        let active = store
            .list(ThoughtListFilter {
                archived: Some(ThoughtArchiveFilter::Active),
                ..Default::default()
            })
            .await;
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, a.id);

        // Archived returns only b
        let archived = store
            .list(ThoughtListFilter {
                archived: Some(ThoughtArchiveFilter::Archived),
                ..Default::default()
            })
            .await;
        assert_eq!(archived.len(), 1);
        assert_eq!(archived[0].id, b.id);

        // All returns both
        let all = store
            .list(ThoughtListFilter {
                archived: Some(ThoughtArchiveFilter::All),
                ..Default::default()
            })
            .await;
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn serialize_omits_archived_when_false() {
        // Backward-compat guarantee: existing .md files never grow an
        // `archived: false` line just because the binary was updated.
        let t = Thought {
            id: "x".to_string(),
            content: "body".to_string(),
            tags: vec![],
            images: vec![],
            created_at: 1,
            updated_at: 1,
            converted_task_ids: vec![],
            archived: false,
        };
        let s = serialize_thought(&t);
        assert!(!s.contains("archived"), "should omit archived when false: {s}");

        let t2 = Thought { archived: true, ..t };
        let s2 = serialize_thought(&t2);
        assert!(s2.contains("archived: true"));
    }

    #[test]
    fn parse_thought_file_without_archived_defaults_to_false() {
        // Backward-compat: a frontmatter from before this PR (no `archived`
        // line) must round-trip with archived = false.
        let raw = "---\nid: legacy-1\ncreatedAt: 1700000000000\nupdatedAt: 1700000000000\ntags: []\nimages: []\nconvertedTaskIds: []\n---\n\nlegacy body\n";
        let t = parse_thought_file(raw).unwrap();
        assert!(!t.archived);
    }

    #[tokio::test]
    async fn merge_pre_flight_rejects_disk_unreachable() {
        // If a source's underlying file vanishes between the in-memory
        // index population and merge invocation, pre-flight should fail
        // BEFORE writing the merged thought — caller sees a clean error
        // and the surviving source is untouched.
        let dir = tempdir().unwrap();
        let store = ThoughtStore::new(dir.path().to_path_buf());
        let a = store.create(ThoughtCreateInput {
            content: "alpha".to_string(),
            images: vec![],
        }).await.unwrap();
        let b = store.create(ThoughtCreateInput {
            content: "beta".to_string(),
            images: vec![],
        }).await.unwrap();

        // Simulate disk vanish for `a` — physically remove the file but
        // leave the in-memory index entry pointing at the now-gone path.
        let a_path = store.file_path_for(&a);
        std::fs::remove_file(&a_path).unwrap();

        let err = store.merge(vec![a.id.clone(), b.id.clone()]).await.unwrap_err();
        assert!(err.contains("unreachable on disk"));
        // No merged thought should have been created on disk.
        let listed = store.list(ThoughtListFilter::default()).await;
        // Both originals still in the in-memory index (b on disk, a's
        // file is gone but the index still has its entry — that's fine,
        // the next reload will reconcile).
        assert_eq!(listed.len(), 2);
        // b is intact on disk.
        let b_path = store.file_path_for(&b);
        assert!(b_path.exists());
    }
}
