use super::*;

/// Stop all sidecar instances and clean up child processes
/// This should be called when the app is closing
pub fn stop_all_sidecars(manager: &ManagedSidecarManager) -> Result<(), String> {
    ulog_info!("[sidecar] Stopping all sidecars and cleaning up child processes...");

    // 1. Stop all managed sidecar instances (kills bun sidecars via Drop)
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
    manager_guard.stop_all();
    drop(manager_guard);

    // 2. Clean up any orphaned child processes (SDK and MCP)
    // This is necessary because SDK spawns child processes that don't die
    // when the parent bun sidecar is killed
    cleanup_child_processes();

    Ok(())
}

/// Shutdown for update — block until all child processes are fully terminated.
/// Unlike stop_all_sidecars (which is non-blocking), this function waits for
/// all bun/SDK/MCP processes to exit, preventing NSIS installer file-lock errors on Windows.
pub fn shutdown_for_update(manager: &ManagedSidecarManager) -> Result<(), String> {
    ulog_info!("[sidecar] Shutdown for update: stopping all processes...");

    // 1. Stop all sidecar instances (via Drop → kill_process → taskkill /T /F)
    stop_all_sidecars(manager)?;

    // 2. Actively kill orphan processes that may survive sidecar tree-kill
    //    (e.g., node.exe from bundled npx — cmd.exe intermediate layers break process tree)
    #[cfg(windows)]
    {
        cleanup_child_processes();
    }

    // 3. Wait for all related processes to truly exit. Uses the same
    //    sysinfo-backed process scan as startup cleanup — no PowerShell
    //    subprocesses, no cmd-line-escaping edge cases, consistent
    //    behavior across Windows and Unix.
    let max_wait = Duration::from_secs(5);
    let start = std::time::Instant::now();
    loop {
        // Update path MUST verify our own sidecars (SIDECAR_MARKER) too —
        // NSIS can't overwrite `bun.exe` while it's in use, so we need
        // confirmation that every MyAgents-related process is gone. Uses
        // STARTUP patterns (superset that includes the sidecar marker).
        if !crate::process_cleanup::has_matching_processes(STARTUP_CLEANUP_PATTERNS) {
            ulog_info!(
                "[sidecar] All processes terminated in {:?}",
                start.elapsed()
            );
            break;
        }

        if start.elapsed() > max_wait {
            ulog_warn!("[sidecar] Update shutdown timeout, force killing remaining...");
            let report = crate::process_cleanup::kill_stale_processes(STARTUP_CLEANUP_PATTERNS);
            ulog_info!(
                "[sidecar] Force-kill final pass: killed {}, residual {} ({:?})",
                report.killed,
                report.residual,
                report.elapsed
            );
            break;
        }

        thread::sleep(Duration::from_millis(100));
    }

    ulog_info!("[sidecar] Shutdown for update complete");
    Ok(())
}

/// Clean up SDK and MCP child processes at app shutdown.
///
/// On Windows, SDK-spawned node/bun processes often survive a direct
/// parent kill because `cmd.exe` intermediates (npx.cmd / bun.exe wrapper)
/// break the process-tree linkage that `taskkill /T /F` relies on. This
/// shutdown cleanup walks descendants by PPID via sysinfo and kills
/// them all — orphans included — in one pass.
///
/// Uses [`CHILD_CLEANUP_PATTERNS`] (no `SIDECAR_MARKER`) because our own
/// sidecars are already killed through their `Child` handles in
/// [`stop_all_sidecars`]. Sweeping by marker here would risk killing a
/// concurrent MyAgents instance's sidecars during any overlap window.
fn cleanup_child_processes() {
    let report = crate::process_cleanup::kill_stale_processes(CHILD_CLEANUP_PATTERNS);
    if report.total_targets() == 0 {
        ulog_info!(
            "[sidecar] Shutdown cleanup: nothing to kill ({:?})",
            report.elapsed
        );
    } else {
        ulog_info!(
            "[sidecar] Shutdown cleanup: killed {} (roots={}, descendants={}, residual={}) in {:?}",
            report.killed,
            report.matched_roots,
            report.descendants,
            report.residual,
            report.elapsed
        );
    }
}
