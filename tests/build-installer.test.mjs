import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildInstaller, runProcess, temporaryDownloadFailure } from "../scripts/build-installer.mjs";

const downloadError = (status) => `Info Verifying NSIS package\nDownloading https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip\nfailed to bundle project \`http status: ${status}\`\n`;
const failed = { code: 1, signal: null, output: downloadError(504) };
const passed = { code: 0, signal: null, output: "Finished 1 bundle" };

test("recognizes temporary bundler downloads without retrying permanent or compiler errors", () => {
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(temporaryDownloadFailure(downloadError(status)), true);
  for (const status of [400, 401, 403, 404]) assert.equal(temporaryDownloadFailure(downloadError(status)), false);
  assert.equal(temporaryDownloadFailure("error[E0504]: could not compile pulse_drop"), false);
  assert.equal(temporaryDownloadFailure('frontend HTTP 504\nfailed to compile'), false);
  assert.equal(temporaryDownloadFailure('failed to bundle project `http status: 504`'), false);
  assert.equal(temporaryDownloadFailure(downloadError(504).replace('https://', '\u001b[4mhttps://').replace('.zip', '.zip\u001b[0m')), true);
});

test("NSIS recovers from 504 and 502 using three attempts and bounded backoff", async () => {
  const outcomes = [failed, { ...failed, output: downloadError(502) }, passed];
  const calls = [], waits = [], messages = [];
  const code = await buildInstaller("nsis", {
    run: async (args) => { calls.push(args); return outcomes.shift(); },
    sleep: async (ms) => waits.push(ms), log: (message) => messages.push(message)
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 3);
  for (const args of calls) assert.deepEqual(args, ["build", "--bundles", "nsis", "--ci", "--", "--locked"]);
  assert.deepEqual(waits, [10_000, 20_000]);
  assert.match(messages[1], /3\/3/);
});

test("a persistent download outage fails after three attempts", async () => {
  let calls = 0;
  const waits = [];
  assert.equal(await buildInstaller("nsis", {
    run: async () => { calls++; return failed; }, sleep: async (ms) => waits.push(ms), log() {}
  }), 1);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [10_000, 20_000]);
});

test("source, permanent HTTP and interrupted builds fail immediately", async () => {
  for (const outcome of [
    { code: 101, output: "error: could not compile pulse_drop" },
    { code: 2, output: downloadError(404) },
    { ...failed, signal: "SIGTERM" }
  ]) {
    let calls = 0;
    const code = await buildInstaller("nsis", { run: async () => { calls++; return outcome; }, sleep() { assert.fail("unexpected retry"); } });
    assert.equal(code, outcome.code);
    assert.equal(calls, 1);
  }
});

test("a compile failure after a temporary download error stops further retries", async () => {
  const outcomes = [failed, { code: 101, output: "error: could not compile pulse_drop" }];
  let calls = 0;
  assert.equal(await buildInstaller("nsis", {
    run: async () => { calls++; return outcomes.shift(); }, sleep: async () => {}, log() {}
  }), 101);
  assert.equal(calls, 2);
});

test("DEB builds run once and unsupported bundles never launch a build", async () => {
  let calls = 0;
  assert.equal(await buildInstaller("deb", { run: async () => { calls++; return failed; } }), 1);
  assert.equal(calls, 1);
  await assert.rejects(buildInstaller("untrusted;argument", { run() { assert.fail("unexpected build"); } }), /Choose an installer bundle/);
});

test("the process runner preserves literal arguments and forwards live output from both streams", async () => {
  const stdout = [], stderr = [];
  const args = ["path with spaces", "literal;argument", "$(literal)"];
  const result = await runProcess(process.execPath, ["-e", 'process.stdout.write(JSON.stringify(process.argv.slice(1))); process.stderr.write("packaging error"); process.exitCode=7;', "--", ...args], {
    stdout: { write: (chunk) => stdout.push(chunk) }, stderr: { write: (chunk) => stderr.push(chunk) }
  });
  assert.equal(result.code, 7);
  assert.equal(result.signal, null);
  assert.deepEqual(JSON.parse(Buffer.concat(stdout).toString()), args);
  assert.equal(Buffer.concat(stderr).toString(), "packaging error");
  assert.match(result.output, /packaging error/);
});

test("process startup failures reject and captured log history stays bounded", async () => {
  await assert.rejects(runProcess(path.join(tmpdir(), randomUUID(), "missing-command"), []), /ENOENT/);
  const sink = { write() {} };
  const result = await runProcess(process.execPath, ["-e", 'process.stdout.write("x".repeat(256*1024)+"TAIL");'], { stdout: sink, stderr: sink });
  assert.equal(result.code, 0);
  assert.equal(result.output.length, 128 * 1024);
  assert.ok(result.output.endsWith("TAIL"));
});
