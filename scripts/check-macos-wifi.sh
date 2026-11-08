#!/usr/bin/env bash
# Validate the actual Apple SDK declarations without Wi-Fi hardware or a GUI.
set -euo pipefail

pulsedrop_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
macos_sdk="$(xcrun --sdk macosx --show-sdk-path)"

# Check the minimum supported OS for each architecture as well as API
# availability in the runner's SDK. Full Rust linking/bundling follows in CI.
for target in arm64-apple-macos11.0 x86_64-apple-macos10.13; do
  printf 'Checking macOS Wi-Fi APIs for %s\n' "$target"
  xcrun --sdk macosx clang \
    -target "$target" -isysroot "$macos_sdk" \
    -fsyntax-only -fobjc-arc -Wall -Wextra \
    -Werror=deprecated-declarations \
    -Werror=unguarded-availability -Werror=unguarded-availability-new \
    "$pulsedrop_root/src-tauri/native/wifi_macos.m"
done
