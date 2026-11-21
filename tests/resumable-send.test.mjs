import test from "node:test";
import assert from "node:assert/strict";
import { createResumableSender, ResumeCancelled, ResumePaused } from "../src/resumable-send.js";

const chunkSize = 4 * 1024 * 1024;
const endpoint = { ip: "127.0.0.1", port: 53612, code: "123456" };
const receiver = "b".repeat(32);
const file = new File([new Uint8Array(chunkSize).fill(13), "tail"], "archive.bin");
const emptyDigest = "0".repeat(64);

function fixture() {
  const files = new Map();
  const posted = [];
  const storage = new Map();
  let unplug = false, loseReply = false;
  return {
    posted, files,
    disconnect(value) { unplug = value; },
    loseReply() { loseReply = true; },
    sender(delays = []) { return createResumableSender({ delays,
      storage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
      fetch: async (url, options) => {
        const id = url.searchParams.get("transfer_id");
        const previous = files.get(id) || null;
        if (unplug) throw new TypeError("offline");
        if (url.pathname === "/resume/cancel") {
          const result = { phase: "cancelled", offset: previous?.offset ?? 0, digest: previous?.digest ?? emptyDigest };
          files.set(id, result);
          return Response.json(result);
        }
        if (options.method === "GET") return Response.json(previous);
        const offset = Number(url.searchParams.get("offset"));
        posted.push(offset);
        const end = offset + options.body.byteLength;
        const result = { phase: end === file.size ? "completed" : "paused", offset: end, digest: url.searchParams.get("digest") };
        files.set(id, result);
        if (loseReply) { loseReply = false; throw new TypeError("reply dropped"); }
        return Response.json(result);
      }
    }); }
  };
}

const signal = () => new AbortController().signal;
const noProgress = { progress() {}, waiting() {} };

test("restart reuses the receiver-scoped transfer and sends only unacknowledged chunks", async () => {
  const service = fixture();
  const original = service.sender();
  const attempt = await original.begin(file, receiver, endpoint);
  await assert.rejects(original.send(file, endpoint, attempt, signal(), {
    waiting() {},
    progress(loaded) { if (loaded === chunkSize) service.disconnect(true); }
  }), ResumePaused);
  assert.deepEqual(service.posted, [0]);

  service.disconnect(false);
  const restarted = service.sender();
  const changedAddress = { ...endpoint, code: "654321", port: 53613 };
  const recovered = await restarted.begin(file, receiver, changedAddress);
  assert.equal(recovered.id, attempt.id);
  const progress = [];
  await restarted.send(file, changedAddress, recovered, signal(), { waiting() {}, progress: (loaded) => progress.push(loaded) });
  assert.deepEqual(progress, [chunkSize, file.size]);
  assert.deepEqual(service.posted, [0, chunkSize]);
  assert.notEqual((await restarted.begin(file, receiver, endpoint)).id, attempt.id);
});

test("a lost chunk acknowledgement is recovered without resending acknowledged bytes", async () => {
  const service = fixture();
  const sender = service.sender();
  service.loseReply();
  await sender.send(file, endpoint, await sender.begin(file, receiver, endpoint), signal(), noProgress);
  assert.deepEqual(service.posted, [0, chunkSize]);
});

test("reconnect retry finishes and a mismatched selected file cannot append to saved chunks", async () => {
  const service = fixture();
  const first = service.sender([0, 0]);
  const attempt = await first.begin(file, receiver, endpoint);
  service.disconnect(true);
  await first.send(file, endpoint, attempt, signal(), {
    progress() {},
    waiting() { service.disconnect(false); }
  });
  assert.deepEqual(service.posted, [0, chunkSize]);

  const next = await first.begin(file, receiver, endpoint);
  await assert.rejects(first.send(file, endpoint, next, signal(), {
    waiting() {},
    progress(loaded) { if (loaded === chunkSize) service.disconnect(true); }
  }), ResumePaused);
  service.disconnect(false);
  const changed = new File([new Uint8Array(chunkSize).fill(99), "tail"], file.name);
  await assert.rejects(first.send(changed, endpoint, next, signal(), noProgress), /does not match/);
  assert.deepEqual(service.posted, [0, chunkSize, 0]);
});

test("a receiver cancellation or queued offline cancellation prevents reuse of the partial", async () => {
  const service = fixture();
  const sender = service.sender();
  const attempt = await sender.begin(file, receiver, endpoint);
  service.files.set(attempt.id, { phase: "cancelled", offset: 0, digest: emptyDigest });
  await assert.rejects(sender.send(file, endpoint, attempt, signal(), noProgress), ResumeCancelled);
  assert.deepEqual(service.posted, []);

  const another = await sender.begin(file, receiver, endpoint);
  service.disconnect(true);
  await assert.rejects(sender.cancel(another, endpoint));
  service.disconnect(false);
  const restarted = service.sender();
  const replacement = await restarted.begin(file, receiver, endpoint);
  assert.notEqual(replacement.id, another.id);
  assert.equal(service.files.get(another.id).phase, "cancelled");
});
