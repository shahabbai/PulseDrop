# Ubuntu 26.04 and Android device testing

For transfers without a router or internet, use the [receiver hotspot setup and physical test checklist](hotspot-transfer.md). Local-network testing below remains applicable.

## 0.4.1 theme testing

Use a fresh 0.4.1 installer. Local builds produce `src-tauri/target/release/bundle/deb/PulseDrop_0.4.1_amd64.deb` and `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk` (Android version `0.4.1`, code `4001`). The debug APK uses the development signing identity; GitHub Release signs its APK with the existing release key.

1. Open **Settings → Appearance → Theme** and choose **Light**, then **Dark**. Check Home, Send, Receive and Settings in each theme.
2. Close and reopen the app. Confirm the selected theme and selector value are restored. Dark is the default on a fresh install.
3. On Android, check the clock/status icons and navigation bar in both themes, rotate the phone, and open/dismiss the keyboard. Keep the existing system-bar spacing.
4. Queue files or start a large transfer, change the theme, and return to the transfer. Progress, cancellation and the queue should keep working.
5. Check a narrow desktop window, keyboard navigation to the theme selector, larger system text, and **Reduce animations** in both themes.

Local validation covers both palettes and responsive layouts in the native Linux app, persistence after reload/restart, keyboard selection, and an exact-byte transfer while switching themes. Android builds locally; physical phone system-bar checks and Windows/macOS UI checks remain device/CI validation.

## 0.4.0 release testing

Use the fresh installers from the final 0.4.0 CI/release build to test this release. Its Android version is `0.4.0`, version code `4000`. Earlier local hotspot test APKs still report `0.3.1`; the `hotspot_multiplatform` APK includes Android discovery/QR controls, while the earlier `hotspot_quick_connect` APK has a Linux-only picker. A filename change does not update an APK’s internal version.

On Android 10+ open **Send files → Hotspot** and verify **Scan QR**, **Choose QR image**, and **Refresh Wi-Fi** above the manual Wi-Fi details. Test Location permission denial/retry separately from Camera permission: denying a scan must leave QR/manual connection available. Repeat discovery, joining, transfers and Disconnect on Linux, Windows and macOS using the [hotspot checklist](hotspot-transfer.md#validation-and-physical-test-checklist). Local network and cancellation checks below still apply; install 0.4.0 on both devices for testing the new workflow.

The named artifacts and validation results below describe earlier test builds, rather than newly generated 0.4.0 installers. Release builds use the existing Android release signing key; local debug builds have a different identity.

## Install the test builds

The `artifacts/` directory contains the test packages and build/test logs. It is ignored by Git.

| Build | File | Size |
| --- | --- | --- |
| Ubuntu 26.04 x86-64 | `PulseDrop_0.1.0_amd64.deb` | 3.9 MiB |
| Android ARM64 debug, including transfer cancellation | `PulseDrop_0.3.1_android_arm64_debug.apk` | 253.8 MiB |

The debug APK includes native debugging symbols, which account for most of its size. Its checksum is in `artifacts/PulseDrop_0.3.1_android_arm64_debug.apk.sha256`. `artifacts/SHA256SUMS` contains the original 0.1.0 build checksums. The older Ubuntu installer can send to the updated Android receiver; use the rebuilt native binary below or the 0.3.1 CI/release installer to test coordinated cancellation on both devices.

### Ubuntu 26.04, x86-64

```bash
sudo apt install ./artifacts/PulseDrop_0.1.0_amd64.deb
pulse_drop
```

You can also run `./src-tauri/target/release/pulse_drop` directly from the repository without installing the package. The build targets Ubuntu 26.04; compatibility with older Ubuntu versions is not claimed.

### Android, ARM64

Copy `artifacts/PulseDrop_0.3.1_android_arm64_debug.apk` to the phone, open it in Files/Downloads, and allow that file manager to install the APK when Android prompts. This build supports Android 7.0/API 24 or newer on an ARM64 device. It includes the frontend and works without a development server or USB connection.

This APK uses a development signing key. It can update a previous debug build signed with the same key. If a previous PulseDrop build has a different signature, Android will reject the update. Preserve any files you need before choosing to uninstall that older app; this build does not automatically uninstall it.

## Test discovery and transfers

### Android system bars and keyboard

After installing a new APK, check that PulseDrop's logo and name sit below the clock/status icons on every screen. Rotate the phone and check that camera cutouts do not overlap navigation or controls. With gesture navigation and, where available, three-button navigation, scroll to the last action and confirm it stays above the system navigation area. Open Send, focus the pairing-code and manual address fields, then dismiss the keyboard; fields should remain reachable and no extra blank space should remain.

The Android activity applies system-bar/cutout insets to the WebView's native parent and forwards the remaining insets to avoid duplicate padding. This follows [Android's WebView inset guidance](https://developer.android.com/develop/ui/views/layout/webapps/understand-window-insets). Desktop resizing tests alone do not exercise Android's system-bar layout.

### Transfer cancellation (0.3.1)

Install 0.3.1 on both devices. Queue a large file and a second small file, start sending, and use **Cancel transfer** on Send. Repeat using **Cancel** on the receiving file’s activity row. Both updated views should show Cancelled, the second queued file should not start, and only completed files should appear in the Inbox. The receiver should stay online and a new send should work. With multiple incoming transfers, test per-file Cancel and **Cancel all incoming**. Test cancellation while the sender is still checking the receiver too. See [cancellation behavior and protocol](transfer-cancellation.md).

### Discovery and file transfers

The receiving device now shows an incoming progress card and a percentage for each file in **Transfer activity**, alongside the sender's existing progress. Use a file large enough to observe progress on your network (for example, 100 MB or more). Check that the receiver advances before completion and reaches 100% once the file is saved, with one completed row and one count increment per file. Switching screens and returning should preserve the transfer state. Interrupt a test transfer and confirm that the receiver reports an interruption rather than success; retrying should work normally.

Receiving progress measures bytes written by the receiving device, while sending progress measures bytes uploaded by the sender. Their percentages may briefly differ because of network buffering. The pairing and existing upload format remain compatible; coordinated cancellation uses the optional 0.3.1 control endpoints. See [receive progress](receive-progress.md) for implementation and validation details.

1. Connect the computer and phone to the same regular Wi-Fi/LAN and keep both apps visible.
2. On Ubuntu, open Receive Files and start the receiver. Note the code.
3. On Android, open Send Files. The Ubuntu receiver should appear under Nearby receivers within a few seconds. Select it and confirm the IP and port populate.
4. Enter the code shown on Ubuntu and send a small text file or image. Confirm the file appears in Ubuntu's Inbox and opens correctly.
5. Stop the Ubuntu receiver. It should disappear from Android's list after the next scan. Restart it, select it again, and enter its new code.
6. Reverse the direction: start Receive on Android and use Send on Ubuntu. Confirm the received file under Android Downloads → PulseDrop → Inbox. The storage mirror may take a few seconds to publish it there.
7. Try an incorrect code; the transfer should be rejected. Then enter the correct code and retry.
8. Test a larger file and several queued files in both directions. Compare contents or SHA-256 hashes when practical.
9. If discovery is blocked, type the destination's displayed IP, port, and code manually and repeat the transfer.

On Ubuntu, inbound UDP `53613` is used for discovery and TCP `53612` is normally used for receiving. If a firewall is enabled, allow those ports from your LAN subnet. If the Receive screen shows a different TCP port, allow that port instead. VPN policies and guest/client isolation can prevent devices from reaching one another.

## Rebuild in this workspace

```bash
source scripts/local-build-env.sh
npm run linux:build
npm run android:build:debug -- --ci
```

The Android APK is generated under `src-tauri/gen/android/app/build/outputs/apk/`, typically `universal/debug/app-universal-debug.apk`. The named files in `artifacts/` are copies of the validated builds; copy new build outputs there when rebuilding.

For a USB install later, enable developer options and USB debugging, authorize the computer, and run `npm run android:install:debug`. The installer selects debug APKs and uses `adb install -r` to preserve app data. With multiple devices, select one through `ANDROID_SERIAL`.

## Validation

The Ubuntu `.deb` built successfully on Ubuntu 26.04. Its package dependencies resolve on this machine. Native WebKit/Tauri integration checks verified receiver startup, pairing-code rejection, saving exact file bytes, receive events, UDP discovery, receiver selection, file selection, and sending a file through the actual WebView HTTP path. The tests used a local fixture receiver; testing between the physical computer and phone remains the checklist above.

Receiving progress passed 17 Rust tests, the JavaScript test suite, and native Linux WebView integration checks. A paced transfer showed live sender and receiver progress, saved exact bytes, preserved progress through navigation, and counted completion once. Concurrent same-named uploads, disconnect cleanup, empty files, and narrow window layouts also passed. See [receiving progress](receive-progress.md).

Cancellation validation passed 24 Rust tests, six JavaScript test files, and native Linux WebView integration tests with real local HTTP transfers. Both cancel controls, queue stopping, partial cleanup, concurrent uploads, exact-byte retry, old-peer compatibility, and completion/cancellation races passed. See [transfer cancellation](transfer-cancellation.md).

The updated Android APK built successfully with API 36 and NDK 28.2. Its package ID is `com.pulsedrop.transfer`, version is `0.3.1` (code `3001`), minimum API is `24`, and its only native ABI is `arm64-v8a`. APK v2 signature verification and ZIP/16 KB native-library alignment checks passed. The earlier Android system-bar fix was confirmed on the user's phone; the new cancellation behavior still needs a physical PC-to-phone test.
