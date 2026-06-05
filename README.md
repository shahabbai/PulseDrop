# PulseDrop

PulseDrop is a Windows and Android-first local network file transfer app built with Tauri 2. It lets devices on the same Wi-Fi/LAN send files directly to each other without cloud storage, accounts, or an external server.

The current first release targets Windows desktop and Android phones. The codebase is structured so macOS and iOS can be added later with Tauri mobile support.

## Features

- Send one or more files from PC to phone or phone to PC.
- Start a receiver on any device and share its IP, port, and 6-digit pairing code.
- Save received files into an app Inbox folder.
- Open the Inbox from the app.
- Local HTTP health check before sending, so bad IP/firewall/VPN problems fail clearly.
- LAN IP detection that prefers Wi-Fi/Ethernet addresses over VPN and tunnel interfaces.

## Stack

- Tauri 2 for desktop/mobile app shell.
- Rust for the local receiver, upload handling, inbox management, device profile, and network interface selection.
- Vanilla HTML, CSS, and JavaScript for the frontend.
- Vite for frontend bundling.
- Android Studio, Android SDK, Android NDK, and Gradle for Android builds.

## How It Works

1. The receiving device starts a small local HTTP receiver.
2. The app shows the receiver IP, port, and pairing code.
3. The sending device enters those values and selects files.
4. Before upload, the sender calls `/health` to confirm the receiver is reachable.
5. Files are posted to `/upload` and saved in the receiver Inbox.


## Project Structure

```text
src/
  index.html          Frontend markup
  styles.css          App UI and animations
  main.js             Frontend behavior and transfer requests

src-tauri/
  src/lib.rs          Tauri commands, receiver server, file saving, LAN IP selection
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
src-tauri/target/release/bundle/msi/PulseDrop_0.1.0_x64_en-US.msi
src-tauri/target/release/bundle/nsis/PulseDrop_0.1.0_x64-setup.exe
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

In this project, `android:dev` builds a debug APK, uninstalls the previous app, installs the new APK, and launches it.

If you want the hot dev-server mode instead, use:

```bash
npm run android:hot
```

Packaged APK testing is recommended because it avoids Android white screens caused by the phone not reaching the PC dev server.


## Testing Transfers

1. Put the PC and phone on the same Wi-Fi/LAN.
2. Start PulseDrop on the receiving device.
3. Open Receive Files and start the receiver.
4. Copy the IP, port, and code into the sending device.
5. Select files and send.

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

### VPN Shows The Wrong IP

PulseDrop tries to prefer Wi-Fi/Ethernet over VPN interfaces. If a VPN address still appears or transfers fail:

- Select the Wi-Fi/LAN IP from the Local addresses chips.
- Use an IP like `192.168.x.x`, `10.x.x.x`, or `172.16-31.x.x`.
- Enable LAN access or split tunneling in the VPN app.
- Temporarily disable the VPN for testing.



## Roadmap Ideas

- Signed Android release APK/AAB.
- Automatic receiver discovery on the LAN.
- QR code pairing.
- Transfer cancellation.
- Per-file receive progress events.
- macOS build.
- iOS build.
- Optional installer step for Windows firewall rule with user/admin consent.

## License

Add a license before publishing publicly. MIT is a common choice for small open-source utilities, but choose the license that fits your plans.
