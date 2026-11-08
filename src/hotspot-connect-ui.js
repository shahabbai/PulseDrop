import { decodeHotspotQr } from "./hotspot-qr.js";

export function mountHotspotConnect({ invoke, scanNetworks = () => invoke("scan_hotspots"), cancelScan = () => {}, canChange, onPrepared = () => {} }) {
  const doc = document;
  const el = (id) => doc.getElementById(id);
  let enabled = false, scanning = false, sequence = 0, extras = {}, scanner, cameraStarting = false;
  let capabilities;
  const message = (text, error = false) => {
    const node = el("hotspot-network-status");
    if (node.textContent !== text) node.textContent = text;
    node.dataset.error = String(error);
  };
  function prepare({ ssid, password, receiver, bssid, interface: adapter }, qr = false) {
    sequence++; scanning = false; cancelScan();
    el("hotspot-ssid").value = ssid;
    el("hotspot-password").value = password || "";
    extras = { receiver, bssid, interface: adapter };
    el("hotspot-selected").hidden = false;
    el("hotspot-networks").hidden = true;
    el("hotspot-selected-name").textContent = ssid;
    el("hotspot-selected-note").textContent = qr ? "Wi-Fi details filled from QR. Press Connect to continue." : "Enter the receiver’s Wi-Fi password below, or scan its QR to fill it automatically.";
    el("hotspot-manual-credentials").open = !qr;
    el("hotspot-name-field").hidden = !qr;
    for (const name of ["ssid", "password"]) {
      el(`hotspot-${name}-error`).hidden = true; el(`hotspot-${name}`).setAttribute("aria-invalid", "false");
    }
    onPrepared();
    (qr ? el("hotspot-join") : el("hotspot-password")).focus();
  }
  async function acceptQr(text) {
    if (!enabled || !canChange()) return;
    prepare(decodeHotspotQr(text), true);
    message("QR read. Check the Wi-Fi name, then choose Connect. Your password stays on this device.");
  }
  async function scan() {
    if (!enabled || scanning || !canChange()) return;
    const token = ++sequence;
    scanning = true; el("hotspot-scan-networks").disabled = true;
    message("Searching for nearby Wi-Fi…");
    try {
      const networks = await scanNetworks();
      if (token !== sequence || !enabled) return;
      const list = el("hotspot-networks");
      list.hidden = false;
      const existing = new Map(Array.from(list.children).map((row) => [row.dataset.key, row]));
      for (const network of networks) {
        const key = JSON.stringify([network.ssid, network.bssid, network.interface, network.security]);
        const row = existing.get(key) || document.createElement("li"); existing.delete(key);
        let button = row.querySelector("button");
        if (!button) {
          row.dataset.key = key;
          button = document.createElement("button"); button.type = "button"; button.className = "hotspot-network-choice";
          const copy = document.createElement("span"), name = document.createElement("strong"), detail = document.createElement("small");
          copy.append(name, detail); const action = document.createElement("span"); action.textContent = "Choose"; button.append(copy, action); row.append(button);
          button.addEventListener("click", () => { if (canChange() && enabled) prepare(button.network); });
        }
        button.network = network;
        button.querySelector("strong").textContent = network.ssid;
        button.querySelector("small").textContent = `${network.signal}% signal · ${network.security || "Open network"}`;
        button.disabled = !network.security.includes("WPA2") || !canChange();
        button.setAttribute("aria-label", `Choose ${network.ssid}, ${network.signal}% signal, ${network.security}`);
        if (!row.parentNode) list.append(row);
      }
      for (const row of existing.values()) row.remove();
      message(networks.length ? `${networks.length} nearby Wi-Fi ${networks.length === 1 ? "network" : "networks"}. Choose your receiver, or scan its QR to skip password entry.` : "No Wi-Fi found yet. Keep the other device’s hotspot running, move closer, and refresh.");
    } catch (error) { if (token === sequence && enabled) message(`${String(error.message || error)} Refresh after enabling Wi-Fi, or use system settings.`, true); }
    finally { if (token === sequence) { scanning = false; el("hotspot-scan-networks").disabled = !canChange(); } }
  }
  function cameraError(error) {
    const name = error?.name;
    message(name === "NotAllowedError" ? "Camera access was denied. Allow camera access and scan again, or choose a QR image."
      : name === "NotFoundError" ? "No camera was found. Choose a QR image or enter the Wi-Fi password."
      : String(error.message || error), true);
  }
  async function stopCamera() { if (scanner) await scanner.stop(); }
  el("hotspot-scan-networks").addEventListener("click", scan);
  el("hotspot-scan-qr").addEventListener("click", async () => {
    if (!enabled || !canChange() || cameraStarting) return;
    cameraStarting = true; el("hotspot-scan-qr").disabled = true;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access is unavailable in this WebView. Choose a QR image or enter the Wi-Fi password below.");
      const { createQrScanner } = await import("./qr-scanner.js");
      if (!enabled) return;
      scanner ||= createQrScanner({
        video: el("hotspot-camera-video"), canvas: el("hotspot-camera-frame"),
        permission: (active) => invoke("qr_camera_active", { active }),
        onCode: acceptQr, onError: cameraError,
        onState: (active) => { el("hotspot-camera").hidden = !active; el("hotspot-scan-qr").disabled = active; }
      });
      message("Point the camera at the other device’s PulseDrop QR. Frames are processed locally.");
      await scanner.start();
    } catch (error) { cameraError(error); }
    finally { cameraStarting = false; el("hotspot-scan-qr").disabled = Boolean(scanner?.active()) || !canChange(); }
  });
  el("hotspot-camera-stop").addEventListener("click", async () => { await stopCamera(); el("hotspot-scan-qr").focus(); message("Camera stopped. Scan again whenever you’re ready."); });
  el("hotspot-choose-qr").addEventListener("click", () => { if (enabled && canChange()) el("hotspot-qr-image").click(); });
  el("hotspot-qr-image").addEventListener("change", async (event) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file || !enabled || !canChange()) return;
    try {
      await stopCamera();
      const { decodeQrImage } = await import("./qr-scanner.js");
      await acceptQr(await decodeQrImage(file));
    } catch (error) { cameraError(error); }
  });
  for (const id of ["hotspot-ssid", "hotspot-password"]) el(id).addEventListener("input", () => {
    extras = {}; el("hotspot-selected").hidden = true; el("hotspot-name-field").hidden = false;
    onPrepared();
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopCamera(); });
  return {
    configure(nextCapabilities, active, busy) {
      capabilities = nextCapabilities;
      el("hotspot-scan-help").textContent = capabilities?.platform === "android"
        ? "Android requires precise Location permission and Location services to list nearby Wi-Fi. Scan QR instead to connect without that scan permission."
        : capabilities?.platform === "macos" ? "macOS requires Location access to show Wi-Fi names. Allow PulseDrop in Privacy & Security, then refresh."
        : capabilities?.platform === "windows" ? "If Windows requests Location access for Wi-Fi discovery, allow it in Privacy & security."
        : "Choose the Wi-Fi name shown on the other device, or scan its QR to fill the password.";
      const available = capabilities?.can_scan ?? capabilities?.can_join;
      const nextEnabled = Boolean(active && available && !busy);
      el("hotspot-wifi-picker").hidden = !active || !available;
      if (enabled && !nextEnabled) { sequence++; scanning = false; cancelScan(); stopCamera(); }
      const entered = !enabled && nextEnabled;
      enabled = nextEnabled;
      if (entered && !el("hotspot-ssid").value) el("hotspot-manual-credentials").open = false;
      for (const id of ["hotspot-scan-networks", "hotspot-scan-qr", "hotspot-choose-qr"]) el(id).disabled = Boolean(!enabled || !canChange() || (id === "hotspot-scan-networks" && scanning) || (id === "hotspot-scan-qr" && (cameraStarting || scanner?.active())));
      for (const button of el("hotspot-networks").querySelectorAll("button")) button.disabled = !enabled || !canChange() || !button.network.security.includes("WPA2");
      if (entered) scan();
    },
    extras: () => ({ ...extras }),
    clear() { extras = {}; el("hotspot-selected").hidden = true; el("hotspot-name-field").hidden = false; },
    stopCamera
  };
}
