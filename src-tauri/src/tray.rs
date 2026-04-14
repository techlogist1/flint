use crate::commands::{self, ConfigState, EngineState};
use crate::overlay;
use crate::timer::TimerStatus;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

const MENU_START_POMODORO: &str = "start_pomodoro";
const MENU_START_STOPWATCH: &str = "start_stopwatch";
const MENU_START_COUNTDOWN: &str = "start_countdown";
const MENU_TOGGLE_OVERLAY: &str = "toggle_overlay";
const MENU_OPEN: &str = "open_flint";
const MENU_QUIT: &str = "quit_flint";

pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let start_pomodoro =
        MenuItem::with_id(app, MENU_START_POMODORO, "Start Pomodoro", true, None::<&str>)?;
    let start_stopwatch =
        MenuItem::with_id(app, MENU_START_STOPWATCH, "Start Stopwatch", true, None::<&str>)?;
    let start_countdown =
        MenuItem::with_id(app, MENU_START_COUNTDOWN, "Start Countdown", true, None::<&str>)?;
    let toggle_overlay =
        MenuItem::with_id(app, MENU_TOGGLE_OVERLAY, "Show / Hide Overlay", true, None::<&str>)?;
    let open_flint =
        MenuItem::with_id(app, MENU_OPEN, "Open Flint", true, None::<&str>)?;
    let separator_a = PredefinedMenuItem::separator(app)?;
    let separator_b = PredefinedMenuItem::separator(app)?;
    let quit_flint =
        MenuItem::with_id(app, MENU_QUIT, "Quit Flint", true, Some("CmdOrCtrl+Q"))?;

    let menu = Menu::with_items(
        app,
        &[
            &start_pomodoro,
            &start_stopwatch,
            &start_countdown,
            &separator_a,
            &toggle_overlay,
            &separator_b,
            &open_flint,
            &quit_flint,
        ],
    )?;

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

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        MENU_START_POMODORO => start_via_event(app, "pomodoro"),
        MENU_START_STOPWATCH => start_via_event(app, "stopwatch"),
        MENU_START_COUNTDOWN => start_via_event(app, "countdown"),
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
    app.exit(0);
}
