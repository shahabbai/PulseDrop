# Changelog

## 0.4.0

### Added

- Transfer through a receiver-hosted Wi-Fi hotspot without an existing router or internet connection.
- Create a local-only hotspot on Android 8+ or a temporary WPA2 hotspot on compatible Linux/NetworkManager devices, then start receiving through the existing file-transfer protocol.
- Discover nearby Wi-Fi networks and join a receiver hotspot inside PulseDrop on Android 10+, Linux, Windows and macOS, with system permission/connection approval where required.
- Scan the other device’s connection QR or import a QR image to fill its Wi-Fi password, receiver address, port and pairing code. Review the network and press **Connect** before switching Wi-Fi.
- Share an already enabled system hotspot by QR. Hiding its QR clears the shared credentials while leaving the system hotspot under the user’s control.

### Connection experience

- Use the same nearby Wi-Fi picker, QR controls and connection actions across Android, Linux, Windows and macOS.
- Replace platform-specific connection instructions with “on the other device” and prefer the rear camera on phones.
- Explain Wi-Fi/Location and camera permissions, scan throttling, unavailable hardware and connection errors with retry or manual setup options.
- Add setup cancellation, hotspot-loss feedback, temporary credential cleanup and protection against older setup/scan results interfering with a newer connection.
- Release app-owned hotspot connections on stop and attempt to restore the previous network without overriding a network chosen manually in system settings.
- Keep QR generation and decoding on the device. Camera scanning requests video only and stops after a scan, cancellation, timeout, leaving Send or app backgrounding.

### Compatibility and downloads

- **Local network remains the default.** Existing discovery, pairing, transfer progress, queues, cancellation and Inbox behavior are preserved.
- Automatic offline hotspot creation requires compatible Android/Linux hardware. Windows/macOS use system hotspot setup with OS and uplink restrictions. macOS remains experimental; physical Windows/macOS hotspot testing is still required.
- Android installation requires API 24+ on ARM64; in-app hotspot creation requires Android 8+, and in-app joining requires Android 10+. Older Android versions can use system Wi-Fi settings.
- Update all app manifests to **0.4.0**, with Android version code **4000**. The release workflow builds fresh installers from the `v0.4.0` tag and publishes this version’s notes only.

| Release asset | Platform |
| --- | --- |
| `PulseDrop_0.4.0_android_arm64.apk` | Android ARM64, signed with the existing release identity |
| `PulseDrop_0.4.0_amd64.deb` | Ubuntu/Linux x86-64, built on Ubuntu 24.04 |
| `PulseDrop_0.4.0_x64-setup.exe` | Windows x64 installer; unsigned |
| `PulseDrop_0.4.0_universal.dmg` | macOS Apple Silicon and Intel; ad hoc signed, not notarized |
| `SHA256SUMS` | SHA-256 checksums for all four installers |

### Validation

- Local hotspot validation passed 38 Rust tests and 65 JavaScript tests, Linux/Android builds, and Windows native-code cross-compilation.
- Native Linux integration checks used simulated Wi-Fi and camera input with real HTTP transfers to verify QR connection, exact-byte delivery, cleanup, restoration, cancellation and responsive layouts.
- Android hotspot discovery and QR controls were confirmed on the user’s phone. Hosted Windows/macOS builds must pass CI before tagging; physical Windows/macOS Wi-Fi and camera tests remain pending.

[Hotspot setup and platform support](https://github.com/shahabbai/PulseDrop/blob/v0.4.0/docs/hotspot-transfer.md) · [Compare v0.3.1…v0.4.0](https://github.com/shahabbai/PulseDrop/compare/v0.3.1...v0.4.0)

## 0.3.1

### Added

- Add **Cancel transfer** on Send to stop the active file and remaining queue, including receiver checking and Android file preparation.
- Add **Cancel file** and **Cancel all incoming** on Receive while keeping the receiver available for new transfers.
- Show a distinct **Cancelled** state on both updated devices without counting incomplete files as received.

### Fixed

- Remove cancelled uploads' partial files and reserved destination names; preserve files that completed before cancellation.
- Stop stalled incoming uploads promptly when cancellation is requested and handle cancellation racing with upload completion or connection errors.
- Prevent Windows cancellation tests from hanging by checking cancellation during bounded socket reads, while preserving the upload idle timeout.
- Preserve keyboard focus on incoming Cancel buttons while progress updates.
- Settle HTTP upload errors correctly so sending controls become available for retry.

### Releases

- Update the application version to **0.3.1** across all manifests and lockfiles.
- Publish only the tagged version's changelog entry on its GitHub Release page. Older entries remain in this file.
- Continue building the Android APK, Linux DEB, Windows EXE, and universal macOS DMG.

Update both devices to 0.3.1 for coordinated cancellation and consistent status on both screens. Older receivers still accept uploads; sender cancellation falls back to closing the upload connection. Completed files are kept, and a new send starts a fresh attempt.

[Compare changes from v0.3.0 to v0.3.1](https://github.com/shahabbai/PulseDrop/compare/v0.3.0...v0.3.1)

## 0.3.0

### Interface

- Redesign Home, Send, Receive, and Settings with a minimal dark interface, consistent typography, shared spacing, and one blue accent.
- Keep the original PulseDrop app icon.
- Add persistent navigation, clearer Send/Receive actions, a file queue, nearby receiver selection, and collapsed manual networking controls.
- Improve empty, loading, error, and success states, keyboard navigation, focus indicators, and reduced-motion preferences.
- Adapt layouts to desktop windows and narrow Android screens.
- Allow HTML file drag-and-drop in the desktop WebView, including Windows.

### Receiving progress and reliability

- Show live percentage, received bytes, and transfer speed on the receiving device as well as the sender.
- Show progress for each incoming file and aggregate progress for simultaneous uploads.
- Preserve receiving progress when switching between screens.
- Correlate transfer events by ID so successful files appear and are counted once.
- Mark transfers complete only after all declared bytes have been written and saved.
- Stage incomplete uploads separately and remove their partial files and reserved names on failure or disconnect.
- Save concurrent uploads with the same filename to separate destination files.
- Keep the existing pairing and HTTP upload protocol compatible with earlier senders.

### Android

- Keep the app header below the system clock, status icons, and display cutouts.
- Respect the system navigation area and keyboard resizing without adding duplicate inset padding.
- Retain LAN discovery, the native storage bridge, and the original launcher icon.

### Builds and releases

- Publish a universal macOS DMG for Apple Silicon and Intel alongside the Android APK, Linux DEB, and Windows EXE.
- Verify macOS app metadata, both architectures, the ad hoc signature, and the disk image before publication.
- Require all four platform builds and checksum validation to succeed before publishing a GitHub Release.
- Display this complete changelog, including previous version history, on the GitHub Release page.
- Validate Android signing-secret encoding before building and accept line-wrapped Base64 keystore contents.

### Downloads and installation

| Download | Platform |
| --- | --- |
| `.deb` | Linux x86-64; built on Ubuntu 24.04, for Ubuntu 24.04/26.04 |
| `x64-setup.exe` | Windows x64 installer |
| `android_arm64.apk` | Android ARM64, Android 7.0/API 24 or newer |
| `universal.dmg` | macOS, Apple Silicon and Intel; experimental |
| `SHA256SUMS` | Checksums for all four installers |

The macOS build uses ad hoc signing and is not notarized by Apple. macOS may require approval in **System Settings → Privacy & Security** before first launch. Physical Mac testing is still needed. The Windows installer is unsigned. Android releases reuse the existing release signing identity; local debug APKs use a different identity and cannot update a release-signed installation directly.

### Validation

- Added native streaming tests and frontend tests for receiving progress, duplicate completion, concurrent uploads, disconnect cleanup, and empty files.
- Validated exact-byte transfers and live sender/receiver progress through a native Linux WebView and local HTTP relay.
- Built and verified the Android debug APK; physical phone testing of the new progress behavior remains part of the device checklist.

[Compare changes from v0.2.0 to v0.3.0](https://github.com/shahabbai/PulseDrop/compare/v0.2.0...v0.3.0)

## 0.2.0

- Discover active PulseDrop receivers automatically on the local network.
- Select a nearby receiver to fill its address and port; pairing codes remain private.
- Add Ubuntu `.deb` builds alongside Windows installers and Android APKs.
- Support Android Wi-Fi discovery and Windows discovery firewall rules.
- Add GitHub Actions checks and automatic releases for version tags.
- Preserve Android app data when installing a debug update.

## 0.1.0

- Initial Windows and Android LAN file transfer release.
