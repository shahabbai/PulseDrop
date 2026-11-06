# Ubuntu 26.04 and Android device testing

## Install the test builds

The `artifacts/` directory contains the test packages and build/test logs. It is ignored by Git.

| Build | File | Size |
| --- | --- | --- |
| Ubuntu 26.04 x86-64 | `PulseDrop_0.1.0_amd64.deb` | 3.9 MiB |
| Android ARM64 debug | `PulseDrop_0.1.0_android_arm64_debug.apk` | 129.8 MiB |

The debug APK includes native debugging symbols, which account for most of its size. `artifacts/SHA256SUMS` contains both checksums.

### Ubuntu 26.04, x86-64

```bash
sudo apt install ./artifacts/PulseDrop_0.1.0_amd64.deb
pulse_drop
```

You can also run `./src-tauri/target/release/pulse_drop` directly from the repository without installing the package. The build targets Ubuntu 26.04; compatibility with older Ubuntu versions is not claimed.

### Android, ARM64

Copy `artifacts/PulseDrop_0.1.0_android_arm64_debug.apk` to the phone, open it in Files/Downloads, and allow that file manager to install the APK when Android prompts. This build supports Android 7.0/API 24 or newer on an ARM64 device. It includes the frontend and works without a development server or USB connection.

This APK uses a development signing key. It can update a previous debug build signed with the same key. If a previous PulseDrop build has a different signature, Android will reject the update. Preserve any files you need before choosing to uninstall that older app; this build does not automatically uninstall it.

## Test discovery and transfers

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

The Android APK built successfully with API 36 and NDK 28.2. Its package ID is `com.pulsedrop.transfer`, version is `0.1.0` (code `1000`), minimum API is `24`, and its only native ABI is `arm64-v8a`. APK v2 signature verification and ZIP/16 KB native-library alignment checks passed. Physical Android installation, Wi-Fi discovery, and transfers await manual device testing.
