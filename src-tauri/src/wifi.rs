//! Native desktop clients. No shell commands, persistent password profiles or
//! administrative privileges are needed to join a receiver's WPA2 hotspot.
#[cfg(any(target_os = "windows", target_os = "macos"))]
use super::{Session, WifiNetwork};

pub(super) fn validate(ssid: &str, password: &str) -> Result<(), String> {
    if ssid.is_empty() || ssid.len() > 32 || ssid.chars().any(char::is_control) {
        return Err("Enter the receiver’s Wi-Fi name (up to 32 bytes).".into());
    }
    if !(8..=63).contains(&password.len())
        || !password.bytes().all(|byte| (32..=126).contains(&byte))
    {
        return Err("Enter its 8–63 character WPA2 Wi-Fi password.".into());
    }
    Ok(())
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
pub(super) struct Active {
    pub session: Session,
    interface: String,
    identity: String,
    previous: Option<String>,
}

// Kept pure so XML/Unicode/password edge cases are tested on every CI runner.
#[cfg(any(target_os = "windows", test))]
fn profile_xml(ssid: &str, password: &str) -> Result<String, String> {
    validate(ssid, password)?;
    let hex: String = ssid.bytes().map(|byte| format!("{byte:02X}")).collect();
    let escaped = password
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;");
    Ok(format!(
        r#"<?xml version="1.0"?><WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1"><name>PulseDrop temporary connection</name><SSIDConfig><SSID><hex>{hex}</hex></SSID><nonBroadcast>false</nonBroadcast></SSIDConfig><connectionType>ESS</connectionType><connectionMode>manual</connectionMode><MSM><security><authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption><sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>{escaped}</keyMaterial></sharedKey></security></MSM></WLANProfile>"#
    ))
}

#[cfg(target_os = "windows")]
#[path = "wifi_windows.rs"]
mod native;
#[cfg(target_os = "macos")]
#[path = "wifi_macos.rs"]
mod native;
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub(super) use native::{available, is_active, join, scan, stop};

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn temporary_windows_profile_escapes_password_and_uses_exact_utf8_ssid() {
        let profile = profile_xml("Phone & 中文", "test<&>\"'password").unwrap();
        assert!(profile.contains("<hex>50686F6E65202620E4B8ADE69687</hex>"));
        assert!(profile.contains("test&lt;&amp;&gt;&quot;&apos;password"));
        assert!(profile.contains("<connectionMode>manual</connectionMode>"));
        assert!(!profile.contains("Phone & 中文"));
        assert!(profile_xml("wifi\nname", "password123").is_err());
        assert!(profile_xml("😀".repeat(9).as_str(), "password123").is_err());
        assert!(profile_xml("Phone", "bad\npassword").is_err());
    }
}
