// Available before the theme bootstrap and shared by the rest of the app.
(() => {
  const tauri = window.__TAURI__;
  const bridge = window.PulseDropAndroid;
  const invoke = tauri?.core?.invoke;
  const listen = tauri?.event?.listen;
  const android = /Android/i.test(window.navigator.userAgent);
  const ios = /iPhone|iPad|iPod/i.test(window.navigator.userAgent);

  /** @type {import("../native-types").NativeUpdates | undefined} */
  let updates;
  const { startUpdate, updateStatus, installUpdate } = bridge ?? {};
  if (startUpdate && updateStatus && installUpdate) {
    updates = {
      start: async () => startUpdate.call(bridge),
      status: async () => JSON.parse(updateStatus.call(bridge)),
      install: async () => installUpdate.call(bridge)
    };
  } else if (invoke && !android && !ios) {
    updates = {
      start: () => invoke("start_update"),
      status: () => invoke("update_status")
    };
  }

  /** @type {import("../native-types").NativePlatform} */
  const platform = {
    invoke,
    android,
    hotspotBridge: bridge,
    updates,
    deviceName: () => bridge?.deviceName?.() ?? null,
    setDiscoveryActive(active) {
      try { bridge?.setDiscoveryActive?.(active); }
      catch (error) { console.warn("Could not enable Android LAN discovery", error); }
    },
    async openInbox(path) {
      if (bridge?.openInbox) {
        bridge.openInbox();
        return "downloads";
      }
      if (android || path.startsWith("/storage/emulated/")) return "manual";
      if (invoke) await invoke("open_inbox");
      else await tauri?.opener?.openPath?.(path);
    },
    setTheme(theme) {
      try {
        if (bridge?.setTheme) bridge.setTheme(theme);
        else tauri?.window?.getCurrentWindow().setTheme(theme).catch(() => {});
      } catch { /* Native appearance is optional. Keep the web theme usable. */ }
    },
    subscribeReceiver(onProgress, makeId) {
      let disposed = false;
      /** @type {import("../native-types").Unlisten[]} */
      const unlisten = [];
      /** @param {import("../native-types").Unlisten} stop */
      function keep(stop) {
        if (disposed) stop();
        else unlisten.push(stop);
      }
      if (listen) {
        // Progress and completion are independent. A failed registration for
        // one channel should not suppress the other.
        listen("file-receive-progress", ({ payload }) => {
          if (!disposed) onProgress(payload);
        }).then(keep).catch((error) => console.warn("Could not subscribe to receive progress", error));
        listen("file-received", ({ payload }) => {
          if (!disposed) onProgress({
            ...payload,
            transfer_id: payload.transfer_id || makeId(),
            phase: "completed",
            received: payload.size,
            speed: 0,
            error: null
          });
        }).then(keep).catch((error) => console.warn("Could not subscribe to received files", error));
      }
      return () => {
        disposed = true;
        for (const stop of unlisten.splice(0)) stop();
      };
    }
  };
  window.PulseDropNative = Object.freeze(platform);
})();
