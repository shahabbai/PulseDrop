import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const isWindows = process.platform === "win32";

function readArg(name, fallback) {
  const prefix = "--" + name + "=";
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = process.argv.indexOf("--" + name);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];

  return fallback;
}

function fail(message) {
  console.error("\n" + message);
  process.exit(1);
}

function versionParts(value) {
  return value.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  }
  return 0;
}

function findBuildToolsDir() {
  const sdkRoot = readArg(
    "sdk",
    process.env.ANDROID_HOME ||
      process.env.ANDROID_SDK_ROOT ||
      (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Android", "Sdk") : undefined),
  );

  if (!sdkRoot) fail("Android SDK path was not found. Set ANDROID_HOME or pass --sdk <path>.");

  const buildToolsRoot = path.join(sdkRoot, "build-tools");
  if (!existsSync(buildToolsRoot)) {
    fail("Android Build Tools folder was not found: " + buildToolsRoot);
  }

  const versions = readdirSync(buildToolsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareVersions);

  if (versions.length === 0) fail("No Android Build Tools versions found in: " + buildToolsRoot);

  return path.join(buildToolsRoot, versions.at(-1));
}

function quoteForLog(arg) {
  return arg.includes(" ") ? "\"" + arg + "\"" : arg;
}

function run(command, args) {
  console.log("\n> " + command + " " + args.map(quoteForLog).join(" "));
  const needsWindowsShell = isWindows && /\.(bat|cmd)$/i.test(command);
  const result = spawnSync(command, args, { stdio: "inherit", shell: needsWindowsShell });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const unsignedApk = path.resolve(
  root,
  readArg(
    "apk",
    path.join(
      "src-tauri",
      "gen",
      "android",
      "app",
      "build",
      "outputs",
      "apk",
      "universal",
      "release",
      "app-universal-release-unsigned.apk",
    ),
  ),
);
const keystore = path.resolve(root, readArg("ks", "pulsedrop-release.jks"));
const alias = readArg("alias", "pulsedrop");
const outputApk = path.resolve(root, readArg("out", "PulseDrop_" + pkg.version + "_android_arm64_signed.apk"));
const defaultAlignedApk = outputApk.toLowerCase().endsWith("_signed.apk")
  ? outputApk.slice(0, -"_signed.apk".length) + "_aligned.apk"
  : outputApk.replace(/\.apk$/i, "_aligned.apk");
const alignedApk = path.resolve(root, readArg("aligned", defaultAlignedApk));
const buildToolsDir = path.resolve(readArg("build-tools", findBuildToolsDir()));
const zipalign = path.join(buildToolsDir, isWindows ? "zipalign.exe" : "zipalign");
const apksigner = path.join(buildToolsDir, isWindows ? "apksigner.bat" : "apksigner");

if (!existsSync(unsignedApk)) fail("Unsigned APK was not found: " + unsignedApk + "\nRun npm run android:build:apk first.");
if (!existsSync(keystore)) fail("Keystore was not found: " + keystore);
if (!existsSync(zipalign)) fail("zipalign was not found: " + zipalign);
if (!existsSync(apksigner)) fail("apksigner was not found: " + apksigner);

console.log("Signing Android APK");
console.log("Unsigned APK: " + unsignedApk);
console.log("Keystore:     " + keystore);
console.log("Alias:        " + alias);
console.log("Build Tools:  " + buildToolsDir);
console.log("Signed APK:   " + outputApk);

run(zipalign, ["-p", "-f", "4", unsignedApk, alignedApk]);
run(apksigner, ["sign", "--ks", keystore, "--ks-key-alias", alias, "--out", outputApk, alignedApk]);
run(apksigner, ["verify", "--verbose", outputApk]);

console.log("\nSigned APK ready:\n" + outputApk);
