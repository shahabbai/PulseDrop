import test from "node:test";
import assert from "node:assert/strict";
import { createReceiverDiscovery } from "../src/discovery.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(scan) {
  const changes = [];
  const timers = new Map();
  let timerId = 0;
  const discovery = createReceiverDiscovery({
    scan,
    onChange: (change) => changes.push(change),
    setTimer: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimer: (id) => timers.delete(id)
  });
  return { discovery, changes, timers };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const receiver = { id: "receiver-1", name: "Phone", ip: "192.168.1.4", port: 53612 };

test("starts scanning immediately and prevents overlapping refreshes", async () => {
  const pending = deferred();
  let scans = 0;
  const { discovery, changes, timers } = setup(() => { scans++; return pending.promise; });
  discovery.start();
  discovery.start();
  await discovery.refresh();
  assert.equal(scans, 1);
  assert.equal(changes[0].scanning, true);
  pending.resolve([receiver]);
  await flush();
  assert.deepEqual(changes.at(-1), { receivers: [receiver], scanning: false, error: null });
  assert.equal([...timers.values()][0].delay, 5000);
  discovery.stop();
  assert.equal(timers.size, 0);
});

test("ignores a late result after leaving the Send screen", async () => {
  const pending = deferred();
  const { discovery, changes, timers } = setup(() => pending.promise);
  discovery.start();
  discovery.stop();
  pending.resolve([receiver]);
  await flush();
  assert.equal(changes.length, 1);
  assert.equal(timers.size, 0);
});

test("reopening during an old scan schedules a fresh scan and ignores old results", async () => {
  const first = deferred();
  let calls = 0;
  const { discovery, changes, timers } = setup(() => ++calls === 1 ? first.promise : Promise.resolve([receiver]));
  discovery.start();
  discovery.stop();
  discovery.start();
  first.resolve([{ ...receiver, name: "Stale" }]);
  await flush();
  assert.equal(changes.length, 1);
  const next = [...timers.values()][0];
  assert.equal(next.delay, 0);
  await next.callback();
  assert.equal(changes.at(-1).receivers[0].name, "Phone");
  discovery.stop();
});

test("each scan replaces the list so offline receivers disappear", async () => {
  let calls = 0;
  const { discovery, changes } = setup(async () => ++calls === 1 ? [receiver] : []);
  discovery.start();
  await flush();
  assert.equal(changes.at(-1).receivers.length, 1);
  await discovery.refresh();
  assert.deepEqual(changes.at(-1).receivers, []);
  discovery.stop();
});

test("scan errors clear stale receivers and still schedule retries", async () => {
  let calls = 0;
  const { discovery, changes, timers } = setup(async () => {
    if (++calls === 1) return [receiver];
    throw new Error("Network disconnected");
  });
  discovery.start();
  await flush();
  await discovery.refresh();
  assert.deepEqual(changes.at(-1), { receivers: [], scanning: false, error: "Network disconnected" });
  assert.equal(timers.size, 1);
  discovery.stop();
});
