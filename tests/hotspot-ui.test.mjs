import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mountHotspot } from "../src/hotspot-ui.js";
import jsQR from "jsqr";
import { decodeHotspotQr } from "../src/hotspot-qr.js";

// Minimal event/element adapter for the Wi-Fi workflow. Native WebView checks
// separately validate actual rendering, focus, layout and real HTTP transfers.
class Element {
  constructor(id) { this.id = id; this.tagName = id.toUpperCase(); this.children = []; this.parentNode = null; this.value = ""; this.hidden = false; this.disabled = false; this.textContent = ""; this.dataset = {}; this.attributes = {}; this.listeners = {}; this.type = "password"; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  get textContent() { return this.text || ""; }
  set textContent(value) { this.text = value; this.textWrites = (this.textWrites || 0) + 1; }
  setAttribute(name, value) { this.attributes[name] = value; }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
  querySelectorAll(tag) { return this.children.flatMap((child) => [...(child.tagName === tag.toUpperCase() ? [child] : []), ...child.querySelectorAll(tag)]); }
  querySelector(tag) { return this.querySelectorAll(tag)[0]; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this); this.parentNode = null; }
  getContext() {
    const canvas = this;
    return { fillStyle: "#fff", fillRect(x, y, width, height) {
      if (!canvas.capturePixels) return;
      canvas.pixels ||= new Uint8ClampedArray(canvas.width * canvas.height * 4);
      const color = this.fillStyle === "#000" ? 0 : 255;
      for (let row = y; row < y + height; row++) for (let col = x; col < x + width; col++) {
        const at = (row * canvas.width + col) * 4;
        canvas.pixels[at] = canvas.pixels[at + 1] = canvas.pixels[at + 2] = color; canvas.pixels[at + 3] = 255;
      }
    } };
  }
  click() { return this.fire("click"); }
  focus() { if (!this.disabled) document.activeElement = this; }
  async fire(type) { await this.listeners[type]?.({ preventDefault() {} }); }
}

async function fixture(run, { startReceiver = async () => {}, android = true, invoke, connectionInfo = () => null } = {}) {
  const priorDocument = globalThis.document, priorInterval = globalThis.setInterval;
  const nodes = new Map([...readFileSync(new URL("../src/index.html", import.meta.url), "utf8").matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new Element(match[1])]));
  const radios = ["send", "receive"].flatMap((side) => ["lan", "hotspot"].map((value) => Object.assign(new Element(side + value), { value, side })));
  const intervals = [];
  globalThis.document = {
    hidden: false,
    addEventListener() {},
    createElement: (tag) => new Element(tag),
    getElementById: (id) => nodes.get(id),
    querySelectorAll: (selector) => selector === ".connection-choice input" ? radios : radios.filter((radio) => selector.includes(`"${radio.side}-connection"`))
  };
  globalThis.setInterval = (callback) => { intervals.push(callback); return 1; };
  let status = { mode: "idle", can_host: true, can_join: true, can_scan: true };
  let scan = { state: "idle" };
  const calls = [];
  const bridge = {
    hotspotStatus: () => JSON.stringify(status),
    hotspotScan() { calls.push("scan"); scan = { state: "done", networks: [] }; },
    hotspotScanStatus: () => JSON.stringify(scan),
    hotspotScanStop() { scan = { state: "idle" }; },
    hotspotStart() { calls.push("start"); status = { ...status, mode: "hosting", ssid: "AndroidAP", password: "secret123" }; },
    hotspotJoin() { calls.push("join"); status = { ...status, mode: "joined", ssid: "AndroidAP" }; },
    hotspotStop() { calls.push("stop"); status = { mode: "idle", can_host: true, can_join: true }; }
  };
  try {
    let mutable = true;
    const ui = mountHotspot({ bridge: android ? bridge : null, invoke, connectionInfo, ensureReceiver: startReceiver, refreshNetwork: async () => { calls.push("refresh"); }, canChange: () => mutable, copy: () => {} });
    await run({ nodes, bridge, calls, intervals, ui, radio: (side, value = "hotspot") => radios.find((r) => r.side === side && r.value === value), setStatus: (next) => { status = next; }, lock: () => { mutable = false; ui.refresh(); } });
  } finally { globalThis.document = priorDocument; globalThis.setInterval = priorInterval; }
}

test("LAN remains the default and invalid hotspot credentials focus the first field", async () => fixture(async ({ nodes, calls, radio }) => {
  assert.equal(nodes.get("hotspot-send").hidden, true);
  assert.deepEqual(calls, []);
  await radio("send").fire("change");
  assert.equal(nodes.get("hotspot-join-form").hidden, false);
  await nodes.get("hotspot-join-form").fire("submit");
  assert.equal(document.activeElement.id, "hotspot-ssid");
  assert.equal(nodes.get("hotspot-password-error").hidden, false);
  assert.equal(calls.includes("join"), false);
}));

test("Android joining clears the password, supports disconnect, and reports OS denial", async () => fixture(async ({ nodes, bridge, calls, radio, setStatus }) => {
  await radio("send").fire("change");
  nodes.get("hotspot-ssid").value = "AndroidAP"; nodes.get("hotspot-password").value = "secret123";
  await nodes.get("hotspot-join-form").fire("submit");
  assert.equal(nodes.get("hotspot-password").value, "");
  assert.equal(nodes.get("hotspot-leave").hidden, false);
  assert.match(nodes.get("hotspot-send-status").textContent, /Connected to AndroidAP/);
  await nodes.get("hotspot-leave").fire("click");
  assert.ok(calls.includes("stop"));
  bridge.hotspotJoin = () => setStatus({ mode: "error", error: "Nearby devices permission denied" });
  nodes.get("hotspot-password").value = "secret123";
  await nodes.get("hotspot-join-form").fire("submit");
  assert.match(nodes.get("hotspot-send-status").textContent, /permission denied/);
  assert.equal(nodes.get("hotspot-join").disabled, false);
}));

test("host credentials and Stop remain usable when receiver startup fails", async () => fixture(async ({ nodes, radio, ui }) => {
  await radio("receive").fire("change"); await nodes.get("hotspot-create").fire("click");
  assert.equal(nodes.get("hotspot-credentials").hidden, false);
  assert.equal(nodes.get("hotspot-stop").disabled, false);
  ui.refresh();
  assert.match(nodes.get("hotspot-receive-status").textContent, /receiver could not start/);
  await nodes.get("hotspot-stop").fire("click");
  assert.equal(nodes.get("hotspot-network-password").textContent, "");
}, { startReceiver: async () => { throw new Error("Port unavailable"); } }));

test("radio controls lock during transfers and OS loss clears stale credentials", async () => fixture(async ({ nodes, radio, setStatus, intervals, lock }) => {
  await radio("receive").fire("change"); await nodes.get("hotspot-create").fire("click");
  lock(); assert.equal(nodes.get("hotspot-stop").disabled, true);
  assert.match(nodes.get("hotspot-receive-status").textContent, /Finish or cancel/);
  setStatus({ mode: "error", error: "Hotspot stopped by Android" }); await intervals[0]();
  assert.equal(nodes.get("hotspot-credentials").hidden, true);
  assert.equal(nodes.get("hotspot-network-password").textContent, "");
  assert.match(nodes.get("hotspot-receive-status").textContent, /stopped by Android/);
}));

test("progress renders do not repeat identical live announcements", async () => fixture(async ({ nodes, radio, ui }) => {
  await radio("receive").fire("change"); await nodes.get("hotspot-create").fire("click");
  const status = nodes.get("hotspot-receive-status"), before = status.textWrites;
  ui.refresh(); ui.refresh();
  assert.equal(status.textWrites, before);
}));

test("Linux hosting reports actual radio settings and clears them when stopped", async () => {
  for (const network_info of [
    "5 GHz · channel 36 · 80 MHz.",
    "2.4 GHz · channel 6 · 20 MHz. 5 GHz setup was unavailable; compatibility settings were used.",
    "Configured for 5 GHz; actual channel details unavailable."
  ]) {
    await fixture(async ({ nodes, radio, ui }) => {
      await radio("receive").fire("change");
      await nodes.get("hotspot-create").fire("click");
      const message = nodes.get("hotspot-receive-status");
      assert.ok(message.textContent.startsWith(network_info));
      assert.equal(nodes.get("hotspot-capability").textContent, network_info);
      assert.equal(message.dataset.error, "false");
      const writes = message.textWrites;
      ui.refresh();
      assert.equal(message.textWrites, writes);
      await nodes.get("hotspot-stop").fire("click");
      assert.ok(!message.textContent.includes(network_info));
      assert.ok(!nodes.get("hotspot-capability").textContent.includes(network_info));
    }, { android: false, invoke: async (command) => {
      if (command === "hotspot_capabilities") return { can_host: true, can_join: true, platform: "linux", message: "Create a temporary hotspot." };
      if (command === "start_hotspot") return { ssid: "PulseDrop-test", password: "secret123", network_info };
      return null;
    } });
  }
});

test("Windows fallback explains offline hosting limits and offers manual receiver refresh", async () => {
  let listening = false;
  await fixture(async ({ nodes, radio }) => {
    await radio("receive").fire("change");
    assert.equal(nodes.get("hotspot-create").disabled, true);
    assert.equal(nodes.get("hotspot-manual-ready").hidden, false);
    assert.match(nodes.get("hotspot-capability").textContent, /Android or supported Linux receiver/);
    await nodes.get("hotspot-manual-ready").fire("click");
    assert.equal(listening, true);
    assert.match(nodes.get("hotspot-receive-status").textContent, /Receiver listening/);
  }, { android: false, invoke: async () => ({ can_host: false, platform: "windows", message: "Use system hotspot settings." }), startReceiver: async () => { listening = true; } });
});

test("desktop senders display the native connection band and clear it on disconnect", async () => {
  for (const platform of ["linux", "windows", "macos"]) {
    await fixture(async ({ nodes, radio, ui }) => {
      await radio("send").fire("change");
      nodes.get("hotspot-ssid").value = "PulseDrop-fast";
      nodes.get("hotspot-password").value = "password123";
      await nodes.get("hotspot-join-form").fire("submit");
      assert.match(nodes.get("hotspot-send-status").textContent, /5 GHz · channel 36/);
      const before = nodes.get("hotspot-send-status").textWrites;
      ui.refresh(); assert.equal(nodes.get("hotspot-send-status").textWrites, before);
      await nodes.get("hotspot-leave").fire("click");
      assert.ok(!nodes.get("hotspot-send-status").textContent.includes("5 GHz"));
    }, { android: false, invoke: async (command) => {
      if (command === "hotspot_capabilities") return { platform, can_host: false, can_join: true, message: "Join another receiver." };
      if (command === "scan_hotspots") return [];
      if (command === "join_hotspot") return { role: "sender", ssid: "PulseDrop-fast", network_info: "5 GHz · channel 36." };
    } });
  }
});

test("Windows hosting reports configured bands and retains Stop after failed setup", async () => {
  for (const failure of [false, true]) {
    let stopped = false;
    await fixture(async ({ nodes, radio }) => {
      await radio("receive").fire("change");
      assert.ok(!nodes.get("hotspot-create").disabled);
      await nodes.get("hotspot-create").fire("click");
      assert.equal(nodes.get("hotspot-stop").hidden, false);
      if (failure) {
        assert.match(nodes.get("hotspot-receive-status").textContent, /timed out/);
        assert.equal(nodes.get("hotspot-credentials").hidden, true);
        assert.equal(nodes.get("hotspot-create").disabled, true);
      } else {
        assert.match(nodes.get("hotspot-receive-status").textContent, /Configured for 5 GHz/);
        assert.match(nodes.get("hotspot-receive-status").textContent, /sharing connection active/);
        assert.ok(!nodes.get("hotspot-receive-status").textContent.includes("No internet is required"));
      }
      await nodes.get("hotspot-stop").fire("click");
      assert.ok(stopped);
      assert.equal(nodes.get("hotspot-create").disabled, false);
    }, { android: false, invoke: async (command) => {
      if (command === "hotspot_capabilities") return { platform: "windows", can_host: true, can_join: true, message: "Prefers 5 GHz." };
      if (command === "start_hotspot") {
        if (failure) throw new Error("Windows hotspot setup timed out. Choose Stop hotspot.");
        return { ssid: "PulseDrop-fast", password: "password123", network_info: "Configured for 5 GHz. Windows selects the channel and width." };
      }
      if (command === "stop_hotspot") stopped = true;
      return null;
    } });
  }
});

test("macOS offers joining without promising automatic hotspot hosting", async () => fixture(async ({ nodes, radio }) => {
  await radio("receive").fire("change");
  assert.equal(nodes.get("hotspot-create").disabled, true);
  assert.match(nodes.get("hotspot-capability").textContent, /Join a receiver’s 5 GHz hotspot/);
  await radio("send").fire("change");
  assert.equal(nodes.get("hotspot-wifi-picker").hidden, false);
}, { android: false, invoke: async (command) => command === "hotspot_capabilities"
  ? { platform: "macos", can_host: false, can_join: true, can_scan: true, message: "Join a receiver’s 5 GHz hotspot from Send → Hotspot." } : [] }));

test("Windows host QR never advertises the sharing uplink as the receiver endpoint", async () => {
  for (const address of [null, "192.168.137.1"]) {
    await fixture(async ({ nodes, radio }) => {
      const canvas = nodes.get("hotspot-qr-code"); canvas.capturePixels = true;
      await radio("receive").fire("change");
      await nodes.get("hotspot-create").fire("click");
      for (let attempt = 0; !canvas.pixels && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 2));
      assert.ok(canvas.pixels, "The real QR painter must finish");
      const decoded = jsQR(canvas.pixels, canvas.width, canvas.height);
      assert.ok(decoded, "The displayed QR must decode");
      const credentials = decodeHotspotQr(decoded.data);
      assert.equal(credentials.ssid, "PulseDrop-fast");
      assert.equal(credentials.receiver?.ip, address || undefined);
    }, { android: false, connectionInfo: () => ({ ip: "192.168.1.10", port: 53612, code: "123456" }), invoke: async (command) => {
      if (command === "hotspot_capabilities") return { platform: "windows", can_host: true, can_join: true };
      if (command === "start_hotspot") return { ssid: "PulseDrop-fast", password: "password123", address };
    } });
  }
});

test("late status from a previous hotspot cannot clear a replacement session", async () => {
  let resolveStatus, count = 0;
  await fixture(async ({ nodes, radio, intervals }) => {
    await radio("receive").fire("change");
    await nodes.get("hotspot-create").fire("click");
    const pending = intervals[0]();
    await nodes.get("hotspot-stop").fire("click");
    await nodes.get("hotspot-create").fire("click");
    resolveStatus(null); await pending;
    assert.equal(nodes.get("hotspot-credentials").hidden, false);
    assert.equal(nodes.get("hotspot-network-name").textContent, "network2");
  }, { android: false, invoke: async (command) => {
    if (command === "hotspot_capabilities") return { can_host: true, platform: "linux", message: "Supported" };
    if (command === "start_hotspot") return { ssid: `network${++count}`, password: "secret123" };
    if (command === "hotspot_status") return new Promise((resolve) => { resolveStatus = resolve; });
  } });
});

test("Ubuntu lists Wi-Fi and connects to the chosen hotspot without opening Settings", async () => {
  let joined;
  const network = { ssid: "AndroidAP_Receiver", bssid: "AA:BB:CC:DD:EE:FF", signal: 90, security: "WPA2", interface: "wlan0" };
  await fixture(async ({ nodes, radio }) => {
    await radio("send").fire("change"); await Promise.resolve();
    const list = nodes.get("hotspot-networks");
    assert.equal(list.children.length, 1);
    await list.children[0].querySelector("button").fire("click");
    assert.equal(nodes.get("hotspot-ssid").value, network.ssid);
    assert.equal(nodes.get("hotspot-name-field").hidden, true);
    nodes.get("hotspot-password").value = "secret123";
    await nodes.get("hotspot-join-form").fire("submit");
    assert.equal(joined.ssid, network.ssid);
    assert.equal(joined.bssid, network.bssid);
    assert.equal(joined.interface, network.interface);
    assert.match(nodes.get("hotspot-send-status").textContent, /Connected to AndroidAP_Receiver/);
  }, { android: false, invoke: async (command, args) => {
    if (command === "hotspot_capabilities") return { can_host: false, can_join: true, platform: "linux", message: "Wi-Fi available" };
    if (command === "scan_hotspots") return [network];
    if (command === "join_hotspot") { joined = args; return { role: "sender", ssid: args.ssid }; }
  } });
});

test("late Wi-Fi scans cannot populate a panel after returning to Local network", async () => {
  let resolve, scanning;
  const ready = new Promise((done) => { scanning = done; });
  await fixture(async ({ nodes, radio }) => {
    await radio("send").fire("change"); await ready;
    await radio("send", "lan").fire("change");
    resolve([{ ssid: "late", bssid: "AA:BB:CC:DD:EE:FF", signal: 90, security: "WPA2", interface: "wlan0" }]);
    await Promise.resolve();
    assert.equal(nodes.get("hotspot-send").hidden, true);
    assert.equal(nodes.get("hotspot-networks").children.length, 0);
  }, { android: false, invoke: async (command) => {
    if (command === "hotspot_capabilities") return { can_host: false, can_join: true, platform: "linux", message: "Wi-Fi available" };
    if (command === "scan_hotspots") { scanning(); return new Promise((done) => { resolve = done; }); }
  } });
});

test("choosing a network keeps a late Wi-Fi refresh from covering the connection form", async () => {
  let scans = 0, resolve;
  const network = { ssid: "Phone", bssid: "AA:BB:CC:DD:EE:FF", interface: "wlan0", signal: 90, security: "WPA2" };
  await fixture(async ({ nodes, radio }) => {
    await radio("send").fire("change"); await Promise.resolve();
    const pending = nodes.get("hotspot-scan-networks").fire("click");
    await nodes.get("hotspot-networks").children[0].querySelector("button").fire("click");
    resolve([{ ...network, ssid: "other" }]); await pending;
    assert.equal(nodes.get("hotspot-networks").hidden, true);
    assert.equal(nodes.get("hotspot-ssid").value, "Phone");
  }, { android: false, invoke: async (command) => {
    if (command === "hotspot_capabilities") return { can_host: false, can_join: true, platform: "linux", message: "Wi-Fi" };
    if (command === "scan_hotspots") return ++scans === 1 ? [network] : new Promise((done) => { resolve = done; });
  } });
});

for (const platform of ["linux", "windows", "macos"]) {
  test(`${platform} exposes the same Wi-Fi picker, QR controls, and native Connect`, async () => {
    let joined;
    const network = { ssid: "Receiver & 中文", bssid: "", interface: "wifi0", signal: 80, security: "WPA2" };
    await fixture(async ({ nodes, radio }) => {
      await radio("send").fire("change"); await Promise.resolve();
      assert.equal(nodes.get("hotspot-wifi-picker").hidden, false);
      assert.equal(nodes.get("hotspot-scan-qr").disabled, false);
      assert.equal(nodes.get("hotspot-choose-qr").disabled, false);
      await nodes.get("hotspot-networks").children[0].querySelector("button").fire("click");
      nodes.get("hotspot-password").value = "password123";
      await nodes.get("hotspot-join-form").fire("submit");
      assert.equal(joined.ssid, network.ssid);
      assert.equal(nodes.get("hotspot-leave").hidden, false);
    }, { android: false, invoke: async (command, args) => {
      if (command === "hotspot_capabilities") return { can_host: false, can_join: true, can_scan: true, platform, message: "Wi-Fi available" };
      if (command === "scan_hotspots") return [network];
      if (command === "join_hotspot") { joined = args; return { role: "sender", ssid: args.ssid }; }
    } });
  });
}

test("Android shows native Wi-Fi results and passes the selected BSSID into Connect", async () => fixture(async ({ nodes, radio, bridge }) => {
  const network = { ssid: "Other device", bssid: "AA:BB:CC:DD:EE:FF", interface: "wifi", signal: 85, security: "WPA2" };
  let joined;
  bridge.hotspotScanStatus = () => JSON.stringify({ state: "done", networks: [network] });
  const join = bridge.hotspotJoin;
  bridge.hotspotJoin = (...args) => { joined = args; join(); };
  await radio("send").fire("change");
  // The bridge reports permission/scan completion asynchronously.
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(nodes.get("hotspot-wifi-picker").hidden, false);
  assert.equal(nodes.get("hotspot-scan-qr").disabled, false);
  await nodes.get("hotspot-networks").children[0].querySelector("button").fire("click");
  nodes.get("hotspot-password").value = "password123";
  await nodes.get("hotspot-join-form").fire("submit");
  assert.deepEqual(joined, [network.ssid, "password123", network.bssid]);
}));

test("Wi-Fi scan permission failures leave QR and manual entry available", async () => fixture(async ({ nodes, radio, bridge }) => {
  bridge.hotspotScanStatus = () => JSON.stringify({ state: "error", error: "Allow precise Location for Wi-Fi scanning" });
  await radio("send").fire("change");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.match(nodes.get("hotspot-network-status").textContent, /precise Location/);
  assert.equal(nodes.get("hotspot-scan-qr").disabled, false);
  assert.equal(nodes.get("hotspot-scan-networks").disabled, false);
  assert.equal(nodes.get("hotspot-join-form").hidden, false);
}));

test("receiver instructions refer to the other device on every platform", () => {
  const html = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");
  assert.match(html, /On the other device, open Send → Hotspot → Scan QR/);
  assert.doesNotMatch(html, /On Ubuntu|Scan phone QR|on your computer|your phone|phone’s QR/);
});

for (const platform of ["windows", "macos"]) {
  test(`${platform} can share an external hotspot by QR without stopping or owning it`, async () => {
    const commands = [];
    await fixture(async ({ nodes, radio, intervals }) => {
      await radio("receive").fire("change");
      assert.equal(nodes.get("hotspot-external-setup").hidden, false);
      await nodes.get("hotspot-external-form").fire("submit");
      assert.equal(document.activeElement.id, "hotspot-external-ssid");
      nodes.get("hotspot-external-ssid").value = "System hotspot";
      nodes.get("hotspot-external-password").value = "password123";
      await nodes.get("hotspot-external-form").fire("submit");
      assert.equal(nodes.get("hotspot-qr").hidden, false);
      assert.equal(nodes.get("hotspot-network-name").textContent, "System hotspot");
      assert.equal(nodes.get("hotspot-external-password").value, "");
      assert.equal(nodes.get("hotspot-stop").textContent, "Hide connection QR");
      await intervals[0]();
      assert.equal(commands.includes("hotspot_status"), false);
      await nodes.get("hotspot-stop").fire("click");
      assert.equal(nodes.get("hotspot-qr").hidden, true);
      assert.equal(nodes.get("hotspot-network-password").textContent, "");
      assert.match(nodes.get("hotspot-receive-status").textContent, /still under your control/);
      assert.equal(commands.includes("stop_hotspot"), false);
    }, { android: false, invoke: async (command) => {
      commands.push(command);
      if (command === "hotspot_capabilities") return { platform, can_host: false, can_join: true, can_scan: true, message: "Use system hotspot settings." };
    } });
  });
}
