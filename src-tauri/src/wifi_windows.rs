use super::{profile_xml, validate, Active, Session, WifiNetwork};
use std::{
    ffi::c_void,
    ptr, thread,
    time::{Duration, Instant},
};
use windows::{
    core::{GUID, PCWSTR},
    Win32::{Foundation::HANDLE, NetworkManagement::WiFi::*},
};

// The API allocates variable-length lists. Guards keep every error path paired
// with WlanFreeMemory/WlanCloseHandle; pointers never escape this worker thread.
struct Client(HANDLE);
impl Drop for Client {
    fn drop(&mut self) {
        unsafe {
            WlanCloseHandle(self.0, None);
        }
    }
}
struct Allocation(*mut c_void);
impl Drop for Allocation {
    fn drop(&mut self) {
        unsafe {
            WlanFreeMemory(self.0);
        }
    }
}
fn check(code: u32) -> Result<(), String> {
    match code {
        0 => Ok(()),
        5 => Err("Windows denied Wi-Fi access. Enable Location services and allow desktop apps to access location in Settings → Privacy & security → Location, then refresh Wi-Fi.".into()),
        _ => Err(format!("Windows Wi-Fi could not complete this action (code {code}). Enable Wi-Fi and the WLAN AutoConfig service, then retry or use system settings.")),
    }
}
fn client() -> Result<Client, String> {
    let mut handle = HANDLE::default();
    let mut version = 0;
    check(unsafe { WlanOpenHandle(2, None, &mut version, &mut handle) })?;
    Ok(Client(handle))
}
fn interfaces(client: &Client) -> Result<Vec<WLAN_INTERFACE_INFO>, String> {
    let mut raw = ptr::null_mut();
    check(unsafe { WlanEnumInterfaces(client.0, None, &mut raw) })?;
    if raw.is_null() {
        return Err("Windows did not return a Wi-Fi adapter.".into());
    }
    let _allocation = Allocation(raw.cast());
    let count = unsafe { (*raw).dwNumberOfItems } as usize;
    if count > 256 {
        return Err("Windows returned an invalid adapter list.".into());
    }
    Ok(
        unsafe { std::slice::from_raw_parts(ptr::addr_of!((*raw).InterfaceInfo).cast(), count) }
            .to_vec(),
    )
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn text(value: &[u16]) -> String {
    String::from_utf16_lossy(&value[..value.iter().position(|v| *v == 0).unwrap_or(value.len())])
}
fn ssid(value: &DOT11_SSID) -> Option<String> {
    let length = value.uSSIDLength as usize;
    if !(1..=32).contains(&length) {
        return None;
    }
    let value = std::str::from_utf8(&value.ucSSID[..length]).ok()?;
    (!value.chars().any(char::is_control)).then(|| value.into())
}
fn connection(client: &Client, guid: &GUID) -> Result<Option<WLAN_CONNECTION_ATTRIBUTES>, String> {
    let mut data = ptr::null_mut();
    let mut size = 0;
    let code = unsafe {
        WlanQueryInterface(
            client.0,
            guid,
            wlan_intf_opcode_current_connection,
            None,
            &mut size,
            &mut data,
            None,
        )
    };
    // ERROR_INVALID_STATE means an adapter that is not associated.
    if code == 5023 {
        return Ok(None);
    }
    check(code)?;
    if data.is_null() {
        return Ok(None);
    }
    let _allocation = Allocation(data);
    if (size as usize) < std::mem::size_of::<WLAN_CONNECTION_ATTRIBUTES>() {
        return Err("Windows returned invalid connection details.".into());
    }
    let info = unsafe { *data.cast::<WLAN_CONNECTION_ATTRIBUTES>() };
    Ok((info.isState == wlan_interface_state_connected).then_some(info))
}
pub(crate) fn available() -> bool {
    client()
        .and_then(|client| interfaces(&client))
        .is_ok_and(|list| !list.is_empty())
}

fn networks(client: &Client, interface: &WLAN_INTERFACE_INFO) -> Result<Vec<WifiNetwork>, String> {
    let mut raw = ptr::null_mut();
    check(unsafe {
        WlanGetAvailableNetworkList(client.0, &interface.InterfaceGuid, 0, None, &mut raw)
    })?;
    if raw.is_null() {
        return Ok(vec![]);
    }
    let _allocation = Allocation(raw.cast());
    let count = unsafe { (*raw).dwNumberOfItems } as usize;
    if count > 65536 {
        return Err("Windows returned an invalid Wi-Fi list.".into());
    }
    let list: &[WLAN_AVAILABLE_NETWORK] =
        unsafe { std::slice::from_raw_parts(ptr::addr_of!((*raw).Network).cast(), count) };
    Ok(list
        .iter()
        .filter_map(|item| {
            Some(WifiNetwork {
                ssid: ssid(&item.dot11Ssid)?,
                // This API groups access points by SSID/security. Do not invent a BSSID.
                bssid: String::new(),
                interface: format!("{:?}", interface.InterfaceGuid),
                signal: item.wlanSignalQuality.min(100) as u8,
                security: if item.dot11DefaultAuthAlgorithm == DOT11_AUTH_ALGO_RSNA_PSK {
                    "WPA2"
                } else if !item.bSecurityEnabled.as_bool() {
                    "Open"
                } else {
                    "Other security"
                }
                .into(),
            })
        })
        .collect())
}
pub(crate) fn scan() -> Result<Vec<WifiNetwork>, String> {
    let client = client()?;
    let interfaces = interfaces(&client)?;
    if interfaces.is_empty() {
        return Err("No Wi-Fi adapter found. Enable Wi-Fi and refresh.".into());
    }
    for interface in &interfaces {
        check(unsafe { WlanScan(client.0, &interface.InterfaceGuid, None, None, None) })?;
    }
    // WlanScan is asynchronous; allow its bounded scan to update the OS cache.
    thread::sleep(Duration::from_secs(4));
    let mut all = vec![];
    for interface in &interfaces {
        all.extend(networks(&client, interface)?);
    }
    all.sort_by_key(|n| std::cmp::Reverse(n.signal));
    let mut seen = std::collections::HashSet::new();
    all.retain(|network| {
        seen.insert((
            network.ssid.clone(),
            network.interface.clone(),
            network.security.clone(),
        ))
    });
    all.truncate(64);
    Ok(all)
}
fn connect(client: &Client, guid: &GUID, profile: &str, temporary: bool) -> Result<(), String> {
    let profile = wide(profile);
    let params = WLAN_CONNECTION_PARAMETERS {
        wlanConnectionMode: if temporary {
            wlan_connection_mode_temporary_profile
        } else {
            wlan_connection_mode_profile
        },
        strProfile: PCWSTR(profile.as_ptr()),
        dot11BssType: dot11_BSS_type_infrastructure,
        ..Default::default()
    };
    check(unsafe { WlanConnect(client.0, guid, &params, None) })
}
fn interface(client: &Client, name: &str) -> Result<GUID, String> {
    interfaces(client)?
        .into_iter()
        .find(|i| format!("{:?}", i.InterfaceGuid) == name)
        .map(|i| i.InterfaceGuid)
        .ok_or_else(|| "The selected Wi-Fi adapter is no longer available.".into())
}
pub(crate) fn join(
    name: &str,
    password: &str,
    _bssid: Option<&str>,
    adapter: Option<&str>,
) -> Result<Active, String> {
    validate(name, password)?;
    let client = client()?;
    let mut chosen = None;
    for candidate in interfaces(&client)? {
        if adapter.is_some_and(|value| value != format!("{:?}", candidate.InterfaceGuid)) {
            continue;
        }
        if networks(&client, &candidate)?
            .iter()
            .any(|network| network.ssid == name && network.security == "WPA2")
        {
            chosen = Some(candidate);
            break;
        }
    }
    let selected = chosen
        .ok_or("This WPA2 hotspot is no longer visible. Refresh Wi-Fi or move closer and retry.")?;
    let previous = connection(&client, &selected.InterfaceGuid)?;
    if previous.as_ref().is_some_and(|info| {
        ssid(&info.wlanAssociationAttributes.dot11Ssid).as_deref() == Some(name)
    }) {
        return Err(
            "This device is already on that Wi-Fi. Choose I’ve connected · Find receiver below."
                .into(),
        );
    }
    let profile = profile_xml(name, password)?;
    connect(&client, &selected.InterfaceGuid, &profile, true)?;
    let deadline = Instant::now() + Duration::from_secs(25);
    let attempt = (|| {
        while Instant::now() < deadline {
            if let Some(info) = connection(&client, &selected.InterfaceGuid)? {
                if ssid(&info.wlanAssociationAttributes.dot11Ssid).as_deref() == Some(name)
                    && info.wlanConnectionMode == wlan_connection_mode_temporary_profile
                {
                    return Ok(Active {
                        session: Session {
                            role: "sender",
                            ssid: name.into(),
                            password: String::new(),
                            address: None,
                        },
                        interface: format!("{:?}", selected.InterfaceGuid),
                        identity: text(&info.strProfileName),
                        previous: previous
                            .filter(|info| info.wlanConnectionMode == wlan_connection_mode_profile)
                            .map(|value| text(&value.strProfileName))
                            .filter(|value| !value.is_empty()),
                    });
                }
                if previous
                    .as_ref()
                    .map_or(true, |prior| info.strProfileName != prior.strProfileName)
                {
                    // Respect a network selected manually while a join was pending.
                    return Err("Wi-Fi changed before this connection finished. Keep your chosen network, or retry.".into());
                }
            }
            thread::sleep(Duration::from_millis(250));
        }
        Err("Could not join the hotspot. Check its password, move closer and retry.".into())
    })();
    if attempt.is_ok() {
        return attempt;
    }
    // Query again before rollback so a manual network change wins. If privacy
    // was revoked, leave Wi-Fi under system control instead of disconnecting an
    // unknown network.
    let current = connection(&client, &selected.InterfaceGuid)?;
    let ours = current.as_ref().map_or(true, |info| {
        (info.wlanConnectionMode == wlan_connection_mode_temporary_profile
            && ssid(&info.wlanAssociationAttributes.dot11Ssid).as_deref() == Some(name))
            || previous
                .as_ref()
                .is_some_and(|prior| prior.strProfileName == info.strProfileName)
    });
    if !ours {
        return attempt;
    }
    check(unsafe { WlanDisconnect(client.0, &selected.InterfaceGuid, None) })?;
    if let Some(prior) =
        previous.filter(|info| info.wlanConnectionMode == wlan_connection_mode_profile)
    {
        let profile = text(&prior.strProfileName);
        if !profile.is_empty() {
            connect(&client, &selected.InterfaceGuid, &profile, false)?;
        }
    }
    attempt
}
pub(crate) fn is_active(active: &Active) -> Result<bool, String> {
    let client = client()?;
    let guid = interface(&client, &active.interface)?;
    Ok(connection(&client, &guid)?.is_some_and(|info| {
        info.wlanConnectionMode == wlan_connection_mode_temporary_profile
            && text(&info.strProfileName) == active.identity
            && ssid(&info.wlanAssociationAttributes.dot11Ssid).as_deref()
                == Some(active.session.ssid.as_str())
    }))
}
pub(crate) fn stop(active: &Active) -> Result<(), String> {
    let client = client()?;
    let guid = interface(&client, &active.interface)?;
    let current = connection(&client, &guid)?;
    if let Some(info) = current {
        if info.wlanConnectionMode != wlan_connection_mode_temporary_profile
            || text(&info.strProfileName) != active.identity
            || ssid(&info.wlanAssociationAttributes.dot11Ssid).as_deref()
                != Some(active.session.ssid.as_str())
        {
            return Ok(());
        }
        check(unsafe { WlanDisconnect(client.0, &guid, None) })?;
    }
    if let Some(previous) = &active.previous {
        connect(&client, &guid, previous, false)?;
    }
    Ok(())
}
