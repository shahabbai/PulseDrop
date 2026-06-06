use if_addrs::{get_if_addrs, IfAddr};
use serde::Serialize;
#[cfg(target_os = "windows")]
use std::process::Command;
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream, UdpSocket},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

const DEFAULT_PORT: u16 = 53612;
const MAX_HEADER_BYTES: usize = 64 * 1024;

#[derive(Default)]
struct ReceiverState {
    runtime: Mutex<Option<ReceiverRuntime>>,
}

struct ReceiverRuntime {
    port: u16,
    code: String,
    inbox_dir: PathBuf,
    stop: std::sync::Arc<AtomicBool>,
}

#[derive(Clone, Serialize)]
struct NetworkAddress {
    ip: String,
    interface_name: String,
    label: String,
    is_private: bool,
    is_vpn_like: bool,
}

#[derive(Serialize)]
struct DeviceProfile {
    name: String,
    platform: String,
    arch: String,
    primary_ip: Option<String>,
    network_ips: Vec<NetworkAddress>,
}

#[derive(Clone, Serialize)]
struct ReceiveSession {
    ip_address: Option<String>,
    ip_addresses: Vec<NetworkAddress>,
    port: u16,
    code: String,
    inbox_dir: String,
}

#[derive(Clone, Serialize)]
struct ReceivedFile {
    name: String,
    size: u64,
    path: String,
}

#[derive(Clone, Serialize)]
struct DiagnosticItem {
    status: String,
    title: String,
    message: String,
    detail: String,
    can_fix: bool,
}

#[derive(Clone, Serialize)]
struct WindowsDiagnostics {
    is_windows: bool,
    app_path: String,
    network: DiagnosticItem,
    firewall: DiagnosticItem,
}
#[tauri::command]
fn device_profile() -> DeviceProfile {
    let network_ips = local_ipv4_candidates();
    let primary_ip = network_ips
        .first()
        .map(|address| address.ip.clone())
        .or_else(default_route_ip_address);

    DeviceProfile {
        name: device_name(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        primary_ip,
        network_ips,
    }
}

#[tauri::command]
fn start_receiver(
    app: AppHandle,
    state: State<'_, ReceiverState>,
) -> Result<ReceiveSession, String> {
    let mut runtime = state
        .runtime
        .lock()
        .map_err(|_| "Receiver state is unavailable".to_string())?;

    if let Some(active) = runtime.as_ref() {
        return Ok(session_from_runtime(active));
    }

    let inbox_dir = inbox_dir(&app)?;
    fs::create_dir_all(&inbox_dir).map_err(|error| format!("Could not create inbox: {error}"))?;

    let listener = bind_receiver()?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Could not read receiver port: {error}"))?
        .port();
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Could not configure receiver: {error}"))?;

    let code = pairing_code();
    let stop = std::sync::Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let thread_code = code.clone();
    let thread_inbox = inbox_dir.clone();
    let thread_app = app.clone();

    thread::spawn(move || {
        receiver_loop(listener, thread_app, thread_inbox, thread_code, thread_stop);
    });

    let active = ReceiverRuntime {
        port,
        code,
        inbox_dir,
        stop,
    };
    let session = session_from_runtime(&active);
    *runtime = Some(active);

    Ok(session)
}

#[tauri::command]
fn stop_receiver(state: State<'_, ReceiverState>) -> Result<(), String> {
    let mut runtime = state
        .runtime
        .lock()
        .map_err(|_| "Receiver state is unavailable".to_string())?;

    if let Some(active) = runtime.take() {
        active.stop.store(true, Ordering::Relaxed);
    }

    Ok(())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn open_inbox(app: AppHandle) -> Result<(), String> {
    let path = inbox_dir(&app)?;
    fs::create_dir_all(&path).map_err(|error| format!("Could not create inbox: {error}"))?;
    tauri_plugin_opener::open_path(path.to_string_lossy().to_string(), None::<&str>)
        .map_err(|error| format!("Could not open inbox: {error}"))
}

#[cfg(target_os = "android")]
#[tauri::command]
fn open_inbox(_app: AppHandle) -> Result<(), String> {
    let inbox = public_android_inbox_dir();
    tauri_plugin_opener::open_path(inbox.to_string_lossy().to_string(), None::<&str>)
        .or_else(|_| tauri_plugin_opener::open_path("/storage/emulated/0/Download", None::<&str>))
        .map_err(|error| format!("Could not open Android Downloads: {error}"))
}

#[tauri::command]
fn windows_diagnostics() -> WindowsDiagnostics {
    collect_windows_diagnostics()
}

#[tauri::command]
fn fix_windows_network_profile() -> Result<String, String> {
    fix_windows_network_profile_impl()
}

#[tauri::command]
fn fix_windows_firewall() -> Result<String, String> {
    fix_windows_firewall_impl()
}

fn diagnostic_item(
    status: &str,
    title: &str,
    message: &str,
    detail: &str,
    can_fix: bool,
) -> DiagnosticItem {
    DiagnosticItem {
        status: status.to_string(),
        title: title.to_string(),
        message: message.to_string(),
        detail: detail.to_string(),
        can_fix,
    }
}

fn current_app_path_string() -> String {
    std::env::current_exe()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[cfg(not(target_os = "windows"))]
fn collect_windows_diagnostics() -> WindowsDiagnostics {
    WindowsDiagnostics {
        is_windows: false,
        app_path: current_app_path_string(),
        network: diagnostic_item(
            "unsupported",
            "Windows network profile",
            "This fix runs on the Windows PC receiver.",
            "Open Settings on the Windows app to check Public or Private network state.",
            false,
        ),
        firewall: diagnostic_item(
            "unsupported",
            "Windows Firewall",
            "This fix runs on the Windows PC receiver.",
            "Open Settings on the Windows app to add the installed PulseDrop executable to Windows Firewall.",
            false,
        ),
    }
}

#[cfg(target_os = "windows")]
fn collect_windows_diagnostics() -> WindowsDiagnostics {
    let app_path = current_app_path_string();
    WindowsDiagnostics {
        is_windows: true,
        app_path: app_path.clone(),
        network: check_windows_network_profile(),
        firewall: check_windows_firewall(&app_path),
    }
}

#[cfg(not(target_os = "windows"))]
fn fix_windows_network_profile_impl() -> Result<String, String> {
    Err("Windows network profile fixes must be run on the Windows PC receiver.".to_string())
}

#[cfg(not(target_os = "windows"))]
fn fix_windows_firewall_impl() -> Result<String, String> {
    Err("Windows Firewall fixes must be run on the Windows PC receiver.".to_string())
}

#[cfg(target_os = "windows")]
fn fix_windows_network_profile_impl() -> Result<String, String> {
    let script = r#"
$ErrorActionPreference = "Stop"
$profiles = @(Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq "Public" -and ($_.IPv4Connectivity -ne "Disconnected" -or $_.IPv6Connectivity -ne "Disconnected") })
foreach ($profile in $profiles) {
  Set-NetConnectionProfile -InterfaceIndex $profile.InterfaceIndex -NetworkCategory Private
}
"#;

    run_elevated_powershell("network-profile", script)?;
    Ok("Network profile fix finished.".to_string())
}

#[cfg(target_os = "windows")]
fn fix_windows_firewall_impl() -> Result<String, String> {
    let app_path = current_app_path_string();
    if app_path.trim().is_empty() {
        return Err("Could not resolve the installed PulseDrop executable path.".to_string());
    }

    let quoted_path = powershell_single_quote(&app_path);
    let script = format!(
        r#"
$ErrorActionPreference = "Stop"
$program = {quoted_path}
$ruleName = "PulseDrop Receiver"
Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Program $program -Action Allow -Profile Private -Protocol TCP -Enabled True | Out-Null
"#
    );

    run_elevated_powershell("firewall", &script)?;
    Ok("Firewall fix finished.".to_string())
}

#[cfg(target_os = "windows")]
fn check_windows_network_profile() -> DiagnosticItem {
    let script = r#"
$profiles = @(Get-NetConnectionProfile | Where-Object { $_.IPv4Connectivity -ne "Disconnected" -or $_.IPv6Connectivity -ne "Disconnected" })
if ($profiles.Count -eq 0) {
  "UNKNOWN|No active Windows network profile was found."
} else {
  $details = ($profiles | ForEach-Object { "$($_.Name) [$($_.InterfaceAlias)] = $($_.NetworkCategory)" }) -join "; "
  $public = @($profiles | Where-Object { $_.NetworkCategory -eq "Public" })
  if ($public.Count -gt 0) {
    "WARN|" + $details
  } else {
    "OK|" + $details
  }
}
"#;

    match run_powershell_capture(script) {
        Ok(output) => {
            let (status, detail) = output
                .split_once("|")
                .unwrap_or(("UNKNOWN", output.as_str()));
            match status.trim() {
                "OK" => diagnostic_item(
                    "ok",
                    "Windows network profile",
                    "Your active Windows network is Private.",
                    detail.trim(),
                    false,
                ),
                "WARN" => diagnostic_item(
                    "warn",
                    "Windows network profile",
                    "Your active Windows network is Public. Phone uploads are often blocked in this mode.",
                    detail.trim(),
                    true,
                ),
                _ => diagnostic_item(
                    "unknown",
                    "Windows network profile",
                    "PulseDrop could not confirm your Windows network profile.",
                    detail.trim(),
                    false,
                ),
            }
        }
        Err(error) => diagnostic_item(
            "unknown",
            "Windows network profile",
            "PulseDrop could not inspect your Windows network profile.",
            &error,
            false,
        ),
    }
}

#[cfg(target_os = "windows")]
fn check_windows_firewall(app_path: &str) -> DiagnosticItem {
    if app_path.trim().is_empty() {
        return diagnostic_item(
            "unknown",
            "Windows Firewall",
            "PulseDrop could not resolve the installed app path.",
            "",
            false,
        );
    }

    let quoted_path = powershell_single_quote(app_path);
    let script = format!(
        r#"
$program = {quoted_path}
$rules = @(Get-NetFirewallApplicationFilter -Program $program -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object {{ $_.Enabled -eq "True" -and $_.Direction -eq "Inbound" -and $_.Action -eq "Allow" }})
if ($rules.Count -gt 0) {{
  "OK|" + (($rules | Select-Object -ExpandProperty DisplayName) -join ", ")
}} else {{
  "WARN|No enabled inbound allow rule was found for " + $program
}}
"#
    );

    match run_powershell_capture(&script) {
        Ok(output) => {
            let (status, detail) = output
                .split_once("|")
                .unwrap_or(("UNKNOWN", output.as_str()));
            match status.trim() {
                "OK" => diagnostic_item(
                    "ok",
                    "Windows Firewall",
                    "PulseDrop is allowed through Windows Firewall.",
                    detail.trim(),
                    false,
                ),
                "WARN" => diagnostic_item(
                    "warn",
                    "Windows Firewall",
                    "Windows Firewall does not have an inbound allow rule for this installed app.",
                    detail.trim(),
                    true,
                ),
                _ => diagnostic_item(
                    "unknown",
                    "Windows Firewall",
                    "PulseDrop could not confirm the Windows Firewall rule.",
                    detail.trim(),
                    false,
                ),
            }
        }
        Err(error) => diagnostic_item(
            "unknown",
            "Windows Firewall",
            "PulseDrop could not inspect Windows Firewall.",
            &error,
            false,
        ),
    }
}

#[cfg(target_os = "windows")]
fn run_powershell_capture(script: &str) -> Result<String, String> {
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .output()
        .map_err(|error| format!("Could not start PowerShell: {error}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            "PowerShell returned an error.".to_string()
        } else {
            stderr
        })
    }
}

#[cfg(target_os = "windows")]
fn run_elevated_powershell(name: &str, script: &str) -> Result<(), String> {
    let script_path = std::env::temp_dir().join(format!("pulsedrop-{name}.ps1"));
    fs::write(&script_path, script)
        .map_err(|error| format!("Could not prepare fix script: {error}"))?;

    let script_arg = format!(
        "-NoProfile -ExecutionPolicy Bypass -File \"{}\"",
        script_path.to_string_lossy()
    );
    let command = format!(
        "Start-Process -FilePath powershell -Verb RunAs -Wait -ArgumentList {}",
        powershell_single_quote(&script_arg)
    );

    let status = Command::new("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &command,
        ])
        .status()
        .map_err(|error| format!("Could not start elevated PowerShell: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(
            "The Windows fix did not complete. If a UAC prompt opened, approve it and try again."
                .to_string(),
        )
    }
}

#[cfg(target_os = "windows")]
fn powershell_single_quote(value: &str) -> String {
    let quote = char::from(39);
    let mut escaped = String::with_capacity(value.len() + 2);
    escaped.push(quote);
    for character in value.chars() {
        if character == quote {
            escaped.push(quote);
            escaped.push(quote);
        } else {
            escaped.push(character);
        }
    }
    escaped.push(quote);
    escaped
}
fn bind_receiver() -> Result<TcpListener, String> {
    TcpListener::bind(("0.0.0.0", DEFAULT_PORT))
        .or_else(|_| TcpListener::bind(("0.0.0.0", 0)))
        .map_err(|error| format!("Could not start receiver: {error}"))
}

fn receiver_loop(
    listener: TcpListener,
    app: AppHandle,
    inbox_dir: PathBuf,
    code: String,
    stop: std::sync::Arc<AtomicBool>,
) {
    while !stop.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, _)) => {
                let app = app.clone();
                let inbox_dir = inbox_dir.clone();
                let code = code.clone();
                thread::spawn(move || {
                    if let Err(error) = handle_stream(stream, &app, &inbox_dir, &code) {
                        eprintln!("Receiver error: {error}");
                    }
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(80));
            }
            Err(error) => {
                eprintln!("Receiver accept error: {error}");
                thread::sleep(Duration::from_millis(250));
            }
        }
    }
}

fn handle_stream(
    mut stream: TcpStream,
    app: &AppHandle,
    inbox_dir: &Path,
    expected_code: &str,
) -> Result<(), String> {
    stream
        .set_nonblocking(false)
        .map_err(|error| format!("Could not configure connection: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(60)))
        .map_err(|error| format!("Could not configure read timeout: {error}"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(15)))
        .map_err(|error| format!("Could not configure write timeout: {error}"))?;

    let request = read_http_request(&mut stream)?;

    if request.method == "OPTIONS" {
        write_response(&mut stream, 204, "No Content", "", "text/plain")?;
        return Ok(());
    }

    if request.method == "GET" && request.path == "/health" {
        let code = request.query.get("code").cloned().unwrap_or_default();
        if code != expected_code {
            write_response(
                &mut stream,
                403,
                "Forbidden",
                "Pairing code does not match",
                "text/plain",
            )?;
        } else {
            write_response(&mut stream, 200, "OK", "Ready", "text/plain")?;
        }
        return Ok(());
    }

    if request.method != "POST" || !request.path.starts_with("/upload") {
        write_response(&mut stream, 404, "Not Found", "Not found", "text/plain")?;
        return Ok(());
    }

    let code = request.query.get("code").cloned().unwrap_or_default();
    if code != expected_code {
        write_response(
            &mut stream,
            403,
            "Forbidden",
            "Pairing code does not match",
            "text/plain",
        )?;
        return Ok(());
    }

    let file_name = request
        .query
        .get("name")
        .map(|name| sanitize_file_name(name))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "received-file".to_string());

    let content_length = request
        .headers
        .get("content-length")
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| "Missing content length".to_string())?;

    let target_path = available_file_path(inbox_dir, &file_name);
    let mut target = File::create(&target_path)
        .map_err(|error| format!("Could not create received file: {error}"))?;

    if !request.body_start.is_empty() {
        let initial_len = request.body_start.len().min(content_length as usize);
        target
            .write_all(&request.body_start[..initial_len])
            .map_err(|error| format!("Could not write received file: {error}"))?;
    }

    let mut remaining = content_length.saturating_sub(request.body_start.len() as u64);
    let mut buffer = [0_u8; 64 * 1024];
    while remaining > 0 {
        let max_read = buffer.len().min(remaining as usize);
        let read_len = stream
            .read(&mut buffer[..max_read])
            .map_err(|error| format!("Could not read upload: {error}"))?;
        if read_len == 0 {
            return Err("Upload ended early".to_string());
        }
        target
            .write_all(&buffer[..read_len])
            .map_err(|error| format!("Could not write upload: {error}"))?;
        remaining -= read_len as u64;
    }

    write_response(&mut stream, 200, "OK", "Saved", "text/plain")?;
    let _ = app.emit(
        "file-received",
        ReceivedFile {
            name: file_name,
            size: content_length,
            path: target_path.to_string_lossy().to_string(),
        },
    );

    Ok(())
}

struct HttpRequest {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body_start: Vec<u8>,
}

fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest, String> {
    let mut reader = BufReader::new(stream);
    let mut raw = Vec::new();

    loop {
        let mut line = Vec::new();
        let read = reader
            .read_until(b'\n', &mut line)
            .map_err(|error| format!("Could not read request: {error}"))?;
        if read == 0 {
            return Err("Connection closed".to_string());
        }
        raw.extend_from_slice(&line);
        if raw.ends_with(b"\r\n\r\n") || raw.ends_with(b"\n\n") {
            break;
        }
        if raw.len() > MAX_HEADER_BYTES {
            return Err("Request header is too large".to_string());
        }
    }

    let mut body_start = Vec::new();
    let consumed = reader.buffer().len();
    if consumed > 0 {
        body_start.extend_from_slice(reader.buffer());
        reader.consume(consumed);
    }

    let header_text =
        String::from_utf8(raw).map_err(|_| "Request was not valid UTF-8".to_string())?;
    let mut lines = header_text.lines();
    let request_line = lines
        .next()
        .ok_or_else(|| "Missing request line".to_string())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default().to_string();
    let target = request_parts.next().unwrap_or_default();
    let (path, query) = parse_target(target);

    let mut headers = HashMap::new();
    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            headers.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    Ok(HttpRequest {
        method,
        path,
        query,
        headers,
        body_start,
    })
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    body: &str,
    content_type: &str,
) -> Result<(), String> {
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
         Access-Control-Allow-Headers: content-type\r\n\
         Content-Type: {content_type}; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n{}",
        body.as_bytes().len(),
        body
    );
    stream
        .write_all(response.as_bytes())
        .map_err(|error| format!("Could not write response: {error}"))
}

fn parse_target(target: &str) -> (String, HashMap<String, String>) {
    let (path, query_text) = target.split_once('?').unwrap_or((target, ""));
    let mut query = HashMap::new();
    for pair in query_text.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        query.insert(percent_decode(key), percent_decode(value));
    }
    (path.to_string(), query)
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(hex) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                output.push(hex);
                index += 3;
                continue;
            }
        }

        output.push(if bytes[index] == b'+' {
            b' '
        } else {
            bytes[index]
        });
        index += 1;
    }

    String::from_utf8_lossy(&output).to_string()
}

fn sanitize_file_name(name: &str) -> String {
    name.chars()
        .map(|char| match char {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            _ => char,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string()
}

fn available_file_path(dir: &Path, file_name: &str) -> PathBuf {
    let candidate = dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }

    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("file");
    let extension = path.extension().and_then(|value| value.to_str());

    for index in 1.. {
        let next_name = match extension {
            Some(extension) => format!("{stem} ({index}).{extension}"),
            None => format!("{stem} ({index})"),
        };
        let next = dir.join(next_name);
        if !next.exists() {
            return next;
        }
    }

    candidate
}

fn session_from_runtime(runtime: &ReceiverRuntime) -> ReceiveSession {
    let ip_addresses = local_ipv4_candidates();
    let ip_address = ip_addresses
        .first()
        .map(|address| address.ip.clone())
        .or_else(default_route_ip_address);

    ReceiveSession {
        ip_address,
        ip_addresses,
        port: runtime.port,
        code: runtime.code.clone(),
        inbox_dir: display_inbox_dir(&runtime.inbox_dir)
            .to_string_lossy()
            .to_string(),
    }
}

#[cfg(target_os = "android")]
fn display_inbox_dir(_actual_dir: &Path) -> PathBuf {
    public_android_inbox_dir()
}

#[cfg(not(target_os = "android"))]
fn display_inbox_dir(actual_dir: &Path) -> PathBuf {
    actual_dir.to_path_buf()
}

#[cfg(target_os = "android")]
fn public_android_inbox_dir() -> PathBuf {
    PathBuf::from("/storage/emulated/0/Download/PulseDrop/Inbox")
}

fn inbox_dir(app: &AppHandle) -> Result<PathBuf, String> {
    inbox_base_dir(app).map(|path| path.join("PulseDrop").join("Inbox"))
}

#[cfg(target_os = "android")]
fn inbox_base_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .download_dir()
        .unwrap_or_else(|_| PathBuf::from("/storage/emulated/0/Download")))
}

#[cfg(not(target_os = "android"))]
fn inbox_base_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))
}

fn pairing_code() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{:06}", nanos % 1_000_000)
}

fn local_ipv4_candidates() -> Vec<NetworkAddress> {
    let mut candidates = Vec::new();

    if let Ok(interfaces) = get_if_addrs() {
        for interface in interfaces {
            let IfAddr::V4(v4) = interface.addr else {
                continue;
            };

            let ip = v4.ip;
            if !is_shareable_ipv4(ip) {
                continue;
            }

            candidates.push(NetworkAddress {
                ip: ip.to_string(),
                interface_name: interface.name.clone(),
                label: format!("{} ({})", ip, interface.name),
                is_private: is_private_lan_ipv4(ip),
                is_vpn_like: is_vpn_like_interface(&interface.name),
            });
        }
    }

    candidates.sort_by(|left, right| {
        network_address_score(right)
            .cmp(&network_address_score(left))
            .then_with(|| left.ip.cmp(&right.ip))
    });
    candidates.dedup_by(|left, right| left.ip == right.ip);

    if candidates.is_empty() {
        if let Some(ip) = default_route_ip_address() {
            candidates.push(NetworkAddress {
                label: format!("{} (default route)", ip),
                interface_name: "default route".to_string(),
                is_private: false,
                is_vpn_like: false,
                ip,
            });
        }
    }

    candidates
}

fn network_address_score(address: &NetworkAddress) -> i32 {
    let Ok(ip) = address.ip.parse::<Ipv4Addr>() else {
        return -1_000;
    };

    let mut score = 0;
    if is_private_lan_ipv4(ip) {
        score += 100;
    }
    if is_wifi_or_ethernet_interface(&address.interface_name) {
        score += 120;
    }
    if is_vpn_like_interface(&address.interface_name) {
        score -= 260;
    }
    if is_virtual_like_interface(&address.interface_name) {
        score -= 90;
    }
    if is_mobile_data_interface(&address.interface_name) {
        score -= 70;
    }
    if is_cgnat_ipv4(ip) {
        score -= 120;
    }

    let octets = ip.octets();
    if octets[0] == 192 && octets[1] == 168 {
        score += 28;
    } else if octets[0] == 172 && (16..=31).contains(&octets[1]) {
        score += 18;
    } else if octets[0] == 10 {
        score += 8;
    }

    score
}

fn is_shareable_ipv4(ip: Ipv4Addr) -> bool {
    !ip.is_loopback() && !ip.is_unspecified() && !is_link_local_ipv4(ip) && !ip.is_broadcast()
}

fn is_private_lan_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    a == 10 || (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 168)
}

fn is_link_local_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    a == 169 && b == 254
}

fn is_cgnat_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    a == 100 && (64..=127).contains(&b)
}

fn is_wifi_or_ethernet_interface(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.contains("wi-fi")
        || name.contains("wifi")
        || name.contains("wireless")
        || name.contains("wlan")
        || name.contains("ethernet")
        || name.contains("local area connection")
        || name == "eth0"
        || name.starts_with("eth")
        || name.starts_with("en")
}

fn is_vpn_like_interface(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.contains("vpn")
        || name.contains("wireguard")
        || name.starts_with("wg")
        || name.starts_with("tun")
        || name.starts_with("tap")
        || name.starts_with("utun")
        || name.starts_with("ppp")
        || name.contains("tailscale")
        || name.contains("zerotier")
        || name.contains("nord")
        || name.contains("proton")
        || name.contains("openvpn")
        || name.contains("anyconnect")
        || name.contains("fortinet")
        || name.contains("cisco")
        || name.contains("cloudflare")
        || name.contains("warp")
        || name.contains("mullvad")
        || name.contains("hamachi")
}

fn is_virtual_like_interface(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.contains("virtual")
        || name.contains("vethernet")
        || name.contains("hyper-v")
        || name.contains("vmware")
        || name.contains("vbox")
        || name.contains("docker")
        || name.contains("bridge")
        || name.contains("bluetooth")
        || name.contains("npcap")
}

fn is_mobile_data_interface(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.contains("rmnet")
        || name.contains("ccmni")
        || name.contains("wwan")
        || name.contains("cellular")
}

fn default_route_ip_address() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    socket
        .local_addr()
        .ok()
        .map(|address| address.ip().to_string())
}

fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "This device".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(ReceiverState::default())
        .invoke_handler(tauri::generate_handler![
            device_profile,
            start_receiver,
            stop_receiver,
            open_inbox,
            windows_diagnostics,
            fix_windows_network_profile,
            fix_windows_firewall
        ])
        .run(tauri::generate_context!())
        .expect("error while running PulseDrop");
}
