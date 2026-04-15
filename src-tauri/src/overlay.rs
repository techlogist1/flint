use crate::commands::ConfigState;
use crate::config;
use crate::storage;
use tauri::{
    AppHandle, LogicalPosition, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

pub const OVERLAY_LABEL: &str = "overlay";
// The overlay Tauri window is created once at these dimensions and NEVER
// resized. Expand/collapse is an inner-CSS animation only. Native window
// resize on Windows was causing content reflow mid-morph and intermittent
// Chrome_WidgetWin_0 unregister crashes on rapid toggle; keeping the window
// fixed side-steps both.
pub const WINDOW_W: f64 = 288.0;
pub const WINDOW_H: f64 = 108.0;

pub fn build_overlay(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(existing) = app.get_webview_window(OVERLAY_LABEL) {
        return Ok(existing);
    }

    let cfg_state = app.state::<ConfigState>();
    let (saved_x, saved_y) = {
        let cfg = cfg_state.0.lock().map_err(|e| e.to_string())?;
        (cfg.overlay.x, cfg.overlay.y)
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
    .transparent(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .focused(false)
    .visible(false);

    match (saved_x, saved_y) {
        (Some(x), Some(y)) => {
            builder = builder.position(x, y);
        }
        _ => {
            if let Some(pos) = compute_default_position(app) {
                builder = builder.position(pos.0, pos.1);
            }
        }
    }

    builder.build().map_err(|e| format!("create overlay window: {}", e))
}

fn compute_default_position(app: &AppHandle) -> Option<(f64, f64)> {
    let main = app.get_webview_window("main")?;
    let monitor = main.current_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let size = monitor.size();
    let pos = monitor.position();
    let monitor_x = pos.x as f64 / scale;
    let monitor_y = pos.y as f64 / scale;
    let monitor_w = size.width as f64 / scale;
    let margin = 20.0;
    let x = monitor_x + monitor_w - WINDOW_W - margin;
    let y = monitor_y + margin + 40.0;
    Some((x, y))
}

/// Close the overlay window if it exists. Called during the app-exit path
/// BEFORE the main window is destroyed so the Win32 window class for the
/// secondary webview is torn down first. Reversing that order on Windows
/// intermittently trips a Chrome_WidgetWin_0 unregister crash
/// (exit code 0xcfffffff) when the overlay is still open at quit time.
pub fn close_overlay_if_open(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = window.hide();
        let _ = window.close();
    }
}

#[tauri::command]
pub fn overlay_show(app: AppHandle) -> Result<(), String> {
    let window = match app.get_webview_window(OVERLAY_LABEL) {
        Some(w) => w,
        None => build_overlay(&app)?,
    };
    window.show().map_err(|e| e.to_string())?;
    window.set_always_on_top(true).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn overlay_hide(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        window.hide().map_err(|e| e.to_string())?;
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
        Ok(false)
    } else {
        window.show().map_err(|e| e.to_string())?;
        window.set_always_on_top(true).map_err(|e| e.to_string())?;
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
