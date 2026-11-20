import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareUpdateRelease, releaseRoot } from "../scripts/prepare-update-release.mjs";

async function fixture(t, includeApk = true) {
  const directory = await mkdtemp(path.join(tmpdir(), "pulsedrop-update-release-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const assets = ["amd64.deb", "x64-setup.exe", "universal.dmg", "universal.app.tar.gz"];
  if (includeApk) assets.push("android_arm64.apk");
  for (const asset of assets) await writeFile(path.join(directory, `PulseDrop_0.7.0_${asset}`), asset);
  return directory;
}

test("the OTA feed identifies each platform by installer and both Mac architectures share the archive", async (t) => {
  const directory = await fixture(t);
  const { manifest, checksums, signatures } = await prepareUpdateRelease(directory, "0.7.0", async (file, version) => {
    assert.equal(version, "0.7.0");
    return `signed:${path.basename(file)}`;
  });
  assert.equal(manifest.version, "0.7.0");
  assert.equal(manifest.platforms["linux-x86_64-deb"].url, `${releaseRoot}/download/v0.7.0/PulseDrop_0.7.0_amd64.deb`);
  assert.equal(manifest.platforms["windows-x86_64-nsis"].signature, "signed:PulseDrop_0.7.0_x64-setup.exe");
  assert.deepEqual(manifest.platforms["darwin-aarch64-app"], manifest.platforms["darwin-x86_64-app"]);
  assert.match(manifest.platforms["darwin-x86_64-app"].url, /\.app\.tar\.gz$/);
  assert.equal(manifest.android.sha256, createHash("sha256").update("android_arm64.apk").digest("hex"));
  assert.match(checksums, /PulseDrop_0\.7\.0_universal\.dmg/);
  assert.equal(signatures.size, 3);
});

test("release refuses to produce an update feed for missing, unexpected, or unsigned assets", async (t) => {
  const directory = await fixture(t, false);
  const signer = async () => assert.fail("should validate assets before signing");
  await assert.rejects(prepareUpdateRelease(directory, "0.7.0", signer), /Missing release assets.*apk/);
  await assert.rejects(prepareUpdateRelease(directory, "0.7.1", signer), /Unexpected release asset/);
  await writeFile(path.join(directory, "PulseDrop_0.7.0_android_arm64.apk"), "test");
  await assert.rejects(prepareUpdateRelease(directory, "0.7.0", async () => {
    throw new Error("Signature verification failed");
  }), /Signature verification failed/);
});
