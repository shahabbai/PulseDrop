import test from "node:test";
import assert from "node:assert/strict";
import { validateHotspot, createHotspotController, androidHotspotTransport } from "../src/hotspot.js";

test("validates Wi-Fi credentials separately from the pairing code", () => {
  assert.deepEqual(validateHotspot({ ssid: "PulseDrop", password: "a secure password" }), {});
  for (const ssid of ["", "a".repeat(33), "😀".repeat(9), "wifi\nname"]) assert.ok(validateHotspot({ ssid, password: "12345678" }).ssid);
  for (const password of ["123456", "x".repeat(64), "1234\n5678", "passwörd"]) assert.ok(validateHotspot({ ssid: "wifi", password }).password);
});

test("late hotspot startup cannot resurrect a stopped session", async () => {
  let finish;
  const changes = [];
  const controller = createHotspotController({ transport: { start: () => new Promise((resolve) => { finish = resolve; }), stop: async () => {} }, onChange: (state) => changes.push(state) });
  const starting = controller.start();
  assert.equal(controller.snapshot().operation, "start");
  await controller.stop();
  finish({ ssid: "late", role: "host" }); await starting;
  assert.equal(controller.snapshot().session, null);
  assert.equal(controller.snapshot().busy, false);
  assert.equal(changes.at(-1).error, "");
});

test("failed stop retains credentials for retry and failed start can be retried", async () => {
  let failure = true;
  const controller = createHotspotController({ transport: {
    start: async () => { if (failure) throw new Error("permission denied"); return { ssid: "network", role: "host" }; },
    stop: async () => { if (failure) throw new Error("cleanup failed"); }
  }, onChange: () => {} });
  await assert.rejects(controller.start(), /permission denied/);
  assert.equal(controller.snapshot().busy, false);
  failure = false; await controller.start(); failure = true;
  await assert.rejects(controller.stop(), /cleanup failed/);
  assert.equal(controller.snapshot().session.ssid, "network");
  failure = false; await controller.stop();
  assert.equal(controller.snapshot().session, null);
});

test("Android transport waits for permission/OS results and propagates denial", async () => {
  let states = ["starting", "starting", "hosting"];
  const bridge = { hotspotStart() {}, hotspotStatus: () => JSON.stringify({ mode: states.shift(), ssid: "Android", password: "secret123" }) };
  const transport = androidHotspotTransport(bridge, { delay: async () => {} });
  assert.equal((await transport.start()).role, "host");
  bridge.hotspotStatus = () => JSON.stringify({ mode: "error", error: "Nearby permission denied" });
  await assert.rejects(transport.start(), /Nearby permission denied/);
});

test("Android connection timeout requests native cleanup and never reports connected", async () => {
  let clock = 0, stopped = false;
  const bridge = { hotspotJoin() {}, hotspotStop() { stopped = true; }, hotspotStatus: () => JSON.stringify({ mode: "joining" }) };
  const transport = androidHotspotTransport(bridge, { now: () => clock, delay: async (ms) => { clock += ms; } });
  await assert.rejects(transport.join({ ssid: "wifi", password: "secret123" }), /timed out/);
  assert.equal(stopped, true);
});

test("Android scans await permissions/results independently of a running hotspot", async () => {
  const network = { ssid: "Receiver", bssid: "AA:BB:CC:DD:EE:FF", security: "WPA2", signal: 90, interface: "wifi" };
  let results = [{ state: "scanning" }, { state: "done", networks: [network] }];
  const transport = androidHotspotTransport({ hotspotScan() {}, hotspotScanStatus: () => JSON.stringify(results.shift()) }, { delay: async () => {} });
  assert.deepEqual(await transport.scan(), [network]);
  results = [{ state: "error", error: "Precise Location denied" }];
  await assert.rejects(transport.scan(), /Precise Location denied/);
});

test("Android Wi-Fi scan timeout releases native scan resources", async () => {
  let clock = 0, stopped = false;
  const transport = androidHotspotTransport({ hotspotScan() {}, hotspotScanStatus: () => '{"state":"scanning"}', hotspotScanStop() { stopped = true; } }, { now: () => clock, delay: async (ms) => { clock += ms; } });
  await assert.rejects(transport.scan(), /timed out/);
  assert.equal(stopped, true);
});

test("cancelled Android scan cannot consume a replacement scan’s status", async () => {
  let release;
  const transport = androidHotspotTransport({
    hotspotScan() {}, hotspotScanStop() {},
    hotspotScanStatus: () => '{"state":"done","networks":[]}'
  }, { delay: () => new Promise((resolve) => { release = resolve; }) });
  const old = transport.scan(), finishOld = release;
  const replacement = transport.scan();
  release();
  assert.deepEqual(await replacement, []);
  finishOld();
  await assert.rejects(old, /cancelled/);
});

test("superseded Android setup cannot stop a replacement connection", async () => {
  let release, stops = 0;
  const transport = androidHotspotTransport({
    hotspotStart() {}, hotspotJoin() {}, hotspotStop() { stops++; },
    hotspotStatus: () => '{"mode":"joined","ssid":"new hotspot"}'
  }, { delay: () => new Promise((resolve) => { release = resolve; }) });
  const old = transport.start(), finishOld = release;
  const replacement = transport.join({ ssid: "new hotspot", password: "password123" });
  release();
  assert.equal((await replacement).ssid, "new hotspot");
  finishOld();
  await assert.rejects(old, /cancelled/);
  assert.equal(stops, 0);
});
