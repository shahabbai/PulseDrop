import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../src/public/native-platform.js", import.meta.url), "utf8");

function platform(bindings = {}) {
  const window = { navigator: { userAgent: "" }, ...bindings };
  runInNewContext(source, { window, console });
  return window.PulseDropNative;
}

test("desktop and Android open the Inbox through the appropriate native interface", async () => {
  const commands = [];
  const tauri = { core: { invoke: async (command) => { commands.push(command); } } };
  await platform({ __TAURI__: tauri }).openInbox("/local/Inbox");
  const phone = platform({
    __TAURI__: tauri,
    navigator: { userAgent: "Android" },
    PulseDropAndroid: {
      deviceName: () => "Test phone",
      openInbox: () => commands.push("Android Downloads")
    }
  });
  assert.equal(phone.deviceName(), "Test phone");
  assert.equal(await phone.openInbox("/storage/emulated/0/Download"), "downloads");
  assert.deepEqual(commands, ["open_inbox", "Android Downloads"]);
});

test("receiver subscriptions normalize completion and remove both immediate and late listeners", async () => {
  const callbacks = new Map(), removed = [];
  let ready;
  const delayed = new Promise((resolve) => { ready = resolve; });
  const native = platform({ __TAURI__: { event: {
    listen(name, callback) {
      callbacks.set(name, callback);
      return name === "file-received" ? delayed : Promise.resolve(() => removed.push(name));
    }
  } } });
  const events = [];
  const dispose = native.subscribeReceiver((progress) => events.push(progress), () => "fallback-id");

  callbacks.get("file-receive-progress")({ payload: { phase: "receiving", received: 10 } });
  callbacks.get("file-received")({ payload: { name: "test.txt", size: 24 } });
  assert.deepEqual(events.map((value) => [value.phase, value.received, value.transfer_id]), [
    ["receiving", 10, undefined], ["completed", 24, "fallback-id"]
  ]);
  await Promise.resolve();
  dispose();
  ready(() => removed.push("file-received"));
  await new Promise((resolve) => setImmediate(resolve));
  callbacks.get("file-received")({ payload: { name: "late.txt", size: 10 } });
  assert.equal(events.length, 2);
  assert.deepEqual(removed, ["file-receive-progress", "file-received"]);
});

test("desktop and Android use their native updater and the browser has none", async () => {
  const commands = [];
  const __TAURI__ = { core: { invoke: async (command) => {
    commands.push(command);
    return { phase: "current" };
  } } };
  const desktop = platform({ __TAURI__ });
  await desktop.updates.start();
  assert.equal((await desktop.updates.status()).phase, "current");

  const android = platform({
    __TAURI__,
    navigator: { userAgent: "Android" },
    PulseDropAndroid: {
      startUpdate: () => commands.push("startUpdate"),
      updateStatus: () => '{"phase":"permission","version":"0.8.0"}',
      installUpdate: () => commands.push("installUpdate")
    }
  });
  await android.updates.start();
  assert.equal((await android.updates.status()).phase, "permission");
  await android.updates.install();
  assert.deepEqual(commands, ["start_update", "update_status", "startUpdate", "installUpdate"]);
  assert.equal(platform().updates, undefined);
  assert.equal(platform({ __TAURI__, navigator: { userAgent: "iPhone" } }).updates, undefined);
});
