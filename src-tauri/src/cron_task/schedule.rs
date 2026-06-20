use super::*;

/// Wall-clock aware sleep that survives system suspend/hibernate.
///
/// Unlike `tokio::time::sleep(duration)` which uses monotonic time (pauses during
/// system sleep on macOS), this function polls `Utc::now()` (wall clock) every
/// POLL_INTERVAL seconds, correctly detecting that the scheduled time has passed
/// even after the system wakes from sleep.
///
/// Returns `true` if target time was reached, `false` if shutdown was requested.
pub(super) async fn sleep_until_wallclock(
    target: DateTime<Utc>,
    shutdown: &RwLock<bool>,
    task_id: &str,
) -> bool {
    const POLL_SECS: u64 = 30;
    loop {
        let now = Utc::now();
        if now >= target {
            return true;
        }
        // Check shutdown flag
        if *shutdown.read().await {
            ulog_info!(
                "[CronTask] Task {} wallclock sleep interrupted by shutdown",
                task_id
            );
            return false;
        }
        // Sleep for min(remaining, POLL_SECS) — short sleeps survive system suspend
        let remaining_secs = (target - now).num_seconds().max(0) as u64;
        let sleep_secs = remaining_secs.min(POLL_SECS).max(1);
        tokio::time::sleep(Duration::from_secs(sleep_secs)).await;
    }
}

/// Compute the next execution time for a cron task (enrichment helper).
/// Returns an RFC3339 string or None if the task is stopped / no schedule.
///
/// v0.1.69 cross-review: past-due values (cold start before first execution,
/// or catch-up after system sleep) used to be returned verbatim — e.g. an
/// `At` task whose target time has passed returned the stale timestamp, a
/// cold-started `Every` task returned `created_at + interval` even though
/// the scheduler actually fires `~2 s` after spawn. SummaryCard now prefers
/// this value over its own cron-parser, so stale timestamps would show
/// "下次触发 5 分钟前" — obviously wrong. Fix: clamp any past-due result
/// forward to match the scheduler's own "fire in 2s / 5s" fallback in
/// `start_task_scheduler`'s `initial_target` block, so the UI and the
/// scheduler agree.
pub(super) fn compute_next_execution(task: &CronTask) -> Option<String> {
    if task.status != TaskStatus::Running {
        return None;
    }

    // Mirror of scheduler's `initial_target` fallback (cron_task.rs ~912):
    // cold-start / first-execution with no better signal fires +2s; past-due
    // fires +5s. `clamp_forward` keeps `compute_next_execution` in lockstep
    // with those minimums so the UI never displays a moment in the past.
    fn clamp_forward(candidate: DateTime<Utc>, min_ahead_secs: i64) -> DateTime<Utc> {
        let min_target = Utc::now() + chrono::Duration::seconds(min_ahead_secs);
        if candidate > min_target {
            candidate
        } else {
            min_target
        }
    }

    match &task.schedule {
        Some(CronSchedule::At { at }) => {
            // One-shot. Past-due → scheduler fires in ~2s after spawn.
            match DateTime::parse_from_rfc3339(at)
                .or_else(|_| DateTime::parse_from_str(at, "%Y-%m-%dT%H:%M:%S"))
            {
                Ok(target) => Some(clamp_forward(target.with_timezone(&Utc), 2).to_rfc3339()),
                Err(_) => None,
            }
        }
        Some(CronSchedule::Every { minutes, start_at }) => {
            // Explicit `start_at` (future) wins for the first execution.
            if let Some(ref sa) = start_at {
                if let Ok(parsed) = DateTime::parse_from_rfc3339(sa) {
                    let target = parsed.with_timezone(&Utc);
                    if target > Utc::now() && task.execution_count == 0 {
                        return Some(target.to_rfc3339());
                    }
                }
            }
            // First ever run with no last_executed_at → scheduler fires +2s.
            if task.execution_count == 0 && task.last_executed_at.is_none() {
                return Some((Utc::now() + chrono::Duration::seconds(2)).to_rfc3339());
            }
            let base = task.last_executed_at.unwrap_or(task.created_at);
            let next = base + chrono::Duration::minutes(*minutes as i64);
            // Past-due (catch-up after sleep) → scheduler fires +5s.
            Some(clamp_forward(next, 5).to_rfc3339())
        }
        Some(CronSchedule::Cron { expr, tz }) => match next_cron_fire_time(expr, tz.as_deref()) {
            Ok(next) => Some(next.to_rfc3339()),
            Err(_) => None,
        },
        Some(CronSchedule::Loop) => {
            // Ralph Loop: no scheduled time, triggered by completion
            None
        }
        None => {
            // Legacy: use interval_minutes — same cold-start clamp as `Every`.
            if task.execution_count == 0 && task.last_executed_at.is_none() {
                return Some((Utc::now() + chrono::Duration::seconds(2)).to_rfc3339());
            }
            let base = task.last_executed_at.unwrap_or(task.created_at);
            let next = base + chrono::Duration::minutes(task.interval_minutes as i64);
            Some(clamp_forward(next, 5).to_rfc3339())
        }
    }
}

/// Enrich a CronTask with computed next_execution_at
pub(super) fn enrich_task(mut task: CronTask) -> CronTask {
    task.next_execution_at = compute_next_execution(&task);
    task
}

/// Public alias for `enrich_task` used by management_api projection paths
/// that don't go through the manager's accessor methods (e.g. echoing the
/// just-updated task back from `update_cron_handler`). Issue #115.
pub fn enrich_for_summary(task: CronTask) -> CronTask {
    enrich_task(task)
}
