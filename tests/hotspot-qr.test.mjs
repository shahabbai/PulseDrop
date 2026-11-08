import test from "node:test";
import assert from "node:assert/strict";
import jsQR from "jsqr";
import { encodeHotspotQr, decodeHotspotQr, qrMatrix } from "../src/hotspot-qr.js";
import { createQrScanner } from "../src/qr-scanner.js";

const receiver = { ip: "192.168.43.1", port: 53612, code: "000123" };
const credentials = { ssid: 'Phone;: "\\é📱', password: 'secure;: "\\123', receiver };

test("Wi-Fi QR preserves escaped and Unicode names, passwords and pairing codes", () => {
  assert.deepEqual(decodeHotspotQr(encodeHotspotQr(credentials)), credentials);
  assert.deepEqual(decodeHotspotQr("WIFI:T:WPA;S:AndroidAP;P:secret123;;"), { ssid: "AndroidAP", password: "secret123" });
});

test("only valid Wi-Fi QR and local pairing endpoints are accepted", () => {
  for (const value of ["https://evil.example", "WIFI:T:nopass;S:Open;;", "WIFI:T:WPA;S:a;S:b;P:secret123;;", "WIFI:T:WPA;S:phone;P:short;;", "WIFI:T:WPA;S:phone;P:secret123;PD:bad;;", "WIFI:"+"x".repeat(2050)]) assert.throws(() => decodeHotspotQr(value));
  for (const ip of ["8.8.8.8", "127.0.0.1", "example.com"]) {
    const qr = encodeHotspotQr({ ...credentials, receiver: { ...receiver, ip } });
    assert.equal(decodeHotspotQr(qr).receiver, undefined);
    const bad = `WIFI:T:WPA;S:phone;P:secret123;PD:${btoa(JSON.stringify({ version: 1, ...receiver, ip }))};;`;
    assert.throws(() => decodeHotspotQr(bad));
  }
});

test("the actual generated QR matrix decodes with the production scanner", async () => {
  const payload = encodeHotspotQr(credentials), qr = await qrMatrix(payload), scale = 5, margin = 4;
  const width = (qr.getModuleCount() + margin * 2) * scale;
  const rgba = new Uint8ClampedArray(width * width * 4); rgba.fill(255);
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const row = Math.floor(y / scale) - margin, col = Math.floor(x / scale) - margin;
    if (row >= 0 && col >= 0 && row < qr.getModuleCount() && col < qr.getModuleCount() && qr.isDark(row, col)) rgba.set([0, 0, 0, 255], (y * width + x) * 4);
  }
  const decoded = jsQR(rgba, width, width);
  assert.equal(decoded.data, payload);
  assert.deepEqual(decodeHotspotQr(decoded.data), credentials);
});

function scannerFixture(options = {}) {
  const grants = [], stopped = [], errors = [], codes = [];
  const video = { readyState: 2, videoWidth: 2, videoHeight: 2, play: async () => {} };
  const canvas = { getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(16), width: 2, height: 2 }) }) };
  const stream = { getTracks: () => [{ stop: () => stopped.push(true) }] };
  const scanner = createQrScanner({ video, canvas, permission: async (active) => { grants.push(active); }, getMedia: async () => stream, decode: () => ({ data: encodeHotspotQr(credentials) }), onCode: (code) => codes.push(code), onError: (error) => errors.push(error), ...options });
  return { scanner, grants, stopped, errors, codes, video, stream };
}

test("successful QR scan stops camera tracks and releases permission before delivery", async () => {
  const fixture = scannerFixture();
  await fixture.scanner.start();
  assert.equal(fixture.codes.length, 1);
  assert.equal(fixture.stopped.length, 1);
  assert.equal(fixture.video.srcObject, null);
  assert.equal(fixture.grants.at(-1), false);
  assert.equal(fixture.scanner.active(), false);
});

test("cancelling pending camera permission closes a late camera stream", async () => {
  let resolve, requested;
  const ready = new Promise((done) => { requested = done; });
  const fixture = scannerFixture({ getMedia: () => { requested(); return new Promise((done) => { resolve = done; }); } });
  const opening = fixture.scanner.start(); await ready;
  await fixture.scanner.stop(); resolve(fixture.stream); await opening;
  assert.equal(fixture.stopped.length, 1);
  assert.equal(fixture.codes.length, 0);
  assert.equal(fixture.video.srcObject, null);
});

test("leaving before camera startup cleanup finishes never opens the camera", async () => {
  let release, calls = 0;
  const fixture = scannerFixture({ permission: (active) => !active && !release ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(), getMedia: async () => { calls++; } });
  const opening = fixture.scanner.start(); await fixture.scanner.stop(); release(); await opening;
  assert.equal(calls, 0);
});

test("denied camera permission is recoverable and releases native permission", async () => {
  const fixture = scannerFixture({ getMedia: async () => { throw new Error("Camera denied"); } });
  await fixture.scanner.start();
  assert.equal(fixture.scanner.active(), false);
  assert.match(fixture.errors[0].message, /Camera denied/);
  assert.equal(fixture.grants.at(-1), false);
});

test("a QR timeout closes the camera and leaves a retry message", async () => {
  let clock = 0, tick;
  const fixture = scannerFixture({ now: () => clock, decode: () => null, setTimer: (callback) => { tick = callback; return 1; }, clearTimer() {} });
  await fixture.scanner.start(); assert.equal(fixture.scanner.active(), true);
  clock = 60001; await tick();
  assert.equal(fixture.scanner.active(), false);
  assert.equal(fixture.stopped.length, 1);
  assert.equal(fixture.grants.at(-1), false);
  assert.match(fixture.errors[0].message, /scan again/);
});
