use super::*;

/// Atomic file save helper - writes to temp file first, then renames
/// This prevents data corruption if the process crashes mid-write.
///
/// Pattern 5 (single-writer invariant): wraps the read-modify-write in
/// `with_file_lock` against a sibling `cron_tasks.json.lock` directory and
/// uses a unique tmp suffix (`.tmp.{pid}.{nanos}`) so two concurrent saves
/// don't race on the same temp path.
pub(super) async fn atomic_save_tasks(
    storage_path: &PathBuf,
    tasks: &Arc<RwLock<HashMap<String, CronTask>>>,
) -> Result<(), String> {
    // Read tasks under lock
    let tasks_snapshot = {
        let tasks_guard = tasks.read().await;
        tasks_guard.values().cloned().collect::<Vec<_>>()
    };
    // Lock released here

    atomic_save_task_snapshot(storage_path, tasks_snapshot).await
}

pub(super) async fn atomic_save_task_snapshot(
    storage_path: &PathBuf,
    tasks_snapshot: Vec<CronTask>,
) -> Result<(), String> {
    let store = CronTaskStore {
        tasks: tasks_snapshot,
    };
    let task_count = store.tasks.len();

    let content = serde_json::to_string_pretty(&store)
        .map_err(|e| format!("Failed to serialize cron tasks: {}", e))?;

    // Ensure directory exists
    if let Some(parent) = storage_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create cron tasks directory: {}", e))?;
    }

    let lock_path = storage_path.with_file_name("cron_tasks.json.lock");
    let storage_path_owned = storage_path.clone();

    crate::utils::file_lock::with_file_lock(
        &lock_path,
        crate::utils::file_lock::FileLockOptions::default(),
        move || {
            // Unique tmp suffix avoids two concurrent savers stepping on
            // each other's `cron_tasks.tmp` (the bug from Pattern 5 §5.1).
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let tmp_path = storage_path_owned.with_file_name(format!(
                "cron_tasks.json.tmp.{}.{}",
                std::process::id(),
                nanos
            ));

            std::fs::write(&tmp_path, &content).map_err(|e| {
                crate::utils::file_lock::FileLockError::Io(std::io::Error::new(
                    e.kind(),
                    format!("Failed to write cron tasks temp file: {}", e),
                ))
            })?;
            std::fs::rename(&tmp_path, &storage_path_owned).map_err(|e| {
                crate::utils::file_lock::FileLockError::Io(std::io::Error::new(
                    e.kind(),
                    format!("Failed to rename cron tasks file: {}", e),
                ))
            })?;
            Ok(())
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    ulog_debug!("[CronTask] Atomically saved {} tasks to disk", task_count);
    Ok(())
}
