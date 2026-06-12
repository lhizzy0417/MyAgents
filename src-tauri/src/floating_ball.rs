// Floating ball desktop companion (PRD 0.2.35, phase 1 · macOS).
//
// Two OS windows, both NSPanels via tauri-nspanel so they NEVER activate the
// app (the user's frontmost app keeps focus — D1/D2 of the PRD):
//
//   fb-ball       92×92 transparent panel, can_become_key_window = false.
//                 Pure visual + mouse target. Hover/click logic lives in the
//                 webview (src/renderer/floating-ball/BallWindow.tsx).
//   fb-companion  chat panel, can_become_key_window = true + nonactivating
//                 style mask: peek = order_front_regardless (no key, pure
//                 visual), pin = make_key_window (keyboard goes to the panel
//                 while the user's app stays frontmost). Hiding the panel
//                 hands keyboard focus straight back to the frontmost app
//                 because our app was never activated.
//
// Context probes (frontmost app / selection / screenshot) are Tauri commands
// (D9: OS-level work goes through Rust invoke, never sidecar HTTP). Selection
// capture is only called on explicit summon — never on hover (PRD D3 red
// line: the clipboard fallback inside get-selected-text simulates Cmd+C and
// must never run on a fly-by hover).
//
// Non-macOS builds compile a stub that reports `supported: false`; the
// renderer gates all UI behind that flag.

use serde::{Deserialize, Serialize};

/// Renderer-facing snapshot of what this build can do.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FbCapabilities {
    pub supported: bool,
    pub active: bool,
}

/// Eager context captured at explicit summon time (PRD §5.1).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FbContext {
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub selection: Option<String>,
}

/// Persisted ball placement — `~/.myagents/floating_ball.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FbPlacement {
    pub dock: String, // "left" | "right"
    /// Vertical position as a fraction of the monitor work-area height, so the
    /// ball lands in the same relative spot across resolution changes.
    pub y_ratio: f64,
}

impl Default for FbPlacement {
    fn default() -> Self {
        Self {
            dock: "right".to_string(),
            y_ratio: 0.36,
        }
    }
}

/// Mirror of the renderer's gate fields in `~/.myagents/config.json`.
/// Read directly from disk (same pattern as `global_shortcut::load_config`)
/// so startup doesn't depend on the frontend being mounted.
#[derive(Debug, Clone, Default)]
pub struct FbConfig {
    pub dev_gate: bool,
    pub enabled: bool,
}

pub fn load_fb_config() -> FbConfig {
    let Some(dir) = crate::app_dirs::myagents_data_dir() else {
        return FbConfig::default();
    };
    let Ok(content) = std::fs::read_to_string(dir.join("config.json")) else {
        return FbConfig::default();
    };
    let Ok(cfg) =
        serde_json::from_str::<serde_json::Value>(crate::utils::bom::strip_bom(&content))
    else {
        return FbConfig::default();
    };
    FbConfig {
        dev_gate: cfg
            .get("floatingBallDevGate")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        enabled: cfg
            .get("floatingBallEnabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    }
}

// ════════════════════════════════════════════════════════════════════════
// macOS implementation
// ════════════════════════════════════════════════════════════════════════
#[cfg(target_os = "macos")]
mod imp {
    use super::{FbCapabilities, FbContext, FbPlacement};
    use crate::{ulog_error, ulog_info, ulog_warn};
    use serde::Serialize;
    use std::path::PathBuf;
    use tauri::{
        AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl,
        WebviewWindowBuilder,
    };
    use tauri_nspanel::{tauri_panel, CollectionBehavior, ManagerExt, PanelLevel, StyleMask,
        WebviewWindowExt};

    pub const BALL_LABEL: &str = "fb-ball";
    pub const COMPANION_LABEL: &str = "fb-companion";

    const BALL_WIN: f64 = 92.0;
    const EDGE_MARGIN: f64 = 6.0;
    const COMPANION_W: f64 = 440.0;
    const COMPANION_H: f64 = 660.0;
    const COMPANION_GAP: f64 = 10.0;

    tauri_panel! {
        // The ball never takes keyboard focus — pure visual + mouse target.
        panel!(FbBallPanel {
            config: {
                can_become_key_window: false,
                can_become_main_window: false,
                is_floating_panel: true
            }
        })

        // The companion can become key (so the user can type) but only when we
        // explicitly call make_key_window — `becomes_key_only_if_needed` keeps
        // order_front_regardless (peek) from stealing focus.
        panel!(FbCompanionPanel {
            config: {
                can_become_key_window: true,
                can_become_main_window: false,
                becomes_key_only_if_needed: true,
                is_floating_panel: true
            }
        })
    }

    // ── Hover detection: NSEvent.mouseLocation polling ──
    //
    // Why polling and not NSTrackingArea / DOM mouseenter: while our app is
    // inactive (the PERMANENT state for nonactivating panels) WKWebView gets
    // no hover/mouseMoved events, so DOM mouseenter never fires. tauri-nspanel
    // tracking areas are owned by the content view (= the WKWebView), whose
    // own mouseEntered: override swallows events instead of bubbling them to
    // the panel subclass — user-verified dead end. NSEvent.mouseLocation is a
    // permission-free class-property query (NOT an event tap / NOT Input
    // Monitoring), and an 8Hz main-thread peek is unmeasurable CPU-wise.
    static HOVER_POLLER_RUNNING: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);

    fn mouse_in_window(win: &tauri::WebviewWindow, mouse_top_left: (f64, f64)) -> bool {
        let Ok(scale) = win.scale_factor() else { return false };
        let Ok(pos) = win.outer_position() else { return false };
        let Ok(size) = win.outer_size() else { return false };
        let pos = pos.to_logical::<f64>(scale);
        let size = size.to_logical::<f64>(scale);
        let (mx, my) = mouse_top_left;
        mx >= pos.x && mx <= pos.x + size.width && my >= pos.y && my <= pos.y + size.height
    }

    /// Current mouse position in Tauri's coordinate space (top-left origin,
    /// logical points). NSEvent.mouseLocation is bottom-left-origin global
    /// points; flip Y against the primary screen height.
    fn mouse_location_top_left() -> Option<(f64, f64)> {
        // Only ever called from run_on_main_thread — marker acquisition is a
        // checked no-op there.
        let mtm = tauri_nspanel::objc2::MainThreadMarker::new()?;
        let loc = tauri_nspanel::objc2_app_kit::NSEvent::mouseLocation();
        let screens = tauri_nspanel::objc2_app_kit::NSScreen::screens(mtm);
        let primary = screens.iter().next()?;
        let height = primary.frame().size.height;
        Some((loc.x, height - loc.y))
    }

    fn start_hover_poller(app: &AppHandle) {
        use std::sync::atomic::Ordering;
        if HOVER_POLLER_RUNNING.swap(true, Ordering::SeqCst) {
            return;
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut ball_inside = false;
            let mut comp_inside = false;
            loop {
                if !HOVER_POLLER_RUNNING.load(Ordering::SeqCst) {
                    break;
                }
                // 60ms ≈ 16Hz：hover 响应的第一段延迟就是这个间隔，120ms 在
                // 体感上"卡"（用户验收反馈）；16Hz 的 mouseLocation 查询 CPU
                // 仍不可测量。
                tokio::time::sleep(std::time::Duration::from_millis(60)).await;
                let app2 = app.clone();
                let (tx, rx) = std::sync::mpsc::channel::<(Option<bool>, Option<bool>)>();
                let dispatched = app
                    .run_on_main_thread(move || {
                        let mouse = mouse_location_top_left();
                        let ball = app2
                            .get_webview_window(BALL_LABEL)
                            .filter(|w| w.is_visible().unwrap_or(false));
                        let comp = app2
                            .get_webview_window(COMPANION_LABEL)
                            .filter(|w| w.is_visible().unwrap_or(false));
                        let ball_in = match (&mouse, &ball) {
                            (Some(m), Some(w)) => Some(mouse_in_window(w, *m)),
                            _ => ball.map(|_| false),
                        };
                        let comp_in = match (&mouse, &comp) {
                            (Some(m), Some(w)) => Some(mouse_in_window(w, *m)),
                            _ => comp.map(|_| false),
                        };
                        let _ = tx.send((ball_in, comp_in));
                    })
                    .is_ok();
                if !dispatched {
                    break;
                }
                let Ok((ball_in, comp_in)) = rx.recv() else { break };
                if let Some(inside) = ball_in {
                    if inside != ball_inside {
                        ball_inside = inside;
                        let _ = app.emit_to(
                            BALL_LABEL,
                            "fb:native-hover",
                            serde_json::json!({ "inside": inside }),
                        );
                    }
                }
                if let Some(inside) = comp_in {
                    if inside != comp_inside {
                        comp_inside = inside;
                        let _ = app.emit_to(
                            COMPANION_LABEL,
                            "fb:native-hover",
                            serde_json::json!({ "inside": inside }),
                        );
                    }
                }
            }
            ulog_info!("[fb] hover poller stopped");
        });
        ulog_info!("[fb] hover poller started");
    }

    fn stop_hover_poller() {
        HOVER_POLLER_RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    fn placement_path() -> Option<PathBuf> {
        crate::app_dirs::myagents_data_dir().map(|d| d.join("floating_ball.json"))
    }

    fn load_placement() -> FbPlacement {
        placement_path()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn save_placement(p: &FbPlacement) {
        if let Some(path) = placement_path() {
            if let Ok(json) = serde_json::to_string(p) {
                let _ = std::fs::write(path, json);
            }
        }
    }

    /// Work area of the monitor the ball lives on (logical coordinates).
    /// Falls back to the primary monitor. Uses `Monitor::work_area()` —
    /// NSScreen visibleFrame on macOS — so the menu bar, the Dock and notch
    /// variations are all accounted for (review fix: an earlier draft hand-
    /// rolled a 28px inset and could clamp the ball under the Dock).
    fn work_area(app: &AppHandle) -> Option<(f64, f64, f64, f64)> {
        let monitor = app
            .get_webview_window(BALL_LABEL)
            .and_then(|w| w.current_monitor().ok().flatten())
            .or_else(|| app.primary_monitor().ok().flatten())?;
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        let pos = area.position.to_logical::<f64>(scale);
        let size = area.size.to_logical::<f64>(scale);
        Some((pos.x, pos.y, size.width, size.height))
    }

    fn ball_xy_for_placement(app: &AppHandle, p: &FbPlacement) -> (f64, f64) {
        let (ax, ay, aw, ah) = work_area(app).unwrap_or((0.0, 28.0, 1440.0, 872.0));
        let x = if p.dock == "left" {
            ax + EDGE_MARGIN
        } else {
            ax + aw - BALL_WIN - EDGE_MARGIN
        };
        let y = (ay + p.y_ratio * ah).clamp(ay, ay + ah - BALL_WIN);
        (x, y)
    }

    fn ensure_windows(app: &AppHandle) -> Result<(), String> {
        if app.get_webview_window(BALL_LABEL).is_none() {
            let win = WebviewWindowBuilder::new(app, BALL_LABEL, WebviewUrl::default())
                .title("MyAgents Ball")
                .inner_size(BALL_WIN, BALL_WIN)
                .resizable(false)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .visible(false)
                .skip_taskbar(true)
                // 非 key 窗口的第一次点击必须直达 webview。wry 默认 false：
                // WKWebView 子类的 acceptsFirstMouse: 返回 NO → AppKit 把
                // first mouse 消费成"选中窗口"，DOM 收不到 mousedown/click
                // （0612 二轮实测：peek 面板第一下轻触/点按无反应，第二下才
                // 激活——第一下只让 panel 变成了 key window）。fb 两窗永远
                // 以非 key 态接受第一击，必须显式开。
                .accept_first_mouse(true)
                .build()
                .map_err(|e| format!("[fb] create ball window: {e}"))?;

            let panel = win
                .to_panel::<FbBallPanel>()
                .map_err(|e| format!("[fb] ball to_panel: {e}"))?;
            panel.set_level(PanelLevel::Floating.value());
            panel.set_style_mask(StyleMask::empty().nonactivating_panel().into());
            panel.set_collection_behavior(
                CollectionBehavior::new()
                    .full_screen_auxiliary()
                    .can_join_all_spaces()
                    .ignores_cycle()
                    .into(),
            );
            panel.set_hides_on_deactivate(false);
            // NSPanel double-release crash guard: Tauri also keeps a reference
            // to the NSWindow; never let AppKit free it on close.
            panel.set_released_when_closed(false);

            let placement = load_placement();
            let (x, y) = ball_xy_for_placement(app, &placement);
            let _ = win.set_position(LogicalPosition::new(x, y));
        }

        if app.get_webview_window(COMPANION_LABEL).is_none() {
            let win = WebviewWindowBuilder::new(app, COMPANION_LABEL, WebviewUrl::default())
                .title("MyAgents Companion")
                .inner_size(COMPANION_W, COMPANION_H)
                .resizable(false) // JS-driven resize via cmd_fb_set_companion_size
                .decorations(false)
                .transparent(true)
                .shadow(true)
                .visible(false)
                .skip_taskbar(true)
                // 同球窗：peek 态（非 key）的第一击必须进 DOM，见上注释。
                .accept_first_mouse(true)
                .build()
                .map_err(|e| format!("[fb] create companion window: {e}"))?;

            // Park it next to the ball IMMEDIATELY. Without an initial
            // position Tauri centers the window — the first show would
            // flash a center-screen frame before our reposition lands
            // (user-verified symptom).
            position_companion_near_ball(app, &win);

            // True frosted glass: NSVisualEffectView under the (transparent)
            // webview, rounded to match the DOM panel radius.
            //
            // 透明度模型（用户两轮实测收敛）：模糊永远全强度，透明度只由 DOM
            // 着色层（fb.css --glass-ghost/--glass-solid）控制。两个坑别再踩：
            // ① 材质必须够通透（Popover 太奶白，把 CSS tint 差全部吃掉）；
            // ② state 必须强制 Active——默认 FollowsWindowActiveState，而本
            //   app 永不激活（nonactivating panel），模糊会按 Inactive 弱化；
            // ③ 不要用 NSWindow.alphaValue 做 peek 半透明——它把模糊输出一起
            //   淡掉，背景文字"不模糊地"透进来，叠字不可读。
            // 材质选型只为 peek 服务（pin 的 0.96 着色会盖住材质）：要的是
            // "重模糊高透"——背后内容成模糊色块但明确可感。Sidebar 是系统
            // 材质里通透度最好的浅色系之一（访达侧栏透桌面那种）；
            // UnderWindowBackground/Popover 固有白度都太高，peek 像实纸。
            if let Err(e) = window_vibrancy::apply_vibrancy(
                &win,
                window_vibrancy::NSVisualEffectMaterial::Sidebar,
                Some(window_vibrancy::NSVisualEffectState::Active),
                Some(24.0),
            ) {
                ulog_warn!("[fb] companion vibrancy failed (non-fatal): {e}");
            }

            let panel = win
                .to_panel::<FbCompanionPanel>()
                .map_err(|e| format!("[fb] companion to_panel: {e}"))?;
            panel.set_level(PanelLevel::Floating.value());
            panel.set_style_mask(StyleMask::empty().nonactivating_panel().into());
            panel.set_collection_behavior(
                CollectionBehavior::new()
                    .full_screen_auxiliary()
                    .can_join_all_spaces()
                    .ignores_cycle()
                    .into(),
            );
            panel.set_hides_on_deactivate(false);
            panel.set_released_when_closed(false);
            panel.set_works_when_modal(true);
        }
        Ok(())
    }

    pub fn enable(app: &AppHandle) -> Result<(), String> {
        use tauri::Emitter;
        ensure_windows(app)?;
        if let Ok(panel) = app.get_webview_panel(BALL_LABEL) {
            panel.order_front_regardless();
            panel.show();
        }
        // Re-enable after a disable: tell the companion to re-acquire its
        // sidecar owner + SSE. On the very first enable the companion webview
        // may not have listeners yet — harmless, its boot path covers that.
        let _ = app.emit_to(COMPANION_LABEL, "fb:lifecycle", serde_json::json!({ "active": true }));
        start_hover_poller(app);
        ulog_info!("[fb] floating ball enabled");
        Ok(())
    }

    pub fn disable(app: &AppHandle) {
        use tauri::Emitter;
        // 作废 in-flight 渐变 task（否则它会在已隐藏的窗口上继续步进 alpha）。
        let _ = next_companion_gen();
        if let Ok(panel) = app.get_webview_panel(COMPANION_LABEL) {
            panel.hide();
        }
        if let Ok(panel) = app.get_webview_panel(BALL_LABEL) {
            panel.hide();
        }
        // Feature off ⇒ release resources: the companion disconnects SSE and
        // releases its sidecar owner (the Mino sidecar then stops unless other
        // owners hold it). Review fix C2 — hide-only left the sidecar running
        // for the rest of the app lifetime.
        let _ = app.emit_to(
            COMPANION_LABEL,
            "fb:lifecycle",
            serde_json::json!({ "active": false }),
        );
        stop_hover_poller();
        ulog_info!("[fb] floating ball disabled");
    }

    pub fn capabilities(app: &AppHandle) -> FbCapabilities {
        let active = app
            .get_webview_window(BALL_LABEL)
            .map(|w| w.is_visible().unwrap_or(false))
            .unwrap_or(false);
        FbCapabilities {
            supported: true,
            active,
        }
    }

    /// Compute + apply the companion's dock-aware position next to the ball.
    fn position_companion_near_ball(app: &AppHandle, companion: &tauri::WebviewWindow) {
        let Some(ball) = app.get_webview_window(BALL_LABEL) else { return };
        let scale = ball.scale_factor().unwrap_or(2.0);
        let Ok(bpos) = ball.outer_position() else { return };
        let bpos = bpos.to_logical::<f64>(scale);
        let Ok(csize) = companion.outer_size() else { return };
        let csize = csize.to_logical::<f64>(scale);
        let (ax, ay, aw, ah) = work_area(app).unwrap_or((0.0, 28.0, 1440.0, 872.0));

        // Ball on the right half → companion opens to its left, and vice versa.
        let dock_right = bpos.x + BALL_WIN / 2.0 > ax + aw / 2.0;
        let mut x = if dock_right {
            bpos.x - COMPANION_GAP - csize.width
        } else {
            bpos.x + BALL_WIN + COMPANION_GAP
        };
        x = x.clamp(ax + 8.0, ax + aw - csize.width - 8.0);
        let mut y = bpos.y + BALL_WIN / 2.0 - csize.height * 0.25;
        y = y.clamp(ay + 8.0, (ay + ah - csize.height - 8.0).max(ay + 8.0));
        let _ = companion.set_position(LogicalPosition::new(x, y));
    }

    // ── 伴侣窗出入场渐变（窗口层 alpha） ──
    //
    // 为什么必须在 NSWindow 层做而不是 CSS：毛玻璃 NSVisualEffectView 垫在
    // （透明的）webview 底下，DOM opacity 管不到它——CSS 渐显会让模糊背板
    // "啪"地全强度出现（与 peek 透明度同一个坑，见 ensure_windows 注释）。
    // NSWindow.alphaValue 把模糊层、内容、窗口阴影一起淡入/淡出。
    //
    // 为什么是 Rust 步进而不是 NSAnimationContext + animator：隐式动画在本
    // app 实测**不产生动画**——setAlphaValue 瞬间生效（0612 真机 + 日志取
    // 证：fade-out start 跑了、肉眼是瞬灭；入场的"渐进感"其实全靠 DOM 升
    // 起在掩护）。成因合理推测是 app 永不激活（nonactivating panel 形态）
    // 下 AppKit 不驱动隐式窗口动画——与 NSTrackingArea 失灵同类，平台惯用
    // 机制在此形态下失效，换确定性方案。set_alpha_value 是经过生产验证的
    // 原语（peek 半透明曾走它）。
    //
    // generation 计数器 = 渐变所有权：每次 show/pin/hide 取新 gen，旧渐变
    // task 在下一步发现 gen 过期即退出；淡出半程被重新唤起时，新渐变从
    // tracked alpha（当前值）起步——天然 retarget、无跳变。
    const FADE_IN_PEEK_MS: u64 = 180;
    const FADE_IN_PIN_MS: u64 = 120;
    // 出场与 peek 入场同长（成对，0612 三轮反馈）。
    const FADE_OUT_MS: u64 = 180;

    static COMPANION_VIS_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    /// 当前窗口 alpha 的镜像（千分位定点），渐变起点采样用——NSWindow 没有
    /// 方便的跨线程 getter，写侧只有我们自己。
    static COMPANION_ALPHA_MILLI: std::sync::atomic::AtomicU32 =
        std::sync::atomic::AtomicU32::new(1000);

    fn next_companion_gen() -> u64 {
        COMPANION_VIS_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
    }

    fn tracked_alpha() -> f64 {
        COMPANION_ALPHA_MILLI.load(std::sync::atomic::Ordering::SeqCst) as f64 / 1000.0
    }

    fn set_tracked_alpha(a: f64) {
        COMPANION_ALPHA_MILLI.store(
            (a.clamp(0.0, 1.0) * 1000.0).round() as u32,
            std::sync::atomic::Ordering::SeqCst,
        );
    }

    /// 确定性步进渐变：从 tracked alpha 渐变到 `to`，smoothstep 缓动；
    /// `hide_when_done` 时收尾 orderOut + alpha 复位。调用方先拿
    /// `next_companion_gen()` 再传入——gen 一换，旧 task 自行退出。
    fn fade_companion_to(
        app: &AppHandle,
        generation: u64,
        to: f64,
        duration_ms: u64,
        hide_when_done: bool,
    ) {
        let from = tracked_alpha();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            use std::sync::atomic::Ordering;
            const STEP_MS: u64 = 13; // ~75Hz；180ms ≈ 13 步，步进 alpha < 0.08 不可察
            let steps = (duration_ms / STEP_MS).max(1);
            for i in 1..=steps {
                tokio::time::sleep(std::time::Duration::from_millis(STEP_MS)).await;
                if COMPANION_VIS_GEN.load(Ordering::SeqCst) != generation {
                    return; // 被更新的 show/pin/hide 接管
                }
                let t = i as f64 / steps as f64;
                let eased = t * t * (3.0 - 2.0 * t); // smoothstep
                let a = from + (to - from) * eased;
                set_tracked_alpha(a);
                let app2 = app.clone();
                let dispatched = app
                    .run_on_main_thread(move || {
                        if let Ok(panel) = app2.get_webview_panel(COMPANION_LABEL) {
                            panel.set_alpha_value(a);
                        }
                    })
                    .is_ok();
                if !dispatched {
                    return;
                }
            }
            if hide_when_done {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                if COMPANION_VIS_GEN.load(Ordering::SeqCst) != generation {
                    return; // 淡出收尾前又被唤起，orderOut 作废
                }
                set_tracked_alpha(1.0);
                let app2 = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Ok(panel) = app2.get_webview_panel(COMPANION_LABEL) {
                        panel.hide();
                        panel.set_alpha_value(1.0); // 复位（下次 show 会先归零）
                    }
                });
            }
        });
    }

    /// Position the companion next to the ball (dock-aware) and show it.
    /// mode = "peek" (no keyboard focus) | "pin" (becomes key window).
    pub fn show_companion(app: &AppHandle, mode: &str) -> Result<(), String> {
        ensure_windows(app)?;
        let companion = app
            .get_webview_window(COMPANION_LABEL)
            .ok_or("[fb] companion window missing")?;
        position_companion_near_ball(app, &companion);

        let panel = app
            .get_webview_panel(COMPANION_LABEL)
            .map_err(|_| "[fb] companion panel missing".to_string())?;
        // 任何一次 show 都让 generation 前进——立刻作废 in-flight 的淡出
        // task（含其收尾 orderOut），再开始本次渐显。
        let generation = next_companion_gen();
        let was_visible = companion.is_visible().unwrap_or(false);
        if !was_visible {
            // 从隐藏出场：alpha 先归零再 orderFront，首帧不闪全亮。
            panel.set_alpha_value(0.0);
            set_tracked_alpha(0.0);
        }
        panel.order_front_regardless();
        panel.show();
        if mode == "pin" {
            // Keyboard focus moves to the panel; the user's app stays
            // frontmost because of the nonactivating style mask.
            panel.make_key_window();
        }
        // Peek: visible but never key — D1. 半透明由 DOM 着色层表达
        // （毛玻璃常开，见 ensure_windows 的 vibrancy 注释）。
        // 已可见时（含淡出半程被重新唤起）从 tracked alpha 续渐到 1，无跳变。
        let dur = if mode == "pin" { FADE_IN_PIN_MS } else { FADE_IN_PEEK_MS };
        fade_companion_to(app, generation, 1.0, dur, false);
        Ok(())
    }

    /// Promote an already-visible peek to pinned (keyboard focus).
    pub fn pin_companion(app: &AppHandle) -> Result<(), String> {
        let panel = app
            .get_webview_panel(COMPANION_LABEL)
            .map_err(|_| "[fb] companion panel missing".to_string())?;
        let generation = next_companion_gen();
        panel.order_front_regardless();
        panel.show();
        panel.make_key_window();
        // peek→pin 时窗口已在 alpha 1（渐变是 no-op）；这里只救"淡出半程
        // 被点住"的边角——从 tracked alpha 续渐回 1。
        fade_companion_to(app, generation, 1.0, FADE_IN_PIN_MS, false);
        Ok(())
    }

    pub fn hide_companion(app: &AppHandle) {
        let Some(win) = app.get_webview_window(COMPANION_LABEL) else { return };
        if !win.is_visible().unwrap_or(false) {
            return;
        }
        let generation = next_companion_gen();
        crate::ulog_debug!("[fb] companion fade-out start (gen {generation})");
        // 渐隐到 0 后由 fade task 收尾 orderOut（hide_when_done）。
        // hide()/orderOut is sufficient — AppKit reassigns key to the
        // frontmost app on its own. (Do NOT call resign_key_window directly;
        // AppKit docs reserve it as a system callback.)
        fade_companion_to(app, generation, 0.0, FADE_OUT_MS, true);
    }

    pub fn drag_ball(app: &AppHandle, dx: f64, dy: f64) -> Result<(), String> {
        let ball = app
            .get_webview_window(BALL_LABEL)
            .ok_or("[fb] ball window missing")?;
        let scale = ball.scale_factor().unwrap_or(2.0);
        let pos = ball
            .outer_position()
            .map_err(|e| format!("[fb] ball position: {e}"))?
            .to_logical::<f64>(scale);
        let _ = ball.set_position(LogicalPosition::new(pos.x + dx, pos.y + dy));
        Ok(())
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct SnapResult {
        pub dock: String,
    }

    /// Snap the ball to the nearest screen edge and persist placement.
    pub fn snap_ball(app: &AppHandle) -> Result<SnapResult, String> {
        let ball = app
            .get_webview_window(BALL_LABEL)
            .ok_or("[fb] ball window missing")?;
        let scale = ball.scale_factor().unwrap_or(2.0);
        let pos = ball
            .outer_position()
            .map_err(|e| format!("[fb] ball position: {e}"))?
            .to_logical::<f64>(scale);
        let (ax, ay, aw, ah) = work_area(app).unwrap_or((0.0, 28.0, 1440.0, 872.0));

        let dock = if pos.x + BALL_WIN / 2.0 < ax + aw / 2.0 {
            "left"
        } else {
            "right"
        };
        let placement = FbPlacement {
            dock: dock.to_string(),
            y_ratio: ((pos.y - ay) / ah).clamp(0.02, 0.92),
        };
        let (x, y) = ball_xy_for_placement(app, &placement);
        let _ = ball.set_position(LogicalPosition::new(x, y));
        save_placement(&placement);
        Ok(SnapResult {
            dock: dock.to_string(),
        })
    }

    pub fn set_companion_size(app: &AppHandle, width: f64, height: f64) -> Result<(), String> {
        let companion = app
            .get_webview_window(COMPANION_LABEL)
            .ok_or("[fb] companion window missing")?;
        let _ = companion.set_size(LogicalSize::new(width.max(360.0), height.max(320.0)));
        Ok(())
    }

    pub fn drag_companion(app: &AppHandle, dx: f64, dy: f64) -> Result<(), String> {
        let companion = app
            .get_webview_window(COMPANION_LABEL)
            .ok_or("[fb] companion window missing")?;
        let scale = companion.scale_factor().unwrap_or(2.0);
        let pos = companion
            .outer_position()
            .map_err(|e| format!("[fb] companion position: {e}"))?
            .to_logical::<f64>(scale);
        let _ = companion.set_position(LogicalPosition::new(pos.x + dx, pos.y + dy));
        Ok(())
    }

    /// Eager context capture (PRD §5.1). MUST run before the companion becomes
    /// key — the probes read the *user's* frontmost app. Selection capture may
    /// fall back to a clipboard round-trip inside get-selected-text, which is
    /// acceptable here because this is only ever called on explicit summon.
    pub fn capture_context() -> FbContext {
        let mut ctx = FbContext::default();

        match active_win_pos_rs::get_active_window() {
            // Clicking the ball can make OUR panel the "active window" in the
            // CGWindow sense even though the app never activates — the user
            // saw "正在看 MyAgents — MyAgents Ball" in the title row. Filter
            // out our own process and fall back to NSWorkspace's frontmost
            // application (which nonactivating panels never become).
            Ok(win) if win.process_id != std::process::id() as u64 => {
                if !win.app_name.is_empty() {
                    ctx.app_name = Some(win.app_name);
                }
                if !win.title.is_empty() {
                    ctx.window_title = Some(win.title);
                }
            }
            Ok(_) => {
                ctx.app_name = frontmost_app_name();
            }
            Err(_) => {
                ulog_warn!("[fb] get_active_window failed (no frontmost window?)");
                ctx.app_name = frontmost_app_name();
            }
        }

        // Don't even try selection capture without Accessibility permission —
        // get-selected-text would fall through to the Cmd+C clipboard hack and
        // surprise the user before they ever granted anything.
        if ax_trusted(false) {
            match get_selected_text::get_selected_text() {
                Ok(text) => {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        // Cap defensively — a 5MB selection should not ride
                        // along into a chat message unasked.
                        let capped: String = trimmed.chars().take(2000).collect();
                        ctx.selection = Some(capped);
                    }
                }
                Err(e) => {
                    ulog_warn!("[fb] get_selected_text failed: {e:?}");
                }
            }
        }

        ctx
    }

    /// Frontmost application name via NSWorkspace — unlike the CGWindow-based
    /// active-win probe this can never return our own nonactivating panels.
    fn frontmost_app_name() -> Option<String> {
        let ws = tauri_nspanel::objc2_app_kit::NSWorkspace::sharedWorkspace();
        let app = ws.frontmostApplication()?;
        let name = app.localizedName()?;
        let name = name.to_string();
        if name.is_empty() || name == "MyAgents" {
            None
        } else {
            Some(name)
        }
    }

    /// Accessibility (AX) permission probe. `prompt = true` shows the system
    /// authorization dialog once.
    pub fn ax_trusted(prompt: bool) -> bool {
        if prompt {
            macos_accessibility_client::accessibility::application_is_trusted_with_prompt()
        } else {
            macos_accessibility_client::accessibility::application_is_trusted()
        }
    }

    /// Shutter-style screenshot (PRD D7: only ever user-initiated). Captures
    /// the full screen via /usr/sbin/screencapture, then downsamples to a
    /// ≤1600px JPEG via /usr/bin/sips so the base64 payload stays in the
    /// hundreds-of-KB range — the raw Retina PNG would otherwise ride the
    /// invoke IPC *and* the /chat/send JSON body at 5–30MB (the ">256KB into
    /// IPC JSON" red line, flagged by both review passes).
    /// First call triggers the macOS Screen Recording permission prompt.
    pub fn screenshot() -> Result<String, String> {
        use base64::Engine;
        let id = uuid::Uuid::new_v4();
        let tmp = std::env::temp_dir().join(format!("myagents-fb-shot-{id}.png"));
        let status = crate::process_cmd::new("/usr/sbin/screencapture")
            .arg("-x") // no shutter sound
            .arg(&tmp)
            .status()
            .map_err(|e| format!("[fb] screencapture spawn: {e}"))?;
        if !status.success() {
            let _ = std::fs::remove_file(&tmp);
            return Err("[fb] screencapture failed (screen recording permission?)".to_string());
        }

        // Downsample + transcode in place. Best-effort: if sips fails we fall
        // back to the original PNG rather than losing the shot.
        let jpg = std::env::temp_dir().join(format!("myagents-fb-shot-{id}.jpg"));
        let sips_ok = crate::process_cmd::new("/usr/bin/sips")
            .args(["-Z", "1600", "-s", "format", "jpeg", "-s", "formatOptions", "72"])
            .arg(&tmp)
            .arg("--out")
            .arg(&jpg)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);

        let (path, mime) = if sips_ok {
            (&jpg, "image/jpeg")
        } else {
            ulog_warn!("[fb] sips downsample failed — falling back to raw png");
            (&tmp, "image/png")
        };
        let bytes = std::fs::read(path).map_err(|e| format!("[fb] read screenshot: {e}"));
        let _ = std::fs::remove_file(&tmp);
        let _ = std::fs::remove_file(&jpg);
        let bytes = bytes?;
        if bytes.is_empty() {
            return Err("[fb] empty screenshot".to_string());
        }
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        Ok(format!("data:{mime};base64,{b64}"))
    }

    /// Cross-window event relay: ball ⇄ companion talk through Rust because
    /// they live in separate webviews.
    pub fn relay(app: &AppHandle, target: &str, event: &str, payload: serde_json::Value) {
        let label = match target {
            "ball" => BALL_LABEL,
            _ => COMPANION_LABEL,
        };
        if let Err(e) = app.emit_to(label, event, payload) {
            ulog_error!("[fb] relay {event} → {label} failed: {e}");
        }
    }
}

// ════════════════════════════════════════════════════════════════════════
// Tauri commands (cross-platform surface; stubs on non-macOS)
// ════════════════════════════════════════════════════════════════════════

#[cfg(target_os = "macos")]
mod commands {
    use super::imp;
    use super::{FbCapabilities, FbContext};
    use tauri::AppHandle;

    #[tauri::command]
    pub async fn cmd_fb_enable(app: AppHandle) -> Result<(), String> {
        // Window/panel creation must happen on the main thread.
        let (tx, rx) = std::sync::mpsc::channel();
        app.clone()
            .run_on_main_thread(move || {
                let _ = tx.send(imp::enable(&app));
            })
            .map_err(|e| format!("[fb] main thread dispatch: {e}"))?;
        rx.recv().map_err(|e| format!("[fb] enable join: {e}"))?
    }

    #[tauri::command]
    pub async fn cmd_fb_disable(app: AppHandle) -> Result<(), String> {
        app.clone()
            .run_on_main_thread(move || imp::disable(&app))
            .map_err(|e| format!("[fb] main thread dispatch: {e}"))
    }

    #[tauri::command]
    pub async fn cmd_fb_capabilities(app: AppHandle) -> Result<FbCapabilities, String> {
        Ok(imp::capabilities(&app))
    }

    #[tauri::command]
    pub async fn cmd_fb_show_companion(app: AppHandle, mode: String) -> Result<(), String> {
        app.clone()
            .run_on_main_thread(move || {
                if let Err(e) = imp::show_companion(&app, &mode) {
                    crate::ulog_error!("[fb] show_companion: {e}");
                }
            })
            .map_err(|e| format!("[fb] main thread dispatch: {e}"))
    }

    /// NOTE: channel-join 等主线程真正执行完 make_key_window 才 resolve——
    /// `run_on_main_thread` 只是派发不等待，renderer 的 `await invoke(pin)`
    /// 之后立刻 focus() 需要窗口已是 key window（非 key 窗口 focus 不出
    /// 光标，0612 二轮实测）。cmd_fb_enable 同款模式。
    #[tauri::command]
    pub async fn cmd_fb_pin_companion(app: AppHandle) -> Result<(), String> {
        let (tx, rx) = std::sync::mpsc::channel();
        app.clone()
            .run_on_main_thread(move || {
                let _ = tx.send(imp::pin_companion(&app));
            })
            .map_err(|e| format!("[fb] main thread dispatch: {e}"))?;
        rx.recv().map_err(|e| format!("[fb] pin join: {e}"))?
    }

    #[tauri::command]
    pub async fn cmd_fb_hide_companion(app: AppHandle) -> Result<(), String> {
        app.clone()
            .run_on_main_thread(move || imp::hide_companion(&app))
            .map_err(|e| format!("[fb] main thread dispatch: {e}"))
    }

    #[tauri::command]
    pub async fn cmd_fb_drag_ball(app: AppHandle, dx: f64, dy: f64) -> Result<(), String> {
        imp::drag_ball(&app, dx, dy)
    }

    #[tauri::command]
    pub async fn cmd_fb_snap_ball(app: AppHandle) -> Result<imp::SnapResult, String> {
        imp::snap_ball(&app)
    }

    #[tauri::command]
    pub async fn cmd_fb_drag_companion(app: AppHandle, dx: f64, dy: f64) -> Result<(), String> {
        imp::drag_companion(&app, dx, dy)
    }

    #[tauri::command]
    pub async fn cmd_fb_set_companion_size(
        app: AppHandle,
        width: f64,
        height: f64,
    ) -> Result<(), String> {
        imp::set_companion_size(&app, width, height)
    }

    /// Eager context capture — blocking AX work off the async runtime.
    #[tauri::command]
    pub async fn cmd_fb_capture_context() -> Result<FbContext, String> {
        tauri::async_runtime::spawn_blocking(imp::capture_context)
            .await
            .map_err(|e| format!("[fb] capture join: {e}"))
    }

    #[tauri::command]
    pub async fn cmd_fb_ax_status(prompt: bool) -> Result<bool, String> {
        tauri::async_runtime::spawn_blocking(move || imp::ax_trusted(prompt))
            .await
            .map_err(|e| format!("[fb] ax join: {e}"))
    }

    #[tauri::command]
    pub async fn cmd_fb_screenshot() -> Result<String, String> {
        tauri::async_runtime::spawn_blocking(imp::screenshot)
            .await
            .map_err(|e| format!("[fb] screenshot join: {e}"))?
    }

    /// Generic ball ⇄ companion event relay.
    #[tauri::command]
    pub async fn cmd_fb_relay(
        app: AppHandle,
        target: String,
        event: String,
        payload: serde_json::Value,
    ) -> Result<(), String> {
        imp::relay(&app, &target, &event, payload);
        Ok(())
    }

    /// Summon the main window and open the companion's session in a new Tab.
    #[tauri::command]
    pub async fn cmd_fb_open_main_with_session(
        app: AppHandle,
        session_id: String,
        workspace_path: String,
    ) -> Result<(), String> {
        use tauri::Emitter;
        crate::tray::show_main_window(&app);
        app.emit_to(
            "main",
            "fb:open-session",
            serde_json::json!({ "sessionId": session_id, "workspacePath": workspace_path }),
        )
        .map_err(|e| format!("[fb] emit open-session: {e}"))
    }
}

#[cfg(not(target_os = "macos"))]
mod commands {
    use super::{FbCapabilities, FbContext};
    use tauri::AppHandle;

    const UNSUPPORTED: &str = "[fb] floating ball is macOS-only in phase 1";

    #[tauri::command]
    pub async fn cmd_fb_enable(_app: AppHandle) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn cmd_fb_disable(_app: AppHandle) -> Result<(), String> {
        Ok(())
    }

    #[tauri::command]
    pub async fn cmd_fb_capabilities(_app: AppHandle) -> Result<FbCapabilities, String> {
        Ok(FbCapabilities {
            supported: false,
            active: false,
        })
    }

    #[tauri::command]
    pub async fn cmd_fb_show_companion(_app: AppHandle, _mode: String) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn cmd_fb_pin_companion(_app: AppHandle) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn cmd_fb_hide_companion(_app: AppHandle) -> Result<(), String> {
        Ok(())
    }

    #[tauri::command]
    pub async fn cmd_fb_drag_ball(_app: AppHandle, _dx: f64, _dy: f64) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    #[derive(serde::Serialize)]
    pub struct SnapResult {
        pub dock: String,
    }

    #[tauri::command]
    pub async fn cmd_fb_snap_ball(_app: AppHandle) -> Result<SnapResult, String> {
        Err(UNSUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn cmd_fb_drag_companion(_app: AppHandle, _dx: f64, _dy: f64) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn cmd_fb_set_companion_size(
        _app: AppHandle,
        _width: f64,
        _height: f64,
    ) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn cmd_fb_capture_context() -> Result<FbContext, String> {
        Ok(FbContext::default())
    }

    #[tauri::command]
    pub async fn cmd_fb_ax_status(_prompt: bool) -> Result<bool, String> {
        Ok(false)
    }

    #[tauri::command]
    pub async fn cmd_fb_screenshot() -> Result<String, String> {
        Err(UNSUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn cmd_fb_relay(
        _app: AppHandle,
        _target: String,
        _event: String,
        _payload: serde_json::Value,
    ) -> Result<(), String> {
        Ok(())
    }

    #[tauri::command]
    pub async fn cmd_fb_open_main_with_session(
        _app: AppHandle,
        _session_id: String,
        _workspace_path: String,
    ) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }
}

pub use commands::*;

/// Startup hook: if the developer gate + ball are both enabled in config,
/// bring the ball up without waiting for the frontend.
pub fn setup_on_startup(app: &tauri::AppHandle) {
    let cfg = load_fb_config();
    if !(cfg.dev_gate && cfg.enabled) {
        return;
    }
    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        let _ = app.clone().run_on_main_thread(move || {
            if let Err(e) = self::macos_enable(&app) {
                crate::ulog_warn!("[fb] startup enable failed: {e}");
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        crate::ulog_info!("[fb] enabled in config but unsupported on this OS — skipping");
    }
}

#[cfg(target_os = "macos")]
fn macos_enable(app: &tauri::AppHandle) -> Result<(), String> {
    imp::enable(app)
}
