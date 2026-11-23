import { formatBytes, formatSpeed } from "./transfer-format.js";
import { CHUNK, createResumableSender, ResumeCancelled, ResumePaused } from "./resumable-send.js";

/** @typedef {{ip: string, port: number, code: string}} Endpoint */
/** @typedef {import("./resumable-send.js").Attempt} Attempt */
/** @typedef {{controller: AbortController, endpoint: Endpoint, cancelRequested: boolean, activeId: string | null, loaded: number, supportsCancellation: boolean, resumeReceiver?: string, attempt?: Attempt, reason?: string, savedTransferId?: string, cancelPromise?: Promise<void>}} Session */
/** @typedef {{kind?: "sending" | "sent" | "failed" | "cancelled" | "paused", label?: string, progress?: number, speed?: number}} ActivityPatch */
/** @typedef {import("./native-types").SendFile} SendFile */
/** @typedef {ActivityPatch & {id: string, file: SendFile, name: string, direction: "send"}} Activity */
/** @typedef {{name?: string, loaded?: number, total?: number, totalLoaded?: number, totalBytes?: number, percent?: number, speed?: number, active?: boolean, kind?: "complete" | "failed" | "cancelled" | "paused"}} Monitor */

const receiverCheckTimeoutMs = 7000;

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {Endpoint} endpoint @param {string} path */
function receiverUrl(endpoint, path) {
  const url = new URL(`http://${endpoint.ip}:${endpoint.port}${path}`);
  url.searchParams.set("code", endpoint.code);
  return url;
}

/** @param {Endpoint} endpoint */
function receiverUnavailableMessage(endpoint) {
  return `Could not reach ${endpoint.ip}:${endpoint.port}. Keep the receiver open, check its address, and connect both devices to the same local network. If it stays unavailable, check its firewall or VPN settings.`;
}

/** @param {Session} session */
function cancelledError(session) {
  const error = new Error(session.reason || "Transfer cancelled");
  error.name = "TransferCancelledError";
  return error;
}

/** @param {Session} session */
function checkCancellation(session) {
  if (session.cancelRequested || session.controller.signal.aborted) throw cancelledError(session);
}

/** @param {number} fileSize */
function uploadTimeoutMs(fileSize) {
  const slowNetworkBudget = Math.ceil((fileSize || 0) / (128 * 1024)) * 1000;
  return Math.min(30 * 60 * 1000, Math.max(2 * 60 * 1000, slowNetworkBudget + 30 * 1000));
}

/**
 * Owns one outgoing queue and its network operations. UI callbacks report state,
 * while the DOM and platform-specific file preparation stay with the caller.
 * @param {{
 *   createId: () => string,
 *   prepareBody?: (file: Blob, signal: AbortSignal) => Promise<ArrayBuffer>,
 *   resumeStorage?: Storage,
 *   addActivity: (activity: Activity) => void,
 *   updateActivity: (id: string, patch: ActivityPatch) => void,
 *   updateTransferMonitor: (update: Monitor) => void,
 *   onStateChange: () => void,
 *   fetch?: typeof globalThis.fetch,
 *   createRequest?: () => XMLHttpRequest
 * }} options
 */
export function createSender({
  createId, prepareBody, resumeStorage, addActivity, updateActivity, updateTransferMonitor,
  onStateChange, fetch = globalThis.fetch, createRequest = () => new XMLHttpRequest()
}) {
  /** @type {Session | null} */
  let activeSession = null;
  const resumable = createResumableSender({ fetch, read: prepareBody, storage: resumeStorage });

  /**
   * @param {Endpoint} endpoint
   * @param {string} path
   * @param {string} id
   * @param {"GET" | "POST"} method
   * @param {AbortSignal} [signal]
   */
  async function transferRequest(endpoint, path, id, method = "GET", signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort, 1800);
    const url = receiverUrl(endpoint, path);
    url.searchParams.set("transfer_id", id);
    try {
      const response = await fetch(url, { method, cache: "no-store", signal: controller.signal });
      /** @type {{phase?: string} | null} */
      const payload = response.ok ? await response.json() : null;
      return { ok: response.ok, phase: payload?.phase };
    }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }

  async function cancel(byReceiver = false) {
    const session = activeSession;
    if (!session || session.cancelRequested) return;
    session.cancelRequested = true;
    session.reason = byReceiver ? "Cancelled by receiving device" : "Transfer cancelled";
    session.cancelPromise = (async () => {
      try {
        if (!byReceiver && session.attempt) {
          session.controller.abort();
          if (await resumable.cancel(session.attempt, session.endpoint) === "completed") {
            session.savedTransferId = session.attempt.id;
          }
        } else if (!byReceiver && session.supportsCancellation && session.activeId) {
          const id = session.activeId;
          const response = await transferRequest(session.endpoint, "/cancel", id, "POST");
          if (response.ok && response.phase === "completed") session.savedTransferId = id;
        }
      } catch { /* A broken connection still needs a local abort. */ }
      finally { session.controller.abort(); }
    })();
    onStateChange();
    await session.cancelPromise;
  }

  /** @param {Endpoint} endpoint @param {Session} session */
  async function checkReceiver(endpoint, session) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    session.controller.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, receiverCheckTimeoutMs);
    try {
      checkCancellation(session);
      const response = await fetch(receiverUrl(endpoint, "/health"), { cache: "no-store", signal: controller.signal });
      checkCancellation(session);
      if (response.status === 404 || response.status === 405) return;
      if (!response.ok) throw new Error(await response.text() || `Receiver returned HTTP ${response.status}`);
      session.supportsCancellation = response.headers.get("X-PulseDrop-Cancellation") === "1";
      const receiver = response.headers.get("X-PulseDrop-Resume");
      if (receiver && /^[a-f0-9]{32}$/.test(receiver) && globalThis.crypto?.subtle) session.resumeReceiver = receiver;
    } catch (error) {
      checkCancellation(session);
      if ((error instanceof Error && error.name === "AbortError") || error instanceof TypeError) throw new Error(receiverUnavailableMessage(endpoint));
      throw error;
    } finally { clearTimeout(timeout); session.controller.signal.removeEventListener("abort", abort); }
  }

  /**
   * @param {SendFile} file @param {Endpoint} endpoint @param {string} activityId
   * @param {{completedBytes: number, totalBytes: number}} context @param {Session} session
   */
  async function sendResumable(file, endpoint, activityId, context, session) {
    const attempt = await resumable.begin(file, session.resumeReceiver || "", endpoint);
    session.attempt = attempt;
    session.activeId = attempt.id;
    if (session.cancelRequested) {
      if (await resumable.cancel(attempt, endpoint).catch(() => null) === "completed") return;
      checkCancellation(session);
    }
    try {
      await resumable.send(file, endpoint, attempt, session.controller.signal, {
        waiting: (label) => {
          updateActivity(activityId, { label, speed: 0 });
          updateTransferMonitor({ name: label, totalLoaded: session.loaded,
            totalBytes: context.totalBytes, speed: 0, active: true });
        },
        progress(loaded, speed) {
          session.loaded = context.completedBytes + loaded;
          const percent = context.totalBytes ? 100 * session.loaded / context.totalBytes : 0;
          updateActivity(activityId, {
            label: formatBytes(loaded) + " of " + formatBytes(file.size) + " · " + formatSpeed(speed),
            progress: file.size ? Math.min(99, 100 * loaded / file.size) : 0, speed
          });
          updateTransferMonitor({
            name: file.name, loaded, total: file.size, totalLoaded: session.loaded,
            totalBytes: context.totalBytes, percent: Math.min(99, percent), speed, active: true
          });
        }
      });
    } catch (error) {
      if (error instanceof ResumeCancelled) await cancel(true);
      if (session.cancelPromise) await session.cancelPromise;
      if (session.savedTransferId !== attempt.id) throw error;
    }
    updateActivity(activityId, { kind: "sent", label: "Sent", progress: 100, speed: 0 });
  }

  /** @param {SendFile} file @param {string} activityId @param {Session} session */
  async function uploadBodyForFile(file, activityId, session) {
    checkCancellation(session);
    if ("readRange" in file) {
      updateActivity(activityId, { label: "Preparing file", progress: 0 });
      const parts = [];
      for (let offset = 0; offset < file.size; offset += CHUNK) {
        parts.push(await file.readRange(offset, Math.min(offset + CHUNK, file.size), session.controller.signal));
      }
      return new Blob(parts, { type: file.type });
    }
    if (!prepareBody) return file;
    updateActivity(activityId, { label: "Preparing file", progress: 0 });
    try { return await prepareBody(file, session.controller.signal); }
    catch (error) { checkCancellation(session); throw error; }
  }

  /**
   * @param {SendFile} file
   * @param {Endpoint} endpoint
   * @param {string} activityId
   * @param {{completedBytes: number, totalBytes: number}} progressContext
   * @param {Session} session
   * @param {string} transferId
   * @returns {Promise<void>}
   */
  async function sendFile(file, endpoint, activityId, progressContext, session, transferId) {
    const uploadBody = await uploadBodyForFile(file, activityId, session);
    checkCancellation(session);

    return new Promise((resolve, reject) => {
      const url = receiverUrl(endpoint, "/upload");
      url.searchParams.set("name", file.name);
      url.searchParams.set("transfer_id", transferId);

      const xhr = createRequest();
      const startedAt = performance.now();
      let settled = false;
      let checkingFailure = false;
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let pollTimer;
      const pollLifetime = new AbortController();
      const signal = session.controller.signal;
      const abort = () => xhr.abort();
      const cleanup = () => { clearTimeout(pollTimer); pollLifetime.abort(); signal.removeEventListener("abort", abort); };
      async function poll() {
        if (settled || signal.aborted || !session.supportsCancellation) return;
        try {
          const response = await transferRequest(endpoint, "/transfer", transferId, "GET", pollLifetime.signal);
          const status = response.ok ? response : null;
          if (!settled && session.activeId === transferId && status?.phase === "cancelled") await cancel(true);
        } catch { /* The upload itself reports connection errors. */ }
        if (!settled && !signal.aborted) pollTimer = setTimeout(poll, 350);
      }
      let latestLoaded = 0;
      let lastLoaded = 0;
      let lastTime = startedAt;
      let lastSpeed = 0;

      /** @param {number} loaded */
      function speedFor(loaded) {
        const now = performance.now();
        const elapsed = Math.max((now - lastTime) / 1000, 0.001);
        if (elapsed >= 0.15 || loaded >= file.size) {
          const delta = Math.max(0, loaded - lastLoaded);
          const instant = delta / elapsed;
          lastSpeed = lastSpeed ? lastSpeed * 0.65 + instant * 0.35 : instant;
          lastLoaded = loaded;
          lastTime = now;
        }
        const average = loaded / Math.max((now - startedAt) / 1000, 0.001);
        return lastSpeed || average;
      }

      /** @param {number} loaded @param {number} total @param {number} [forcedPercent] */
      function publishProgress(loaded, total, forcedPercent) {
        if (settled) return;
        session.loaded = (progressContext.completedBytes || 0) + loaded;
        latestLoaded = loaded;
        const size = total || file.size || 0;
        const completedBytes = progressContext.completedBytes || 0;
        const totalBytes = progressContext.totalBytes || size;
        const totalLoaded = Math.min(totalBytes || completedBytes + loaded, completedBytes + loaded);
        const filePercent = size ? (loaded / size) * 100 : 0;
        const fallbackPercent = forcedPercent ?? filePercent;
        const overallPercent = totalBytes ? (totalLoaded / totalBytes) * 100 : fallbackPercent;
        const speed = speedFor(loaded);
        const label = formatBytes(loaded) + " of " + formatBytes(size) + " - " + formatSpeed(speed);

        updateActivity(activityId, {
          progress: Math.min(99, filePercent || overallPercent),
          label,
          speed
        });
        updateTransferMonitor({
          name: file.name,
          loaded,
          total: size,
          totalLoaded,
          totalBytes,
          percent: Math.min(99, overallPercent),
          speed,
          active: true
        });
      }

      /** @param {string} message */
      function fail(message, cancelled = session.cancelRequested) {
        if (settled) return;
        settled = true;
        cleanup();
        const kind = cancelled ? "cancelled" : "failed";
        updateActivity(activityId, {
          label: message,
          kind,
          speed: 0
        });
        updateTransferMonitor({
          name: file.name,
          loaded: latestLoaded,
          total: file.size,
          totalLoaded: (progressContext.completedBytes || 0) + latestLoaded,
          totalBytes: progressContext.totalBytes || file.size,
          percent: progressContext.totalBytes ? (((progressContext.completedBytes || 0) + latestLoaded) / progressContext.totalBytes) * 100 : 0,
          speed: 0,
          kind,
          active: false
        });
        reject(cancelled ? cancelledError(session) : new Error(message));
      }

      /** @param {string} message */
      async function failAfterStatusCheck(message) {
        if (settled || checkingFailure) return;
        checkingFailure = true;
        // A receiver cancellation may close the upload before its next status
        // poll. Resolve that race before deciding to continue the sender queue.
        try {
          if (session.supportsCancellation) {
            const response = await transferRequest(endpoint, "/transfer", transferId, "GET", pollLifetime.signal);
            const status = response.ok ? response : null;
            if (!settled && status?.phase === "cancelled") {
              await cancel(true);
            }
          }
        } catch { /* Report the original error when status cannot be reached. */ }
        fail(session.cancelRequested ? session.reason || "Transfer cancelled" : message);
      }

      xhr.open("POST", url.toString(), true);
      xhr.timeout = uploadTimeoutMs(file.size);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.upload.onprogress = (event) => {
        const total = event.lengthComputable ? event.total : file.size;
        publishProgress(event.loaded, total);
      };
      function succeed() {
        if (settled) return;
        settled = true;
        cleanup();
        const totalBytes = progressContext.totalBytes || file.size;
        const totalLoaded = Math.min(totalBytes, (progressContext.completedBytes || 0) + file.size);
        updateActivity(activityId, {
          progress: 100,
          label: "Sent",
          kind: "sent",
          speed: 0
        });
        updateTransferMonitor({
          name: file.name,
          loaded: file.size,
          total: file.size,
          totalLoaded,
          totalBytes,
          percent: totalBytes ? (totalLoaded / totalBytes) * 100 : 100,
          speed: 0,
          active: true
        });
        resolve();
      }

      xhr.onload = () => {
        if (settled) return;
        if (xhr.status >= 200 && xhr.status < 300) {
          succeed();
        } else {
          const message = xhr.responseText || "Upload failed with HTTP " + xhr.status;
          const cancelled = xhr.status === 409 && /cancelled/i.test(message);
          if (cancelled && !session.cancelRequested) { session.cancelRequested = true; session.reason = "Cancelled by receiving device"; session.controller.abort(); }
          if (cancelled || session.cancelRequested) fail(session.reason || message, true);
          else failAfterStatusCheck(message);
        }
      };
      xhr.onerror = () => failAfterStatusCheck(receiverUnavailableMessage(endpoint));
      xhr.onabort = () => session.savedTransferId === transferId ? succeed() : fail(session.reason || "Transfer cancelled", true);
      xhr.ontimeout = () => failAfterStatusCheck("Transfer timed out before the receiver answered");
      publishProgress(0, file.size, progressContext.totalBytes ? ((progressContext.completedBytes || 0) / progressContext.totalBytes) * 100 : 0);
      signal.addEventListener("abort", abort, { once: true });
      try {
        xhr.send(uploadBody);
      } catch (error) {
        fail(messageOf(error));
      }
      if (!settled && session.supportsCancellation) pollTimer = setTimeout(poll, 350);
    });
  }

  /** @param {SendFile[]} files @param {Endpoint} endpoint */
  async function send(files, endpoint) {
    if (activeSession || !files.length) return null;
    const queue = [...files];
    const totalBytes = queue.reduce((sum, file) => sum + file.size, 0);
    /** @type {Session} */
    const session = { controller: new AbortController(), endpoint, cancelRequested: false, activeId: null, loaded: 0, supportsCancellation: false };
    activeSession = session;
    onStateChange();
    let sent = 0, failed = 0, completedBytes = 0;
    let error = "", paused = false;
    updateTransferMonitor({ name: "Checking receiver", totalBytes, percent: 0, active: true });
    try {
      await checkReceiver(endpoint, session);
      for (const file of queue) {
        checkCancellation(session);
        const activityId = createId();
        const transferId = createId();
        session.activeId = session.resumeReceiver ? null : transferId;
        session.loaded = completedBytes;
        addActivity({ id: activityId, file, name: file.name, label: "Sending", kind: "sending", direction: "send", progress: 0, speed: 0 });
        updateTransferMonitor({ name: file.name, totalLoaded: completedBytes, totalBytes, percent: totalBytes ? completedBytes / totalBytes * 100 : 0, speed: 0, active: true });
        try {
          if (session.resumeReceiver) {
            await sendResumable(file, endpoint, activityId, { completedBytes, totalBytes }, session);
          } else {
            await sendFile(file, endpoint, activityId, { completedBytes, totalBytes }, session, transferId);
          }
          sent += 1;
          completedBytes += file.size;
        } catch (cause) {
          const cancelled = session.cancelRequested;
          const message = messageOf(cause);
          paused = cause instanceof ResumePaused;
          updateActivity(activityId, { kind: cancelled ? "cancelled" : paused ? "paused" : "failed", label: message, speed: 0 });
          if (cancelled) break;
          failed += 1;
          error = message;
          if (session.resumeReceiver) break;
        } finally { session.activeId = null; session.attempt = undefined; }
      }
    } catch (cause) {
      if (!session.cancelRequested) {
        failed += 1;
        error = messageOf(cause);
      }
    } finally {
      if (session.cancelPromise) await session.cancelPromise;
      session.controller.abort();
      activeSession = null;
      onStateChange();
    }

    const complete = sent === queue.length;
    const cancelled = session.cancelRequested && !complete;
    const totalLoaded = complete ? totalBytes : Math.min(totalBytes, session.loaded || completedBytes);
    updateTransferMonitor({
      name: complete ? "Transfer complete" : cancelled ? session.reason || "Transfer cancelled" : paused ? "Transfer paused" : "Transfer failed",
      totalLoaded, totalBytes,
      percent: complete ? 100 : Math.min(99, totalBytes ? totalLoaded / totalBytes * 100 : 0),
      speed: 0, kind: complete ? "complete" : cancelled ? "cancelled" : paused ? "paused" : "failed", active: false
    });
    return { complete, cancelled, sent, failed, error, ...(paused && !cancelled ? { paused } : {}) };
  }

  return { send, cancel, busy: () => activeSession !== null, cancelling: () => Boolean(activeSession?.cancelRequested) };
}
