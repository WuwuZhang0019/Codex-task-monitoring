use fs2::FileExt;
use rand::RngCore;
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

struct Runtime {
    root: PathBuf,
    resources: PathBuf,
    child: Mutex<Option<Child>>,
    endpoint: Mutex<Option<String>>,
    token: String,
    _lock: File,
}

fn private_command(executable: &std::path::Path) -> Command {
    let mut command = Command::new(executable);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

fn start_owner(runtime: &Runtime) -> Result<(), String> {
    let mut guard = runtime.child.lock().map_err(|e| e.to_string())?;
    if let Some(child) = guard.as_mut() {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            return Ok(());
        }
    }
    *runtime.endpoint.lock().unwrap() = None;
    #[cfg(windows)]
    {
        let account = std::env::var("USERNAME").map_err(|e| e.to_string())?;
        // WebView2 owns its profile ACLs. Protect business data separately.
        let private_data = runtime.root.join("data");
        fs::create_dir_all(&private_data).map_err(|e| e.to_string())?;
        let result = private_command(std::path::Path::new("icacls.exe"))
            .arg(&private_data)
            .args([
                "/inheritance:r",
                "/grant:r",
                &format!("{account}:(OI)(CI)F"),
                "SYSTEM:(OI)(CI)F",
                "/Q",
            ])
            .output()
            .map_err(|e| e.to_string())?;
        if !result.status.success() {
            return Err("无法保护当前用户的私有数据目录".into());
        }
    }
    let data = runtime.root.join("data");
    let discovery = data.join("owner.json");
    if discovery.exists() {
        fs::remove_file(&discovery).map_err(|e| e.to_string())?;
    }
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(runtime.root.join("runtime.log"))
        .map_err(|e| e.to_string())?;
    let child = private_command(&runtime.resources.join("node.exe"))
        .arg(runtime.resources.join("app/desktop/owner.mjs"))
        .env("WORKBENCH_DATA_DIR", &data)
        .env("WORKBENCH_SESSION_TOKEN", &runtime.token)
        .env_remove("NODE_OPTIONS")
        .stdin(Stdio::piped())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log)
        .spawn()
        .map_err(|e| format!("运行组件启动失败 {e}"))?;
    *guard = Some(child);
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(10) {
        if let Ok(bytes) = fs::read(&discovery) {
            if let Ok(record) = serde_json::from_slice::<Value>(&bytes) {
                if record["pid"].as_u64() == guard.as_ref().map(|c| c.id() as u64) {
                    let endpoint = record["endpoint"]
                        .as_str()
                        .filter(|s| s.starts_with("http://127.0.0.1:"))
                        .ok_or("无效所有者地址")?;
                    *runtime.endpoint.lock().unwrap() = Some(endpoint.to_string());
                    return Ok(());
                }
            }
        }
        if guard
            .as_mut()
            .unwrap()
            .try_wait()
            .map_err(|e| e.to_string())?
            .is_some()
        {
            return Err("领域服务启动失败，请查看 runtime.log".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if let Some(child) = guard.as_mut() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Err("领域服务启动超过 10 秒".into())
}

#[tauri::command]
fn runtime_status(state: tauri::State<Runtime>) -> Value {
    json!({"dataPath":state.root.join("data").display().to_string(),"needsSetup": !state.root.join("data/projects.json").exists() || state.root.join("data/.migration-pending.json").exists(),"migrationPending":state.root.join("data/.migration-pending.json").exists(),"running": state.endpoint.lock().unwrap().is_some()})
}

#[tauri::command]
fn recover_workspace(
    window: tauri::WebviewWindow,
    state: tauri::State<Runtime>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("仅主窗口可以恢复工作区".into());
    }
    let output = private_command(&state.resources.join("node.exe"))
        .arg(state.resources.join("app/desktop/migrate.mjs"))
        .arg("--recover")
        .arg(state.root.join("data"))
        .env_remove("NODE_OPTIONS")
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(())
}

#[tauri::command]
async fn initialize_workspace(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Runtime>,
    source: Option<String>,
    source_stopped: bool,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("仅主窗口可以初始化工作区".into());
    }
    if let Some(source) = source {
        if !source_stopped || !PathBuf::from(&source).is_absolute() {
            return Err("请提供旧数据绝对路径并确认旧服务已停写".into());
        }
        if state.root.join("data/projects.json").exists() {
            return Err("当前工作区已初始化".into());
        }
        let output = private_command(&state.resources.join("node.exe"))
            .arg(state.resources.join("app/desktop/migrate.mjs"))
            .arg(source)
            .arg(state.root.join("data"))
            .env_remove("NODE_OPTIONS")
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
    }
    start_owner(&state)
}

fn allowed_request(path: &str, method: &str) -> bool {
    if path.contains('?') || path.contains('%') || path.contains('\\') {
        return false;
    }
    let parts: Vec<&str> = path.split('/').collect();
    match parts.as_slice() {
        ["", "health" | "sample"] => method == "GET",
        ["", "import-drafts"] => matches!(method, "GET" | "POST"),
        ["", "requests"] => method == "POST",
        ["", "import-drafts", id] => valid_id(id) && matches!(method, "GET" | "PUT"),
        ["", "import-drafts", id, "validate" | "confirm" | "publish"] => valid_id(id) && method == "POST",
        ["", "projects"] => matches!(method, "GET" | "POST"),
        ["", "projects", id] => valid_id(id) && matches!(method, "GET" | "PUT"),
        ["", "projects", id, action] => {
            valid_id(id)
                && match *action {
                    "model" => matches!(method, "GET" | "PUT"),
                    "monitor" | "receipts" | "business" => matches!(method, "GET" | "POST"),
                    "outputs" => method == "POST",
                    _ => false,
                }
        }
        _ => false,
    }
}
fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.chars().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

#[tauri::command]
async fn api_request(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Runtime>,
    path: String,
    method: String,
    body: Option<Value>,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("仅主窗口可以请求业务服务".into());
    }
    if !allowed_request(&path, &method) {
        return Err("禁止的桌面请求".into());
    }
    let bytes = body.as_ref().map(|v| v.to_string()).unwrap_or_default();
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("请求体超过 2MB".into());
    }
    let endpoint = state
        .endpoint
        .lock()
        .unwrap()
        .clone()
        .ok_or("领域服务未运行")?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client
        .request(
            method.parse().map_err(|_| "无效请求方法")?,
            format!("{endpoint}/api{path}"),
        )
        .bearer_auth(&state.token);
    if body.is_some() {
        request = request
            .header("Content-Type", "application/json")
            .body(bytes);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "领域服务连接失败，请从托盘主动恢复")?;
    let status = response.status().as_u16();
    let value: Value = response.json().await.map_err(|_| "领域服务响应无效")?;
    Ok(json!({"status":status,"data":value}))
}

fn stop_owner(runtime: &Runtime) {
    if let Ok(mut child) = runtime.child.lock() {
        if let Some(mut process) = child.take() {
            if let Some(input) = process.stdin.as_mut() {
                let _ = writeln!(input, "stop");
            }
            // The owner drains requests before exiting. Never terminate an in-flight write here.
            let _ = process.wait();
        }
    }
    *runtime.endpoint.lock().unwrap() = None;
}

fn perform_runtime_action(app: &tauri::AppHandle, action: &str) -> Result<(), String> {
    match action {
        "show" => {
            let window = app.get_webview_window("main").ok_or("主窗口不存在")?;
            window.show().map_err(|e| e.to_string())?;
            let _ = window.unminimize();
            window.set_focus().map_err(|e| e.to_string())?;
        }
        "panel" => app
            .get_webview_window("panel")
            .ok_or("浮窗不存在")?
            .show()
            .map_err(|e| e.to_string())?,
        "recover" => {
            let handle = app.clone();
            std::thread::spawn(move || {
                let _ = start_owner(&handle.state::<Runtime>());
            });
        }
        "exit" => {
            let handle = app.clone();
            std::thread::spawn(move || {
                stop_owner(&handle.state::<Runtime>());
                handle.exit(0);
            });
        }
        _ => return Err("未知桌面动作".into()),
    }
    Ok(())
}

#[tauri::command]
fn runtime_action(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    action: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("仅主窗口可以执行桌面动作".into());
    }
    perform_runtime_action(&app, &action)
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let root = app.path().app_local_data_dir()?;
            #[cfg(debug_assertions)]
            let root = std::env::var_os("WORKBENCH_DESKTOP_TEST_ROOT")
                .map(PathBuf::from)
                .unwrap_or(root);
            fs::create_dir_all(&root)?;
            let lock = OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(root.join("desktop.lock"))?;
            if lock.try_lock_exclusive().is_err() {
                fs::write(root.join("show.request"), b"show")?;
                app.handle().exit(0);
                return Ok(());
            }
            let mut random = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut random);
            let token = random
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            let resources = dunce::simplified(&app.path().resource_dir()?).join("runtime");
            let root = dunce::simplified(&root).to_path_buf();
            let runtime = Runtime {
                root: root.clone(),
                resources,
                child: Mutex::new(None),
                endpoint: Mutex::new(None),
                token,
                _lock: lock,
            };
            if root.join("data/projects.json").exists()
                && !root.join("data/.migration-pending.json").exists()
            {
                // Keep the recovery UI available if existing data or the child fails.
                let _ = start_owner(&runtime);
            }
            app.manage(runtime);
            let show = MenuItem::with_id(app, "show", "打开工作台", true, None::<&str>)?;
            let panel = MenuItem::with_id(app, "panel", "显示浮窗宿主", true, None::<&str>)?;
            let recover = MenuItem::with_id(app, "recover", "恢复领域服务", true, None::<&str>)?;
            let exit = MenuItem::with_id(app, "exit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &panel, &recover, &exit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| {
                    let _ = perform_runtime_action(app, event.id.as_ref());
                })
                .build(app)?;
            tauri::WebviewWindowBuilder::new(
                app,
                "panel",
                tauri::WebviewUrl::App("panel.html".into()),
            )
            .title("任务航线 · 浮窗宿主")
            .inner_size(600.0, 38.0)
            .decorations(false)
            .always_on_top(true)
            .focused(false)
            .visible(false)
            .build()?;
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                if root.join("show.request").exists() {
                    let _ = fs::remove_file(root.join("show.request"));
                    if let Some(w) = handle.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                    }
                }
                std::thread::sleep(Duration::from_millis(250));
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            runtime_action,
            runtime_status,
            initialize_workspace,
            recover_workspace,
            api_request
        ])
        .run(tauri::generate_context!())
        .expect("桌面宿主运行失败");
}

#[cfg(test)]
mod tests {
    use super::allowed_request;
    #[test]
    fn desktop_transport_rejects_arbitrary_targets_and_methods() {
        assert!(allowed_request("/projects", "POST"));
        assert!(allowed_request("/import-drafts", "POST"));
        assert!(allowed_request(
            "/import-drafts/12345678-1234-1234-1234-123456789abc/publish",
            "POST"
        ));
        assert!(allowed_request(
            "/projects/12345678-1234-1234-1234-123456789abc/business",
            "POST"
        ));
        assert!(!allowed_request("/import-drafts/other/publish", "POST"));
        assert!(!allowed_request("/requests", "GET"));
        assert!(allowed_request(
            "/projects/12345678-1234-1234-1234-123456789abc/model",
            "PUT"
        ));
        for path in [
            "http://example.com",
            "/projects/../health",
            "/projects/%2e%2e",
            "/projects?token=x",
            "/ai/extract",
            "/projects/other-project/model",
        ] {
            assert!(!allowed_request(path, "POST"));
        }
        assert!(!allowed_request("/projects", "DELETE"));
    }
}
