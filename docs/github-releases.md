# Automatic GitHub releases

Use **v0.4.1** for the saved Light/Dark theme choice in Settings. Leave existing published tags unchanged.

The application manifests and lockfiles are prepared as 0.4.1. Run the commands below to commit and push the changes, wait for CI, and then push the tag. No commit, tag, or GitHub publication is performed by preparing these files.

## What happens automatically

```mermaid
flowchart LR
    A[Push or pull request] --> B[Version checks and frontend tests]
    B --> C[Linux tests and DEB]
    B --> D[Windows tests and EXE]
    B --> E[Android debug APK]
    B --> M[macOS tests and universal test DMG]
    F[Push v0.4.1 tag] --> G[Validate tag, changelog, and tests]
    G --> H[Build DEB, EXE, release APK, universal DMG]
    H --> I[Sign and verify APK]
    I --> J[Collect installers and SHA256SUMS]
    J --> K[Upload to draft, then publish release]
```

`.github/workflows/ci.yml` runs on pushes to `main`, pull requests, and manual dispatch. It checks all version files, runs JavaScript and desktop Rust tests, and builds Linux and Windows installers, an Android debug APK, and a universal macOS test DMG. Its artifacts are available on the workflow run for seven days. CI requires no signing secrets and never publishes a release.

`.github/workflows/release.yml` runs when you push a stable tag such as `v0.4.1`. The tag must match the versions in `package.json`, both lockfiles, `Cargo.toml`, and `tauri.conf.json`, and `CHANGELOG.md` must have a non-empty entry for that version. It tests and builds Linux, Windows, macOS, and Android, signs the Android release APK, then creates a GitHub Release only after all release builds succeed. Assets are uploaded to a temporary draft, which the workflow publishes automatically after upload completes.

The Release page body contains **only the tagged version’s section** from `CHANGELOG.md`, extracted by `scripts/release-notes.mjs` and passed through GitHub CLI’s `--notes-file`. For `v0.4.1`, it contains one bullet about the saved Light/Dark theme choice. The 0.4.0 and earlier entries stay in the repository and do not appear in that release’s description. Missing, empty, or duplicate version headings fail validation. Draft retries use the same tagged section. Preview the body with `node scripts/release-notes.mjs 0.4.1`. See the [GitHub CLI release documentation](https://cli.github.com/manual/gh_release_create).

| Release asset | Architecture / platform |
| --- | --- |
| `PulseDrop_0.4.1_amd64.deb` | Linux x86-64, built on Ubuntu 24.04 |
| `PulseDrop_0.4.1_x64-setup.exe` | Windows x64 NSIS installer |
| `PulseDrop_0.4.1_android_arm64.apk` | Android ARM64 release APK, API 24+ |
| `PulseDrop_0.4.1_universal.dmg` | macOS Apple Silicon and Intel, experimental/ad hoc signed |
| `SHA256SUMS` | SHA-256 checksums for all four installers |

The Linux build uses Ubuntu 24.04 as a baseline for compatibility with newer Ubuntu releases, including your Ubuntu 26.04 machine. The Windows job runs natively on `windows-2022`; it produces an `.exe` installer, rather than a standalone executable. The Windows installer is currently unsigned, so Windows may show an unknown-publisher prompt. Windows certificate signing can be added separately.

These are GitHub-hosted builds. The workflow installs its own toolchain and does not use the local `.build-tools/` directory. Android uses Java 21, API 36, and NDK 28.2.13676358, matching the local setup. Action references are pinned to commit hashes; update those pins when upgrading actions.

Windows setup caches Tauri’s installer tools in `%LOCALAPPDATA%\tauri`, keyed by runner architecture and the installed Tauri CLI version. CI and Release build desktop installers through `scripts/build-installer.mjs`. Windows NSIS builds retry up to three total attempts, waiting 10 then 20 seconds, only when the failed bundler log identifies a temporary HTTP download response (`408`, `429`, `500`, `502`, `503` or `504`). The helper streams build output, reuses compiled output/tools, and preserves Tauri’s download verification. Source errors, permanent HTTP errors, interruptions and exhausted retries still fail the job. Linux DEB builds run once.

## Download and test the macOS build

No personal Mac or Apple signing secrets are needed to build the ad hoc signed DMG. Both CI's **macOS universal test DMG** job and Release's **macOS universal DMG** job run on GitHub's `macos-15` runner, build the frontend before native Rust tests, and compile both Apple Silicon and Intel targets into one installer. They request `--bundles app,dmg` so Tauri retains the `.app` for verification; a DMG-only build removes that intermediate app after packaging. Each verifies the app's ad hoc signature, both executable architectures, the local network, camera and Location permission descriptions, and the DMG checksum before uploading the artifact.

After committing/pushing the CI changes, open [Actions → CI](https://github.com/shahabbai/PulseDrop/actions/workflows/ci.yml), select the latest successful run, and download **ci-macos-universal-dmg** from **Artifacts**. You can also use **Run workflow** on a branch containing the changes. Extract the downloaded ZIP and share the `.dmg` with a Mac tester. No new version or release tag is needed for this CI build.

For a published version, download the `.dmg` directly from [GitHub Releases](https://github.com/shahabbai/PulseDrop/releases). The release job builds it from the same tagged source as the other three installers; it does not reuse a previous CI artifact.

On the Mac, open the DMG, drag **PulseDrop** into **Applications**, and launch it. This test build uses ad hoc signing, not an Apple Developer identity, and is not notarized. Gatekeeper may block the first launch; for a build you trust, use **System Settings → Privacy & Security → Open Anyway**, then follow the confirmation prompts. See [Tauri's ad hoc signing guidance](https://v2.tauri.app/distribute/sign/macos/#ad-hoc-signing).

Allow PulseDrop's local network permission when prompted and allow incoming connections if the macOS firewall asks. Keep both apps open on the same LAN, then test discovery, manual IP/pairing, transfers in both directions with Ubuntu or Android, and **Open Inbox**. Declining local network access can prevent discovery and outgoing transfers; enable it in **System Settings → Privacy & Security → Local Network** if needed. The app includes `NSLocalNetworkUsageDescription` in its macOS bundle for this permission.

These jobs compile both architectures and run Rust tests on the runner's native architecture. They do not launch or test the graphical app, establish physical LAN connectivity, or build iOS. Apple Developer signing/notarization and physical device validation are separate follow-up work. The release notes explicitly identify the macOS download as experimental and not notarized.

## 1. Create or reuse the Android release signing key

If you already have a production keystore, use that same file, alias, and passwords. Otherwise create one once. On this Ubuntu workspace:

```bash
source scripts/local-build-env.sh
mkdir -p .build-tools/signing
keytool -genkeypair -v \
  -keystore .build-tools/signing/pulsedrop-release.jks \
  -storetype JKS \
  -alias pulsedrop \
  -keyalg RSA -keysize 3072 -validity 10000
base64 -w 0 .build-tools/signing/pulsedrop-release.jks \
  > .build-tools/signing/pulsedrop-release.jks.base64
```

`keytool` prompts for the keystore password and certificate details, then the key password. You can choose the same password for the store and key. The Base64 file is an encoding of the private keystore, not encryption. Both files remain in the ignored `.build-tools/` directory.

Back up the keystore, alias, and passwords outside the repository. Reuse them for every release: Android requires the same signing identity when updating an installed app. The 0.1.0 APK built for your phone was debug-signed; switching it to a new release key requires a one-time uninstall/reinstall. Save any needed app data first. Later release APKs signed with this persistent release key can update one another normally. See [Android signing guidance](https://v2.tauri.app/distribute/sign/android/).

## 2. Add four GitHub repository secrets

Open [PulseDrop Actions secrets](https://github.com/shahabbai/PulseDrop/settings/secrets/actions), or navigate to **Settings → Secrets and variables → Actions → New repository secret**. Add:

| Secret name | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Entire contents of `pulsedrop-release.jks.base64` |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | `pulsedrop`, or the alias in your existing keystore |
| `ANDROID_KEY_PASSWORD` | Key password; use the same value as the store password if configured that way |

Do not put these values in YAML or commit the keystore. The release workflow restores it in the runner's temporary directory, passes passwords through environment variables to `apksigner`, and removes the temporary keystore after signing. GitHub documents the secret setup [here](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets).

If **Restore signing keystore** reports `Invalid base64-encoded string`, replace `ANDROID_KEYSTORE_BASE64` with the complete contents of the encoded file. A path, filename, partial selection, or a command is not the encoded keystore. Recreate the encoding from the existing key with:

```bash
base64 -w 0 .build-tools/signing/pulsedrop-release.jks \
  > .build-tools/signing/pulsedrop-release.jks.base64
```

Open that file locally, select/copy all its contents, and update the secret under **Settings → Secrets and variables → Actions**. Do not include quotes or Markdown formatting. Keep using the same keystore and passwords. After saving the corrected secret, open the failed Release run and choose **Re-run failed jobs**; a secret-only correction needs no new version tag or source commit. The updated workflow also validates Base64 before expensive build steps and accepts whitespace/line wrapping while rejecting malformed data. That workflow improvement applies to future tags containing the change; the existing tagged workflow works with the corrected single-line secret.

No personal access token is needed. The final publishing job requests `contents: write` for GitHub's automatically supplied `GITHUB_TOKEN`; other jobs use read access. If repository or organization policy disables Actions or restricts the referenced actions/token permissions, adjust that policy under **Settings → Actions → General**.

## 3. Commit 0.4.1 manually

Run these commands in Bash from the repository root on `main`. The version bump and short changelog are already applied. Commit the theme, Android system-bar appearance, version files and documentation together.

Review existing staged files first. The explicit file lists below exclude `design-system/`, `.agents/`, `.codex/`, `.build-tools/`, artifacts, generated assets and signing files. These local paths are already ignored; do not use `git add .` for this release.

```bash
cd /home/shahab/PulseDrop
git status --short
git diff --cached --name-only
npm run version:check -- v0.4.1
npm test
npm run frontend:build
node scripts/release-notes.mjs 0.4.1
```

### Theme and release files

```bash
git add -- package.json package-lock.json \
  src/{index.html,main.js,styles.css} src/public/theme.js tests/theme.test.mjs \
  src-tauri/{Cargo.toml,Cargo.lock,tauri.conf.json} \
  src-tauri/capabilities/default.json \
  src-tauri/gen/schemas/capabilities.json \
  src-tauri/gen/android/app/src/main/java/com/pulsedrop/transfer/{MainActivity,PulseDropAndroidBridge}.kt \
  CHANGELOG.md README.md docs/device-testing.md docs/github-releases.md
git diff --cached --stat
git commit -m "feat: add saved light and dark themes in 0.4.1"
git status --short
git push origin main
```

Wait for **CI on the final commit** to pass for all platforms. CI artifacts can be used for installation tests. The release tag builds fresh installers and signs the Android APK with the existing release identity. Existing local build artifacts are not changed by the version bump; build a fresh 0.4.1 installer to test this change.

In **Settings → Appearance → Theme**, switch between Light and Dark. Check Home, Send, Receive and Settings, then close and reopen the app to confirm the choice is saved. On Android, check that the clock and system navigation icons remain readable in both themes, including after rotating the phone. Existing LAN/hotspot transfers should behave as before. See [device testing](device-testing.md).

## 4. Publish version 0.4.1

After the final commit passes CI, with your existing Android secrets still configured:

```bash
git tag -a v0.4.1 -m "PulseDrop 0.4.1"
git push origin v0.4.1
```

Pushing this tag starts **Release**. Once every job succeeds, GitHub automatically publishes [the release](https://github.com/shahabbai/PulseDrop/releases) with the `.deb`, `.apk`, `.exe`, `.dmg`, checksums, and only the short 0.4.1 section from `CHANGELOG.md` as its visible release notes. No installer needs to be uploaded or committed by hand. The APK is ARM64, the Windows and Linux packages are x64, and the DMG contains both macOS architectures.

Pushing a commit alone runs CI. Pushing the matching version tag publishes the release. An existing published tag must not be reused or moved.

## Future versions

After 0.4.1, use `0.4.2` for fixes or `0.5.0` for another feature release. After committing the feature/fix, update the version and changelog:

```bash
npm run version:bump -- 0.4.2
# Update CHANGELOG.md with the release notes.
npm run version:check
git add package.json package-lock.json src-tauri/Cargo.toml \
  src-tauri/Cargo.lock src-tauri/tauri.conf.json CHANGELOG.md
git commit -m "Release 0.4.2"
git push origin main
# Wait for CI to pass, then:
git tag -a v0.4.2 -m "PulseDrop 0.4.2"
git push origin v0.4.2
```

`version:bump` updates the five manifest/lockfiles together. Android's default version code is derived from this version (`0.4.1` becomes `4001`), so increasing the version also increases the Android update version code. This setup accepts stable numeric versions only; prerelease suffixes need an explicit version-code policy before adding them.

## If a run fails

- If Windows finishes compiling `pulse_drop.exe` but fails while downloading `nsis-3.11.zip` with `http status: 504`, the NSIS tool download timed out. Re-running the failed job may succeed once the download service recovers. New revisions use the installer-tool cache and bounded download retries in both CI and Release. Commit/push those changes to use them; rerunning an older revision retains its original build command. A persistent outage still fails the build, so no incomplete installer is published.
- If native compilation reports that `kCLAuthorizationStatusAuthorizedWhenInUse` is unavailable on macOS, use the macOS authorization grant (`kCLAuthorizationStatusAuthorizedAlways`). The adapter reads the instance authorization property on macOS 11+ and retains the legacy getter only for older supported systems. Both macOS workflows run `bash scripts/check-macos-wifi.sh` against Apple Silicon and Intel deployment targets before Rust compilation so unavailable/deprecated SDK APIs fail in a named native check. Commit/push the correction to trigger CI on the new source; rerunning an older revision keeps the original error.
- If the macOS build succeeds but verification cannot find `PulseDrop.app/Contents/Info.plist`, ensure its build command uses `--bundles app,dmg`. Tauri removes the intermediate `.app` when only `dmg` is requested. Commit and push the workflow fix to start a new CI run; rerunning the previous run uses the old command.
- A missing secret fails the Android release job with the secret names to configure. Add them, then use **Re-run failed jobs**.
- If Rust compilation reports that `frontendDist` (`../dist`) does not exist, build the frontend in that same job before `cargo test`. Desktop jobs do this explicitly because `tauri::generate_context!()` embeds frontend assets at compile time. The frontend built in the separate checks job is not shared with other runners. Commit/push workflow fixes to trigger a new CI run; rerunning an old run uses its original workflow revision.
- If Windows Rust tests hang at `cancelling_wakes_a_blocked_read_and_retains_the_response_channel`, update to the fix that uses short, cancellation-aware socket reads instead of relying on shutting down a cloned socket. The regression test now fails within a bounded wait. CI and Release compile Rust tests in a separate step, then limit test execution to five minutes so a hung test cannot consume the rest of the build job. Push the fix to start a new CI run; rerunning the old revision retains the old test.
- A tag/version mismatch fails before building installers. Fix the source version and publish a new matching tag. Published versions should keep their original tags and assets.
- Failed builds do not reach the publishing job. A failure during upload leaves a draft; rerunning the publishing job reuses that draft and uploads the complete asset set before publication. Already published releases are not overwritten.
- Physical LAN discovery and transfer tests still belong in [device testing](device-testing.md); hosted runners verify builds and automated tests, not communication between your phone and PC.

The desktop build approach follows [Tauri's GitHub Actions guidance](https://v2.tauri.app/distribute/pipelines/github/).

## Local validation

For 0.4.1, local validation passed 78 JavaScript tests and 38 Rust tests, and built the Linux DEB and Android debug APK. Native Linux checks exercised both themes across all four screens at widths from 360 to 1440 pixels, keyboard selection, saved preferences after reload and a full app restart, text/status contrast of at least 4.5:1, control/focus contrast of at least 3:1, and a real paced upload while switching themes. Queue contents, receiver state and exact received bytes were preserved. Android system bars still need a physical phone check; Windows/macOS builds and UI checks remain for CI and device testing. The release-note preview contains only the single 0.4.1 theme bullet. No GitHub release is published during local validation.
