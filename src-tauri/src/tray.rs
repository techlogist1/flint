use crate::commands::{self, ConfigState, EngineState, PluginRegistry};
use crate::overlay;
use crate::plugins::{self, TimerModeInfo};
use crate::timer::TimerStatus;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

const MENU_TOGGLE_OVERLAY: &str = "toggle_overlay";
const MENU_OPEN: &str = "open_flint";
const MENU_QUIT: &str = "quit_flint";
/// Prefix for dynamic "Start {mode}" entries. The suffix is the plugin id,
/// so any plugin with `timer_mode: true` can register itself without the
/// tray having to know about it ahead of time.
const MENU_START_PREFIX: &str = "start_mode::";

pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let menu = build_menu(app)?;

    let icon = app
        .default_window_icon()
        .ok_or_else(|| "missing default window icon".to_string())?
        .clone();

    TrayIconBuilder::with_id("flint-tray")
        .icon(icon)
        .tooltip("Flint")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

/// Rebuild the tray menu against the current plugin registry + config. Call
/// this after any change that could add or remove timer-mode plugins (e.g.
/// enabling a community plugin via `set_plugin_enabled`) so the menu stays
/// in sync with the plugin set — no hardcoding, no reboot.
pub fn rebuild_menu(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let Some(tray) = app.tray_by_id("flint-tray") else {
        return Ok(());
    };
    let menu = build_menu(app)?;
    tray.set_menu(Some(menu))?;
    Ok(())
}

fn build_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let modes = current_timer_modes(app);

    let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>> = Vec::new();

    if modes.is_empty() {
        // Should not happen in practice — at least one builtin timer-mode
        // plugin is always bundled — but keep the menu usable even if the
        // user disables them all.
        let none = MenuItem::with_id(app, "no_modes", "No timer modes enabled", false, None::<&str>)?;
        items.push(Box::new(none));
    } else {
        for mode in &modes {
            let label = format!("Start {}", mode.label);
            let id = format!("{}{}", MENU_START_PREFIX, mode.id);
            let item = MenuItem::with_id(app, &id, label, true, None::<&str>)?;
            items.push(Box::new(item));
        }
    }

    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    items.push(Box::new(MenuItem::with_id(
        app,
        MENU_TOGGLE_OVERLAY,
        "Show / Hide Overlay",
        true,
        None::<&str>,
    )?));
    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    items.push(Box::new(MenuItem::with_id(
        app,
        MENU_OPEN,
        "Open Flint",
        true,
        None::<&str>,
    )?));
    items.push(Box::new(MenuItem::with_id(
        app,
        MENU_QUIT,
        "Quit Flint",
        true,
        Some("CmdOrCtrl+Q"),
    )?));

    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        items.iter().map(|b| b.as_ref()).collect();
    let menu = Menu::with_items(app, &refs)?;
    Ok(menu)
}

fn current_timer_modes(app: &AppHandle) -> Vec<TimerModeInfo> {
    let registry = app.state::<PluginRegistry>();
    let cfg_state = app.state::<ConfigState>();
    let Ok(plugins) = registry.0.lock() else {
        return Vec::new();
    };
    let Ok(cfg) = cfg_state.0.lock() else {
        return Vec::new();
    };
    plugins::enabled_timer_modes(&plugins, &cfg.plugins.enabled)
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    if let Some(mode_id) = id.strip_prefix(MENU_START_PREFIX) {
        start_via_event(app, mode_id);
        return;
    }
    match id {
        MENU_TOGGLE_OVERLAY => {
            let _ = overlay::overlay_toggle(app.clone());
        }
        MENU_OPEN => open_main_window(app),
        MENU_QUIT => quit_from_tray(app),
        _ => {}
    }
}

fn start_via_event(app: &AppHandle, mode: &str) {
    let engine = app.state::<EngineState>();
    let is_idle = engine
        .0
        .lock()
        .map(|s| s.status == TimerStatus::Idle)
        .unwrap_or(false);
    open_main_window(app);
    if !is_idle {
        return;
    }
    let _ = app.emit(
        "tray:start-session",
        serde_json::json!({ "mode": mode }),
    );
}

fn open_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn toggle_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);
    if visible && focused {
        let _ = window.hide();
    } else {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn update_tooltip(app: &AppHandle) {
    let Some(tray) = app.tray_by_id("flint-tray") else {
        return;
    };
    let engine = app.state::<EngineState>();
    let Ok(state) = engine.0.lock() else { return };
    let cfg_state = app.state::<ConfigState>();
    let show_timer = cfg_state
        .0
        .lock()
        .map(|c| c.tray.show_timer_in_tray)
        .unwrap_or(true);

    let label = match state.status {
        TimerStatus::Idle => "Flint".to_string(),
        TimerStatus::Running | TimerStatus::Paused => {
            let base = format!(
                "Flint — {}",
                match state.status {
                    TimerStatus::Running => "running",
                    TimerStatus::Paused => "paused",
                    _ => "",
                }
            );
            if show_timer {
                format!("{} · {}", base, format_elapsed(state.elapsed_sec))
            } else {
                base
            }
        }
    };
    let _ = tray.set_tooltip(Some(label));
}

fn format_elapsed(sec: u64) -> String {
    let h = sec / 3600;
    let m = (sec % 3600) / 60;
    let s = sec % 60;
    if h > 0 {
        format!("{}:{:02}:{:02}", h, m, s)
    } else {
        format!("{:02}:{:02}", m, s)
    }
}

pub fn quit_from_tray(app: &AppHandle) {
    // B-H2: If a session is running/paused when the user picks "Quit Flint"
    // from the tray, we must finalize it (as cancelled) so the JSON session
    // file is written to disk and recovery.json is cleaned up. Otherwise the
    // focus block silently disappears and the session auto-resumes with a
    // wrong elapsed on next launch.
    let engine = app.state::<EngineState>();
    let needs_finalize = engine
        .0
        .lock()
        .map(|s| s.status != TimerStatus::Idle)
        .unwrap_or(false);
    if needs_finalize {
        if let Ok(mut state) = engine.0.lock() {
            if let Err(e) = commands::finalize_session(&mut state, app, false) {
                eprintln!("[flint] finalize session on quit failed: {}", e);
            }
        }
    }
    // Tear the overlay down before app.exit() so its Win32 window class is
    // unregistered before the main window — reversing this order on Windows
    // intermittently trips a Chrome_WidgetWin_0 unregister crash
    // (exit code 0xcfffffff) when the overlay is still open at quit time.
    overlay::close_overlay_if_open(app);
    app.exit(0);
}
