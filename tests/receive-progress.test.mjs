import test from "node:test";
import assert from "node:assert/strict";
import { createReceiveProgress } from "../src/receive-progress.js";

const update = { transfer_id: "one", name: "archive.zip", size: 1000, received: 0, speed: 0, phase: "receiving" };

test("incoming byte updates produce progress before the file completes", () => {
  const model = createReceiveProgress();
  assert.equal(model.accept(update).summary.progress, 0);
  const progress = model.accept({ ...update, received: 350, speed: 100 });
  assert.equal(progress.item.kind, "receiving");
  assert.equal(progress.summary.progress, 35);
  assert.equal(progress.summary.speed, 100);
  assert.equal(progress.completed, false);
});

test("100 percent and the received count require a successful terminal event", () => {
  const model = createReceiveProgress();
  assert.equal(model.accept({ ...update, received: 1000 }).summary.progress, 99);
  let count = 0;
  for (const phase of ["completed", "completed", "receiving"]) {
    const result = model.accept({ ...update, received: 1000, phase });
    if (result?.completed) count += 1;
    if (result) assert.equal(result.summary.progress, 100);
  }
  assert.equal(count, 1, "progress completion and file-received must count as one file");
});

test("same-named concurrent uploads have independent IDs and weighted byte totals", () => {
  const model = createReceiveProgress();
  model.accept({ ...update, received: 500, speed: 100 });
  const both = model.accept({ ...update, transfer_id: "two", size: 3000, received: 500, speed: 200 });
  assert.equal(both.summary.name, "2 incoming files");
  assert.equal(both.summary.activeCount, 2);
  assert.equal(both.summary.progress, 25);
  assert.equal(both.summary.speed, 300);
  const firstDone = model.accept({ ...update, phase: "completed" });
  assert.equal(firstDone.summary.activeCount, 1);
  assert.equal(firstDone.summary.name, update.name);
  assert.equal(firstDone.summary.size, 3000);
});

test("an interrupted file stays failed with its received byte count", () => {
  const model = createReceiveProgress();
  model.accept({ ...update, received: 250 });
  const failed = model.accept({ ...update, received: 300, phase: "failed", error: "Upload ended early" });
  assert.equal(failed.item.kind, "failed");
  assert.equal(failed.summary.progress, 30);
  assert.equal(failed.item.error, "Upload ended early");
  assert.equal(failed.completed, false);
  assert.equal(model.accept({ ...update, received: 500 }), null);
});

test("stale byte counts cannot move progress backwards", () => {
  const model = createReceiveProgress();
  model.accept({ ...update, received: 750 });
  assert.equal(model.accept({ ...update, received: 250 }), null);
});

test("empty files finish at 100 percent without invalid numeric values", () => {
  const model = createReceiveProgress();
  assert.equal(model.accept({ ...update, size: 0 }).summary.progress, 0);
  const done = model.accept({ ...update, size: 0, phase: "completed" });
  assert.equal(done.summary.progress, 100);
  assert.equal(done.summary.received, 0);
  assert.equal(done.summary.speed, 0);
});

test("cancellation keeps partial progress, never counts a file, and rejects late completion", () => {
  const model = createReceiveProgress();
  model.accept({ ...update, received: 250 });
  const cancelled = model.accept({ ...update, received: 300, phase: "cancelled" });
  assert.equal(cancelled.item.kind, "cancelled");
  assert.equal(cancelled.summary.progress, 30);
  assert.equal(cancelled.summary.speed, 0);
  assert.equal(cancelled.completed, false);
  assert.equal(model.accept({ ...update, phase: "completed" }), null);
  assert.equal(model.accept({ ...update, received: 500 }), null);
});

test("cancelling one incoming file leaves the other file's progress active", () => {
  const model = createReceiveProgress();
  model.accept(update);
  model.accept({ ...update, transfer_id: "two", received: 400 });
  const result = model.accept({ ...update, phase: "cancelled" });
  assert.equal(result.summary.activeCount, 1);
  assert.equal(result.summary.received, 400);
  assert.equal(result.summary.phase, "receiving");
});
