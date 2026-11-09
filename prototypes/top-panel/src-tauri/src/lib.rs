use tauri::{Emitter, LogicalPosition, LogicalSize, Manager};

// The compact bar is positioned once. Opening the drawer never resizes or moves it.
fn position_windows(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let bar = app
        .get_webview_window("main")
        .ok_or("Missing compact bar")?;
    let drawer = app.get_webview_window("drawer").ok_or("Missing drawer")?;
    let monitor = bar
        .primary_monitor()?
        .ok_or("No primary monitor available")?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let available_width = area.size.width as f64 / scale;
    let available_height = area.size.height as f64 / scale;
    let left = area.position.x as f64 / scale;
    let top = area.position.y as f64 / scale;
    let bar_width = 600.0_f64.min(available_width - 32.0);
    let drawer_width = 920.0_f64.min(available_width - 32.0);
    bar.set_size(LogicalSize::new(bar_width, 38.0))?;
    bar.set_position(LogicalPosition::new(
        left + (available_width - bar_width) / 2.0,
        top,
    ))?;
    drawer.set_size(LogicalSize::new(
        drawer_width,
        522.0_f64.min(available_height - 70.0),
    ))?;
    drawer.set_position(LogicalPosition::new(
        left + (available_width - drawer_width) / 2.0,
        top + 38.0,
    ))?;
    Ok(())
}

#[tauri::command]
fn set_drawer_open(app: tauri::AppHandle, open: bool) -> Result<(), String> {
    let drawer = app.get_webview_window("drawer").ok_or("Missing drawer")?;
    drawer
        .emit("drawer-visibility", open)
        .map_err(|e| e.to_string())?;
    if open {
        drawer.show().map_err(|e| e.to_string())?;
    } else {
        drawer.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn sync_drawer(app: tauri::AppHandle, html: String) -> Result<(), String> {
    app.emit_to("drawer", "drawer-view", html)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn drawer_message(app: tauri::AppHandle, message: String) -> Result<(), String> {
    if ![
        "ready", "enter", "leave", "pin", "collapse", "quit", "read", "reset", "ended", "accepted",
    ]
    .contains(&message.as_str())
    {
        return Err("Unknown drawer action".into());
    }
    app.emit_to("main", "drawer-action", message)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn quit_demo(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            for label in ["main", "drawer"] {
                app.get_webview_window(label)
                    .ok_or("Missing demo window")?
                    .set_focusable(false)?;
            }
            position_windows(app.handle())?;
            app.get_webview_window("main")
                .ok_or("Missing compact bar")?
                .show()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_drawer_open,
            sync_drawer,
            drawer_message,
            quit_demo
        ])
        .run(tauri::generate_context!())
        .expect("error while running panel demo");
}
