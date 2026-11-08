<p align="center">
  <img src="assets/brand/pulsedrop-github-logo.png" alt="PulseDrop logo" width="820" />
</p>

# PulseDrop

PulseDrop is a Windows and Android-first local network file transfer app built with Tauri 2. It lets devices on the same Wi-Fi/LAN send files directly to each other without cloud storage, accounts, or an external server.

The app supports Windows desktop, Ubuntu 26.04, and Android phones. CI also builds an experimental universal macOS DMG for Apple Silicon and Intel; physical Mac testing is still needed. iOS support is planned.

The next release is **0.3.0**. See [automatic GitHub releases](docs/github-releases.md) for the Android signing setup, manual commit commands, and the tag-based workflow that publishes `.deb`, `.apk`, Windows `.exe`, and universal macOS `.dmg` installers with the full [changelog](CHANGELOG.md).

## Features

- Send one or more files from PC to phone or phone to PC.
- Start a receiver on any device and share its IP, port, and 6-digit pairing code.
- Automatically discover active receivers on the LAN and select one to fill its IP and port.
- Save received files into an app Inbox folder.
- Follow live byte progress and speed on both the sending and receiving devices, with per-file transfer activity.
- Open the Inbox from the app.
- Local HTTP health check before sending, so bad IP/firewall/VPN problems fail clearly.
- LAN IP detection that prefers Wi-Fi/Ethernet addresses over VPN and tunnel interfaces.

## Stack

The interface uses a shared dark design system with persistent navigation, file queues, nearby receivers, and collapsed advanced networking controls. The original native app icon is retained. Local design reference files are excluded from Git.

- Tauri 2 for desktop/mobile app shell.
- Rust for the local receiver, upload handling, inbox management, device profile, and network interface selection.
- Vanilla HTML, CSS, and JavaScript for the frontend.
- Vite for frontend bundling.
- Android Studio, Android SDK, Android NDK, and Gradle for Android builds.

## How It Works

1. The receiving device starts a small local HTTP receiver.
2. The app shows the receiver IP, port, and pairing code and answers LAN discovery requests.
3. The sending device selects a nearby receiver (or enters its IP and port manually), enters its pairing code, and selects files.
4. Before upload, the sender calls `/health` to confirm the receiver is reachable.
5. Files are posted to `/upload` and saved in the receiver Inbox.


## Project Structure

```text
src/
  index.html          Frontend markup
  styles.css          App UI and animations
  main.js             Frontend behavior and transfer requests
  discovery.js        Discovery polling and view lifecycle

src-tauri/
  src/lib.rs          Tauri commands, receiver server, file saving, LAN IP selection
  src/discovery.rs    UDP discovery service, scanning, protocol validation, and tests
  src/network.rs      Shared IPv4 and network interface helpers
  tauri.conf.json     App metadata, CSP, build config, bundle config
  capabilities/       Tauri permissions
  icons/              Desktop/mobile source icons
  gen/android/        Generated Android project

scripts/
  build-frontend.mjs          Builds Vite assets and copies them into Android assets
  android-install-debug.mjs   Installs and launches the newest debug APK with adb
```

## Requirements

### Windows Development

- Windows 10 or newer.
- Node.js 18 or newer.
- Rust stable with Cargo.
- Microsoft Visual Studio Build Tools with C++ desktop tools.
- WebView2 Runtime, usually already installed on modern Windows.

### Android Development

- Android Studio.
- Android SDK.
- Android NDK.
- Android platform tools / `adb`.
- Developer options and USB debugging enabled on the phone.

Useful Rust Android targets:

```bash
rustup target add aarch64-linux-android
rustup target add armv7-linux-androideabi
rustup target add i686-linux-android
rustup target add x86_64-linux-android
```


## Install Dependencies

```bash
npm install
```

## Run On Windows

```bash
npm run dev
```

## Build And Test On Ubuntu 26.04

For this workspace, project-local Rust, Java, Linux development libraries, and Android SDK tools are available in the ignored `.build-tools/` directory. Enable them in each new terminal:

```bash
source scripts/local-build-env.sh
npm run linux:build
```

The Ubuntu package is generated at `src-tauri/target/release/bundle/deb/PulseDrop_0.2.0_amd64.deb`. The existing `0.1.0` test artifact can still be installed with `sudo apt install ./artifacts/PulseDrop_0.1.0_amd64.deb`, or run `./src-tauri/target/release/pulse_drop` directly after building.

On another Ubuntu machine, install the [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux), Rust, and Node.js before building; `.build-tools/` is local and is not committed. See [device testing instructions](docs/device-testing.md) for the Ubuntu/Android test builds and a transfer checklist.


## Build Windows Installer

```bash
npm run build
```

Current Windows build artifacts are created under:

```text
src-tauri/target/release/bundle/
```

Typical outputs:

```text
src-tauri/target/release/bundle/msi/PulseDrop_0.2.0_x64_en-US.msi
src-tauri/target/release/bundle/nsis/PulseDrop_0.2.0_x64-setup.exe
```

For GitHub releases, the `.exe` installer is usually the easiest for users. The `.msi` is also useful for enterprise-style installation.

## Prepare Android

Initialize the Android project once:

```bash
npm run android:init
```

The generated Android project lives here:

```text
src-tauri/gen/android/
```

The Android manifest should include these permissions:

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
<uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE" />
```

The app also needs cleartext HTTP enabled because transfers happen over local `http://192.168.x.x:53612` URLs:

```xml
android:usesCleartextTraffic="true"
```

## Run On Android Phone

Connect the phone by USB, enable USB debugging, accept the authorization prompt, then run:

```bash
npm run android:dev
```

In this project, `android:dev` builds a debug APK, updates the existing debug app while preserving its data, and launches it. An existing release signed with a different key cannot be replaced by the debug APK; Android will report a signature mismatch.

If you want the hot dev-server mode instead, use:

```bash
npm run android:hot
```

Packaged APK testing is recommended because it avoids Android white screens caused by the phone not reaching the PC dev server.


## Testing Transfers

1. Put the PC and phone on the same Wi-Fi/LAN.
2. Start PulseDrop on the receiving device.
3. Open Receive Files and start the receiver.
4. Open Send Files on the other device and select the receiver under Nearby receivers.
5. Enter the receiving device's code. If discovery is unavailable, enter its IP and port manually.
6. Select files and send.

Discovery uses IPv4 UDP port `53613`; file transfers continue to use HTTP, normally on TCP `53612`. Pairing codes are never included in discovery packets. The Send screen refreshes automatically while visible, with a manual refresh button available. See [LAN discovery design and validation](docs/lan-discovery.md).

### Automated Checks

```bash
npm test
npm run frontend:build
cd src-tauri
cargo test
```

To check the receiver manually, open this in a browser from the other device:

```text
http://PC_IP:53612/health?code=PAIRING_CODE
```

Expected response:

```text
Ready
```

Example:

```text
http://192.168.1.25:53612/health?code=123456
```

## Troubleshooting

### Phone Browser Cannot Reach The PC Receiver

First check on the PC:

```bash
curl "http://127.0.0.1:53612/health?code=PAIRING_CODE"
```

If that returns `Ready`, test the PC LAN IP:

```bash
curl "http://192.168.x.x:53612/health?code=PAIRING_CODE"
```

If localhost works but the phone cannot reach the PC:

- Allow PulseDrop through Windows Firewall on Private networks.
- Set the Windows Wi-Fi/Ethernet network profile to Private.
- Make sure the phone and PC are on the same Wi-Fi/LAN.
- Disable VPN temporarily, or enable LAN access / split tunneling in the VPN.
- Check whether the router has AP isolation / client isolation enabled.

### Check If Port 53612 Is Listening On Windows

```bat
netstat -ano | findstr :53612
```

Good result:

```text
TCP    0.0.0.0:53612     0.0.0.0:0     LISTENING     12345
```

If the app uses another port, use the port shown in the Receive screen.

### Windows Firewall Prompt

The first time a release build receives files, Windows may ask whether to allow network access. Users should allow Private network access.

This is normal for LAN file transfer apps. PulseDrop cannot receive files from phones unless Windows allows inbound local network connections.

### Nearby Receivers Is Empty

- Start the receiver on the other device and keep both apps in the foreground on the same LAN.
- On Windows, use Settings → Windows Firewall → Fix to add the receiver TCP rule and the UDP `53613` discovery rule on Private networks. Older TCP-only rules allow transfers but do not enable discovery.
- VPN, guest Wi-Fi, client isolation, or blocked broadcast traffic can prevent discovery. Enter the receiver IP, port, and code manually in that case.
- Only active PulseDrop receivers using this discovery protocol appear. IPv6-only networks and discovery across routed subnets are not supported.
- If UDP `53613` is already occupied, receiving still works and the Receive screen explains how to connect manually.

### VPN Shows The Wrong IP

PulseDrop tries to prefer Wi-Fi/Ethernet over VPN interfaces. If a VPN address still appears or transfers fail:

- Select the Wi-Fi/LAN IP from the Local addresses chips.
- Use an IP like `192.168.x.x`, `10.x.x.x`, or `172.16-31.x.x`.
- Enable LAN access or split tunneling in the VPN app.
- Temporarily disable the VPN for testing.



## Roadmap Ideas

- Android App Bundle / Play Store distribution.
- QR code pairing.
- Transfer cancellation.
- Signed and notarized macOS releases.
- iOS build.
- Optional installer step for Windows firewall rule with user/admin consent.

## License

MIT license
