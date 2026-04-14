use std::fs;
use std::path::PathBuf;

fn ensure_flint_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "could not resolve home directory".to_string())?;
    let flint_dir = home.join(".flint");
    let sessions_dir = flint_dir.join("sessions");
    let plugins_dir = flint_dir.join("plugins");

    for dir in [&flint_dir, &sessions_dir, &plugins_dir] {
        fs::create_dir_all(dir)
            .map_err(|e| format!("failed to create {}: {}", dir.display(), e))?;
    }

    Ok(flint_dir)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    match ensure_flint_dir() {
        Ok(path) => println!("[flint] data directory ready at {}", path.display()),
        Err(e) => eprintln!("[flint] {}", e),
    }

    tauri::Builder::default()
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
