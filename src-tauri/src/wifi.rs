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

// Use the BSS frequency, not a channel-number guess (6 GHz reuses numbers).
#[cfg(any(target_os = "windows", test))]
fn frequency_description(khz: u32) -> Option<String> {
    let mhz = khz / 1000;
    let (band, channel) = match mhz {
        2484 => ("2.4 GHz", 14),
        2412..=2472 if (mhz - 2407) % 5 == 0 => ("2.4 GHz", (mhz - 2407) / 5),
        5005..=5895 if mhz % 5 == 0 => ("5 GHz", (mhz - 5000) / 5),
        5935 => ("6 GHz", 2),
        5955..=7115 if (mhz - 5950) % 5 == 0 => ("6 GHz", (mhz - 5950) / 5),
        _ => return None,
    };
    Some(format!("{band} · channel {channel}."))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reports_measured_frequency_without_confusing_6ghz_channels() {
        assert_eq!(
            frequency_description(5180000).as_deref(),
            Some("5 GHz · channel 36.")
        );
        assert_eq!(
            frequency_description(2437000).as_deref(),
            Some("2.4 GHz · channel 6.")
        );
        assert_eq!(
            frequency_description(2484000).as_deref(),
            Some("2.4 GHz · channel 14.")
        );
        assert_eq!(
            frequency_description(5955000).as_deref(),
            Some("6 GHz · channel 1.")
        );
        assert_eq!(frequency_description(0), None);
        assert_eq!(frequency_description(5181000), None);
    }
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
