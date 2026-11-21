// Keep the same chunk size and digest format as the receiver.
const CHUNK = 4 * 1024 * 1024;
const EMPTY_DIGEST = "0".repeat(64);
const RETENTION = 7 * 24 * 60 * 60 * 1000;
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 8000, 8000, 8000];

/** @typedef {{ip: string, port: number, code: string}} Endpoint */
/** @typedef {{id: string, key: string, cancelled: boolean, updated: number}} Attempt */
/** @typedef {{phase: "paused" | "completed" | "cancelled", offset: number, digest: string}} Checkpoint */

export class ResumeCancelled extends Error {}
export class ResumePaused extends Error {}
class Retryable extends Error {}

/** @param {Uint8Array} bytes */
function hex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

/** @param {string} digest @param {ArrayBuffer} bytes */
async function extendDigest(digest, bytes) {
  const data = new Uint8Array(64 + bytes.byteLength);
  data.set(new TextEncoder().encode(digest));
  data.set(new Uint8Array(bytes), 64);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

/** @param {number} ms @param {AbortSignal} signal */
function sleep(ms, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(undefined);
    }, ms);
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * @param {{
 *   fetch: typeof globalThis.fetch,
 *   read?: (blob: Blob, signal: AbortSignal) => Promise<ArrayBuffer>,
 *   storage?: Storage,
 *   delays?: readonly number[]
 * }} options
 */
export function createResumableSender({ fetch, read = (blob) => blob.arrayBuffer(), storage, delays = RETRY_DELAYS }) {
  const storageKey = "pulsedrop.resume.v1";
  /** @type {Map<string, Attempt>} */
  const saved = new Map();
  try {
    const entries = JSON.parse(storage?.getItem(storageKey) || "[]");
    for (const record of Array.isArray(entries) ? entries : []) {
      if (record && typeof record.key === "string" && /^[a-f0-9]{32}$/.test(record.id) &&
          Date.now() - record.updated < RETENTION) saved.set(record.key, record);
    }
  } catch { /* A missing local record leaves the current session usable. */ }

  function persist() {
    try { storage?.setItem(storageKey, JSON.stringify([...saved.values()].slice(-128))); }
    catch { /* Keep records for this session when storage is unavailable. */ }
  }

  /** @param {Attempt} attempt */
  function forget(attempt) {
    saved.delete(attempt.key);
    persist();
  }

  /**
   * @param {Endpoint} endpoint @param {Attempt} attempt @param {string} path
   * @param {{signal?: AbortSignal, body?: ArrayBuffer, fields?: Record<string,string>, post?: boolean}} [options]
   * @returns {Promise<Checkpoint | null>}
   */
  async function request(endpoint, attempt, path, { signal, body, fields, post } = {}) {
    signal?.throwIfAborted();
    const url = new URL(`http://${endpoint.ip}:${endpoint.port}${path}`);
    url.search = new URLSearchParams({ code: endpoint.code, transfer_id: attempt.id, ...fields }).toString();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, body ? 120_000 : 4000);
    try {
      const response = await fetch(url, {
        method: post || body ? "POST" : "GET", body,
        cache: "no-store", signal: controller.signal,
        headers: body ? { "Content-Type": "application/octet-stream" } : undefined
      });
      if (response.status === 403) throw new ResumePaused("Pairing code changed or does not match. Enter the current code and send again.");
      if ([408, 429, 500, 502, 503, 504].includes(response.status)) throw new Retryable();
      if (!response.ok) throw new Error(await response.text() || "The receiver refused the chunk.");
      return await response.json();
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof TypeError || controller.signal.aborted) throw new Retryable();
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  /** @param {Attempt} attempt @param {Endpoint} endpoint */
  async function cancel(attempt, endpoint) {
    attempt.cancelled = true;
    persist();
    const result = await request(endpoint, attempt, "/resume/cancel", { post: true });
    forget(attempt);
    return result?.phase;
  }

  /** @param {File} file @param {string} receiver @param {Endpoint} endpoint */
  async function begin(file, receiver, endpoint) {
    const key = JSON.stringify([receiver, file.name, file.size]);
    const previous = saved.get(key);
    if (previous && Date.now() - previous.updated < RETENTION) {
      if (!previous.cancelled) return previous;
      try { await cancel(previous, endpoint); }
      catch (error) {
        if (error instanceof Retryable) {
          throw new ResumePaused("Reconnect to the receiver to finish cancelling the previous transfer.");
        }
        throw error;
      }
    }
    const attempt = { id: hex(crypto.getRandomValues(new Uint8Array(16))), key, cancelled: false, updated: Date.now() };
    saved.set(key, attempt);
    persist();
    return attempt;
  }

  /**
   * @param {File} file @param {Endpoint} endpoint @param {Attempt} attempt @param {AbortSignal} signal
   * @param {{progress: (bytes: number, speed: number) => void, waiting: (message: string) => void}} report
   */
  async function send(file, endpoint, attempt, signal, report) {
    /** @template T @param {() => Promise<T>} operation */
    async function retry(operation) {
      for (let index = 0; ; index++) {
        signal.throwIfAborted();
        try { return await operation(); }
        catch (error) {
          if (!(error instanceof Retryable)) throw error;
          if (index === delays.length) throw new ResumePaused("Transfer paused. Reconnect to the receiver and send the same file again to resume.");
          report.waiting("Waiting for the receiver to reconnect…");
          await sleep(delays[index], signal);
        }
      }
    }

    /** @param {Checkpoint} checkpoint */
    function verifyRange(checkpoint) {
      if (checkpoint.phase === "cancelled") {
        forget(attempt);
        throw new ResumeCancelled("Cancelled by receiving device");
      }
      if (!["paused", "completed"].includes(checkpoint.phase) ||
          !Number.isSafeInteger(checkpoint.offset) || checkpoint.offset < 0 || checkpoint.offset > file.size ||
          (checkpoint.offset !== file.size && checkpoint.offset % CHUNK !== 0) ||
          (checkpoint.phase === "completed" && checkpoint.offset !== file.size) ||
          !/^[a-f0-9]{64}$/.test(checkpoint.digest)) {
        throw new Error("Receiver returned an invalid checkpoint.");
      }
    }

    const status = () => request(endpoint, attempt, "/resume", { signal });
    const existing = await retry(status);
    if (existing) verifyRange(existing);
    let offset = existing?.offset ?? 0;
    let digest = EMPTY_DIGEST;
    if (offset || existing?.phase === "completed") report.waiting("Verifying saved chunks…");
    for (let start = 0; start < offset; start += CHUNK) {
      signal.throwIfAborted();
      digest = await extendDigest(digest, await read(file.slice(start, Math.min(offset, start + CHUNK)), signal));
    }
    if (existing && file.size === 0 && existing.digest !== EMPTY_DIGEST) {
      digest = await extendDigest(digest, new ArrayBuffer(0));
    }
    if (existing && digest !== existing.digest) {
      throw new Error("The selected file does not match the saved chunks. Select the original file or discard the saved transfer on the receiver.");
    }
    report.progress(offset, 0);
    let complete = existing?.phase === "completed";
    while (!complete) {
      signal.throwIfAborted();
      const end = Math.min(offset + CHUNK, file.size);
      const bytes = await read(file.slice(offset, end), signal);
      const commitOnly = offset === file.size && file.size > 0;
      const nextDigest = commitOnly ? digest : await extendDigest(digest, bytes);
      const started = performance.now();
      const fields = { name: file.name, size: String(file.size), offset: String(offset), digest: nextDigest };
      const next = await retry(async () => {
        /** @type {Checkpoint | null} */
        let result;
        try { result = await request(endpoint, attempt, "/resume", { signal, post: true, body: bytes, fields }); }
        catch (error) {
          if (!(error instanceof Retryable)) throw error;
          // The receiver may have saved a chunk before its reply was lost.
          result = await status();
          if (!result) throw error;
        }
        if (!result) throw new Retryable();
        verifyRange(result);
        if (result.offset === offset && result.phase !== "completed") throw new Retryable();
        if (result.offset !== end || result.digest !== nextDigest) throw new Error("The receiver checkpoint did not match the uploaded chunk.");
        return result;
      });
      offset = next.offset;
      digest = next.digest;
      complete = next.phase === "completed";
      attempt.updated = Date.now();
      persist();
      report.progress(offset, bytes.byteLength / Math.max(0.001, (performance.now() - started) / 1000));
    }
    forget(attempt);
  }

  return { begin, send, cancel, forget };
}
