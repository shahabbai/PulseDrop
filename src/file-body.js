// Android prepares selected content before XHR. Keep that preparation abortable
// so cancellation need not wait for a large file to finish reading into memory.
export function readFileBody(file, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => new DOMException("File preparation cancelled", "AbortError");
    if (signal.aborted) { reject(aborted()); return; }
    const reader = new FileReader();
    let settled = false;
    function finish(callback, value) {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      reader.onload = reader.onerror = reader.onabort = null;
      callback(value);
    }
    function abort() { reader.abort(); finish(reject, aborted()); }
    reader.onload = () => finish(resolve, reader.result);
    reader.onerror = () => finish(reject, new Error("Could not read selected file"));
    reader.onabort = () => finish(reject, aborted());
    signal.addEventListener("abort", abort, { once: true });
    try { reader.readAsArrayBuffer(file); }
    catch (error) { finish(reject, error); }
  });
}
