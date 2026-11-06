import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkVersion, setVersion, validateVersion } from "../scripts/version.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pulsedrop-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "src-tauri"));
  const files = {
    "package.json": JSON.stringify({ version: "0.1.0" }),
    "package-lock.json": JSON.stringify({ version: "0.1.0", packages: { "": { version: "0.1.0" }, "node_modules/example": { version: "3.0.0" } } }),
    "src-tauri/tauri.conf.json": JSON.stringify({ version: "0.1.0" }),
    "src-tauri/Cargo.toml": '[package]\nname = "pulse_drop"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\n',
    "src-tauri/Cargo.lock": 'version = 3\n\n[[package]]\nname = "pulse_drop"\nversion = "0.1.0"\n\n[[package]]\nname = "serde"\nversion = "1.0.228"\n'
  };
  for (const [file, data] of Object.entries(files)) writeFileSync(path.join(root, file), data);
  return root;
}

test("updates every app version while preserving dependency versions", (t) => {
  const root = fixture(t);
  assert.equal(setVersion(root, "0.2.0"), "0.2.0");
  assert.equal(checkVersion(root, "v0.2.0"), "0.2.0");
  assert.match(readFileSync(path.join(root, "src-tauri/Cargo.lock"), "utf8"), /name = "serde"\nversion = "1.0.228"/);
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json")));
  assert.equal(lock.packages["node_modules/example"].version, "3.0.0");
});

test("rejects mismatched manifests and release tags", (t) => {
  const root = fixture(t);
  assert.throws(() => checkVersion(root, "v0.2.0"), /does not match/);
  writeFileSync(path.join(root, "src-tauri/tauri.conf.json"), JSON.stringify({ version: "0.2.0" }));
  assert.throws(() => checkVersion(root), /tauri.conf.json/);
});

test("checks the root entries in both lockfiles", (t) => {
  const root = fixture(t);
  const file = path.join(root, "package-lock.json");
  const lock = JSON.parse(readFileSync(file));
  lock.packages[""].version = "0.0.1";
  writeFileSync(file, JSON.stringify(lock));
  assert.throws(() => checkVersion(root), /packages.root/);
});

test("rejects invalid versions and overlapping Android version-code ranges", () => {
  for (const version of ["0.0.0", "v0.2.0", "0.2", "01.2.0", "0.2.0-beta.1", "1.1000.0", "0.1.1000", "99999.0.0"]) {
    assert.throws(() => validateVersion(version), undefined, version);
  }
  assert.equal(validateVersion("0.2.1"), "0.2.1");
});

test("a missing manifest version prevents all changes", (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, "src-tauri/Cargo.lock"), 'version = 3\n');
  assert.throws(() => setVersion(root, "0.2.0"), /Could not locate/);
  assert.equal(JSON.parse(readFileSync(path.join(root, "package.json"))).version, "0.1.0");
});
