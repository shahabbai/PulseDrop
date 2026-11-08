import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const bootstrap = readFileSync(new URL("../src/public/theme.js", import.meta.url), "utf8");

function boot({ saved = null, storageUnavailable = false, native = {} } = {}) {
  const values = new Map(saved === null ? [] : [["pulsedrop.theme", saved]]);
  const root = { dataset: {} };
  const meta = { setAttribute(name, value) { this[name] = value; } };
  const window = { ...native };
  const localStorage = {
    getItem(key) { if (storageUnavailable) throw new Error("Storage blocked"); return values.get(key) ?? null; },
    setItem(key, value) { if (storageUnavailable) throw new Error("Storage blocked"); values.set(key, value); }
  };
  runInNewContext(bootstrap, {
    window, localStorage,
    document: { documentElement: root, querySelector: () => meta }
  });
  return { theme: window.PulseDropTheme, root, meta, values };
}

test("first launch and invalid stored preferences use Dark; saved Light applies during bootstrap", () => {
  for (const saved of [null, "dark", "unknown", "LIGHT", ""]) {
    const { theme, root, meta } = boot({ saved });
    assert.equal(theme.getTheme(), "dark");
    assert.equal(root.dataset.theme, "dark");
    assert.equal(meta.content, "#101218");
  }
  const { theme, root, meta } = boot({ saved: "light" });
  assert.equal(theme.getTheme(), "light");
  assert.equal(root.dataset.theme, "light");
  assert.equal(meta.content, "#f6f7fb");
});

test("switching updates appearance immediately and survives an app restart in both directions", () => {
  let app = boot();
  for (const choice of ["light", "dark", "light"]) {
    app.theme.setTheme(choice);
    assert.equal(app.root.dataset.theme, choice);
    assert.equal(app.values.get("pulsedrop.theme"), choice);
    app = boot({ saved: app.values.get("pulsedrop.theme") });
    assert.equal(app.theme.getTheme(), choice);
  }
  app.theme.setTheme("unexpected");
  assert.equal(app.theme.getTheme(), "light");
  assert.equal(app.values.get("pulsedrop.theme"), "light");
});

test("blocked storage still allows Light and Dark for the current session", () => {
  const app = boot({ storageUnavailable: true });
  assert.equal(app.theme.getTheme(), "dark");
  for (const choice of ["light", "dark"]) {
    app.theme.setTheme(choice);
    assert.equal(app.root.dataset.theme, choice);
  }
});

test("Android and desktop native chrome follow the saved theme and subsequent changes", async () => {
  for (const platform of ["android", "desktop"]) {
    const calls = [];
    const native = platform === "android"
      ? { PulseDropAndroid: { setTheme(theme) { calls.push(theme); } } }
      : { __TAURI__: { window: { getCurrentWindow: () => ({ setTheme(theme) { calls.push(theme); return Promise.resolve(); } }) } } };
    const app = boot({ saved: "light", native });
    app.theme.setTheme("dark");
    app.theme.setTheme("light");
    assert.deepEqual(calls, ["light", "dark", "light"], platform);
  }
});

test("unavailable native appearance APIs cannot prevent theme changes or create unhandled rejections", async () => {
  for (const native of [
    { PulseDropAndroid: { setTheme() { throw new Error("Unavailable"); } } },
    { __TAURI__: { window: { getCurrentWindow: () => ({ setTheme: () => Promise.reject(new Error("Unsupported")) }) } } }
  ]) {
    const app = boot({ native });
    app.theme.setTheme("light");
    assert.equal(app.root.dataset.theme, "light");
    assert.equal(app.values.get("pulsedrop.theme"), "light");
  }
  await new Promise((resolve) => setImmediate(resolve));
});
