use crate::commands::ConfigState;
use crate::config::{self, Overlay as OverlayConfig};
use crate::storage;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{
    AppHandle, Emitter, LogicalPosition, Manager, PhysicalPosition, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

pub const OVERLAY_LABEL: &str = "overlay";
// The overlay Tauri window is created once at these dimensions and NEVER
// resized. Expand/collapse is an inner-CSS animation only. Native window
// resize on Windows was causing content reflow mid-morph and intermittent
// Chrome_WidgetWin_0 unregister crashes on rapid toggle; keeping the window
// fixed side-steps both.
pub const WINDOW_W: f64 = 288.0;
pub const WINDOW_H: f64 = 108.0;

const OVERLAY_MARGIN: f64 = 20.0;
const OVERLAY_TOP_OFFSET: f64 = 40.0;

/// C-H2: set true while `build_overlay` is mid-flight so the shutdown
/// paths can wait for a newborn window to finish constructing before
/// tearing it down. Without this, toggling the overlay on and hitting
/// Ctrl+Q within ~50 ms could race the WebviewWindowBuilder against
/// `close_overlay_if_open`, leaving a zombie handle that crashes on
/// `app.exit(0)`.
static OVERLAY_BUILDING: Mutex<bool> = Mutex::new(false);

pub fn build_overlay(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(existing) = app.get_webview_window(OVERLAY_LABEL) {
        return Ok(existing);
    }

    // Guard: mark the build as in-flight so close_overlay_if_open can
    // block on us finishing. We always clear the flag in the drop guard
    // below — even on a build error or panic-safe early return.
    {
        let mut flag = OVERLAY_BUILDING
            .lock()
            .map_err(|e| format!("overlay build flag: {}", e))?;
        *flag = true;
    }
    struct ClearOnDrop;
    impl Drop for ClearOnDrop {
        fn drop(&mut self) {
            if let Ok(mut flag) = OVERLAY_BUILDING.lock() {
                *flag = false;
            }
        }
    }
    let _clear = ClearOnDrop;

    let cfg_state = app.state::<ConfigState>();
    let overlay_cfg = {
        let cfg = cfg_state.0.lock().map_err(|e| e.to_string())?;
        cfg.overlay.clone()
    };

    let mut builder = WebviewWindowBuilder::new(
        app,
        OVERLAY_LABEL,
        WebviewUrl::App("overlay.html".into()),
    )
    .title("Flint Overlay")
    .inner_size(WINDOW_W, WINDOW_H)
    .min_inner_size(WINDOW_W, WINDOW_H)
    .max_inner_size(WINDOW_W, WINDOW_H)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .focused(false)
    .visible(false);

    // O-H3: honor config.overlay.position when the user has NOT dragged
    // the overlay (x/y are None). Once the user drags, the saved x/y take
    // precedence. Falling back to computing coords from the primary
    // monitor's work area for each named corner.
    match (overlay_cfg.x, overlay_cfg.y) {
        (Some(x), Some(y)) => {
            builder = builder.position(x, y);
        }
        _ => {
            if let Some(pos) = compute_corner_position(app, &overlay_cfg.position) {
                builder = builder.position(pos.0, pos.1);
            }
        }
    }

    builder
        .build()
        .map_err(|e| format!("create overlay window: {}", e))
}

/// O-H3: compute the top-left corner for the overlay window given a named
/// corner (`top-left`, `top-right`, `bottom-left`, `bottom-right`). Reads
/// the monitor from the main window when available, or from the app's
/// primary monitor as a fallback — so the overlay can be positioned at
/// startup even before the main window paints.
fn compute_corner_position(app: &AppHandle, position: &str) -> Option<(f64, f64)> {
    let monitor = app
        .get_webview_window("main")
        .and_then(|m| m.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())?;
    let scale = monitor.scale_factor();
    let size = monitor.size();
    let pos = monitor.position();
    let monitor_x = pos.x as f64 / scale;
    let monitor_y = pos.y as f64 / scale;
    let monitor_w = size.width as f64 / scale;
    let monitor_h = size.height as f64 / scale;

    let left_x = monitor_x + OVERLAY_MARGIN;
    let right_x = monitor_x + monitor_w - WINDOW_W - OVERLAY_MARGIN;
    let top_y = monitor_y + OVERLAY_MARGIN + OVERLAY_TOP_OFFSET;
    let bottom_y = monitor_y + monitor_h - WINDOW_H - OVERLAY_MARGIN;

    let (x, y) = match position {
        "top-left" => (left_x, top_y),
        "bottom-left" => (left_x, bottom_y),
        "bottom-right" => (right_x, bottom_y),
        // Default / unknown / "top-right" → the PRD default.
        _ => (right_x, top_y),
    };
    Some((x, y))
}

/// O-H3: public entry point used by `update_config` to live-apply overlay
/// config changes. Emits the new opacity to the overlay webview (which
/// turns it into a CSS `opacity` on the inner container) and, when the
/// user has not dragged the overlay (x/y are still None), moves the
/// window to match the newly-selected corner without a restart.
pub fn apply_overlay_config(app: &AppHandle, cfg: &OverlayConfig) {
    let _ = app.emit_to(OVERLAY_LABEL, "overlay:config", cfg.clone());
    if cfg.x.is_none() && cfg.y.is_none() {
        if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
            if let Some((x, y)) = compute_corner_position(app, &cfg.position) {
                let _ = window.set_position(LogicalPosition::new(x, y));
            }
        }
    }
}

/// Close the overlay window if it exists. Called during the app-exit path
/// BEFORE the main window is destroyed so the Win32 window class for the
/// secondary webview is torn down first. Reversing that order on Windows
/// intermittently trips a Chrome_WidgetWin_0 unregister crash
/// (exit code 0xcfffffff) when the overlay is still open at quit time.
///
/// C-H2: if a build is mid-flight (user toggled overlay on then hit
/// Ctrl+Q within ~50 ms), spin-wait for it to finish so the newborn
/// window is visible to `get_webview_window` before we tear it down.
/// Cap the wait at ~500 ms so a wedged build never blocks shutdown
/// forever.
pub fn close_overlay_if_open(app: &AppHandle) {
    for _ in 0..20 {
        let building = OVERLAY_BUILDING
            .lock()
            .map(|b| *b)
            .unwrap_or(false);
        if !building {
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = window.hide();
        let _ = window.close();
    }
}

/// P-H4: tell the overlay webview whether its window is currently visible
/// so it can suspend its `session:tick` subscription when hidden. The JS
/// side listens for `overlay:visibility` and gates `useTickState(visible)`.
fn emit_visibility(app: &AppHandle, visible: bool) {
    let _ = app.emit_to(OVERLAY_LABEL, "overlay:visibility", visible);
}

/// Emit the current overlay config (opacity + position) to the overlay
/// webview so it can pick up CSS opacity on first mount. Called after
/// show/toggle so a freshly-visible window never flashes at 100% before
/// the CSS variable settles.
fn emit_overlay_config_snapshot(app: &AppHandle) {
    let overlay_cfg = {
        let cfg_state = app.state::<ConfigState>();
        let Ok(cfg) = cfg_state.0.lock() else {
            return;
        };
        cfg.overlay.clone()
    };
    let _ = app.emit_to(OVERLAY_LABEL, "overlay:config", overlay_cfg);
}

#[tauri::command]
pub fn overlay_show(app: AppHandle) -> Result<(), String> {
    let window = match app.get_webview_window(OVERLAY_LABEL) {
        Some(w) => w,
        None => build_overlay(&app)?,
    };
    window.show().map_err(|e| e.to_string())?;
    window.set_always_on_top(true).map_err(|e| e.to_string())?;
    emit_visibility(&app, true);
    emit_overlay_config_snapshot(&app);
    Ok(())
}

#[tauri::command]
pub fn overlay_hide(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        window.hide().map_err(|e| e.to_string())?;
        emit_visibility(&app, false);
    }
    Ok(())
}

#[tauri::command]
pub fn overlay_toggle(app: AppHandle) -> Result<bool, String> {
    let window = match app.get_webview_window(OVERLAY_LABEL) {
        Some(w) => w,
        None => build_overlay(&app)?,
    };
    let visible = window.is_visible().unwrap_or(false);
    if visible {
        window.hide().map_err(|e| e.to_string())?;
        emit_visibility(&app, false);
        Ok(false)
    } else {
        window.show().map_err(|e| e.to_string())?;
        window.set_always_on_top(true).map_err(|e| e.to_string())?;
        emit_visibility(&app, true);
        emit_overlay_config_snapshot(&app);
        Ok(true)
    }
}

#[tauri::command]
pub fn overlay_save_position(
    app: AppHandle,
    config: State<'_, ConfigState>,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window(OVERLAY_LABEL) else {
        return Ok(());
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let physical: PhysicalPosition<i32> = window
        .outer_position()
        .map_err(|e| e.to_string())?;
    let x = physical.x as f64 / scale;
    let y = physical.y as f64 / scale;
    let mut cfg = config.0.lock().map_err(|e| e.to_string())?;
    cfg.overlay.x = Some(x);
    cfg.overlay.y = Some(y);
    let dir = storage::flint_dir()?;
    config::save(&dir, &cfg)
}

#[tauri::command]
pub fn overlay_move_to(
    x: f64,
    y: f64,
    app: AppHandle,
    config: State<'_, ConfigState>,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        window
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
    }
    let mut cfg = config.0.lock().map_err(|e| e.to_string())?;
    cfg.overlay.x = Some(x);
    cfg.overlay.y = Some(y);
    let dir = storage::flint_dir()?;
    config::save(&dir, &cfg)
}
