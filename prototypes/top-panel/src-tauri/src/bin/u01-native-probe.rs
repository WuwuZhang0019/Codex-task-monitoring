#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{fs::OpenOptions, io::Write, sync::Mutex};
use tauri::{LogicalPosition, LogicalSize, Manager, State, WebviewUrl, WebviewWindow};

type Handle = *mut std::ffi::c_void;
#[repr(C)]
#[derive(Default, serde::Serialize)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct Point {
    x: i32,
    y: i32,
}
#[link(name = "user32")]
unsafe extern "system" {
    fn SetWindowRgn(hwnd: Handle, region: Handle, redraw: i32) -> i32;
    fn GetWindowRect(hwnd: Handle, rect: *mut Rect) -> i32;
    fn GetForegroundWindow() -> Handle;
    fn GetWindowLongPtrW(hwnd: Handle, index: i32) -> isize;
    fn GetDpiForWindow(hwnd: Handle) -> u32;
    fn WindowFromPoint(point: Point) -> Handle;
    fn GetAncestor(hwnd: Handle, flags: u32) -> Handle;
}
#[link(name = "gdi32")]
unsafe extern "system" {
    fn CreateRoundRectRgn(
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
        width: i32,
        height: i32,
    ) -> Handle;
    fn DeleteObject(object: Handle) -> i32;
}

struct ProbeState {
    log: Mutex<std::fs::File>,
    frame: Mutex<u64>,
}
fn record(state: &ProbeState, value: serde_json::Value) -> Result<(), String> {
    writeln!(state.log.lock().map_err(|e| e.to_string())?, "{value}").map_err(|e| e.to_string())
}

#[tauri::command]
fn probe_frame(
    window: WebviewWindow,
    state: State<ProbeState>,
    frame: u64,
    progress: f64,
) -> Result<serde_json::Value, String> {
    if window.label() != "u01-panel" || !progress.is_finite() || !(0.0..=1.0).contains(&progress) {
        return Err("Invalid probe frame".into());
    }
    let mut previous = state.frame.lock().map_err(|e| e.to_string())?;
    if frame <= *previous {
        return Err("Stale probe frame".into());
    }
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let width = (600.0 + 320.0 * progress) * scale;
    let height = (38.0 + 522.0 * progress) * scale;
    let left = ((920.0 * scale - width) / 2.0).round() as i32;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0;
    let mut rect = Rect::default();
    let value = unsafe {
        let region = CreateRoundRectRgn(
            left,
            0,
            left + width.round() as i32 + 1,
            height.round() as i32 + 1,
            1,
            1,
        );
        if region.is_null() {
            return Err("CreateRoundRectRgn failed".into());
        }
        if SetWindowRgn(hwnd, region, 1) == 0 {
            DeleteObject(region);
            return Err("SetWindowRgn failed".into());
        }
        GetWindowRect(hwnd, &mut rect);
        let outside = WindowFromPoint(Point {
            x: rect.left + 4,
            y: rect.top + 150,
        });
        let inside = WindowFromPoint(Point {
            x: rect.left + (460.0 * scale) as i32,
            y: rect.top + 15,
        });
        serde_json::json!({"date":"2026-11-09", "kind":"frame", "frame":frame, "progress":progress,
            "rect":rect, "scale":scale, "dpi":GetDpiForWindow(hwnd),
            "foreground":GetForegroundWindow() as usize, "panel":hwnd as usize,
            "topmost":GetWindowLongPtrW(hwnd, -20) & 8 != 0,
            "noActivate":GetWindowLongPtrW(hwnd, -20) & 0x08000000 != 0,
            "outsideRoot":GetAncestor(outside, 2) as usize, "insideRoot":GetAncestor(inside, 2) as usize,
            "region":{"left":left,"width":width.round(),"height":height.round()}})
    };
    *previous = frame;
    record(&state, value.clone())?;
    Ok(value)
}

#[tauri::command]
fn probe_input(
    window: WebviewWindow,
    state: State<ProbeState>,
    kind: String,
    value: String,
) -> Result<(), String> {
    if !["input", "click", "ready", "measurement", "complete"].contains(&kind.as_str())
        || value.len() > 2000
    {
        return Err("Invalid probe input".into());
    }
    if kind == "ready" && window.label() == "u01-panel" {
        window.show().map_err(|e| e.to_string())?;
    }
    record(
        &state,
        serde_json::json!({"date":"2026-11-09","window":window.label(),"kind":kind,"value":value}),
    )
}

fn main() {
    let log_path =
        std::env::var("U01_NATIVE_LOG").expect("Set U01_NATIVE_LOG to an isolated evidence file");
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .expect("Cannot open probe log");
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    tauri::Builder::default()
        .manage(ProbeState {
            log: Mutex::new(log),
            frame: Mutex::new(0),
        })
        .setup(|app| {
            let input = tauri::WebviewWindowBuilder::new(
                app,
                "u01-input",
                WebviewUrl::App("u01-input.html".into()),
            )
            .title("U01 原生输入测试 2026-11-09")
            .inner_size(1100.0, 760.0)
            .build()?;
            let monitor = input.primary_monitor()?.ok_or("No monitor")?;
            let scale = monitor.scale_factor();
            let area = monitor.work_area();
            let x = area.position.x as f64 / scale + (area.size.width as f64 / scale - 920.0) / 2.0;
            let y = area.position.y as f64 / scale;
            input.set_position(LogicalPosition::new(x - 90.0, y))?;
            let panel = tauri::WebviewWindowBuilder::new(
                app,
                "u01-panel",
                WebviewUrl::App("u01-probe.html".into()),
            )
            .title("U01 固定宿主探测 2026-11-09")
            .inner_size(920.0, 560.0)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .resizable(false)
            .focused(false)
            .visible(false)
            .build()?;
            panel.set_focusable(false)?;
            panel.set_size(LogicalSize::new(920.0, 560.0))?;
            panel.set_position(LogicalPosition::new(x, y))?;
            let state = app.state::<ProbeState>();
            record(
                &state,
                serde_json::json!({"date":"2026-11-09","kind":"environment",
                "monitorSize":monitor.size(),"workArea":area,"scale":scale,
                "inputHwnd":input.hwnd()?.0 as usize,"panelHwnd":panel.hwnd()?.0 as usize}),
            )?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![probe_frame, probe_input])
        .run(context)
        .expect("U01 native feasibility probe failed");
}
