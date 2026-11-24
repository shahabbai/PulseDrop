/** @typedef {import("./native-types").Invoke} Invoke */
/** @typedef {import("./native-types").TrustedPeer} TrustedPeer */
/** @typedef {{ip: string, port: number}} Address */
/** @typedef {{key: string, id: string, challenge: string}} Identity */
/** @typedef {{decision: "pending" | "accepted" | "declined"}} Decision */
/** @typedef {{method?: "GET" | "POST", fields?: Record<string, string>, body?: ArrayBuffer, signal?: AbortSignal, nonce?: string}} RequestOptions */

const APPROVAL_WINDOW = 120_000;

export class TrustedVerificationError extends Error {}

/** @template T @param {AbortSignal} signal @param {(signal: AbortSignal) => Promise<T>} operation */
async function withinControlDeadline(signal, operation) {
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 6500);
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

function newNonce() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @param {AbortSignal} signal */
function pollingDelay(signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(undefined);
    }, 900);
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** @param {Response} response @returns {Promise<Decision>} */
async function decisionFrom(response) {
  if (!response.ok) throw new Error(await response.text());
  const result = await response.json();
  if (!["pending", "accepted", "declined"].includes(result?.decision)) {
    throw new Error("The receiver returned an invalid approval status.");
  }
  return result;
}

/**
 * @param {() => Promise<Response>} status
 * @param {AbortSignal} signal
 * @param {string} refusal
 */
async function waitForDecision(status, signal, refusal) {
  const expires = Date.now() + APPROVAL_WINDOW;
  while (Date.now() < expires) {
    await pollingDelay(signal);
    const { decision } = await decisionFrom(await status());
    if (decision === "accepted") return;
    if (decision === "declined") throw new Error(refusal);
  }
  throw new Error("The request expired before the receiver approved it.");
}

/** @param {{invoke: Invoke, fetch?: typeof globalThis.fetch}} options */
export function createTrustedClient({ invoke, fetch = globalThis.fetch }) {
  /** @param {Address} address @param {AbortSignal} signal */
  async function identify(address, signal) {
    const response = await fetch(`http://${address.ip}:${address.port}/trust/info`, {
      cache: "no-store", redirect: "error", signal
    });
    if (!response.ok) throw new Error("Trusted devices are unavailable on this receiver.");
    const info = await response.json();
    if (!/^[\w-]{43}$/.test(info?.key) || !/^[a-f0-9]{32}$/.test(info?.id)
        || !/^[\w-]{22}$/.test(info?.challenge)) {
      throw new Error("The receiver returned an invalid device identity.");
    }
    return /** @type {Identity} */ (info);
  }

  /** @param {Address} address @param {Identity} receiver @param {string} sender */
  function session(address, receiver, sender) {
    /** @param {string} path @param {RequestOptions} [options] */
    async function request(path, { method = "GET", fields, body, signal, nonce = newNonce() } = {}) {
      signal?.throwIfAborted();
      const url = new URL(`http://${address.ip}:${address.port}${path}`);
      url.search = new URLSearchParams({
        ...fields, sender, receiver: receiver.key, challenge: receiver.challenge, nonce,
        time: String(Math.floor(Date.now() / 1000))
      }).toString();
      const proof = await invoke("trusted_sign", { method, target: url.pathname + url.search });
      signal?.throwIfAborted();
      const response = await fetch(url.href + "&proof=" + proof, {
        method, body, signal, cache: "no-store", redirect: "error",
        headers: body ? { "Content-Type": "application/octet-stream" } : undefined
      });
      const reply = response.headers.get("X-PulseDrop-Proof");
      if (!reply || !await invoke("trusted_verify", {
        key: receiver.key, nonce, status: response.status, body: await response.clone().text(), proof: reply
      })) {
        throw new TrustedVerificationError("Could not verify the receiver. Check both devices’ clocks and send the file again.");
      }
      return response;
    }
    return request;
  }

  /** @param {Address} address @param {TrustedPeer} peer @param {AbortSignal} signal */
  async function connect(address, peer, signal) {
    const info = await identify(address, signal);
    if (info.key !== peer.key || info.id !== peer.id) {
      throw new Error("The receiver’s identity changed. Verify the device before pairing again.");
    }
    const request = session(address, info, (await invoke("trusted_snapshot")).key);
    const check = await request("/trust/device", { signal });
    if (!check.ok) throw new Error(await check.text());
    return {
      request,
      /** @param {string} transferId @param {{name: string, size: number}} file @param {AbortSignal} signal @param {(message: string) => void} waiting */
      async approveFile(transferId, file, signal, waiting) {
        const offerId = newNonce();
        const fields = { transfer_id: transferId, offer_id: offerId, name: file.name, size: String(file.size) };
        try {
          const response = await withinControlDeadline(signal, (signal) => request("/trust/file", { method: "POST", fields, signal }));
          const { decision } = await decisionFrom(response);
          if (decision === "pending") {
            waiting("Waiting for the receiver to accept…");
            await waitForDecision(
              () => withinControlDeadline(signal, (signal) => request("/trust/file", { fields: { offer_id: offerId }, signal })),
              signal, "The receiving device declined the file."
            );
          }
          return offerId;
        } catch (error) {
          await finishFile(transferId, offerId);
          throw error;
        }
      },
      finishFile
    };

    /** @param {string} transferId @param {string} offerId */
    async function finishFile(transferId, offerId) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1200);
      try {
        await request("/trust/file/finish", {
          method: "POST", fields: { transfer_id: transferId, offer_id: offerId }, signal: controller.signal
        });
      } catch { /* The receiver expires requests that the sender cannot close. */ }
      finally { clearTimeout(timer); }
    }
  }

  /** @param {Address & {code: string}} address @param {string} name @param {AbortSignal} signal */
  async function pair(address, name, signal) {
    const info = await withinControlDeadline(signal, (signal) => identify(address, signal));
    const local = await invoke("trusted_snapshot");
    const request = session(address, info, local.key);
    const id = newNonce();
    const code = await invoke("trusted_pair_code", { key: info.key, id });
    const response = await withinControlDeadline(signal, (signal) => request("/trust/pair", {
      method: "POST", fields: { code: address.code, name }, nonce: id, signal
    }));
    await decisionFrom(response.clone());
    const receiver = await response.json();
    if (typeof receiver.name !== "string") throw new Error("The receiver did not send its device name.");
    return {
      key: info.key, name: receiver.name, code,
      wait: () => waitForDecision(
        () => withinControlDeadline(signal, (signal) => request("/trust/pair", { fields: { pair_id: id }, signal })),
        signal, "The receiving device declined pairing."
      ),
      remember: () => invoke("trusted_remember", { key: info.key, name: receiver.name })
    };
  }

  return { identify, connect, pair };
}

/** @typedef {Awaited<ReturnType<ReturnType<typeof createTrustedClient>["connect"]>>} TrustedTransport */
