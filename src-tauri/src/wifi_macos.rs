use super::{validate, Active, Session, WifiNetwork};
use serde_json::{json, Value};
use std::ffi::{c_char, CStr, CString};

extern "C" {
    fn pulsedrop_wifi_macos(input: *const c_char) -> *mut c_char;
    fn pulsedrop_wifi_macos_free(response: *mut c_char);
}
fn call(input: Value) -> Result<Value, String> {
    let encoded = CString::new(input.to_string()).map_err(|_| "Invalid Wi-Fi request")?;
    let response = unsafe { pulsedrop_wifi_macos(encoded.as_ptr()) };
    if response.is_null() {
        return Err("macOS did not return a Wi-Fi response.".into());
    }
    let decoded = serde_json::from_slice(unsafe { CStr::from_ptr(response).to_bytes() });
    unsafe {
        pulsedrop_wifi_macos_free(response);
    }
    let value: Value = decoded.map_err(|_| "Could not read the macOS Wi-Fi response")?;
    if let Some(error) = value["error"].as_str() {
        return Err(error.into());
    }
    Ok(value)
}
pub(crate) fn available() -> bool {
    call(json!({"operation":"available"})).is_ok_and(|value| value["available"] == true)
}
pub(crate) fn scan() -> Result<Vec<WifiNetwork>, String> {
    let value = call(json!({"operation":"scan"}))?;
    serde_json::from_value(value["networks"].clone())
        .map_err(|_| "Could not read nearby Wi-Fi networks".into())
}
pub(crate) fn join(
    ssid: &str,
    password: &str,
    bssid: Option<&str>,
    interface: Option<&str>,
) -> Result<Active, String> {
    validate(ssid, password)?;
    let value = call(
        json!({"operation":"join", "ssid":ssid, "password":password, "bssid":bssid.unwrap_or(""), "interface":interface.unwrap_or("")}),
    )?;
    Ok(Active {
        session: Session {
            role: "sender",
            ssid: ssid.into(),
            password: String::new(),
            address: None,
        },
        interface: value["interface"]
            .as_str()
            .ok_or("Missing Wi-Fi interface")?
            .into(),
        identity: value["bssid"]
            .as_str()
            .ok_or("Missing access point address")?
            .into(),
        previous: value["previous"]
            .as_str()
            .filter(|name| !name.is_empty())
            .map(String::from),
    })
}
pub(crate) fn is_active(active: &Active) -> Result<bool, String> {
    call(json!({"operation":"current", "ssid":active.session.ssid, "interface":active.interface, "bssid":active.identity}))
        .map(|value| value["active"] == true)
}
pub(crate) fn stop(active: &Active) -> Result<(), String> {
    call(json!({"operation":"stop", "ssid":active.session.ssid, "interface":active.interface, "bssid":active.identity, "previous":active.previous.as_deref().unwrap_or("")})).map(|_| ())
}
