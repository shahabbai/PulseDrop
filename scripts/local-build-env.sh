#!/usr/bin/env bash
# Source this file to use the optional project-local build tools.
# With system tools installed, normal npm build commands work without this file.
PULSEDROP_BUILD_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.build-tools"

if [[ -x "$PULSEDROP_BUILD_ROOT/cargo/bin/cargo" ]]; then
  export CARGO_HOME="$PULSEDROP_BUILD_ROOT/cargo"
  export RUSTUP_HOME="$PULSEDROP_BUILD_ROOT/rustup"
  export PATH="$CARGO_HOME/bin:$PATH"
fi

if [[ -d "$PULSEDROP_BUILD_ROOT/native/usr" ]]; then
  export PATH="$PULSEDROP_BUILD_ROOT/bin:$PULSEDROP_BUILD_ROOT/native/usr/bin:$PATH"
  export PKG_CONFIG_SYSROOT_DIR="$PULSEDROP_BUILD_ROOT/native"
  export PKG_CONFIG_PATH="$PULSEDROP_BUILD_ROOT/native/usr/lib/x86_64-linux-gnu/pkgconfig:$PULSEDROP_BUILD_ROOT/native/usr/share/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
  export LIBRARY_PATH="$PULSEDROP_BUILD_ROOT/native/usr/lib/x86_64-linux-gnu${LIBRARY_PATH:+:$LIBRARY_PATH}"
  export LD_LIBRARY_PATH="$PULSEDROP_BUILD_ROOT/native/usr/lib/x86_64-linux-gnu:$PULSEDROP_BUILD_ROOT/native/usr/lib/x86_64-linux-gnu/android${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

if [[ -x "$PULSEDROP_BUILD_ROOT/native/usr/lib/jvm/java-21-openjdk-amd64/bin/java" ]]; then
  export JAVA_HOME="$PULSEDROP_BUILD_ROOT/native/usr/lib/jvm/java-21-openjdk-amd64"
  export PATH="$JAVA_HOME/bin:$PATH"
fi

if [[ -d "$PULSEDROP_BUILD_ROOT/android/cmdline-tools" ]]; then
  export ANDROID_HOME="$PULSEDROP_BUILD_ROOT/android"
  export ANDROID_SDK_ROOT="$ANDROID_HOME"
  export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
  if [[ -d "$ANDROID_HOME/ndk" ]]; then
    NDK_HOME="$(find "$ANDROID_HOME/ndk" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)"
    export NDK_HOME
  fi
fi

export GRADLE_USER_HOME="$PULSEDROP_BUILD_ROOT/gradle"
