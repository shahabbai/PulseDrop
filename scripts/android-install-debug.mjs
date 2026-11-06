import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const activityName = "com.pulsedrop.transfer/.MainActivity";
const apkRoot = resolve("src-tauri", "gen", "android", "app", "build", "outputs", "apk");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options
  });

  if (result.status !== 0) {
    process.exit(result.status === null ? 1 : result.status);
  }
}

function findApks(dir) {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findApks(path));
    } else if (entry.isFile() && entry.name.endsWith(".apk") && /(?:^|[\\/])debug(?:[\\/])/.test(path)) {
      files.push(path);
    }
  }
  return files;
}

function newestApk() {
  const apks = findApks(apkRoot);
  if (apks.length === 0) {
    console.error(`No debug APK found under ${apkRoot}. Run npm run android:build:debug first.`);
    process.exit(1);
  }

  return apks.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
}

const adb = process.env.ADB || (
  process.env.ANDROID_HOME
    ? join(process.env.ANDROID_HOME, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb")
    : process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "Android", "Sdk", "platform-tools", "adb.exe")
    : "adb"
);

const apk = newestApk();
console.log(`Installing ${apk}`);

run(adb, ["install", "-r", apk]);
run(adb, ["shell", "am", "start", "-n", activityName]);
