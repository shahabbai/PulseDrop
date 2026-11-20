import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateVersion } from "./version.mjs";

export const releaseRoot = "https://github.com/shahabbai/PulseDrop/releases";

function expectedAssets(version) {
  validateVersion(version);
  return {
    deb: `PulseDrop_${version}_amd64.deb`,
    exe: `PulseDrop_${version}_x64-setup.exe`,
    dmg: `PulseDrop_${version}_universal.dmg`,
    mac: `PulseDrop_${version}_universal.app.tar.gz`,
    apk: `PulseDrop_${version}_android_arm64.apk`
  };
}

function manifestFor(version, assets, signatures, hashes) {
  const platforms = {};
  for (const [platform, asset] of [
    ["linux-x86_64-deb", assets.deb],
    ["windows-x86_64-nsis", assets.exe],
    ["darwin-aarch64-app", assets.mac],
    ["darwin-x86_64-app", assets.mac]
  ]) {
    platforms[platform] = {
      signature: signatures.get(asset),
      url: `${releaseRoot}/download/v${version}/${encodeURIComponent(asset)}`
    };
  }
  return { version, platforms, android: { sha256: hashes.get(assets.apk) } };
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function validateAssets(directory, assets) {
  const expected = new Set(Object.values(assets));
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !expected.delete(entry.name)) {
      throw new Error(`Unexpected release asset: ${entry.name}`);
    }
  }
  if (expected.size) throw new Error(`Missing release assets: ${[...expected].join(", ")}`);
}

/** Verify all release inputs before returning ready-to-publish metadata. */
export async function prepareUpdateRelease(directory, version, sign) {
  const assets = expectedAssets(version);
  await validateAssets(directory, assets);

  const signatures = new Map();
  for (const asset of [assets.deb, assets.exe, assets.mac]) {
    signatures.set(asset, await sign(path.resolve(directory, asset), version));
  }

  const hashes = new Map();
  for (const asset of Object.values(assets).sort()) {
    hashes.set(asset, await sha256(path.join(directory, asset)));
  }
  const manifest = manifestFor(version, assets, signatures, hashes);
  const checksums = Array.from(hashes, ([file, hash]) => `${hash}  ${file}\n`).join("");
  return { manifest, checksums, signatures };
}

export async function generateUpdateMetadata(directory, version, privateKey, password, publicKey, signer = "minisign") {
  if (!privateKey || !password || !publicKey) throw new Error("Configure both Tauri updater signing secrets before releasing.");
  const temporary = await mkdtemp(path.join(tmpdir(), "pulsedrop-updater-"));
  try {
    const secret = path.join(temporary, "updater.key");
    const publicFile = path.join(temporary, "updater.pub");
    const signature = path.join(temporary, "artifact.minisig");
    await writeFile(secret, Buffer.from(privateKey, "base64"), { mode: 0o600 });
    await writeFile(publicFile, Buffer.from(publicKey, "base64"));

    function minisign(args, input, failure) {
      const result = spawnSync(signer, args, { input, stdio: ["pipe", "ignore", "ignore"], timeout: 120_000 });
      if (result.status !== 0) throw new Error(failure);
    }

    const { manifest, checksums, signatures } = await prepareUpdateRelease(directory, version, async (file, release) => {
      minisign(
        ["-S", "-q", "-s", secret, "-x", signature, "-t", `version:${release}\tfile:${path.basename(file)}`, "-m", file],
        `${password}\n`, `Could not sign ${path.basename(file)}. Check the updater signing key and password.`
      );
      minisign(
        ["-V", "-q", "-p", publicFile, "-x", signature, "-m", file],
        "", "Updater signing key does not match the public key embedded in PulseDrop."
      );
      return (await readFile(signature)).toString("base64");
    });

    for (const [asset, value] of signatures) {
      await writeFile(path.join(directory, `${asset}.sig`), value);
    }
    await writeFile(path.join(directory, "SHA256SUMS"), checksums);
    await writeFile(path.join(directory, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [directory, version] = process.argv.slice(2);
    if (!directory || !version) throw new Error("Usage: node scripts/prepare-update-release.mjs <assets-directory> <version>");
    const config = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
    await generateUpdateMetadata(directory, version, process.env.TAURI_SIGNING_PRIVATE_KEY,
      process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, config.plugins.updater.pubkey);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
