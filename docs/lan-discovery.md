# LAN receiver discovery

PulseDrop sends files from `src/main.js` through WebView HTTP requests. The Rust backend in `src-tauri/src/lib.rs` owns the local HTTP receiver, pairing code, Inbox, and network diagnostics. The receiver tries TCP `53612` and falls back to an available port. Discovery must therefore report the bound port rather than assume the default. The existing `/health` and `/upload` pairing checks remain the transfer entry points.

The new `discovery.rs` module uses UDP query/reply on port `53613`, with the existing `serde`, `serde_json`, and `if-addrs` dependencies. This keeps discovery independent of WebView networking and avoids requiring a system discovery daemon. This is a PulseDrop-specific protocol rather than mDNS/DNS-SD.

## User flow

1. Start Receive on the destination. Its HTTP listener and discovery responder start together. Stopping Receive drops the responder, joins its thread, and releases its UDP port.
2. Open Send on another device. Nearby receivers appear automatically; selecting one fills its IP and actual HTTP port and focuses the code input.
3. Enter the six-digit code shown on the receiver and send files through the existing health check and upload flow.

Changing the selected destination clears the previous code. Starting a local receiver no longer fills the sender's fields with its own address. Manual IP/port/code entry remains available, including when the receiver cannot bind the discovery port.

## Network behavior

- Each scan binds an ephemeral UDP socket to every eligible IPv4 interface and queries that interface's subnet broadcast address. It uses the actual interface netmask rather than assuming a `/24` network.
- Loopback, link-local, VPN, virtual, cellular, and point-to-point interfaces are excluded using shared helpers in `network.rs`.
- Three request rounds run over approximately 1.8 seconds. The frontend waits five seconds after completion before the next scan. Refresh starts a scan immediately when none is in progress.
- Replies go directly to the requesting socket. The sender uses the packet's source IP; advertisements do not supply a target IP.
- The frontend replaces its list after each completed scan. Devices that stop responding disappear on the next completed refresh. A selected endpoint remains available for manual connection and for an ongoing transfer.
- A process-scoped random ID deduplicates replies across interfaces and filters out the app's own receiver. IDs are not persisted or used as credentials.
- Interface membership is refreshed every five seconds on the responder. Each new scan enumerates interfaces again.

Packets are bounded JSON objects. Queries have `service: "pulsedrop"`, `version: 1`, `kind: "discover"`, and a 32-character hexadecimal `nonce`. Replies echo the nonce, use `kind: "receiver"`, and add a `receiver` object containing `id`, `name`, `platform`, and `port`. Pairing codes and Inbox paths are never advertised.

The parser rejects oversized/malformed messages, unknown fields, incompatible protocols, old scan nonces, invalid ports, and invalid display names. Replies must arrive from the discovery port and the scanned subnet. Scans cap their result count and receive work; the responder limits replies per source IP. Discovery provides candidate addresses, while the existing pairing checks authorize transfers.

## Platform integration

Windows Settings checks for both TCP and UDP inbound permissions. Its existing user-triggered Fix action creates a Private-profile UDP `53613` rule restricted to `LocalSubnet`, alongside the existing TCP rule. Merely starting discovery does not change firewall settings.

Android adds `CHANGE_WIFI_MULTICAST_STATE`. The JavaScript bridge requests a non-reference-counted Wi-Fi multicast lock while the Send screen is active or a receiver is running. The Activity releases it on pause/destroy and reacquires it on resume when requested. Android documents this lock as enabling reception of packets normally filtered by the Wi-Fi stack; it should be released when unused to save power. See [Android MulticastLock documentation](https://developer.android.com/reference/android/net/wifi/WifiManager.MulticastLock). Android receiver names use the device manufacturer and model.

The frontend controller in `src/discovery.js` allows one scan at a time, stops polling when the Send screen is left or the app is hidden, and discards results from prior view lifetimes. The Tauri command runs scans on a blocking worker rather than the UI thread and rejects overlapping backend scans.

## Validation

`npm test` covers polling, overlapping refreshes, late results after navigation, reopening during a scan, removal of offline receivers, and retry after errors. Rust tests in `discovery.rs` cover protocol validation, pairing-code exclusion, actual HTTP port reporting, subnet masks, real loopback UDP discovery/deduplication, self-filtering, and responder shutdown/port release. Run them with `cargo test` in `src-tauri` on a configured Tauri development machine.

For device acceptance testing, use Windows and Android on the same Wi-Fi, test sending in both directions, stop/restart a receiver, switch Wi-Fi networks, and verify manual entry with broadcast blocked. Check a second receiver and a non-default TCP port as well. Platform builds and physical LAN tests are required to confirm device-specific Wi-Fi and firewall behavior.

Implementation validation passed: the production frontend build; five frontend controller tests; ten Rust discovery tests in an isolated harness importing the actual source modules and using the app's locked dependency versions; a full `cargo check --locked --target x86_64-pc-windows-gnu`; and browser checks at 1120px and 360px using mocked Tauri commands. A sender/responder test on this machine also passed through actual interface enumeration and subnet broadcast.

Ubuntu 26.04 `.deb` and Android ARM64 debug APK builds subsequently passed. Native Linux WebKit/Tauri integration tests verified receiving, pairing rejection, discovery, receiver selection, and sending exact file bytes. Android APK signature and 16 KB alignment checks passed; physical phone testing remains outstanding. See [device testing instructions](device-testing.md) for installation and the two-device checklist.

## Boundaries

Discovery is IPv4 and limited to the local broadcast subnet. Guest-network isolation, VPN policies, broadcast filtering, or an occupied UDP port can prevent discovery even when manual HTTP transfers work. Only one receiver per host can own UDP `53613`; additional instances retain manual transfers. Background receiving behavior remains governed by Android's existing application lifecycle. Future mDNS/DNS-SD support could improve interoperability but would be a separate transport for discovery.
