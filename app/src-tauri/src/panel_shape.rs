// 日期 2026-11-11。固定原生宿主；CSS 与原生命中区域使用同一确认进度。
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{Manager, WebviewWindow};

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Layout {
    pub width: f64,
    pub height: f64,
    pub compact_width: f64,
    pub compact_height: f64,
    pub scale: f64,
    pub x: i32,
    pub y: i32,
}

impl Layout {
    pub(crate) fn new(
        x: i32,
        y: i32,
        work_width: u32,
        work_height: u32,
        scale: f64,
    ) -> Result<Self, String> {
        if !scale.is_finite() || scale <= 0.0 || work_width == 0 || work_height == 0 {
            return Err("显示区域或缩放无效".into());
        }
        let width = 960.0_f64.min(work_width as f64 / scale - 32.0).max(1.0);
        let height = 678.0_f64.min(work_height as f64 / scale - 16.0).max(1.0);
        Ok(Self {
            width,
            height,
            compact_width: 600.0_f64.min(width),
            compact_height: 38.0_f64.min(height),
            scale,
            x: x + ((work_width as f64 - width * scale) / 2.0).round() as i32,
            y,
        })
    }

    fn shape(self, progress: f64) -> Geometry {
        let width = self.compact_width + (self.width - self.compact_width) * progress;
        let height = self.compact_height + (self.height - self.compact_height) * progress;
        Geometry {
            progress,
            left: (self.width - width) / 2.0,
            width,
            height,
            radius: (18.0 + 2.0 * progress).min(width / 2.0).min(height),
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Geometry {
    progress: f64,
    left: f64,
    width: f64,
    height: f64,
    radius: f64,
}

#[derive(Default)]
struct ShapeState {
    layout: Option<Layout>,
    pinned: Option<bool>,
    last_frame: u64,
    progress: f64,
}

impl ShapeState {
    fn accepts(&self, frame: u64) -> bool {
        frame > self.last_frame
    }
}

#[derive(Default)]
pub(crate) struct PanelShapeState(Mutex<ShapeState>);

fn frame_metrics(layout: Layout, shape: Geometry, frame: u64, applied: bool) -> Value {
    json!({
        "applied": applied, "frame": frame, "progress": shape.progress, "left": shape.left, "top": 0,
        "shapeWidth": shape.width, "shapeHeight": shape.height, "radius": shape.radius,
        "hostWidth": layout.width, "hostHeight": layout.height, "scaleFactor": layout.scale
    })
}

// 此函数只从 setup 或 run_on_main_thread 中调用；不在动画路径修改窗口矩形。
pub(crate) fn configure(window: &WebviewWindow, pinned: bool) -> Result<Value, String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or(window
            .app_handle()
            .primary_monitor()
            .map_err(|e| e.to_string())?)
        .ok_or("显示区域不可用")?;
    let area = monitor.work_area();
    let layout = Layout::new(
        area.position.x,
        area.position.y,
        area.size.width,
        area.size.height,
        monitor.scale_factor(),
    )?;
    let shared = window.state::<PanelShapeState>();
    let mut state = shared.0.lock().map_err(|e| e.to_string())?;
    if state.layout != Some(layout) {
        // 仅初始化或显示区域变化进入此分支，日常展开/收起始终复用同一宿主。
        window
            .set_size(tauri::LogicalSize::new(layout.width, layout.height))
            .map_err(|e| e.to_string())?;
        window
            .set_position(tauri::PhysicalPosition::new(layout.x, layout.y))
            .map_err(|e| e.to_string())?;
        apply_region(window, layout, layout.shape(state.progress))?;
        state.layout = Some(layout);
    }
    if state.pinned != Some(pinned) {
        // pinned 表示固定展开；悬停和紧凑态也始终置顶。
        window.set_always_on_top(true).map_err(|e| e.to_string())?;
        state.pinned = Some(pinned);
    }
    let metrics = json!({"compactWidth":layout.compact_width,"compactHeight":layout.compact_height,
        "width":layout.width,"height":layout.height,"scaleFactor":layout.scale,"pinned":pinned,
        "x":layout.x,"y":layout.y,"progress":state.progress});
    debug_record("configure", &metrics, window);
    Ok(metrics)
}

pub(crate) fn set_pinned(window: &WebviewWindow, pinned: bool) -> Result<Value, String> {
    let shared = window.state::<PanelShapeState>();
    let mut state = shared.0.lock().map_err(|e| e.to_string())?;
    if state.pinned != Some(pinned) {
        window.set_always_on_top(true).map_err(|e| e.to_string())?;
        state.pinned = Some(pinned);
    }
    Ok(json!({"pinned":pinned,"progress":state.progress}))
}

// 单调序号在窗口线程内核对并应用；重载页面使用真实时钟高位生成新序号。
pub(crate) fn apply_frame(
    window: &WebviewWindow,
    frame: u64,
    progress: f64,
) -> Result<Value, String> {
    if frame == 0 || !progress.is_finite() || !(0.0..=1.0).contains(&progress) {
        return Err("浮窗动画帧或进度无效".into());
    }
    let shared = window.state::<PanelShapeState>();
    let mut state = shared.0.lock().map_err(|e| e.to_string())?;
    let layout = state.layout.ok_or("浮窗几何尚未初始化")?;
    if !state.accepts(frame) {
        return Ok(frame_metrics(
            layout,
            layout.shape(state.progress),
            state.last_frame,
            false,
        ));
    }
    let geometry = layout.shape(progress);
    apply_region(window, layout, geometry)?;
    state.progress = progress;
    state.last_frame = frame;
    let metrics = frame_metrics(layout, geometry, frame, true);
    debug_record("frame", &metrics, window);
    Ok(metrics)
}

pub(crate) fn show_without_activation(window: &WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    {
        // ShowWindow 返回先前的可见状态而非成功标记，不能把 0 当失败。
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0;
        unsafe {
            native::ShowWindow(hwnd, 4);
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        window.show().map_err(|e| e.to_string())
    }
}

#[cfg(windows)]
mod native {
    pub type Handle = *mut std::ffi::c_void;
    #[repr(C)]
    #[derive(Default, serde::Serialize)]
    pub struct Rect {
        pub left: i32,
        pub top: i32,
        pub right: i32,
        pub bottom: i32,
    }
    #[link(name = "user32")]
    unsafe extern "system" {
        pub fn SetWindowRgn(hwnd: Handle, region: Handle, redraw: i32) -> i32;
        pub fn ShowWindow(hwnd: Handle, command: i32) -> i32;
        pub fn GetWindowRect(hwnd: Handle, rect: *mut Rect) -> i32;
        pub fn GetForegroundWindow() -> Handle;
        pub fn GetDpiForWindow(hwnd: Handle) -> u32;
    }
    #[link(name = "gdi32")]
    unsafe extern "system" {
        pub fn CreateRoundRectRgn(
            left: i32,
            top: i32,
            right: i32,
            bottom: i32,
            ellipse_width: i32,
            ellipse_height: i32,
        ) -> Handle;
        pub fn CreateRectRgn(left: i32, top: i32, right: i32, bottom: i32) -> Handle;
        pub fn CombineRgn(destination: Handle, first: Handle, second: Handle, mode: i32) -> i32;
        pub fn DeleteObject(object: Handle) -> i32;
    }
}

fn apply_region(window: &WebviewWindow, layout: Layout, geometry: Geometry) -> Result<(), String> {
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0;
        // 向外取整最多保护 1 个物理像素，顶部矩形与下方圆角区域合并。
        let left = (geometry.left * layout.scale).floor() as i32;
        let right = ((geometry.left + geometry.width) * layout.scale).ceil() as i32;
        let bottom = (geometry.height * layout.scale).ceil() as i32;
        let radius = (geometry.radius * layout.scale).round().max(1.0) as i32;
        unsafe {
            let region = native::CreateRoundRectRgn(left, 0, right, bottom, radius * 2, radius * 2);
            if region.is_null() {
                return Err("无法创建浮窗圆角区域".into());
            }
            let top = native::CreateRectRgn(left, 0, right, (bottom - radius).max(1));
            if top.is_null() {
                native::DeleteObject(region);
                return Err("无法创建浮窗顶部区域".into());
            }
            let combined = native::CombineRgn(region, region, top, 2);
            native::DeleteObject(top);
            if combined == 0 {
                native::DeleteObject(region);
                return Err("无法合并浮窗形状".into());
            }
            if native::SetWindowRgn(hwnd, region, 1) == 0 {
                native::DeleteObject(region);
                return Err("无法应用浮窗可见和命中区域".into());
            }
            // 成功后 HRGN 归系统所有；不得再次释放。
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (window, layout, geometry);
        Err("当前系统不支持浮窗原生区域裁剪".into())
    }
}

#[cfg(debug_assertions)]
fn debug_record(kind: &str, metrics: &Value, window: &WebviewWindow) {
    use std::{
        fs::OpenOptions,
        io::Write,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };
    let Some(target) = std::env::var_os("WORKBENCH_PANEL_DIAGNOSTICS").map(PathBuf::from) else {
        return;
    };
    // 诊断仅允许显式开启并写入本仓库 app/test-results 内已有目录。
    let allowed = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test-results");
    let (Ok(allowed), Some(parent)) = (allowed.canonicalize(), target.parent()) else {
        return;
    };
    let Ok(parent) = parent.canonicalize() else {
        return;
    };
    if !target.is_absolute()
        || !parent.starts_with(allowed)
        || target.extension().and_then(|s| s.to_str()) != Some("jsonl")
    {
        return;
    }
    let mut value = json!({"kind":kind,"metrics":metrics,"timestampMs":SystemTime::now().duration_since(UNIX_EPOCH).map(|t|t.as_millis()).unwrap_or(0)});
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        let mut rect = native::Rect::default();
        unsafe {
            native::GetWindowRect(hwnd.0, &mut rect);
            value["windowRect"] = json!(rect);
            value["dpi"] = json!(native::GetDpiForWindow(hwnd.0));
            value["foreground"] = json!(native::GetForegroundWindow() as usize);
            value["panel"] = json!(hwnd.0 as usize);
        }
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(target) {
        let _ = writeln!(file, "{value}");
    }
}

#[cfg(not(debug_assertions))]
fn debug_record(_kind: &str, _metrics: &Value, _window: &WebviewWindow) {}

#[cfg(test)]
mod tests {
    use super::{Layout, ShapeState};
    #[test]
    fn geometry_keeps_top_and_center_across_progress_and_dpi() {
        for scale in [1.0, 1.25, 1.5, 2.0] {
            let layout = Layout::new(-1920, 24, 1920, 1080, scale).unwrap();
            assert_eq!(layout.y, 24);
            for progress in [0.0, 0.25, 0.5, 0.75, 1.0] {
                let shape = layout.shape(progress);
                assert!((shape.left + shape.width / 2.0 - layout.width / 2.0).abs() < 1e-9);
                assert!(shape.width <= layout.width && shape.height <= layout.height);
                assert!(shape.radius <= shape.height);
            }
            assert_eq!(layout.shape(0.0).width, layout.compact_width);
            assert_eq!(layout.shape(0.0).height, layout.compact_height);
            assert_eq!(layout.shape(1.0).width, layout.width);
            assert_eq!(layout.shape(1.0).height, layout.height);
        }
    }
    #[test]
    fn small_work_area_clamps_compact_and_expanded_geometry() {
        let layout = Layout::new(0, 0, 390, 740, 1.5).unwrap();
        assert_eq!(layout.width, 228.0);
        assert_eq!(layout.compact_width, layout.width);
        assert!(layout.height * layout.scale <= 740.0 - 16.0 * layout.scale);
        let tiny = Layout::new(0, 0, 10, 10, 1.0).unwrap();
        assert_eq!(tiny.compact_height, 1.0);
        assert!(Layout::new(0, 0, 0, 10, 1.0).is_err());
        assert!(Layout::new(0, 0, 10, 10, f64::NAN).is_err());
    }
    #[test]
    fn older_or_duplicate_frame_never_replaces_applied_state() {
        let state = ShapeState {
            last_frame: 1_794_367_200_000_002,
            progress: 0.6,
            ..Default::default()
        };
        assert!(!state.accepts(1_794_367_200_000_001));
        assert!(!state.accepts(1_794_367_200_000_002));
        assert!(state.accepts(1_794_367_200_000_003));
        assert_eq!(state.progress, 0.6);
    }
}
