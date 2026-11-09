use tauri::{LogicalPosition, LogicalSize, Manager};

#[tauri::command]
fn resize_panel(window: tauri::WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    let monitor = window
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("No primary monitor available")?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let width = width
        .clamp(200.0, 980.0)
        .min(area.size.width as f64 / scale - 32.0);
    let height = height
        .clamp(38.0, 560.0)
        .min(area.size.height as f64 / scale - 32.0);
    let x = area.position.x as f64 / scale + (area.size.width as f64 / scale - width) / 2.0;
    let y = area.position.y as f64 / scale;
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    window
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn quit_demo(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .ok_or("Missing panel window")?;
            window.set_focusable(false)?;
            resize_panel(window.clone(), 420.0, 38.0)?;
            window.show()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![resize_panel, quit_demo])
        .run(tauri::generate_context!())
        .expect("error while running panel demo");
}
