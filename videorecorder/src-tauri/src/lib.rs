mod recorder;

// Import the state and the commands into the local scope
use recorder::{RecorderState, start_recording, stop_recording, get_open_windows};
use tauri::Manager;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn toggle_overlay(app: tauri::AppHandle, show: bool) {
    if let Some(window) = app.get_webview_window("overlay") {
        if show {
            window.show().unwrap();
        } else {
            window.hide().unwrap();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(RecorderState::new())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            start_recording,    // Now registered without recorder::
            stop_recording,     // Now registered without recorder::
            get_open_windows,   // Now registered without recorder::
            toggle_overlay
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}