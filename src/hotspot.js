// Credentials live only in the current view/session, never in localStorage.
export function validateHotspot({ ssid, password }) {
  const errors = {};
  if (!ssid || new TextEncoder().encode(ssid).length > 32 || /[\u0000-\u001f\u007f]/.test(ssid)) {
    errors.ssid = "Enter the receiver’s Wi-Fi name (up to 32 bytes).";
  }
  if (!/^[\x20-\x7e]{8,63}$/.test(password)) {
    errors.password = "Enter its WPA2 Wi-Fi password (8–63 characters). This is separate from the pairing code.";
  }
  return errors;
}

export function createHotspotController({ transport, onChange }) {
  let generation = 0;
  let state = { busy: false, operation: "", session: null, error: "" };
  const publish = (patch) => { state = { ...state, ...patch }; onChange({ ...state }); };
  async function run(operation, action) {
    if (state.busy && operation !== "stop") return;
    const token = ++generation;
    publish({ busy: true, operation, error: "" });
    try {
      const session = await action();
      if (token !== generation) return;
      publish({ session: operation === "stop" ? null : session, busy: false, operation: "", error: "" });
      return session;
    } catch (error) {
      if (token === generation) publish({ busy: false, operation: "", error: String(error.message || error) });
      throw error;
    }
  }
  return {
    start: () => run("start", () => transport.start()),
    join: (credentials) => run("join", () => transport.join(credentials)),
    stop: () => run("stop", () => state.session?.external ? undefined : transport.stop()),
    useExternal(session) {
      if (state.busy || state.session) throw new Error("Disconnect or stop the current PulseDrop hotspot first.");
      generation++;
      publish({ session: { ...session, role: "host", external: true }, error: "" });
    },
    snapshot: () => ({ ...state }),
    reportError(error) { publish({ error }); },
    lost(error) { if (!state.busy) publish({ session: null, error }); }
  };
}

export function androidHotspotTransport(bridge, { delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now } = {}) {
  let scanGeneration = 0;
  let operationGeneration = 0;
  async function waitFor(mode, token) {
    const deadline = now() + 75000;
    // JavaScript bridge calls enqueue work on the UI thread. Allow the queued
    // operation to publish its first state before accepting a result.
    await delay(100);
    while (now() < deadline) {
      if (token !== operationGeneration) throw new Error("Wi-Fi setup was cancelled.");
      const status = JSON.parse(bridge.hotspotStatus());
      if (status.mode === mode) return { ...status, role: mode === "hosting" ? "host" : "sender" };
      if (status.mode === "error") throw new Error(status.error || "Wi-Fi setup failed. Try again.");
      if (status.mode === "idle" && mode !== "idle") throw new Error("Wi-Fi setup was cancelled.");
      await delay(200);
    }
    if (token === operationGeneration) bridge.hotspotStop();
    throw new Error("Wi-Fi setup timed out. Check permissions and system Wi-Fi settings, then try again.");
  }
  return {
    async start() { const token = ++operationGeneration; bridge.hotspotStart(); return waitFor("hosting", token); },
    async join({ ssid, password, bssid }) { const token = ++operationGeneration; bridge.hotspotJoin(ssid, password, bssid || ""); return waitFor("joined", token); },
    async scan() {
      const token = ++scanGeneration;
      bridge.hotspotScan();
      const deadline = now() + 45000;
      await delay(100);
      while (now() < deadline) {
        if (token !== scanGeneration) throw new Error("Wi-Fi scan cancelled.");
        const scan = JSON.parse(bridge.hotspotScanStatus());
        if (scan.state === "done") return scan.networks;
        if (scan.state === "error") throw new Error(scan.error);
        if (scan.state === "idle") throw new Error("Wi-Fi scan cancelled.");
        await delay(200);
      }
      if (token === scanGeneration) bridge.hotspotScanStop();
      throw new Error("Wi-Fi scan timed out. Allow Location access, enable Location services and try again.");
    },
    cancelScan() { scanGeneration++; bridge.hotspotScanStop(); },
    async stop() { const token = ++operationGeneration; bridge.hotspotStop(); await waitFor("idle", token); }
  };
}
