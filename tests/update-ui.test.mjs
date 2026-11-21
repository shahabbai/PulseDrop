import test from "node:test";
import assert from "node:assert/strict";
import { mountUpdater } from "../src/update-ui.js";

function setup(updates, blocked = () => null, saved = new Map()) {
  const nodes = {};
  for (const id of ["check-update", "update-status", "update-progress", "update-notice-text", "view-update", "dismiss-update"]) {
    nodes[id] = {
      disabled: false,
      setAttribute() {},
      removeAttribute(name) { delete this[name]; },
      addEventListener(_name, listener) { this.click = listener; }
    };
  }
  const querySelector = (selector) => nodes[selector.slice(1)];
  const notice = { hidden: true, querySelector };
  const busy = [], samples = [];
  let openedSettings = 0;
  const { checkAvailability } = mountUpdater({
    updates, blocked, notice,
    root: { querySelector, ownerDocument: { addEventListener() {}, defaultView: { localStorage: {
      getItem: (key) => saved.get(key),
      setItem: (key, value) => saved.set(key, value)
    } } } },
    openSettings: () => openedSettings++,
    onBusy: (value) => busy.push(value),
    wait: async () => samples.push({ ...nodes["update-progress"] })
  });
  return {
    button: nodes["check-update"], status: nodes["update-status"], busy, samples, checkAvailability,
    notice, noticeText: nodes["update-notice-text"], open: nodes["view-update"].click,
    dismiss: nodes["dismiss-update"].click, openedSettings: () => openedSettings
  };
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

test("automatic checks show a notice and leave installation to the Settings action", async () => {
  let checks = 0;
  const ui = setup({
    check: async () => { checks++; return "0.9.0"; },
    start: () => assert.fail("automatic checks must not install"),
    status: () => assert.fail("automatic checks use their own result")
  }, () => "Finish your current transfer before updating.");
  await ui.checkAvailability(1);
  await ui.checkAvailability(60_000);
  assert.equal(checks, 1);
  assert.equal(ui.notice.hidden, false);
  assert.equal(ui.noticeText.textContent, "PulseDrop 0.9.0 is available.");
  assert.equal(ui.button.textContent, "Install update");
  assert.deepEqual(ui.busy, []);
  ui.open();
  assert.equal(ui.openedSettings(), 1);
  await ui.button.click();
  assert.match(ui.status.textContent, /Finish your current transfer/);
});

test("dismissal survives restart and only applies to the dismissed release", async () => {
  const storage = new Map();
  const first = setup({ check: async () => "0.9.0" }, undefined, storage);
  await first.checkAvailability(1);
  first.dismiss();
  assert.equal(first.notice.hidden, true);
  let version = "0.9.0";
  const restarted = setup({ check: async () => version }, undefined, storage);
  await restarted.checkAvailability(1);
  assert.equal(restarted.notice.hidden, true);
  assert.equal(restarted.button.textContent, "Install update");
  version = "0.9.1";
  await restarted.checkAvailability(3_600_001);
  assert.equal(restarted.notice.hidden, false);
  assert.match(restarted.noticeText.textContent, /0\.9\.1/);
});

test("automatic checks recover after a quiet failure and ignore a stale result after a manual check", async () => {
  let checks = 0, resolveCheck;
  const ui = setup({
    check: async () => {
      if (++checks === 1) throw new Error("Offline");
      return new Promise((resolve) => { resolveCheck = resolve; });
    },
    start: async () => {},
    status: async () => ({ phase: "current" })
  });
  await ui.checkAvailability(1);
  await ui.checkAvailability(60_000);
  assert.equal(ui.notice.hidden, true);
  assert.equal(checks, 1);
  const pending = ui.checkAvailability(300_001);
  await ui.checkAvailability(300_002);
  assert.equal(checks, 2);
  await ui.button.click();
  resolveCheck("0.9.0");
  await pending;
  assert.equal(ui.notice.hidden, true);
  assert.match(ui.status.textContent, /latest version/);
});
