use super::*;

// ============ Cron Run Records (execution history) ============

const MAX_RUN_RECORDS: usize = 500;

/// Sentinel prefix used by `execute_task_directly` to flag an `Err` that is
/// NOT an execution failure but a deliberate "linked Task is in terminal
/// state, we've already called `stop_task`" short-circuit (v0.1.69 H2
/// cross-review follow-up).
///
/// The outer scheduler loop detects this prefix and skips:
///   1. writing a failure record to `cron_runs/<id>.jsonl`
///   2. setting `task.last_error`
///   3. emitting `cron:execution-error`
/// — without it, the graceful terminal-state stop would still surface to the
/// UI as a failed tick, giving the user a misleading "最近一次失败" badge
/// seconds before the task's real status flips to Stopped.
pub(super) const TERMINAL_STOP_SENTINEL: &str = "__TERMINAL_STOP__:";

/// A single execution record for a cron task
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronRunRecord {
    pub ts: i64,                 // Unix timestamp (ms)
    pub ok: bool,                // Whether execution succeeded
    pub duration_ms: u64,        // Execution duration
    pub content: Option<String>, // AI output text (delivery content)
    pub error: Option<String>,   // Error message on failure
}

/// PRD 0.2.5 R4 — return shape for `trigger_now()`. Echoed back to the
/// caller (CLI / HTTP) so they can display "what got fired, where to look".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerNowInfo {
    pub task_id: String,
    pub session_id: String,
    pub dispatched_at: String,
}

/// Sanitize task_id to prevent path traversal (remove path separators and dots sequences)
fn sanitize_task_id(task_id: &str) -> String {
    task_id.replace(['/', '\\', '\0'], "").replace("..", "")
}

/// Get the JSONL file path for a task's run records
pub(super) fn run_record_path(task_id: &str) -> PathBuf {
    let safe_id = sanitize_task_id(task_id);
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".myagents")
        .join("cron_runs")
        .join(format!("{}.jsonl", safe_id))
}

/// Append a run record to ~/.myagents/cron_runs/<taskId>.jsonl
/// Truncates to MAX_RUN_RECORDS if exceeded.
pub fn record_cron_run(task_id: &str, record: &CronRunRecord) -> Result<(), String> {
    let path = run_record_path(task_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create cron_runs dir: {}", e))?;
    }

    let line = serde_json::to_string(record)
        .map_err(|e| format!("Failed to serialize run record: {}", e))?
        + "\n";

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open run record file: {}", e))?;

    file.write_all(line.as_bytes())
        .map_err(|e| format!("Failed to write run record: {}", e))?;

    // Truncate if over limit
    truncate_run_file_if_needed(&path, MAX_RUN_RECORDS);
    Ok(())
}

/// Read the most recent `limit` run records (returned in chronological order)
pub fn read_cron_runs(task_id: &str, limit: usize) -> Vec<CronRunRecord> {
    let path = run_record_path(task_id);
    if !path.exists() {
        return vec![];
    }

    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    let capped = limit.min(100);
    let records: Vec<CronRunRecord> = content
        .lines()
        .rev()
        .take(capped)
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    // Reverse back to chronological order
    records.into_iter().rev().collect()
}

/// Truncate a JSONL file to keep only the last `max` lines
fn truncate_run_file_if_needed(path: &PathBuf, max: usize) {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return,
    };

    let lines: Vec<&str> = content.lines().collect();
    if lines.len() <= max {
        return;
    }

    // Keep only the last `max` lines
    let kept: Vec<&str> = lines[lines.len() - max..].to_vec();
    let new_content = kept.join("\n") + "\n";
    let _ = fs::write(path, new_content);
}

/// Event payload for cron task execution trigger
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTaskTriggerPayload {
    pub task_id: String,
    pub prompt: String,
    pub is_first_execution: bool,
    pub ai_can_exit: bool,
    pub workspace_path: String,
    pub session_id: String,
    pub run_mode: RunMode,
    pub notify_enabled: bool,
    pub tab_id: Option<String>,
}

// ============ Recovery Event Types (方案 A: Rust 统一恢复) ============

/// Event payload for a single task recovery success
/// Emitted as "cron:task-recovered" for each successfully recovered task
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTaskRecoveredPayload {
    pub task_id: String,
    pub session_id: String,
    pub workspace_path: String,
    pub port: u16,
    pub status: String,
    pub execution_count: u32,
    pub interval_minutes: u32,
}

/// Event payload for task status changes
/// Emitted as "cron:task-status-changed" when task status changes
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTaskStatusChangedPayload {
    pub task_id: String,
    pub session_id: String,
    pub old_status: String,
    pub new_status: String,
    pub reason: Option<String>,
}

/// Event payload for recovery summary
/// Emitted as "cron:recovery-summary" after all recovery attempts complete
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronRecoverySummaryPayload {
    pub total_tasks: u32,
    pub recovered_count: u32,
    pub failed_count: u32,
    pub failed_tasks: Vec<CronRecoveryFailedTask>,
}

/// Info about a single failed recovery
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronRecoveryFailedTask {
    pub task_id: String,
    pub workspace_path: String,
    pub error: String,
}
