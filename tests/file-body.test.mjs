import test from "node:test";
import assert from "node:assert/strict";
import { readFileBody } from "../src/file-body.js";

function fixture(t) {
  const instances = [];
  class Reader {
    constructor() { instances.push(this); }
    readAsArrayBuffer(file) { this.file = file; }
    abort() { this.aborted = true; this.onabort?.(); }
  }
  const previous = globalThis.FileReader;
  globalThis.FileReader = Reader;
  t.after(() => { if (previous) globalThis.FileReader = previous; else delete globalThis.FileReader; });
  return instances;
}

test("cancelling preparation aborts the read and ignores a late load", async (t) => {
  const readers = fixture(t), controller = new AbortController();
  const pending = readFileBody({}, controller.signal);
  const lateLoad = readers[0].onload;
  const rejected = assert.rejects(pending, { name: "AbortError" });
  controller.abort();
  readers[0].result = new ArrayBuffer(10);
  lateLoad();
  await rejected;
  assert.equal(readers[0].aborted, true);
  assert.equal(readers[0].onload, null);
});

test("an already cancelled send does not start preparing a file", async (t) => {
  const readers = fixture(t), controller = new AbortController();
  controller.abort();
  await assert.rejects(readFileBody({}, controller.signal), { name: "AbortError" });
  assert.equal(readers.length, 0);
});

test("successful preparation releases its abort listener", async (t) => {
  const readers = fixture(t), controller = new AbortController();
  const pending = readFileBody({}, controller.signal);
  const data = new ArrayBuffer(3);
  readers[0].result = data;
  readers[0].onload();
  assert.equal(await pending, data);
  controller.abort();
  assert.equal(readers[0].aborted, undefined);
});

test("read errors reject rather than leaving sending controls busy", async (t) => {
  const readers = fixture(t), controller = new AbortController();
  const pending = readFileBody({}, controller.signal);
  readers[0].onerror();
  await assert.rejects(pending, /Could not read selected file/);
});
