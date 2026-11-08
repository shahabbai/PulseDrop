import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

export function temporaryDownloadFailure(output) {
  // Only retry a failed bundler download, never a source/compiler error or a
  // permanent HTTP response. Tauri retains responsibility for download hashes.
  output = stripVTControlCharacters(output);
  return /\bDownloading\s+https?:\/\/\S+/i.test(output)
    && /failed to bundle project[^\r\n]*http status:\s*[`'"]?(?:408|429|500|502|503|504)\b/i.test(output);
}

export function runProcess(command, args, { cwd = root, stdout = process.stdout, stderr = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    function forward(stream, chunk) {
      stream.write(chunk);
      output = (output + chunk.toString()).slice(-128 * 1024);
    }
    child.stdout.on("data", (chunk) => forward(stdout, chunk));
    child.stderr.on("data", (chunk) => forward(stderr, chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code: code ?? 1, signal, output }));
  });
}

export async function buildInstaller(bundle, {
  run = (args) => runProcess(process.execPath, [require.resolve("@tauri-apps/cli/tauri.js"), ...args]),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = (message) => console.warn(message)
} = {}) {
  if (!["deb", "nsis"].includes(bundle)) throw new Error("Choose an installer bundle: deb or nsis.");
  const args = ["build", "--bundles", bundle, "--ci", "--", "--locked"];
  const attempts = bundle === "nsis" ? 3 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await run(args);
    if (result.code === 0 && !result.signal) return 0;
    if (result.signal || attempt === attempts || !temporaryDownloadFailure(result.output)) return result.code || 1;
    const wait = attempt * 10_000;
    log(`Installer download temporarily failed. Retrying build in ${wait / 1000}s (${attempt + 1}/${attempts}); compiled output and cached tools are reused.`);
    await sleep(wait);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const bundle = process.argv[2];
    if (!["deb", "nsis"].includes(bundle)) throw new Error("Usage: node scripts/build-installer.mjs <deb|nsis>");
    // Generated installers only; keep Cargo's compiled output and tool cache.
    rmSync(path.join(root, "src-tauri/target/release/bundle"), { recursive: true, force: true });
    process.exitCode = await buildInstaller(bundle);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
