//! Optional receiver-hosted Wi-Fi. The file transfer protocol stays unchanged.
use serde::Serialize;
#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
use std::sync::Mutex;

#[cfg(any(target_os = "windows", target_os = "macos", test))]
#[path = "wifi.rs"]
mod desktop;

#[derive(Clone, Serialize)]
pub(crate) struct Capabilities {
    pub can_host: bool,
    pub can_join: bool,
    pub can_scan: bool,
    pub platform: String,
    pub message: String,
}

#[derive(Clone, Serialize)]
pub(crate) struct Session {
    pub role: &'static str,
    pub ssid: String,
    pub password: String,
    pub address: Option<String>,
}

#[derive(Clone, Serialize, serde::Deserialize)]
pub(crate) struct WifiNetwork {
    pub ssid: String,
    pub bssid: String,
    pub signal: u8,
    pub security: String,
    pub interface: String,
}

#[derive(Default)]
pub(crate) struct HotspotState {
    #[cfg(target_os = "linux")]
    active: Mutex<Option<linux::Active>>,
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    client: Mutex<Option<desktop::Active>>,
}

impl HotspotState {
    pub fn current(&self) -> Result<Option<Session>, String> {
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            let mut active = self.client.lock().map_err(|_| "Wi-Fi state unavailable")?;
            if let Some(client) = active.as_ref() {
                if desktop::is_active(client)? {
                    return Ok(Some(client.session.clone()));
                }
                // A network selected outside PulseDrop belongs to the user.
                *active = None;
            }
        }
        #[cfg(target_os = "linux")]
        {
            let mut active = self
                .active
                .lock()
                .map_err(|_| "Hotspot state unavailable")?;
            if let Some(session) = active.as_ref() {
                if linux::is_active(session, &mut linux::nmcli)? {
                    return Ok(Some(session.session.clone()));
                }
                linux::stop(session, &mut linux::nmcli)?;
                *active = None;
            }
        }
        Ok(None)
    }

    pub fn capabilities(&self) -> Capabilities {
        #[cfg(target_os = "linux")]
        let can_host = linux::adapter(&mut linux::nmcli).is_ok();
        #[cfg(target_os = "linux")]
        let can_join = linux::client_adapter(&mut linux::nmcli).is_ok();
        #[cfg(not(target_os = "linux"))]
        let can_host = false;
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        let can_join = desktop::available();
        #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
        let can_join = false;
        Capabilities {
            can_host,
            can_join,
            can_scan: can_join,
            platform: std::env::consts::OS.into(),
            message: if can_host {
                "Creates a temporary Wi-Fi network. This may disconnect this device from its current Wi-Fi. No router or internet is needed.".into()
            } else {
                "Automatic hotspot creation is unavailable here. Use an Android 8+ or supported Linux device as the receiver, or enable a hotspot in system settings if your device supports it.".into()
            },
        }
    }

    pub fn scan(&self) -> Result<Vec<WifiNetwork>, String> {
        #[cfg(target_os = "linux")]
        {
            linux::scan(&mut linux::nmcli, true)
        }
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            desktop::scan()
        }
        #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
        Err("Use system Wi-Fi settings on this platform.".into())
    }

    pub fn join(
        &self,
        ssid: String,
        password: String,
        bssid: Option<String>,
        interface: Option<String>,
    ) -> Result<Session, String> {
        #[cfg(target_os = "linux")]
        {
            let mut active = self
                .active
                .lock()
                .map_err(|_| "Hotspot state unavailable")?;
            if active.is_some() {
                return Err("Disconnect the current PulseDrop hotspot first.".into());
            }
            let created = linux::join(
                &mut linux::nmcli,
                &ssid,
                &password,
                bssid.as_deref(),
                interface.as_deref(),
            )?;
            let session = created.session.clone();
            *active = Some(created);
            Ok(session)
        }
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            let mut active = self.client.lock().map_err(|_| "Wi-Fi state unavailable")?;
            if active.is_some() {
                return Err("Disconnect the current PulseDrop hotspot first.".into());
            }
            let created = desktop::join(&ssid, &password, bssid.as_deref(), interface.as_deref())?;
            let session = created.session.clone();
            *active = Some(created);
            Ok(session)
        }
        #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
        {
            let _ = (ssid, password, bssid, interface);
            Err("Use system Wi-Fi settings on this platform.".into())
        }
    }

    pub fn start(&self) -> Result<Session, String> {
        #[cfg(target_os = "linux")]
        {
            let mut active = self
                .active
                .lock()
                .map_err(|_| "Hotspot state unavailable")?;
            if let Some(session) = active.as_ref() {
                if session.session.role != "host" {
                    return Err(
                        "Disconnect the joined hotspot before creating a receiver hotspot.".into(),
                    );
                }
                return Ok(session.session.clone());
            }
            let created = linux::start(&mut linux::nmcli)?;
            let session = created.session.clone();
            *active = Some(created);
            Ok(session)
        }
        #[cfg(not(target_os = "linux"))]
        Err("Use system hotspot settings or an Android/Linux receiver to create a network.".into())
    }

    pub fn stop(&self) -> Result<(), String> {
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            let mut active = self.client.lock().map_err(|_| "Wi-Fi state unavailable")?;
            if let Some(client) = active.as_ref() {
                desktop::stop(client)?;
            }
            *active = None;
        }
        #[cfg(target_os = "linux")]
        {
            let mut active = self
                .active
                .lock()
                .map_err(|_| "Hotspot state unavailable")?;
            if let Some(session) = active.as_ref() {
                linux::stop(session, &mut linux::nmcli)?;
            }
            *active = None;
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{Session, WifiNetwork};
    use std::{
        fs::File,
        io::Read,
        process::{Command, Stdio},
        thread,
        time::{Duration, Instant},
    };

    pub struct Active {
        pub session: Session,
        uuid: String,
        interface: String,
        previous: Option<String>,
    }

    type Reply = Result<String, String>;
    type Runner<'a> = dyn FnMut(&[&str]) -> Reply + 'a;

    // No shell, no elevation, and no credentials in error output. NetworkManager
    // applies the user's normal permissions. Bound even an unresponsive daemon.
    pub fn nmcli(args: &[&str]) -> Reply {
        let mut child = Command::new("nmcli")
            .args(["--wait", "15"])
            .args(args)
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| {
                "NetworkManager (nmcli) is unavailable. Use system hotspot settings.".to_string()
            })?;
        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        return Err("NetworkManager could not complete this action. Check Wi-Fi, hotspot support, and your network permissions in Settings.".into());
                    }
                    let output = child
                        .wait_with_output()
                        .map_err(|_| "Could not read NetworkManager response")?;
                    return Ok(String::from_utf8_lossy(&output.stdout).trim().into());
                }
                Ok(None) if started.elapsed() < Duration::from_secs(20) => {
                    thread::sleep(Duration::from_millis(50))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("NetworkManager did not respond. Check system Wi-Fi settings and try again.".into());
                }
            }
        }
    }

    pub fn adapter(run: &mut Runner<'_>) -> Reply {
        let devices = run(&["-t", "-f", "DEVICE,TYPE", "device", "status"])?;
        for line in devices.lines() {
            let Some((name, kind)) = line.split_once(':') else {
                continue;
            };
            if kind != "wifi"
                || name.is_empty()
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
            {
                continue;
            }
            if run(&["-g", "WIFI-PROPERTIES.AP", "device", "show", name])
                .is_ok_and(|value| value == "yes")
            {
                return Ok(name.into());
            }
        }
        Err("No Wi-Fi adapter with hotspot support is available. Enable Wi-Fi or use another device as the receiver.".into())
    }

    pub fn client_adapter(run: &mut Runner<'_>) -> Reply {
        let devices = run(&["-t", "-f", "DEVICE,TYPE", "device", "status"])?;
        devices
            .lines()
            .find_map(|line| {
                let (name, kind) = line.split_once(':')?;
                (kind == "wifi"
                    && !name.is_empty()
                    && name
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b)))
                .then(|| name.to_string())
            })
            .ok_or_else(|| "No Wi-Fi adapter is available. Enable Wi-Fi and try again.".into())
    }

    fn fields(line: &str) -> Vec<String> {
        let mut fields = vec![String::new()];
        let mut escaped = false;
        for c in line.chars() {
            if escaped {
                fields.last_mut().unwrap().push(c);
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == ':' {
                fields.push(String::new());
            } else {
                fields.last_mut().unwrap().push(c);
            }
        }
        if escaped {
            fields.last_mut().unwrap().push('\\');
        }
        fields
    }

    pub fn scan(run: &mut Runner<'_>, refresh: bool) -> Result<Vec<WifiNetwork>, String> {
        let output = run(&[
            "-t",
            "-e",
            "yes",
            "-f",
            "SSID,BSSID,SIGNAL,SECURITY,DEVICE",
            "device",
            "wifi",
            "list",
            "--rescan",
            if refresh { "yes" } else { "no" },
        ])?;
        let mut networks = Vec::new();
        for line in output.lines() {
            let values = fields(line);
            if values.len() != 5
                || values[0].is_empty()
                || values[0].len() > 32
                || values[0].chars().any(char::is_control)
            {
                continue;
            }
            let Ok(signal) = values[2].parse::<u8>() else {
                continue;
            };
            if signal > 100 || !valid_bssid(&values[1]) {
                continue;
            }
            networks.push(WifiNetwork {
                ssid: values[0].clone(),
                bssid: values[1].clone(),
                signal,
                security: values[3].clone(),
                interface: values[4].clone(),
            });
        }
        networks.sort_by(|a, b| b.signal.cmp(&a.signal).then_with(|| a.ssid.cmp(&b.ssid)));
        networks.dedup_by(|a, b| a.bssid == b.bssid && a.interface == b.interface);
        networks.truncate(64);
        Ok(networks)
    }

    fn valid_bssid(value: &str) -> bool {
        let parts: Vec<_> = value.split(':').collect();
        parts.len() == 6
            && parts
                .iter()
                .all(|part| part.len() == 2 && part.bytes().all(|b| b.is_ascii_hexdigit()))
    }

    pub fn join(
        run: &mut Runner<'_>,
        ssid: &str,
        password: &str,
        bssid: Option<&str>,
        interface: Option<&str>,
    ) -> Result<Active, String> {
        if ssid.is_empty()
            || ssid.len() > 32
            || ssid.chars().any(char::is_control)
            || !(8..=63).contains(&password.len())
            || !password.bytes().all(|b| (32..=126).contains(&b))
        {
            return Err("Check the Wi-Fi name and its 8–63 character WPA2 password, or scan the receiver's QR code.".into());
        }
        let network = scan(run, false)?.into_iter().find(|network| network.ssid == ssid && bssid.map_or(true, |id| network.bssid == id) && interface.map_or(true, |name| network.interface == name))
            .ok_or("This hotspot is no longer visible. Keep the receiver nearby and refresh the Wi-Fi list.")?;
        if !network.security.contains("WPA2") {
            return Err("This network does not advertise WPA2. Use system Wi-Fi settings for other security types.".into());
        }
        let mut random = [0u8; 16];
        File::open("/dev/urandom")
            .and_then(|mut file| file.read_exact(&mut random))
            .map_err(|_| "Could not create a connection ID")?;
        let hex: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let uuid = format!(
            "{}-{}-4{}-a{}-{}",
            &hex[..8],
            &hex[8..12],
            &hex[13..16],
            &hex[17..20],
            &hex[20..32]
        );
        let previous = run(&[
            "-g",
            "GENERAL.CON-UUID",
            "device",
            "show",
            &network.interface,
        ])?;
        let mut active = Active {
            session: Session {
                role: "sender",
                ssid: ssid.into(),
                password: String::new(),
                address: None,
            },
            uuid,
            interface: network.interface,
            previous: if previous.is_empty() || previous == "--" {
                None
            } else {
                Some(previous)
            },
        };
        run(&[
            "connection",
            "add",
            "type",
            "wifi",
            "ifname",
            &active.interface,
            "con-name",
            &format!("PulseDrop-join-{}", &hex[..8]),
            "ssid",
            ssid,
            "connection.uuid",
            &active.uuid,
            "connection.autoconnect",
            "no",
            "802-11-wireless.mode",
            "infrastructure",
            "802-11-wireless.bssid",
            &network.bssid,
            "wifi-sec.key-mgmt",
            "wpa-psk",
            "wifi-sec.proto",
            "rsn",
            "wifi-sec.psk",
            password,
            "ipv4.method",
            "auto",
            "ipv4.never-default",
            "yes",
            "ipv4.ignore-auto-dns",
            "yes",
            "ipv6.method",
            "disabled",
        ])?;
        let result: Result<(), String> = (|| {
            run(&[
                "connection",
                "up",
                "uuid",
                &active.uuid,
                "ifname",
                &active.interface,
            ])?;
            let gateway = run(&["-g", "IP4.GATEWAY", "device", "show", &active.interface])?;
            active.session.address = gateway
                .parse::<std::net::Ipv4Addr>()
                .ok()
                .filter(|ip| super::super::is_private_lan_ipv4(*ip))
                .map(|ip| ip.to_string());
            Ok(())
        })();
        if let Err(error) = result {
            let cleanup = stop(&active, run);
            return Err(if cleanup.is_err() {
                format!("{error} Reconnect your previous Wi-Fi in system settings; PulseDrop cleanup needs attention.")
            } else {
                "Could not connect. Check the password, keep the hotspot running, and try scanning its QR code again.".into()
            });
        }
        Ok(active)
    }

    pub fn start(run: &mut Runner<'_>) -> Result<Active, String> {
        let mut random = [0u8; 32];
        File::open("/dev/urandom")
            .and_then(|mut file| file.read_exact(&mut random))
            .map_err(|_| "Could not generate a secure hotspot password")?;
        let hex: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let uuid = format!(
            "{}-{}-4{}-a{}-{}",
            &hex[..8],
            &hex[8..12],
            &hex[13..16],
            &hex[17..20],
            &hex[20..32]
        );
        let interface = adapter(run)?;
        let previous = run(&["-g", "GENERAL.CON-UUID", "device", "show", &interface])?;
        let previous = if previous.is_empty() || previous == "--" {
            None
        } else {
            Some(previous)
        };
        let mut active = Active {
            session: Session {
                role: "host",
                ssid: format!("PulseDrop-{}", &hex[..6]),
                password: hex[32..56].into(),
                address: None,
            },
            uuid,
            interface,
            previous,
        };
        // Create an owned, non-autoconnecting profile before activation so a
        // failed start can be rolled back without touching unrelated profiles.
        run(&[
            "connection",
            "add",
            "type",
            "wifi",
            "ifname",
            &active.interface,
            "con-name",
            &active.session.ssid,
            "ssid",
            &active.session.ssid,
            "connection.uuid",
            &active.uuid,
            "connection.autoconnect",
            "no",
            "802-11-wireless.mode",
            "ap",
            "802-11-wireless.band",
            "bg",
            "wifi-sec.key-mgmt",
            "wpa-psk",
            "wifi-sec.proto",
            "rsn",
            "wifi-sec.psk",
            &active.session.password,
            "ipv4.method",
            "shared",
            "ipv4.never-default",
            "yes",
            "ipv6.method",
            "disabled",
        ])?;
        let activated = (|| {
            run(&[
                "connection",
                "up",
                "uuid",
                &active.uuid,
                "ifname",
                &active.interface,
            ])?;
            let addresses = run(&["-g", "IP4.ADDRESS", "device", "show", &active.interface])?;
            active.session.address = addresses
                .lines()
                .filter_map(|s| s.split('/').next())
                .find(|s| {
                    s.parse::<std::net::Ipv4Addr>()
                        .is_ok_and(super::super::is_shareable_ipv4)
                })
                .map(str::to_string);
            if active.session.address.is_none() {
                return Err("The hotspot has no IPv4 address. Check system Wi-Fi settings.".into());
            }
            Ok(())
        })();
        if let Err(error) = activated {
            return Err(if stop(&active, run).is_err() {
                format!("{error} Cleanup needs attention: remove the PulseDrop hotspot in system Wi-Fi settings and reconnect your previous network.")
            } else {
                error
            });
        }
        Ok(active)
    }

    pub fn stop(active: &Active, run: &mut Runner<'_>) -> Result<(), String> {
        let current = run(&[
            "-g",
            "GENERAL.CON-UUID",
            "device",
            "show",
            &active.interface,
        ])?;
        let ours = current == active.uuid;
        if ours {
            run(&["connection", "down", "uuid", &active.uuid])?;
        }
        if let Err(error) = run(&["connection", "delete", "uuid", &active.uuid]) {
            // The user or NetworkManager may already have deleted our profile.
            // A retry after failed restoration must still be able to finish.
            let profiles = run(&["-g", "UUID", "connection", "show"])?;
            if profiles.lines().any(|uuid| uuid == active.uuid) {
                return Err(error);
            }
        }
        // Never replace a new network the user selected while the app was open.
        if ours || current.is_empty() || current == "--" {
            if let Some(previous) = &active.previous {
                run(&[
                    "connection",
                    "up",
                    "uuid",
                    previous,
                    "ifname",
                    &active.interface,
                ])?;
            }
        }
        Ok(())
    }

    pub fn is_active(active: &Active, run: &mut Runner<'_>) -> Result<bool, String> {
        Ok(run(&[
            "-g",
            "GENERAL.CON-UUID",
            "device",
            "show",
            &active.interface,
        ])? == active.uuid)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        const NETWORK: &str = "Phone\\:Lab:AA\\:BB\\:CC\\:DD\\:EE\\:FF:82:WPA2:wlan0";

        #[test]
        fn wifi_scan_parses_escaped_names_and_rejects_malformed_rows() {
            let networks = scan(&mut |_| Ok(format!("{NETWORK}\nBad:MAC:101:WPA2:wlan0\n:AA\\:BB\\:CC\\:DD\\:EE\\:FE:70:WPA2:wlan0")), true).unwrap();
            assert_eq!(networks.len(), 1);
            assert_eq!(networks[0].ssid, "Phone:Lab");
            assert_eq!(networks[0].bssid, "AA:BB:CC:DD:EE:FF");
            assert_eq!(networks[0].signal, 82);
        }

        #[test]
        fn joining_uses_an_owned_wpa2_profile_pinned_to_the_selected_access_point() {
            let mut commands = Vec::new();
            let active = join(
                &mut |args| {
                    commands.push(args.iter().map(|s| s.to_string()).collect::<Vec<_>>());
                    Ok(if args.contains(&"SSID,BSSID,SIGNAL,SECURITY,DEVICE") {
                        NETWORK
                    } else if args.contains(&"GENERAL.CON-UUID") {
                        "previous-network"
                    } else if args.contains(&"IP4.GATEWAY") {
                        "192.168.43.1"
                    } else {
                        ""
                    }
                    .into())
                },
                "Phone:Lab",
                "secret123",
                Some("AA:BB:CC:DD:EE:FF"),
                Some("wlan0"),
            )
            .unwrap();
            assert_eq!(active.session.role, "sender");
            assert!(active.session.password.is_empty());
            assert_eq!(active.session.address.as_deref(), Some("192.168.43.1"));
            let add = commands
                .iter()
                .find(|args| args[0..2] == ["connection", "add"])
                .unwrap();
            for pair in [
                ["connection.autoconnect", "no"],
                ["802-11-wireless.bssid", "AA:BB:CC:DD:EE:FF"],
                ["802-11-wireless.mode", "infrastructure"],
                ["ipv4.method", "auto"],
            ] {
                assert!(add.windows(2).any(|args| args == pair));
            }
        }

        #[test]
        fn invalid_or_missing_wifi_targets_never_change_networks() {
            let mut calls = 0;
            assert!(join(
                &mut |_| {
                    calls += 1;
                    Ok(NETWORK.into())
                },
                "Phone:Lab",
                "short",
                None,
                None
            )
            .is_err());
            assert_eq!(calls, 0);
            assert!(join(
                &mut |_| {
                    calls += 1;
                    Ok(NETWORK.into())
                },
                "different",
                "secret123",
                None,
                None
            )
            .is_err());
            assert_eq!(calls, 1);
            assert!(join(
                &mut |_| Ok(NETWORK.into()),
                "Phone:Lab",
                "secret123",
                Some("00:00:00:00:00:00"),
                None
            )
            .is_err());
        }

        #[test]
        fn failed_wifi_join_removes_its_profile_and_restores_previous_network() {
            let mut calls = Vec::new();
            let mut interrupted = false;
            let result = join(
                &mut |args| {
                    calls.push(args.join(" "));
                    if args.contains(&"SSID,BSSID,SIGNAL,SECURITY,DEVICE") {
                        return Ok(NETWORK.into());
                    }
                    if args.contains(&"GENERAL.CON-UUID") {
                        return Ok(if interrupted { "--" } else { "original" }.into());
                    }
                    if args.starts_with(&["connection", "up", "uuid"]) && args[3] != "original" {
                        interrupted = true;
                        return Err("authentication failed".into());
                    }
                    Ok(String::new())
                },
                "Phone:Lab",
                "secret123",
                None,
                None,
            );
            assert!(result.is_err());
            assert!(calls
                .iter()
                .any(|s| s.starts_with("connection delete uuid ")));
            assert_eq!(
                calls.last().unwrap(),
                "connection up uuid original ifname wlan0"
            );
        }

        #[test]
        fn start_creates_secure_owned_profile_and_returns_actual_address() {
            let mut commands = Vec::new();
            let mut run = |args: &[&str]| {
                commands.push(args.iter().map(|s| s.to_string()).collect::<Vec<_>>());
                Ok(match args {
                    ["-t", ..] => "wlan0:wifi\neth0:ethernet",
                    ["-g", "WIFI-PROPERTIES.AP", ..] => "yes",
                    ["-g", "GENERAL.CON-UUID", ..] => "previous-network",
                    ["-g", "IP4.ADDRESS", ..] => "10.42.0.1/24",
                    _ => "",
                }
                .into())
            };
            let active = start(&mut run).unwrap();
            assert_eq!(active.session.address.as_deref(), Some("10.42.0.1"));
            assert_eq!(active.session.password.len(), 24);
            assert!(active
                .session
                .password
                .bytes()
                .all(|b| b.is_ascii_hexdigit()));
            let add = commands
                .iter()
                .find(|args| args[0..2] == ["connection", "add"])
                .unwrap();
            for pair in [
                ["connection.autoconnect", "no"],
                ["802-11-wireless.mode", "ap"],
                ["wifi-sec.proto", "rsn"],
                ["ipv4.method", "shared"],
            ] {
                assert!(add.windows(2).any(|args| args == pair));
            }
        }

        #[test]
        fn failed_activation_removes_owned_profile_and_restores_previous_network() {
            let mut commands = Vec::new();
            let mut run = |args: &[&str]| {
                commands.push(args.iter().map(|s| s.to_string()).collect::<Vec<_>>());
                match args {
                    ["-t", ..] => Ok("wlan0:wifi".into()),
                    ["-g", "WIFI-PROPERTIES.AP", ..] => Ok("yes".into()),
                    ["-g", "GENERAL.CON-UUID", ..] => Ok(if commands.len() == 3 {
                        "original"
                    } else {
                        "--"
                    }
                    .into()),
                    ["connection", "up", "uuid", id, ..] if *id != "original" => {
                        Err("activation failed".into())
                    }
                    _ => Ok(String::new()),
                }
            };
            let Err(error) = start(&mut run) else {
                panic!("Activation should fail")
            };
            assert!(error.contains("activation failed"));
            assert!(commands
                .iter()
                .any(|args| args[0..2] == ["connection", "delete"]));
            assert!(commands
                .iter()
                .any(|args| args[0..4] == ["connection", "up", "uuid", "original"]));
        }

        #[test]
        fn stop_does_not_disconnect_a_network_selected_by_the_user() {
            let active = Active {
                session: Session {
                    role: "host",
                    ssid: "own".into(),
                    password: "secret".into(),
                    address: None,
                },
                uuid: "owned".into(),
                interface: "wlan0".into(),
                previous: Some("old".into()),
            };
            let mut commands = Vec::new();
            stop(&active, &mut |args| {
                commands.push(args.join(" "));
                Ok("new-network".into())
            })
            .unwrap();
            assert_eq!(
                commands,
                [
                    "-g GENERAL.CON-UUID device show wlan0",
                    "connection delete uuid owned"
                ]
            );
        }

        #[test]
        fn unavailable_adapters_and_creation_errors_do_not_modify_existing_networks() {
            let mut commands = Vec::new();
            let error = adapter(&mut |args| {
                commands.push(args.join(" "));
                Ok(if args[0] == "-t" {
                    "wlan0:wifi\neth0:ethernet"
                } else {
                    "no"
                }
                .into())
            })
            .unwrap_err();
            assert!(error.contains("No Wi-Fi adapter"));
            assert!(commands.iter().all(|args| !args.starts_with("connection")));
            commands.clear();
            let result = start(&mut |args| {
                commands.push(args.join(" "));
                match args {
                    ["-t", ..] => Ok("wlan0:wifi".into()),
                    ["-g", "WIFI-PROPERTIES.AP", ..] => Ok("yes".into()),
                    ["-g", "GENERAL.CON-UUID", ..] => Ok("original".into()),
                    _ => Err("permission denied".into()),
                }
            });
            assert!(result.is_err());
            assert!(!commands
                .iter()
                .any(|args| args.starts_with("connection down")
                    || args.starts_with("connection delete")
                    || args.starts_with("connection up")));
        }

        #[test]
        fn cleanup_retry_after_deleted_profile_can_restore_previous_network() {
            let active = Active {
                session: Session {
                    role: "host",
                    ssid: "own".into(),
                    password: "secret".into(),
                    address: None,
                },
                uuid: "owned".into(),
                interface: "wlan0".into(),
                previous: Some("original".into()),
            };
            let mut commands = Vec::new();
            stop(&active, &mut |args| {
                commands.push(args.join(" "));
                match args {
                    ["-g", "GENERAL.CON-UUID", ..] => Ok("--".into()),
                    ["connection", "delete", ..] => Err("already deleted".into()),
                    ["-g", "UUID", ..] => Ok("original\nother".into()),
                    _ => Ok(String::new()),
                }
            })
            .unwrap();
            assert_eq!(
                commands.last().unwrap(),
                "connection up uuid original ifname wlan0"
            );
        }
    }
}
