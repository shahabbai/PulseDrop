import { createTrustedClient } from "./trusted-client.js";
import { formatBytes } from "./transfer-format.js";

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, className, action) {
  const node = element("button", text, className);
  node.type = "button";
  node.addEventListener("click", async () => {
    node.disabled = true;
    try { await action(); }
    finally { node.disabled = false; }
  });
  return node;
}

export function mountTrustedDevices({ invoke, isReceiveView, canPoll, showToast, changed, paired, deviceName }) {
  const settings = document.querySelector("#trust-settings");
  const settingsStatus = document.querySelector("#trust-settings-status");
  const pairing = document.querySelector("#trust-pair-action");
  const pairButton = document.querySelector("#trust-pair");
  const dialog = document.querySelector("#trust-pair-dialog");
  const pairInstruction = document.querySelector("#trust-pair-instruction");
  const pairCode = document.querySelector("#trust-pair-code");
  const pairStatus = document.querySelector("#trust-pair-status");
  const pairConfirm = document.querySelector("#trust-pair-confirm");
  const incoming = document.querySelector("#trust-incoming");
  const requests = document.querySelector("#trust-requests");
  const announcement = document.querySelector("#trust-announcement");
  const peerList = document.querySelector("#trust-peers");
  const client = invoke && createTrustedClient({ invoke });
  let peers = new Map();
  let pending = new Map();
  let snapshotVersion = "";
  let loading;
  let pairLifetime;
  let interval;

  async function mutate(command, args) {
    try {
      await invoke(command, args);
      // If a read started before the change, read again after it completes.
      await loading;
      await refresh();
      return true;
    } catch (error) {
      showToast(String(error));
      return false;
    }
  }

  function renderPolicy(peer) {
    const details = element("details", "", "disclosure trust-peer");
    details.dataset.peerId = peer.id;
    const summary = element("summary");
    summary.append(element("strong", peer.name), element("span", peer.policy.automatic ? "Auto-accept rules" : "Ask each time", "value-badge"));
    const form = element("form", "", "trust-policy");
    const autoLabel = element("label", "", "trust-checkbox");
    const automatic = element("input");
    automatic.type = "checkbox";
    automatic.checked = peer.policy.automatic;
    autoLabel.append(automatic, element("span", "Automatically accept files"));
    const size = element("input");
    size.type = "number";
    size.min = "1";
    size.max = "1048576";
    size.required = true;
    size.value = String(peer.policy.max_mib);
    const extensions = element("input");
    extensions.type = "text";
    extensions.maxLength = 200;
    extensions.placeholder = "Any extension";
    extensions.value = peer.policy.extensions;
    const sizeLabel = element("label", "Maximum size per file (MiB)", "field");
    const extensionsLabel = element("label", "Allowed extensions", "field");
    sizeLabel.append(size);
    extensionsLabel.append(extensions, element("small", "Use commas, e.g. jpg, pdf. Leave blank to allow any extension."));
    const limits = element("div", "", "trust-policy");
    function updateLimits() {
      limits.hidden = !automatic.checked;
      size.disabled = extensions.disabled = !automatic.checked;
    }
    automatic.addEventListener("change", updateLimits);
    updateLimits();
    limits.append(sizeLabel, extensionsLabel, element("small", "Files outside these limits still ask for approval.", "muted"));
    const actions = element("div", "", "trust-actions");
    const save = element("button", "Save rules", "secondary-action");
    save.type = "submit";
    actions.append(save, button("Forget device", "text-button", () => mutate("trusted_forget", { id: peer.id })));
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      save.disabled = true;
      const policy = { automatic: automatic.checked, max_mib: Number(size.value), extensions: extensions.value };
      if (await mutate("trusted_set_policy", { id: peer.id, policy })) showToast("Acceptance rules saved");
      save.disabled = false;
    });
    form.append(autoLabel, limits, actions);
    details.append(summary, form);
    return details;
  }

  function renderPeers(updated) {
    const elements = new Map([...peerList.children].map((node) => [node.dataset.peerId, node]));
    for (const [id, peer] of updated) {
      if (JSON.stringify(peers.get(id)) === JSON.stringify(peer)) continue;
      const previous = elements.get(id);
      const details = renderPolicy(peer);
      if (previous) {
        const focused = previous.contains(document.activeElement);
        details.open = previous.open;
        previous.replaceWith(details);
        if (focused) details.querySelector("summary").focus();
      } else {
        peerList.append(details);
      }
    }
    for (const [id, node] of elements) {
      if (!updated.has(id)) {
        if (node.contains(document.activeElement)) {
          settingsStatus.tabIndex = -1;
          settingsStatus.focus();
        }
        node.remove();
      }
    }
    settingsStatus.textContent = updated.size ? "Manage which files each device can send automatically." : "Pair a device from Send to see it here.";
  }

  function renderRequests(updated) {
    const elements = new Map([...requests.children].map((node) => [node.dataset.requestId, node]));
    for (const [id, item] of updated) {
      if (elements.has(id)) continue;
      const card = element("article", "", "trust-request");
      card.dataset.requestId = id;
      const isPair = item.kind === "pair";
      card.append(element("strong", isPair ? `Pair with ${item.device}` : item.name));
      card.append(element("p", isPair ? "Compare this code with the one on the sending device."
        : `${formatBytes(item.size)} from ${item.device}`, "muted"));
      if (isPair) card.append(element("strong", item.code, "mono trust-code"));
      const actions = element("div", "", "trust-actions");
      const decide = (accept) => mutate("trusted_decide", { id: item.id, kind: item.kind, accept });
      actions.append(button("Decline", "secondary-action", () => decide(false)),
        button(isPair ? "Codes match · Trust device" : "Accept file", "primary-action", () => decide(true)));
      card.append(actions);
      requests.append(card);
    }
    for (const [id, node] of elements) if (!updated.has(id)) {
      if (node.contains(document.activeElement)) document.querySelector("#receive-title").focus({ preventScroll: true });
      node.remove();
    }
    incoming.hidden = updated.size === 0;
    announcement.textContent = updated.size ? `${updated.size} incoming ${updated.size === 1 ? "request" : "requests"}` : "";
    if (updated.size && [...updated.keys()].some((id) => !pending.has(id)) && !isReceiveView()) {
      showToast("Incoming request. Open Receive to review it.");
    }
  }

  async function refresh() {
    if (!client) return;
    const request = loading ??= (async () => {
      try {
        const result = await invoke("trusted_snapshot");
        settings.hidden = pairing.hidden = false;
        const nextVersion = JSON.stringify(result.peers);
        if (nextVersion !== snapshotVersion) {
          const updated = new Map(result.peers.map((peer) => [peer.id, peer]));
          renderPeers(updated);
          peers = updated;
          snapshotVersion = nextVersion;
          changed();
        }
        const updated = new Map(result.pending.map((item) => [`${item.kind}:${item.id}`, item]));
        if (updated.size !== pending.size || [...updated.keys()].some((id) => !pending.has(id))) {
          renderRequests(updated);
          pending = updated;
        }
      } catch (error) {
        settings.hidden = false;
        settingsStatus.textContent = `Trusted devices unavailable. ${String(error)}`;
      }
    })();
    try { await request; }
    finally { if (loading === request) loading = undefined; }
  }

  async function pair(address) {
    if (!client || dialog.open) return;
    const lifetime = new AbortController();
    pairLifetime = lifetime;
    pairInstruction.textContent = "Contacting the receiver…";
    pairCode.hidden = pairConfirm.hidden = true;
    pairStatus.textContent = "";
    pairConfirm.onclick = null;
    dialog.showModal();
    const timer = setTimeout(() => lifetime.abort(), 135_000);
    try {
      const request = await client.pair(address, deviceName() || "PulseDrop device", lifetime.signal);
      lifetime.signal.throwIfAborted();
      pairInstruction.textContent = `Compare this code with ${request.name}. Confirm on the receiver first.`;
      pairCode.hidden = false;
      pairCode.textContent = request.code;
      pairStatus.textContent = "Waiting for the receiver to confirm…";
      await request.wait();
      if (!dialog.open || lifetime.signal.aborted) return;
      pairStatus.textContent = "Receiver confirmed. Trust this device if both codes match.";
      pairConfirm.hidden = false;
      pairConfirm.onclick = async () => {
        pairConfirm.disabled = true;
        try {
          await request.remember();
          await refresh();
          paired(address, [...peers.values()].find((peer) => peer.key === request.key));
          if (dialog.open && pairLifetime === lifetime) dialog.close();
          showToast(`${request.name} is now trusted`);
        } catch (error) { pairStatus.textContent = String(error); }
        finally { pairConfirm.disabled = false; }
      };
    } catch (error) {
      if (dialog.open && pairLifetime === lifetime) {
        pairStatus.textContent = lifetime.signal.aborted ? "The pairing request timed out." : String(error);
      }
    } finally { clearTimeout(timer); }
  }

  document.querySelector("#trust-pair-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    pairLifetime?.abort();
    if (!pairButton.hidden) pairButton.focus();
    else document.querySelector("#send-title").focus({ preventScroll: true });
  });

  if (client) {
    interval = setInterval(() => { if (canPoll()) void refresh(); }, 900);
    window.addEventListener("pagehide", () => {
      clearInterval(interval);
      pairLifetime?.abort();
    });
  }

  return { client, find: (id) => peers.get(id), pair, refresh };
}
