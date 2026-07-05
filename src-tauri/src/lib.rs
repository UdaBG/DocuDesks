use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

/// PDF paths passed on the command line, handed to the frontend once it asks.
struct PendingFiles(Mutex<Vec<String>>);

fn pdf_args<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    args.into_iter()
        .filter(|a| a.to_lowercase().ends_with(".pdf"))
        // std::path::absolute, not canonicalize: the latter yields \\?\-prefixed
        // paths on Windows that the fs-scope globs would not match.
        .filter_map(|a| std::path::absolute(&a).map(|p| p.to_string_lossy().into_owned()).ok())
        .collect()
}

#[tauri::command]
fn get_pending_files(state: State<PendingFiles>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

/// Automation hook: lets scripts and integrations pre-select the output folder.
#[tauri::command]
fn get_output_dir_override() -> Option<String> {
    std::env::var("SIGNER_OUTPUT_DIR").ok().filter(|s| !s.is_empty())
}

/// Send PDFs to the OS print pipeline via the shell "print" verb.
#[tauri::command]
fn print_files(paths: Vec<String>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        for p in paths {
            std::process::Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-WindowStyle",
                    "Hidden",
                    "-Command",
                    &format!("Start-Process -FilePath '{}' -Verb Print", p.replace('\'', "''")),
                ])
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        for p in paths {
            std::process::Command::new("lp")
                .arg(&p)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        let files = pdf_args(argv.into_iter().skip(1));
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.unminimize();
            let _ = win.set_focus();
            if !files.is_empty() {
                let _ = win.emit("files-opened", files);
            }
        }
    }));

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .manage(PendingFiles(Mutex::new(pdf_args(std::env::args().skip(1)))))
        .setup(|app| {
            // Android WebView scales all web text by the system font size
            // (Vivo "large font" etc.), blowing up the px-based UI. The
            // document has its own zoom — pin the UI text to 100%.
            #[cfg(target_os = "android")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.with_webview(|webview| {
                        webview.jni_handle().exec(|env, _activity, webview| {
                            if let Ok(settings) = env
                                .call_method(
                                    webview,
                                    "getSettings",
                                    "()Landroid/webkit/WebSettings;",
                                    &[],
                                )
                                .and_then(|v| v.l())
                            {
                                let _ = env.call_method(
                                    &settings,
                                    "setTextZoom",
                                    "(I)V",
                                    &[jni::objects::JValue::Int(100)],
                                );
                            }
                        });
                    });
                }
            }
            // WebView2 consumes touchpad pinches for its own page-scale zoom
            // before the page sees them; disable that so pinches reach the
            // app as ctrl+wheel events (smooth zoom in the edit view).
            #[cfg(target_os = "windows")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.with_webview(|webview| unsafe {
                        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings5;
                        use windows::core::Interface;
                        if let Ok(core) = webview.controller().CoreWebView2() {
                            if let Ok(settings) = core.Settings() {
                                if let Ok(s5) = settings.cast::<ICoreWebView2Settings5>() {
                                    let _ = s5.SetIsPinchZoomEnabled(false);
                                }
                            }
                        }
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_pending_files, get_output_dir_override, print_files])
        .run(tauri::generate_context!())
        .expect("error while running DocuDesk Lite");
}
