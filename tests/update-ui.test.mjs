import test from "node:test";
import assert from "node:assert/strict";
import { mountUpdater } from "../src/update-ui.js";

function setup(updates, blocked = () => null) {
  const nodes = {};
  for (const id of ["check-update", "update-status", "update-progress"]) {
    nodes[id] = {
      disabled: false,
      setAttribute() {},
      removeAttribute(name) { delete this[name]; },
      addEventListener(_name, listener) { this.click = listener; }
    };
  }
  const busy = [], samples = [];
  mountUpdater({
    updates, blocked,
    root: { querySelector: (selector) => nodes[selector.slice(1)] },
    onBusy: (value) => busy.push(value),
    wait: async () => samples.push({ ...nodes["update-progress"] })
  });
  return { button: nodes["check-update"], status: nodes["update-status"], busy, samples };
}

test("a single check tracks download and installation, then unlocks when current", async () => {
  let checks = 0;
  const states = [
    { phase: "checking" },
    { phase: "downloading", version: "0.8.0", total: 80, received: 20 },
    { phase: "installing", version: "0.8.0" },
    { phase: "current" }
  ];
  const ui = setup({
    start: async () => { checks++; },
    status: async () => states.shift()
  });
  const running = ui.button.click();
  assert.equal(ui.button.disabled, true);
  await ui.button.click();
  await running;
  assert.equal(checks, 1);
  assert.deepEqual(ui.busy, [true, false]);
  assert.match(ui.status.textContent, /latest version/);
  assert.equal(ui.samples[1].value, 20);
  assert.equal(ui.samples[1].max, 80);
  assert.equal(ui.button.disabled, false);
});

test("updates wait for transfers and surface retryable native errors", async () => {
  let reason = "Finish your current transfer before updating.";
  let checked = false;
  const ui = setup({ start: async () => { checked = true; throw new Error("Offline"); } }, () => reason);
  await ui.button.click();
  assert.equal(checked, false);
  assert.equal(ui.status.textContent, reason);
  reason = null;
  await ui.button.click();
  assert.equal(checked, true);
  assert.equal(ui.status.textContent, "Offline");
  assert.equal(ui.button.disabled, false);
});

test("Android permission and installer retries reuse the downloaded APK", async () => {
  let downloads = 0, installs = 0;
  const states = [
    { phase: "permission", version: "0.8.0" },
    { phase: "ready", version: "0.8.0" },
    { phase: "error", message: "APK was removed." }
  ];
  const ui = setup({
    start: async () => { downloads++; },
    status: async () => states.shift(),
    install: async () => { installs++; }
  });
  await ui.button.click();
  assert.match(ui.status.textContent, /Android Settings/);
  assert.equal(ui.button.textContent, "Install update");
  await ui.button.click();
  assert.match(ui.status.textContent, /Android’s installer/);
  await ui.button.click();
  assert.equal(ui.button.textContent, "Check for updates");
  assert.equal(downloads, 1);
  assert.equal(installs, 2);
});

test("unsupported builds explain why the update control is disabled", () => {
  const ui = setup(undefined);
  assert.equal(ui.button.disabled, true);
  assert.match(ui.status.textContent, /unavailable/);
});
