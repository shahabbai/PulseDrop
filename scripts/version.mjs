import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cargoVersion = /(^\[package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m;
const lockVersion = /(^name = "pulse_drop"\r?\nversion = ")([^"]+)(")/m;

export function validateVersion(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("Use a stable version such as 0.2.0 (without a v prefix).");
  }
  const [major, minor, patch] = version.split(".").map(Number);
  const code = major * 1_000_000 + minor * 1000 + patch;
  if (minor > 999 || patch > 999 || !Number.isSafeInteger(code) || code < 1 || code > 2_100_000_000) {
    throw new Error("Version exceeds Android's supported version-code range.");
  }
  return version;
}

function sources(root) {
  return {
    pkg: JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")),
    npmLock: JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8")),
    tauri: JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8")),
    cargo: readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8"),
    cargoLock: readFileSync(path.join(root, "src-tauri/Cargo.lock"), "utf8")
  };
}

export function checkVersion(root = projectRoot, tag) {
  const data = sources(root);
  const version = validateVersion(data.pkg.version);
  const versions = {
    "package-lock.json": data.npmLock.version,
    "package-lock.json packages.root": data.npmLock.packages?.[""]?.version,
    "tauri.conf.json": data.tauri.version,
    "Cargo.toml": data.cargo.match(cargoVersion)?.[2],
    "Cargo.lock pulse_drop": data.cargoLock.match(lockVersion)?.[2]
  };
  for (const [file, value] of Object.entries(versions)) {
    if (value !== version) throw new Error(`${file} has version ${value}; expected ${version}. Run npm run version:bump -- ${version}`);
  }
  if (tag !== undefined && tag !== `v${version}`) {
    throw new Error(`Release tag ${tag} does not match the app version v${version}.`);
  }
  return version;
}

export function setVersion(root, version) {
  validateVersion(version);
  const data = sources(root);
  if (!cargoVersion.test(data.cargo) || !lockVersion.test(data.cargoLock) || !data.npmLock.packages?.[""]) {
    throw new Error("Could not locate the app version in all manifests and lockfiles.");
  }
  data.pkg.version = version;
  data.npmLock.version = version;
  data.npmLock.packages[""].version = version;
  data.tauri.version = version;
  for (const [file, value] of [["package.json", data.pkg], ["package-lock.json", data.npmLock], ["src-tauri/tauri.conf.json", data.tauri]]) {
    writeFileSync(path.join(root, file), JSON.stringify(value, null, 2) + "\n");
  }
  writeFileSync(path.join(root, "src-tauri/Cargo.toml"), data.cargo.replace(cargoVersion, (_, before, old, after) => before + version + after));
  writeFileSync(path.join(root, "src-tauri/Cargo.lock"), data.cargoLock.replace(lockVersion, (_, before, old, after) => before + version + after));
  return checkVersion(root);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, tag] = process.argv.slice(2);
    const version = command === "--check" ? checkVersion(projectRoot, tag) : setVersion(projectRoot, command || "");
    console.log(`PulseDrop ${version}: all manifests and lockfiles match.`);
    if (command === "--check" && process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
