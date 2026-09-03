//! The desktop shell: Tauri, the fs and dialog plugins, and two commands
//! the web build has no use for.
//!
//! Everything interesting happens in the shared frontend. The two commands
//! here exist because a browser cannot do either thing:
//!
//!  - `opened_with` reports the path notey was launched with, so
//!    `notey ~/notes/plan.md` opens that file (and double-clicking a `.md`
//!    associated with notey does the same, since the shell passes the path
//!    the same way).
//!  - `allow_folder` widens the fs plugin's scope at run time. The
//!    capability in `capabilities/default.json` can only name paths known
//!    when the app was built — `$DOCUMENT/Notey` — but the whole point of
//!    choosing a folder is that it is somewhere else. Nothing is read or
//!    written here; this only permits it, and only for a folder the user
//!    named through the picker or on the command line.

use tauri_plugin_fs::FsExt;

/// The path notey was launched with, if it was launched with one.
#[tauri::command]
fn opened_with() -> Option<String> {
    std::env::args()
        .nth(1)
        .filter(|arg| !arg.trim().is_empty() && !arg.starts_with('-'))
}

/// Permit the vault to live in `path`. Recursive: a vault is a tree.
#[tauri::command]
fn allow_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.fs_scope()
        .allow_directory(&path, true)
        .map_err(|err| err.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![opened_with, allow_folder])
        .run(tauri::generate_context!())
        .expect("error while running notey");
}
