import { androidHotspotTransport, createHotspotController, validateHotspot } from "./hotspot.js";
import { mountHotspotConnect } from "./hotspot-connect-ui.js";
import { encodeHotspotQr, paintHotspotQr } from "./hotspot-qr.js";

export function mountHotspot({ invoke, bridge, ensureReceiver, refreshNetwork, canChange, copy, connectionInfo = () => null, connected = () => {}, onChange = () => {} }) {
  const doc = document;
  const el = (id) => doc.getElementById(id);
  let capabilities = null;
  let sendMode = "lan", receiveMode = "lan";
  let checking = false;
  let externalSharing = false;
  let qrKey = "";
  const native = bridge && typeof bridge.hotspotStatus === "function";
  const transport = native ? androidHotspotTransport(bridge) : {
    start: async () => ({ ...await invoke("start_hotspot"), role: "host" }),
    join: (credentials) => invoke("join_hotspot", { ssid: credentials.ssid, password: credentials.password, bssid: credentials.bssid || null, interface: credentials.interface || null }),
    stop: () => invoke("stop_hotspot")
  };
  const controller = createHotspotController({ transport, onChange: () => { render(); onChange(); } });
  const connectUI = mountHotspotConnect({ invoke, canChange, onPrepared: () => render(),
    scanNetworks: native ? () => transport.scan() : () => invoke("scan_hotspots"),
    cancelScan: native ? () => transport.cancelScan() : () => {}
  });
  const safe = (action) => async (event) => {
    event?.preventDefault();
    if (!canChange()) { status("Finish or cancel active transfers before changing Wi-Fi."); return; }
    try { await action(); } catch { /* The controller or inline action reports the failure. */ }
  };
  function status(message, receiving = false, error = true) {
    const node = el(receiving ? "hotspot-receive-status" : "hotspot-send-status");
    if (node.textContent !== message) node.textContent = message;
    node.dataset.error = String(error);
  }
  function render() {
    const current = controller.snapshot();
    const host = current.session?.role === "host";
    const sender = current.session?.role === "sender";
    const busy = current.busy || externalSharing;
    el("hotspot-send").hidden = sendMode !== "hotspot";
    el("hotspot-send-description").textContent = capabilities?.can_join
      ? "Create a hotspot on the other device, then scan its QR or choose its Wi-Fi below."
      : "Join the receiver’s hotspot in Wi-Fi settings, then find it below.";
    el("hotspot-receive").hidden = receiveMode !== "hotspot";
    el("hotspot-create").disabled = !capabilities?.can_host || busy || Boolean(current.session) || !canChange();
    el("hotspot-create").hidden = host || (busy && current.operation === "start");
    el("hotspot-stop").hidden = !host && !(busy && current.operation === "start");
    el("hotspot-stop").disabled = (busy && current.operation === "stop") || !canChange();
    el("hotspot-stop").textContent = busy ? (current.operation === "stop" ? "Stopping…" : "Cancel setup") : current.session?.external ? "Hide connection QR" : "Stop hotspot";
    el("hotspot-credentials").hidden = !host;
    el("hotspot-credentials-details").hidden = !host;
    if (capabilities?.message) el("hotspot-capability").textContent = host ? "On the other device, open Send → Hotspot → Scan QR. No password to type." : capabilities.message;
    el("hotspot-network-name").textContent = host ? current.session.ssid : "";
    el("hotspot-network-password").textContent = host ? current.session.password : "";
    el("hotspot-qr").hidden = !host;
    if (host) {
      const key = encodeHotspotQr({ ...current.session, receiver: connectionInfo() });
      if (key !== qrKey) {
        qrKey = key;
        el("hotspot-qr-hint").textContent = "On the other device, open Send → Hotspot → Scan QR. No password typing.";
        paintHotspotQr(el("hotspot-qr-code"), key, () => qrKey === key).catch(() => {
          if (qrKey === key) el("hotspot-qr-hint").textContent = "Could not display the QR. Copy Wi-Fi details or enter the password on the sender.";
        });
      }
    } else if (qrKey) { qrKey = ""; el("hotspot-qr-code").width = 0; el("hotspot-qr-code").height = 0; }
    el("hotspot-state").textContent = busy ? "Setting up…" : current.session?.external ? "Connection QR ready" : host ? "Hotspot active" : "Not started";
    el("hotspot-external-setup").hidden = !capabilities || host || sender;
    el("hotspot-join-form").hidden = !capabilities?.can_join || host || sender;
    el("hotspot-join").disabled = busy || !canChange() || !el("hotspot-ssid").value;
    el("hotspot-join").textContent = busy && current.operation === "join" ? "Connecting…" : "Connect";
    el("hotspot-leave").hidden = !sender && !(busy && current.operation === "join");
    el("hotspot-leave").disabled = (busy && current.operation === "stop") || !canChange();
    el("hotspot-leave").textContent = busy && current.operation === "join" ? "Cancel connection" : "Disconnect hotspot";
    el("hotspot-manual-ready").hidden = capabilities?.can_host !== false;
    for (const id of ["hotspot-wifi-settings", "hotspot-system-settings", "hotspot-find", "hotspot-manual-ready"]) {
      el(id).disabled = busy || !canChange();
    }
    for (const input of document.querySelectorAll(".connection-choice input")) input.disabled = busy || Boolean(current.session) || !canChange();
    for (const id of ["hotspot-ssid", "hotspot-password"]) el(id).disabled = busy || !canChange();
    for (const id of ["hotspot-external-share", "hotspot-external-ssid", "hotspot-external-password"]) el(id).disabled = busy || !canChange();
    el("hotspot-receive").setAttribute("aria-busy", String(busy && current.operation !== "join"));
    el("hotspot-join-form").setAttribute("aria-busy", String(busy && current.operation === "join"));
    connectUI.configure(capabilities, sendMode === "hotspot" && !host && !sender, busy);
    if (current.error) {
      status(current.error, receiveMode === "hotspot");
      if (sendMode === "hotspot") status(current.error);
    } else if (busy) {
      status(current.operation === "stop" ? "Releasing the hotspot connection…" : "Complete any Wi-Fi permission or connection request on this device.", receiveMode === "hotspot", false);
    } else if (host) {
      status(current.session.external ? "Connection QR ready. Keep the system hotspot enabled. Hiding this QR does not turn it off." : "Hotspot ready. Scan its QR on the other device, then choose Connect. No internet is required.", true, false);
    } else if (sender) {
      status(`Connected to ${current.session.ssid}. ${current.session.paired ? "Receiver details filled. Add files and send." : "Find the receiver below and enter its pairing code."}`, false, false);
    }
    if (!canChange() && !current.error) status("Finish or cancel active transfers before changing Wi-Fi.", receiveMode === "hotspot", false);
  }
  async function checkCapabilities() {
    if (capabilities || checking) return;
    checking = true;
    try {
      capabilities = native ? { ...JSON.parse(bridge.hotspotStatus()), platform: "android", message: "A local-only hotspot needs Android 8 or later and Wi-Fi hardware support. It may replace your current Wi-Fi connection. No router, SIM or mobile data is needed." }
        : invoke ? await invoke("hotspot_capabilities") : { can_host: false, message: "Open PulseDrop to set up a hotspot. Browser preview cannot change Wi-Fi." };
      el("hotspot-capability").textContent = capabilities.message;
      if (["windows", "macos", "ios"].includes(capabilities.platform)) {
        el("hotspot-capability").textContent += capabilities.platform === "ios"
          ? " iPhone Personal Hotspot requires system setup and may require a cellular plan; use an Android/Linux receiver for offline hosting."
          : " For reliable hosting without internet, use an Android or supported Linux receiver. You can join that hotspot from this device.";
      }
      capabilities.message = el("hotspot-capability").textContent;
    } catch (error) {
      capabilities = { can_host: false };
      el("hotspot-capability").textContent = String(error.message || error);
    } finally { checking = false; render(); }
  }
  for (const side of ["send", "receive"]) {
    document.querySelectorAll(`input[name="${side}-connection"]`).forEach((input) => input.addEventListener("change", () => {
      if (side === "send") sendMode = input.value; else receiveMode = input.value;
      capabilities = null;
      checkCapabilities(); render();
    }));
  }
  el("hotspot-create").addEventListener("click", safe(async () => {
    const session = await controller.start();
    if (!session || controller.snapshot().session !== session) return;
    try { await ensureReceiver(session.address); render(); }
    catch (error) {
      // Hotspot exists even if binding the receiver failed. Keep its credentials
      // and Stop control so the user can recover instead of leaking a network.
      controller.reportError(`Hotspot created, but the receiver could not start: ${String(error)}. Use Start receiving to retry, or Stop hotspot.`);
    }
  }));
  el("hotspot-stop").addEventListener("click", safe(async () => {
    const external = controller.snapshot().session?.external;
    await controller.stop(); await refreshNetwork(); status(external ? "Connection QR hidden. Your system hotspot is still under your control in Settings." : "Hotspot stopped. You can keep receiving on your local network.", true, false);
  }));
  el("hotspot-external-form").addEventListener("submit", safe(async () => {
    if (externalSharing || controller.snapshot().session || controller.snapshot().busy) return;
    const credentials = { ssid: el("hotspot-external-ssid").value, password: el("hotspot-external-password").value };
    const errors = validateHotspot(credentials);
    for (const name of ["ssid", "password"]) {
      el(`hotspot-external-${name}`).setAttribute("aria-invalid", String(Boolean(errors[name])));
      el(`hotspot-external-${name}-error`).hidden = !errors[name];
      el(`hotspot-external-${name}-error`).textContent = errors[name] || "";
    }
    if (Object.keys(errors).length) { el(`hotspot-external-${Object.keys(errors)[0]}`).focus(); return; }
    externalSharing = true; render();
    try {
      await ensureReceiver();
      controller.useExternal(credentials);
      el("hotspot-external-password").value = "";
      el("hotspot-external-ssid").value = "";
    } catch (error) { status(String(error.message || error), true); }
    finally { externalSharing = false; render(); }
  }));
  el("hotspot-leave").addEventListener("click", safe(async () => {
    await controller.stop(); connectUI.clear(); await refreshNetwork(); status("Disconnected. Choose another hotspot or return to Local network.", false, false);
  }));
  el("hotspot-join-form").addEventListener("submit", safe(async () => {
    const credentials = { ssid: el("hotspot-ssid").value, password: el("hotspot-password").value, ...connectUI.extras() };
    const errors = validateHotspot(credentials);
    for (const name of ["ssid", "password"]) {
      el(`hotspot-${name}-error`).hidden = !errors[name]; el(`hotspot-${name}-error`).textContent = errors[name] || "";
      el(`hotspot-${name}`).setAttribute("aria-invalid", String(Boolean(errors[name])));
    }
    if (Object.keys(errors).length) { el("hotspot-manual-credentials").open = true; el("hotspot-name-field").hidden = false; el(`hotspot-${Object.keys(errors)[0]}`).focus(); return; }
    const session = await controller.join(credentials);
    if (!session) return;
    el("hotspot-password").value = "";
    await refreshNetwork();
    if (credentials.receiver) { connected(credentials.receiver); session.paired = true; render(); }
  }));
  el("hotspot-password-toggle").addEventListener("click", () => {
    const show = el("hotspot-password").type === "password";
    el("hotspot-password").type = show ? "text" : "password";
    el("hotspot-password-toggle").textContent = show ? "Hide" : "Show";
    el("hotspot-password-toggle").setAttribute("aria-pressed", String(show));
  });
  for (const [id, hosting] of [["hotspot-wifi-settings", false], ["hotspot-system-settings", true]]) {
    el(id).addEventListener("click", safe(async () => {
      try {
        if (native) bridge.openWifiSettings(hosting);
        else if (invoke) await invoke("open_wifi_settings", { hosting });
        else throw new Error("Open Wi-Fi in your device’s Settings app.");
        status("Return to PulseDrop after changing Wi-Fi, then refresh the connection.", hosting, false);
      } catch (error) { status(String(error.message || error), hosting); }
    }));
  }
  el("hotspot-manual-ready").addEventListener("click", safe(async () => {
    try { await ensureReceiver(); status("Receiver listening. Use the hotspot’s address below; choose it in Advanced network details if needed.", true, false); }
    catch (error) { status(String(error.message || error), true); }
  }));
  el("hotspot-find").addEventListener("click", safe(async () => {
    await refreshNetwork(); status("Searching the connected network. If no receiver appears, enter its IP address and port manually below.", false, false);
  }));
  el("hotspot-copy").addEventListener("click", () => {
    const session = controller.snapshot().session;
    if (session?.role === "host") copy(`Wi-Fi: ${session.ssid}\nPassword: ${session.password}`, "Wi-Fi details");
  });
  // Detect OS-initiated stop/loss and address assignment. Never recreate a
  // hotspot automatically or persist a password when the app resumes.
  if (native || invoke) {
    let polling = false;
    setInterval(async () => {
      if (document.hidden || controller.snapshot().busy || !controller.snapshot().session || controller.snapshot().session.external || polling) return;
      polling = true;
      const polledSession = controller.snapshot().session;
      try {
      const current = native ? JSON.parse(bridge.hotspotStatus()) : await invoke("hotspot_status").then((session) => session ? { ...session, mode: session.role === "sender" ? "joined" : "hosting" } : { mode: "idle" });
      if (controller.snapshot().busy || controller.snapshot().session !== polledSession) return;
      const session = controller.snapshot().session;
      if (session && ["idle", "error"].includes(current.mode)) {
        controller.lost(current.error || "Hotspot disconnected. Start it again to reconnect.");
        refreshNetwork();
      } else if (session?.role === "host" && current.address && session.address !== current.address) {
        session.address = current.address; ensureReceiver(current.address).catch(() => {});
      }
      } catch (error) {
        status(`Could not check hotspot state: ${String(error.message || error)}. Check system Wi-Fi settings or stop and retry.`, receiveMode === "hotspot");
      } finally { polling = false; }
    }, 3000);
  }
  render();
  return {
    refresh: render,
    busy: () => controller.snapshot().busy || externalSharing,
    hostActive: () => controller.snapshot().session?.role === "host",
    stop: () => controller.stop(),
    viewChanged(view) { if (view !== "send") connectUI.stopCamera(); }
  };
}
