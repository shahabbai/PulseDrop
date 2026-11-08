# Changelog

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
