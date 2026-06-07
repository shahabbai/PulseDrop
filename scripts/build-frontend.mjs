import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, copyFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32"
  });

  if (result.status !== 0) {
    process.exit(result.status === null ? 1 : result.status);
  }
}

function copyDir(source, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      copyDir(sourcePath, targetPath);
    } else if (entry.isFile()) {
      copyFileSync(sourcePath, targetPath);
    }
  }
}

run("npx", ["vite", "build"]);

const dist = resolve("dist");
const androidAssets = resolve("src-tauri", "gen", "android", "app", "src", "main", "assets");

if (existsSync(androidAssets) && existsSync(dist)) {
  for (const entry of readdirSync(dist, { withFileTypes: true })) {
    const targetPath = join(androidAssets, entry.name);
    if (existsSync(targetPath)) {
      rmSync(targetPath, { recursive: true, force: true });
    }
  }
  copyDir(dist, androidAssets);
  console.log(`Copied frontend assets to ${androidAssets}`);
}
