import test from "node:test";
import assert from "node:assert/strict";
import { createSender } from "../src/sender.js";

const endpoint = { ip: "127.0.0.1", port: 53612, code: "123456" };
const queue = ["first", "next"].map((name) => Object.assign(new Blob([name]), { name: `${name}.txt` }));

function fixture({ cancelPhase = "cancelled", send = () => {} } = {}) {
  let id = 0;
  let started;
  const uploadStarted = new Promise((resolve) => { started = resolve; });
  const requests = [], activities = new Map(), progress = [];
  const sender = createSender({
    createId: () => String(++id),
    addActivity: (activity) => activities.set(activity.id, activity),
    updateActivity: (id, update) => Object.assign(activities.get(id), update),
    updateTransferMonitor: (update) => progress.push(update),
    onStateChange() {},
    fetch: async (url, options) => {
      requests.push([url.pathname, url.searchParams.get("transfer_id"), options.method]);
      if (url.pathname === "/health") return new Response("Ready", { headers: { "X-PulseDrop-Cancellation": "1" } });
      return new Response(JSON.stringify({ phase: cancelPhase }));
    },
    createRequest: () => ({
      upload: {},
      open(_method, url) { this.url = new URL(url); },
      setRequestHeader() {},
      send(body) { started(body); send.call(this); },
      abort() { this.onabort(); }
    })
  });
  return { sender, uploadStarted, requests, activities, progress };
}

test("sender cancellation keeps a committed file and stops before the next queued file", async () => {
  const { sender, uploadStarted, requests, activities, progress } = fixture({ cancelPhase: "completed" });
  const work = sender.send(queue, endpoint);
  assert.equal(await uploadStarted, queue[0]);
  assert.equal(await sender.send(queue, endpoint), null);
  await sender.cancel();
  assert.deepEqual(await work, { complete: false, cancelled: true, sent: 1, failed: 0, error: "" });
  assert.deepEqual(requests.map(([path]) => path), ["/health", "/cancel"]);
  assert.deepEqual([...activities.values()].map(({ kind }) => kind), ["sent"]);
  assert.equal(progress.at(-1).kind, "cancelled");
  assert.equal(sender.busy(), false);
});

test("a synchronous upload failure releases the sender so another send can complete", async () => {
  let rejectOnce = true;
  const { sender, progress } = fixture({
    send() {
      if (rejectOnce) {
        rejectOnce = false;
        throw new Error("Upload setup failed");
      }
      this.status = 200;
      this.onload();
    }
  });
  const first = await sender.send([queue[0]], endpoint);
  assert.deepEqual(first, { complete: false, cancelled: false, sent: 0, failed: 1, error: "Upload setup failed" });
  assert.equal(sender.busy(), false);
  const retry = await sender.send([queue[0]], endpoint);
  assert.equal(retry.complete, true);
  assert.equal(progress.at(-1).percent, 100);
});

test("a native dropped file can be sent to a receiver using the original upload protocol", async () => {
  const { sender, uploadStarted } = fixture({ send() { this.status = 200; this.onload(); } });
  const file = {
    name: "dropped.txt", size: 4, type: "application/octet-stream",
    async readRange(start, end) { return new TextEncoder().encode("drop".slice(start, end)).buffer; }
  };
  const result = await sender.send([file], endpoint);
  assert.equal(result.complete, true);
  assert.equal(await (await uploadStarted).text(), "drop");
});
