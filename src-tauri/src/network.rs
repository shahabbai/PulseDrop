use std::net::Ipv4Addr;

pub(crate) fn is_shareable_ipv4(ip: Ipv4Addr) -> bool {
    !ip.is_loopback() && !ip.is_unspecified() && !is_link_local_ipv4(ip) && !ip.is_broadcast()
}

pub(crate) fn is_private_lan_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    a == 10 || (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 168)
}

pub(crate) fn is_link_local_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    a == 169 && b == 254
}

pub(crate) fn is_cgnat_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    a == 100 && (64..=127).contains(&b)
}

pub(crate) fn is_wifi_or_ethernet_interface(name: &str) -> bool {
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

pub(crate) fn is_vpn_like_interface(name: &str) -> bool {
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

pub(crate) fn is_virtual_like_interface(name: &str) -> bool {
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

pub(crate) fn is_mobile_data_interface(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.contains("rmnet")
        || name.contains("ccmni")
        || name.contains("wwan")
        || name.contains("cellular")
}
