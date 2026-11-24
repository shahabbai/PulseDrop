import { createReceiverDiscovery } from "./discovery.js";
import { validateReceiver } from "./ui.js";
import { createReceiveProgress } from "./receive-progress.js";
import { readFileBody } from "./file-body.js";
import { createSender } from "./sender.js";
import { formatBytes, formatSpeed } from "./transfer-format.js";
import { mountSettings } from "./settings-ui.js";
import { mountUpdater } from "./update-ui.js";
import { mountHotspot } from "./hotspot-ui.js";
import { mountTrustedDevices } from "./trusted-ui.js";
import { mountGlass } from "./glass.js";
import { version } from "../package.json";

const native = window.PulseDropNative;
const { invoke, android: isAndroidRuntime } = native;
const platformNames = new Map([
  ["linux", "Linux"], ["windows", "Windows"], ["macos", "macOS"], ["android", "Android"], ["ios", "iOS"]
]);
const bootScreen = document.querySelector("#boot-screen");

function hideBootScreen() {
  if (bootScreen) {
    bootScreen.remove();
  }
}

const state = {
  activeView: "home",
  files: [],
  receiver: null,
  selectedIp: null,
  networkIps: [],
  inboxCount: 0,
  activities: []
};

state.discoveredReceivers = [];
state.selectedReceiver = null;
state.discoveryScanning = false;
state.validationErrors = {};
state.sendError = "";
state.scrollPositions = {};
const queuedFileIds = new WeakMap();
const queuedFileStates = new WeakMap();
const incomingProgress = createReceiveProgress();
let restoreSendFocus = false;
let updating = false;
let changingReceiver = false;
let checkingTrustedAddress = false;
const receiveCancellation = new Set();

function createId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return String(Date.now()) + "-" + String(Math.random());
}

const els = {
  appShell: document.querySelector("#app-shell"),
  mainContent: document.querySelector("#main-content"),
  manualConnection: document.querySelector("#manual-connection"),
  sendError: document.querySelector("#send-error"),
  sendHint: document.querySelector("#send-hint"),
  scanIndicator: document.querySelector("#scan-indicator"),
  queueCount: document.querySelector("#queue-count"),
  transferProgress: document.querySelector("#transfer-progress"),
  cancelSend: document.querySelector("#cancel-send"),
  cancelReceive: document.querySelector("#cancel-receive"),
  transferAnnouncement: document.querySelector("#transfer-announcement"),
  receiveMonitor: document.querySelector("#receive-monitor"),
  receiveName: document.querySelector("#receive-name"),
  receivePercent: document.querySelector("#receive-percent"),
  receiveProgress: document.querySelector("#receive-progress"),
  receiveFill: document.querySelector("#receive-fill"),
  receiveBytes: document.querySelector("#receive-bytes"),
  receiveSpeed: document.querySelector("#receive-speed"),
  receiveLabel: document.querySelector("#receive-label"),
  receiveAnnouncement: document.querySelector("#receive-announcement"),
  receiverSession: document.querySelector("#receiver-session"),
  receiverStateTitle: document.querySelector("#receiver-state-title"),
  receiverStateDescription: document.querySelector("#receiver-state-description"),
  navReceiverIndicator: document.querySelector("#nav-receiver-indicator"),
  homeScreen: document.querySelector("#home-screen"),
  workflowScreen: document.querySelector("#workflow-screen"),
  homeSend: document.querySelector("#home-send"),
  homeReceive: document.querySelector("#home-receive"),
  homeSettings: document.querySelector("#home-settings"),
  backHome: document.querySelector("#back-home"),
  sendPanel: document.querySelector("#send-panel"),
  receivePanel: document.querySelector("#receive-panel"),
  settingsPanel: document.querySelector("#settings-panel"),
  statusDot: document.querySelector("#status-dot"),
  deviceName: document.querySelector("#device-name"),
  deviceCaption: document.querySelector("#device-caption"),
  devicePlatform: document.querySelector("#device-platform"),
  localIp: document.querySelector("#local-ip"),
  receiverState: document.querySelector("#receiver-state"),
  inboxCount: document.querySelector("#inbox-count"),
  peerIp: document.querySelector("#peer-ip"),
  peerPort: document.querySelector("#peer-port"),
  peerCode: document.querySelector("#peer-code"),
  peerCodeField: document.querySelector("#peer-code-field"),
  pairDevice: document.querySelector("#trust-pair"),
  trustedSelection: document.querySelector("#trust-selected"),
  receiverList: document.querySelector("#receiver-list"),
  discoveryStatus: document.querySelector("#discovery-status"),
  refreshReceivers: document.querySelector("#refresh-receivers"),
  receiverDiscoveryStatus: document.querySelector("#receiver-discovery-status"),
  fileInput: document.querySelector("#file-input"),
  dropZone: document.querySelector("#drop-zone"),
  fileList: document.querySelector("#file-list"),
  queueTotal: document.querySelector("#queue-total"),
  clearFiles: document.querySelector("#clear-files"),
  sendFiles: document.querySelector("#send-files"),
  transferMonitor: document.querySelector("#transfer-monitor"),
  transferName: document.querySelector("#transfer-name"),
  transferPercent: document.querySelector("#transfer-percent"),
  transferFill: document.querySelector("#transfer-fill"),
  transferBytes: document.querySelector("#transfer-bytes"),
  transferSpeed: document.querySelector("#transfer-speed"),
  toggleReceiver: document.querySelector("#toggle-receiver"),
  sessionIp: document.querySelector("#session-ip"),
  sessionPort: document.querySelector("#session-port"),
  sessionCode: document.querySelector("#session-code"),
  networkRow: document.querySelector("#network-row"),
  networkChips: document.querySelector("#network-chips"),
  inboxPath: document.querySelector("#inbox-path"),
  openInbox: document.querySelector("#open-inbox"),
  activityList: document.querySelector("#activity-list"),
  activityTotal: document.querySelector("#activity-total"),
  copyIp: document.querySelector("#copy-ip"),
  copyPort: document.querySelector("#copy-port"),
  copyCode: document.querySelector("#copy-code"),
  toast: document.querySelector("#toast")
};

const receiverDiscovery = createReceiverDiscovery({
  scan: () => invoke("discover_receivers"),
  onChange({ receivers, scanning, error }) {
    state.discoveredReceivers = receivers;
    state.discoveryScanning = scanning;
    els.refreshReceivers.disabled = scanning || sender.busy();
    els.scanIndicator.hidden = !scanning;
    els.discoveryStatus.dataset.error = String(Boolean(error));
    els.receiverList.setAttribute("aria-busy", String(scanning));
    if (error) {
      els.discoveryStatus.textContent = `${error} Use “Enter address manually” to connect.`;
    } else if (scanning) {
      els.discoveryStatus.textContent = "Searching on your LAN…";
    } else if (state.selectedReceiver && !receivers.some((peer) => peer.id === state.selectedReceiver.id)) {
      els.discoveryStatus.textContent = "The selected receiver is no longer visible. Check that it is still receiving, or enter its address below.";
    } else {
      els.discoveryStatus.textContent = receivers.length
        ? `${receivers.length} ${receivers.length === 1 ? "receiver" : "receivers"} ready. Choose a device below.`
        : "No receivers yet. Open Receive on your other device, or enter its address manually.";
    }
    if (!scanning || receivers.length === 0) renderDiscoveredReceivers();
  }
});

function renderDiscoveredReceivers() {
  const focusedId = document.activeElement && document.activeElement.dataset.receiverId;
  els.receiverList.replaceChildren();
  for (const peer of state.discoveredReceivers) {
    const row = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "receiver-choice";
    button.dataset.receiverId = peer.id;
    button.disabled = sender.busy();
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("class", "icon");
    icon.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", /android|ios/i.test(peer.platform) ? "#icon-phone" : "#icon-device");
    icon.append(use);
    const selected = state.selectedReceiver && state.selectedReceiver.id === peer.id
      && els.peerIp.value.trim() === peer.ip && Number(els.peerPort.value) === peer.port;
    button.setAttribute("aria-pressed", String(Boolean(selected)));
    const info = document.createElement("span");
    const name = document.createElement("strong");
    const trusted = trustedUI.find(peer.id);
    name.textContent = trusted?.name ?? peer.name;
    const address = document.createElement("small");
    address.textContent = `${platformNames.get(peer.platform) ?? peer.platform} · ${peer.ip}:${peer.port}`;
    info.append(name, address);
    const action = document.createElement("span");
    action.className = "receiver-choice-action";
    action.textContent = trusted
      ? state.files.length ? "Send now" : "Trusted"
      : selected ? "Selected" : "Select";
    button.append(icon, info, action);
    button.addEventListener("click", () => {
      if (sender.busy() || checkingTrustedAddress || updating || hotspotUI.busy()) return;
      if (!selected) els.peerCode.value = "";
      state.selectedReceiver = peer;
      state.manuallyPairedReceiver = null;
      els.peerIp.value = peer.ip;
      els.peerPort.value = String(peer.port);
      state.validationErrors = {};
      state.sendError = "";
      renderSendErrors();
      renderDiscoveredReceivers();
      syncSendControls();
      if (trusted) {
        if (state.files.length) {
          if (!els.sendFiles.disabled) els.sendFiles.focus({ preventScroll: true });
          void sendSelectedFiles();
        }
      } else {
        els.peerCode.focus();
        showToast("Enter the code shown on the receiving device");
      }
    });
    row.append(button);
    els.receiverList.append(row);
    if (focusedId === peer.id) button.focus({ preventScroll: true });
  }
}

function updateDiscoveryActivity() {
  const browsing = state.activeView === "send" && !document.hidden && Boolean(invoke);
  if (browsing) receiverDiscovery.start();
  else receiverDiscovery.stop();
  if (!invoke) {
    els.discoveryStatus.textContent = "Run inside PulseDrop to discover receivers on your LAN.";
    els.refreshReceivers.disabled = true;
  }
  native.setDiscoveryActive(!document.hidden && (browsing || Boolean(state.receiver)));
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}

function resetTransferMonitor() {
  if (!els.transferMonitor) return;
  els.transferMonitor.hidden = true;
  els.transferMonitor.classList.remove("is-active", "is-complete", "is-failed");
  els.transferName.textContent = "Ready";
  els.transferPercent.textContent = "0%";
  els.transferFill.style.width = "0%";
  els.transferProgress.setAttribute("aria-valuenow", "0");
  els.transferAnnouncement.textContent = "";
  els.transferBytes.textContent = "0 B of 0 B";
  els.transferSpeed.textContent = "0 B/s";
}

function updateTransferMonitor(details = {}) {
  if (!els.transferMonitor) return;
  const totalBytes = details.totalBytes || details.total || 0;
  const loadedBytes = details.totalLoaded ?? details.loaded ?? 0;
  const percent = clampPercent(details.percent ?? (totalBytes ? (loadedBytes / totalBytes) * 100 : 0));

  els.transferMonitor.hidden = false;
  els.transferMonitor.classList.toggle("is-active", details.active !== false);
  els.transferMonitor.classList.toggle("is-complete", details.kind === "complete");
  els.transferMonitor.classList.toggle("is-failed", details.kind === "failed");
  els.transferMonitor.classList.toggle("is-cancelled", details.kind === "cancelled");
  els.transferName.textContent = details.name || "Transfer";
  els.transferPercent.textContent = Math.round(percent) + "%";
  els.transferFill.style.width = percent + "%";
  els.transferProgress.setAttribute("aria-valuenow", String(Math.round(percent)));
  const announcement = details.kind === "complete" ? "Transfer complete. All files sent."
    : details.kind === "cancelled" ? "Transfer cancelled. Completed files were kept."
    : details.kind === "paused" ? "Transfer paused. Reconnect to the receiver to resume."
    : details.kind === "failed" ? "Transfer failed. Check the connection and try again."
    : "Transfer in progress.";
  if (els.transferAnnouncement.textContent !== announcement) els.transferAnnouncement.textContent = announcement;
  els.transferBytes.textContent = totalBytes
    ? formatBytes(loadedBytes) + " of " + formatBytes(totalBytes)
    : formatBytes(loadedBytes);
  els.transferSpeed.textContent = details.speed ? formatSpeed(details.speed) : "0 B/s";
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => els.toast.classList.remove("show"), 4500);
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
}

function normalizeView(mode) {
  return mode === "send" || mode === "receive" || mode === "settings" ? mode : "home";
}

function viewFromLocation() {
  return normalizeView(window.location.hash.replace("#", ""));
}

function writeViewHistory(view, replaceHistory) {
  const hash = view === "home" ? "#home" : `#${view}`;
  const previous = window.history.state;
  const depth = replaceHistory || !previous ? 0 : (previous.depth || 0) + 1;
  const stateValue = { view, depth };

  if (replaceHistory || !window.history.state) {
    window.history.replaceState(stateValue, "", hash);
    return;
  }

  if (window.history.state.view !== view) {
    window.history.pushState(stateValue, "", hash);
  }
}

function setView(mode, options = {}) {
  const nextView = normalizeView(mode);
  const isHome = nextView === "home";
  if (state.activeView !== nextView) state.scrollPositions[state.activeView] = els.mainContent.scrollTop;
  state.activeView = nextView;
  if (nextView !== "send") els.dropZone.classList.remove("dragging");
  hotspotUI.viewChanged(nextView);
  updateDiscoveryActivity();

  els.appShell.dataset.view = nextView;
  els.homeScreen.hidden = !isHome;
  els.workflowScreen.hidden = isHome;
  els.sendPanel.hidden = nextView !== "send";
  els.receivePanel.hidden = nextView !== "receive";
  els.settingsPanel.hidden = nextView !== "settings";
  els.backHome.hidden = isHome;
  document.querySelectorAll(".nav-item").forEach((button) => {
    if (button.dataset.mode === nextView) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });

  if (options.updateHistory !== false) {
    writeViewHistory(nextView, Boolean(options.replaceHistory));
  }

  if (nextView === "settings") settingsUI.refresh();
  if (nextView !== "home") void trustedUI.refresh();
  els.mainContent.scrollTop = state.scrollPositions[nextView] || 0;
  if (options.focus !== false) {
    const heading = document.querySelector(isHome ? "#home-title" : `#${nextView}-title`);
    heading.focus({ preventScroll: true });
  }
}

function endpointFromFields() {
  return { ip: els.peerIp.value.trim(), port: Number(els.peerPort.value.trim()), code: els.peerCode.value.trim() };
}

function selectedTrustedPeer() {
  const selected = state.manuallyPairedReceiver ?? state.selectedReceiver;
  const { ip, port } = endpointFromFields();
  return selected?.ip === ip && selected.port === port ? trustedUI.find(selected.id) : undefined;
}

function syncSendControls() {
  const sending = sender.busy();
  const cancelling = sender.cancelling();
  const paused = state.files.some((file) => queuedFileStates.get(file)?.kind === "paused");
  const focusWasSend = document.activeElement === els.sendFiles;
  const focusWasCancel = document.activeElement === els.cancelSend;
  els.cancelSend.hidden = !sending;
  els.sendFiles.hidden = sending;
  els.cancelSend.disabled = cancelling;
  els.cancelSend.textContent = cancelling ? "Cancelling…" : "Cancel transfer";
  const busy = sending || checkingTrustedAddress || updating || hotspotUI.busy();
  const trusted = selectedTrustedPeer();
  els.peerCodeField.hidden = Boolean(trusted);
  els.pairDevice.hidden = Boolean(trusted);
  els.pairDevice.disabled = busy;
  els.trustedSelection.hidden = !trusted;
  els.trustedSelection.textContent = trusted ? `Trusted · ${trusted.name}` : "";
  els.sendFiles.disabled = busy || state.files.length === 0;
  if (sending && focusWasSend && !cancelling) els.cancelSend.focus({ preventScroll: true });
  if (!sending && focusWasCancel) els.sendFiles.focus({ preventScroll: true });
  els.clearFiles.disabled = sending || state.files.length === 0;
  els.fileInput.disabled = sending;
  if (sending) els.dropZone.classList.remove("dragging");
  for (const input of [els.peerIp, els.peerPort, els.peerCode]) input.disabled = sending;
  els.refreshReceivers.disabled = !invoke || sending || state.discoveryScanning;
  els.sendFiles.setAttribute("aria-busy", String(sending));
  els.sendFiles.querySelector("span").textContent = sending ? "Sending…" : paused ? "Resume transfer" : "Send files";
  els.sendHint.textContent = sending ? "Keep both devices open until the transfer finishes."
    : paused ? "Reconnect to the receiver and resume the selected file."
    : trusted ? "Send when the receiver is ready."
    : state.files.length ? "Choose a receiver or enter its address." : "Add files and choose a receiver to get started.";
  for (const choice of els.receiverList.querySelectorAll(".receiver-choice")) {
    const peer = trustedUI.find(choice.dataset.receiverId);
    if (peer) choice.querySelector(".receiver-choice-action").textContent = state.files.length ? "Send now" : "Trusted";
  }
  document.querySelectorAll(".remove-file, .receiver-choice").forEach((button) => { button.disabled = sending; });
  hotspotUI.refresh();
}

function queueFileId(file) {
  if (!queuedFileIds.has(file)) queuedFileIds.set(file, createId());
  return queuedFileIds.get(file);
}

function updateQueuedFile(file, activity) {
  queuedFileStates.set(file, activity);
  const row = Array.from(els.fileList.children).find((element) => element.dataset.fileId === queueFileId(file));
  if (!row) return;
  row.dataset.status = activity.kind || "queued";
  row.querySelector(".queue-file-state").textContent = activity.kind === "sent" ? "Sent"
    : activity.kind === "cancelled" ? "Cancelled · retry available"
    : activity.kind === "paused" ? "Paused · resume available"
    : activity.kind === "failed" ? "Failed · retry available"
    : activity.kind === "sending" ? `Sending ${Math.round(clampPercent(activity.progress || 0))}%` : "Queued";
}

function renderFiles() {
  els.fileList.innerHTML = "";
  const total = state.files.reduce((sum, file) => sum + file.size, 0);
  els.queueTotal.textContent = formatBytes(total);
  els.queueCount.textContent = String(state.files.length);
  syncSendControls();

  if (state.files.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-list";
    empty.innerHTML = '<span>No files in your queue</span><small>Add a few files above to get started.</small>';
    els.fileList.append(empty);
    return;
  }

  state.files.forEach((file, index) => {
    const row = document.createElement("li");
    row.className = "file-row";
    row.dataset.fileId = queueFileId(file);
    row.innerHTML = `
      <span class="file-type-icon"><svg class="icon" aria-hidden="true"><use href="#icon-file"></use></svg></span>
      <div class="file-copy">
        <strong title="${escapeAttr(file.name)}">${escapeHtml(file.name)}</strong>
        <span>${formatBytes(file.size)}<span class="queue-file-state">Queued</span></span>
      </div>
      <button class="remove-file" type="button" title="Remove ${escapeAttr(file.name)}" aria-label="Remove ${escapeAttr(file.name)}" ${sender.busy() ? "disabled" : ""}>
        <svg class="icon" aria-hidden="true"><use href="#icon-close"></use></svg>
      </button>
    `;
    row.querySelector("button").addEventListener("click", () => {
      file.release?.();
      state.files.splice(index, 1);
      renderFiles();
      const next = els.fileList.querySelectorAll(".remove-file")[Math.min(index, state.files.length - 1)];
      (next || els.fileInput).focus();
    });
    els.fileList.append(row);
    const activity = queuedFileStates.get(file);
    if (activity) updateQueuedFile(file, activity);
  });
}

function getReceiverAddresses() {
  if (state.receiver && Array.isArray(state.receiver.ip_addresses)) {
    return state.receiver.ip_addresses;
  }
  return state.networkIps;
}

function selectedReceiverIp() {
  const addresses = getReceiverAddresses();
  if (state.selectedIp) return state.selectedIp;
  if (state.receiver && state.receiver.ip_address) return state.receiver.ip_address;
  if (addresses.length > 0) return addresses[0].ip;
  return null;
}

function renderNetworkChoices() {
  const addresses = getReceiverAddresses();
  els.networkChips.innerHTML = "";
  els.networkRow.hidden = addresses.length < 2;
  if (addresses.length < 2) return;

  const selectedIp = selectedReceiverIp();
  addresses.forEach((address) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "network-chip";
    if (address.is_vpn_like) button.classList.add("vpn-like");
    if (address.ip === selectedIp) button.classList.add("active");
    button.setAttribute("aria-pressed", String(address.ip === selectedIp));
    button.textContent = address.label || address.ip;
    button.title = address.is_vpn_like ? "VPN or tunnel address" : "Local network address";
    button.addEventListener("click", () => {
      state.selectedIp = address.ip;
      els.localIp.textContent = address.ip;
      renderReceiver();
      showToast(`${address.ip} selected`);
    });
    els.networkChips.append(button);
  });
}

function renderReceiver() {
  const active = Boolean(state.receiver);
  const receiverIp = active ? selectedReceiverIp() : null;
  els.receiverState.textContent = active ? "Online" : "Offline";
  els.receiverSession.classList.toggle("is-live", active);
  els.receiverStateTitle.textContent = active ? "Ready to receive" : "Ready when you are";
  els.receiverStateDescription.textContent = active
    ? `Choose “${state.receiver.name}” on your sender, then enter the pairing code below.`
    : "Start receiving to make this device visible on your network.";
  els.navReceiverIndicator.hidden = !active;
  els.sessionIp.textContent = receiverIp || "--";
  els.sessionPort.textContent = active && state.receiver.port ? state.receiver.port : "--";
  els.sessionCode.textContent = active && state.receiver.code ? state.receiver.code : "--";
  els.inboxPath.textContent = active && state.receiver.inbox_dir ? state.receiver.inbox_dir : "Start receiving to create your Inbox";
  els.inboxPath.title = els.inboxPath.textContent;
  els.openInbox.disabled = !active;
  for (const button of [els.copyIp, els.copyPort, els.copyCode]) button.disabled = !active;
  els.toggleReceiver.title = active ? "Stop receiving" : "Start receiving";
  els.toggleReceiver.setAttribute("aria-label", els.toggleReceiver.title);
  els.toggleReceiver.classList.toggle("is-live", active);
  els.toggleReceiver.innerHTML = active
    ? '<svg class="icon" aria-hidden="true"><use href="#icon-stop"></use></svg><span>Stop receiving</span>'
    : '<svg class="icon" aria-hidden="true"><use href="#icon-play"></use></svg><span>Start receiving</span>';
  els.receiverDiscoveryStatus.hidden = !active;
  els.receiverDiscoveryStatus.textContent = active
    ? (state.receiver.discovery_error
      ? `${state.receiver.discovery_error}. Share the IP, port, and code to connect manually.`
      : "Visible on your local network. Only share this code with someone you trust.")
    : "";
  els.receiverDiscoveryStatus.dataset.error = String(Boolean(active && state.receiver.discovery_error));
  updateDiscoveryActivity();
  renderNetworkChoices();
}

function addActivity(activity) {
  state.activities.unshift({
    id: createId(),
    progress: 0,
    ...activity
  });
  trimActivities();
  if (activity.file) updateQueuedFile(activity.file, state.activities[0]);
  renderActivities();
}

function updateActivity(id, patch) {
  const item = state.activities.find((activity) => activity.id === id);
  if (!item) return;
  Object.assign(item, patch);
  if (item.file) updateQueuedFile(item.file, item);
  trimActivities();
  renderActivities();
}

function trimActivities() {
  let recent = 0;
  state.activities = state.activities.filter((item) => ["receiving", "sending", "paused"].includes(item.kind) || recent++ < 12);
}

function handleReceiveProgress(payload) {
  const update = incomingProgress.accept(payload);
  if (!update) return;
  const { item, completed, summary } = update;
  if (item.phase !== "receiving") receiveCancellation.delete(item.id);
  const activity = {
    ...item,
    label: item.kind === "cancelled" ? "Cancelled · incomplete file removed"
      : item.kind === "received" ? `Received ${formatBytes(item.size)}`
      : item.kind === "paused" ? `Paused · ${formatBytes(item.received)} saved for resume`
      : item.kind === "failed" ? item.error || "Transfer interrupted. Ask the sender to retry."
      : `Receiving ${formatBytes(item.received)} of ${formatBytes(item.size)}`
  };
  if (completed) state.inboxCount += 1;
  if (state.activities.some((entry) => entry.id === item.id)) updateActivity(item.id, activity);
  else addActivity(activity);

  if (!summary.activeCount && document.activeElement === els.cancelReceive) document.querySelector("#receive-title").focus({ preventScroll: true });
  els.cancelReceive.hidden = !summary.activeCount;
  els.cancelReceive.disabled = summary.activeCount > 0 && state.activities.filter((entry) => entry.direction === "receive" && entry.kind === "receiving").every((entry) => receiveCancellation.has(entry.id));
  els.cancelReceive.textContent = els.cancelReceive.disabled ? "Cancelling…" : summary.activeCount > 1 ? "Cancel all incoming" : "Cancel file";
  els.receiveMonitor.classList.toggle("is-cancelled", summary.kind === "cancelled");
  els.receiveMonitor.hidden = false;
  els.receiveMonitor.classList.toggle("is-active", summary.kind === "receiving");
  els.receiveMonitor.classList.toggle("is-complete", summary.kind === "received");
  els.receiveMonitor.classList.toggle("is-failed", summary.kind === "failed");
  els.receiveName.textContent = summary.name;
  els.receiveLabel.textContent = summary.kind === "receiving" ? "Receiving" : summary.kind === "received" ? "File received" : summary.kind === "cancelled" ? "Transfer cancelled" : summary.kind === "paused" ? "Transfer paused" : "Transfer interrupted";
  els.receivePercent.textContent = `${Math.round(summary.progress)}%`;
  els.receiveProgress.setAttribute("aria-valuenow", String(Math.round(summary.progress)));
  els.receiveFill.style.width = `${summary.progress}%`;
  els.receiveBytes.textContent = `${formatBytes(summary.received)} of ${formatBytes(summary.size)}`;
  els.receiveSpeed.textContent = summary.kind === "receiving" ? (summary.speed > 0 ? formatSpeed(summary.speed) : "Measuring speed…")
    : summary.kind === "received" ? "Saved to Inbox" : summary.kind === "cancelled" ? "Incomplete file removed" : summary.kind === "paused" ? "Waiting for the sender to resume" : "Ask the sender to retry";
  const announcement = summary.kind === "receiving" ? `Receiving ${summary.activeCount} ${summary.activeCount === 1 ? "file" : "files"}.`
    : summary.kind === "received" ? "File received and saved to Inbox." : summary.kind === "cancelled" ? "Incoming transfer cancelled. Incomplete file removed." : summary.kind === "paused" ? "Transfer paused. Confirmed bytes were saved." : "An incoming transfer was interrupted.";
  if (els.receiveAnnouncement.textContent !== announcement) els.receiveAnnouncement.textContent = announcement;
  hotspotUI.refresh();
}

async function cancelIncoming(transferId = null) {
  const ids = state.activities.filter((item) => item.direction === "receive"
    && (item.kind === "receiving" || (transferId && item.kind === "paused"))
    && (!transferId || item.id === transferId)).map((item) => item.id);
  if (!ids.length) return;
  ids.forEach((id) => receiveCancellation.add(id));
  const active = state.activities.filter((item) => item.direction === "receive" && item.kind === "receiving");
  els.cancelReceive.disabled = active.every((item) => receiveCancellation.has(item.id));
  els.cancelReceive.textContent = els.cancelReceive.disabled ? "Cancelling…" : active.length > 1 ? "Cancel all incoming" : "Cancel file";
  renderActivities();
  try { await Promise.all(ids.map((id) => invoke("cancel_receive", { transferId: id }))); }
  catch (error) {
    ids.forEach((id) => receiveCancellation.delete(id));
    els.cancelReceive.disabled = false;
    els.cancelReceive.textContent = "Cancel incoming";
    showToast(`Could not cancel: ${error.message || error}. Try again.`);
    renderActivities();
  }
}

function renderActivities() {
  const existing = new Map(Array.from(els.activityList.children).map((row) => [row.dataset.transferId, row]));
  els.activityTotal.textContent = state.activities.length ? state.activities.length + " recent" : "No transfers";
  els.inboxCount.textContent = state.inboxCount + " " + (state.inboxCount === 1 ? "file" : "files");
  if (!state.activities.length) {
    els.activityList.innerHTML = '<li class="empty-list"><svg class="icon" aria-hidden="true"><use href="#icon-download"></use></svg><span>No transfers yet</span><small>Your received files and recent transfers will appear here.</small></li>';
    return;
  }
  // Keep controls mounted while bytes change so pointer/keyboard focus survives.
  state.activities.forEach((activity, index) => {
    const progress = Math.round(clampPercent(activity.progress || 0));
    const row = existing.get(activity.id) || document.createElement("li");
    existing.delete(activity.id);
    if (!row.dataset.transferId) {
      row.dataset.transferId = activity.id;
      row.innerHTML = '<svg class="icon" aria-hidden="true"><use></use></svg><div class="activity-copy"><strong></strong><span></span></div><div class="activity-meter"><span class="activity-percent"></span><span class="activity-speed"></span><button class="secondary-action cancel-action" type="button">Cancel</button></div><div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div class="progress-fill"></div></div>';
      row.querySelector("button").addEventListener("click", () => cancelIncoming(activity.id));
    }
    row.className = `activity-row ${activity.kind || ""}`;
    const name = row.querySelector("strong");
    name.textContent = activity.name;
    name.title = activity.name;
    row.querySelector(".activity-copy > span").textContent = activity.label || "";
    row.querySelector(".activity-percent").textContent = `${progress}%`;
    const speed = row.querySelector(".activity-speed");
    speed.hidden = !activity.speed;
    speed.textContent = activity.speed ? formatSpeed(activity.speed) : "";
    const button = row.querySelector("button");
    const canCancel = activity.direction === "receive" && Boolean(state.receiver)
      && ["receiving", "paused"].includes(activity.kind);
    if (!canCancel && document.activeElement === button) document.querySelector("#receive-title").focus({ preventScroll: true });
    button.hidden = !canCancel;
    button.disabled = receiveCancellation.has(activity.id);
    button.textContent = button.disabled ? "Cancelling…" : activity.kind === "paused" ? "Discard" : "Cancel";
    button.setAttribute("aria-label", `${activity.kind === "paused" ? "Discard saved transfer" : "Cancel receiving"} ${activity.name}`);
    const track = row.querySelector(".progress-track");
    track.setAttribute("aria-label", `${activity.direction === "receive" ? "Incoming" : "Outgoing"} transfer: ${activity.name}`);
    track.setAttribute("aria-valuenow", String(progress));
    row.querySelector(".progress-fill").style.width = `${progress}%`;
    row.querySelector("use").setAttribute("href", activity.kind === "failed" ? "#icon-info" : activity.kind === "cancelled" ? "#icon-close" : activity.direction === "receive" ? "#icon-download" : "#icon-upload");
    if (els.activityList.children[index] !== row) els.activityList.insertBefore(row, els.activityList.children[index] || null);
  });
  existing.forEach((row) => row.remove());
}

function addFiles(fileList) {
  const incoming = Array.from(fileList || []);
  if (sender.busy()) {
    incoming.forEach((file) => file.release?.());
    return;
  }
  if (!incoming.length) return;
  const existing = new Set(state.files.map((file) => `${file.name}-${file.size}-${file.lastModified}`));
  for (const file of incoming) {
    const key = `${file.name}-${file.size}-${file.lastModified}`;
    if (!existing.has(key)) {
      state.files.push(file);
      existing.add(key);
    } else file.release?.();
  }
  renderFiles();
}

async function loadDeviceProfile() {
  if (!invoke) {
    els.deviceName.textContent = "Browser preview";
    els.devicePlatform.textContent = "";
    els.localIp.textContent = "Open in Tauri";
    return;
  }

  try {
    const profile = await invoke("device_profile");
    state.networkIps = Array.isArray(profile.network_ips) ? profile.network_ips : [];
    if (state.receiver) state.receiver = await invoke("start_receiver", { receiverName: null });
    state.selectedIp = profile.primary_ip || (state.networkIps[0] && state.networkIps[0].ip) || null;
    els.statusDot.classList.toggle("online", Boolean(state.selectedIp));
    const name = native.deviceName() || profile.name;
    state.deviceName = name;
    els.deviceName.textContent = name;
    els.deviceCaption.hidden = name === "This device";
    els.devicePlatform.textContent = platformNames.get(profile.platform) ?? profile.platform;
    els.localIp.textContent = state.selectedIp || "No network";
    els.localIp.title = state.networkIps.map((address) => address.label || address.ip).join("\n");
    renderNetworkChoices();
    if (state.receiver) renderReceiver();
  } catch (error) {
    els.deviceName.textContent = "Device unavailable";
    els.localIp.textContent = "Network unavailable";
    showToast(String(error));
  }
}

async function toggleReceiver() {
  if (updating || changingReceiver) return;
  if (!invoke) {
    showToast("Run inside Tauri to start receiving");
    return;
  }

  changingReceiver = true;
  setBusy(els.toggleReceiver, true);
  try {
    if (hotspotUI.busy()) throw new Error("Finish or cancel hotspot setup first.");
    if (state.receiver) {
      if (hotspotUI.hostActive()) await hotspotUI.stop();
      await invoke("stop_receiver");
      state.receiver = null;
      showToast("Receiver stopped");
    } else {
      const preferredIp = state.selectedIp;
      state.receiver = await invoke("start_receiver", { receiverName: native.deviceName() });
      state.selectedIp = preferredIp || state.receiver.ip_address || selectedReceiverIp();
      showToast("Receiver is online");
    }
    renderReceiver();
    renderActivities();
  } catch (error) {
    showToast(String(error));
    els.receiverDiscoveryStatus.hidden = false;
    els.receiverDiscoveryStatus.dataset.error = "true";
    els.receiverDiscoveryStatus.textContent = `Could not change the receiver state: ${String(error.message || error)}. Try again or check your network.`;
  } finally {
    changingReceiver = false;
    setBusy(els.toggleReceiver, false);
  }
}

async function openInbox() {
  if (!state.receiver || !state.receiver.inbox_dir) {
    showToast("Start receiver first");
    return;
  }

  try {
    const result = await native.openInbox(state.receiver.inbox_dir);
    if (result === "downloads") showToast("Opening Android Downloads");
    if (result === "manual") showToast("Open Downloads, then PulseDrop/Inbox");
  } catch (error) {
    showToast(String(error));
  }
}

function renderSendErrors(focus = false) {
  const errors = Object.entries(state.validationErrors);
  for (const id of ["peer-ip", "peer-port", "peer-code"]) {
    const input = document.getElementById(id);
    const error = document.getElementById(`${id}-error`);
    const message = state.validationErrors[id];
    input.setAttribute("aria-invalid", String(Boolean(message)));
    error.hidden = !message;
    error.textContent = message || "";
  }
  els.sendError.replaceChildren();
  els.sendError.hidden = errors.length === 0 && !state.sendError;
  if (els.sendError.hidden) return;
  const title = document.createElement("strong");
  title.textContent = state.sendError || "A few details before we send";
  els.sendError.append(title);
  if (errors.length) {
    const list = document.createElement("ul");
    for (const [id, message] of errors) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = `#${id}`;
      link.textContent = message;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        if (id !== "peer-code") els.manualConnection.open = true;
        document.getElementById(id).focus();
      });
      item.append(link);
      list.append(item);
    }
    els.sendError.append(list);
  }
  if (state.validationErrors["peer-ip"] || state.validationErrors["peer-port"]) els.manualConnection.open = true;
  if (focus) els.sendError.focus();
}

async function sendSelectedFiles() {
  if (updating || hotspotUI.busy() || sender.busy() || checkingTrustedAddress || !state.files.length) return;
  const endpoint = endpointFromFields();
  let trusted = selectedTrustedPeer();
  // Manual addresses and hotspot QR handoffs can work without discovery.
  if (!trusted && (!endpoint.code || state.hotspotAddress) && trustedUI.client && !state.selectedReceiver
      && !Object.keys(validateReceiver(endpoint, { requireCode: false })).length) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    checkingTrustedAddress = true;
    syncSendControls();
    try {
      await trustedUI.refresh();
      const info = await trustedUI.client.identify(endpoint, controller.signal);
      const peer = trustedUI.find(info.id);
      if (peer?.key === info.key) trusted = peer;
    } catch { /* An offline or older receiver can still use the manual PIN flow. */ }
    finally { clearTimeout(timeout); checkingTrustedAddress = false; syncSendControls(); }
    const current = endpointFromFields();
    if (current.ip !== endpoint.ip || current.port !== endpoint.port || current.code !== endpoint.code
        || updating || hotspotUI.busy() || !state.files.length) return;
  }
  if (trusted) {
    endpoint.trusted = { id: trusted.id, connect: (signal) => trustedUI.client.connect(endpoint, trusted, signal) };
  }
  state.validationErrors = validateReceiver(endpoint, { requireCode: !trusted });
  state.sendError = "";
  renderSendErrors(true);
  if (Object.keys(state.validationErrors).length || !state.files.length) return;

  const queue = [...state.files];
  restoreSendFocus = false;
  const result = await sender.send(queue, endpoint);
  if (!result) return;
  const { cancelled, complete, sent, failed, error, paused } = result;
  if (paused) {
    state.files = state.files.filter((file) => {
      if (queuedFileStates.get(file)?.kind !== "sent") return true;
      file.release?.();
      return false;
    });
    renderFiles();
  }
  if (cancelled) {
    for (const file of queue) {
      const previous = queuedFileStates.get(file);
      if (!previous || previous.kind !== "sent") updateQueuedFile(file, { ...previous, kind: "cancelled" });
    }
  }
  state.sendError = error;
  renderSendErrors(Boolean(state.sendError));
  showToast(complete ? `${sent} ${sent === 1 ? "file" : "files"} sent` : cancelled ? "Transfer cancelled. Completed files were kept." : state.sendError || `${failed} files failed`);
  if (restoreSendFocus && state.activeView === "send") els.sendFiles.focus({ preventScroll: true });
}

async function copyText(text, label) {
  if (!text || text === "--") return;
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(String(text));
    } else {
      const previousFocus = document.activeElement;
      const field = document.createElement("textarea");
      field.value = String(text);
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.append(field);
      field.select();
      const copied = document.execCommand("copy");
      field.remove();
      if (previousFocus) previousFocus.focus({ preventScroll: true });
      if (!copied) throw new Error("Clipboard access is unavailable");
    }
    showToast(`${label} copied`);
  } catch {
    showToast(`Could not copy ${label.toLowerCase()}. You can select the value and copy it manually.`);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
    return entities[char];
  });
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function bindEvents() {
  els.cancelSend.addEventListener("click", () => sender.cancel());
  els.cancelReceive.addEventListener("click", () => cancelIncoming());
  document.querySelector(".skip-link").addEventListener("click", (event) => {
    event.preventDefault();
    els.mainContent.focus({ preventScroll: true });
  });
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      setView(button.dataset.mode);
    });
  });
  els.backHome.addEventListener("click", () => {
    if (state.activeView !== "home" && window.history.state && window.history.state.depth > 0) {
      window.history.back();
      return;
    }
    setView("home", { replaceHistory: true });
  });

  window.addEventListener("popstate", (event) => {
    const nextView = event.state && event.state.view ? event.state.view : viewFromLocation();
    setView(nextView, { updateHistory: false });
  });
  window.addEventListener("hashchange", () => {
    if (!/^#(home|send|receive|settings)$/.test(window.location.hash)) return;
    const view = viewFromLocation();
    if (state.activeView !== view) setView(view, { updateHistory: false });
  });

  els.fileInput.addEventListener("change", (event) => {
    addFiles(event.target.files);
    els.fileInput.value = "";
  });
  els.clearFiles.addEventListener("click", () => {
    state.files.forEach((file) => file.release?.());
    state.files = [];
    els.fileInput.value = "";
    renderFiles();
    resetTransferMonitor();
  });
  els.sendFiles.addEventListener("click", sendSelectedFiles);
  els.pairDevice.addEventListener("click", () => {
    const endpoint = endpointFromFields();
    state.validationErrors = validateReceiver(endpoint);
    state.sendError = "";
    renderSendErrors(true);
    if (!Object.keys(state.validationErrors).length) void trustedUI.pair(endpoint);
  });
  els.refreshReceivers.addEventListener("click", () => receiverDiscovery.refresh());
  for (const input of [els.peerIp, els.peerPort]) {
    input.addEventListener("input", () => {
      if (state.selectedReceiver) els.peerCode.value = "";
      state.selectedReceiver = null;
      state.manuallyPairedReceiver = null;
      state.hotspotAddress = false;
      renderDiscoveredReceivers();
      syncSendControls();
    });
  }
  for (const input of [els.peerIp, els.peerPort, els.peerCode]) {
    input.addEventListener("input", () => {
      state.hotspotAddress = false;
      delete state.validationErrors[input.id];
      state.sendError = "";
      renderSendErrors();
    });
  }
  document.addEventListener("visibilitychange", updateDiscoveryActivity);
  window.addEventListener("pagehide", () => receiverDiscovery.stop());
  els.toggleReceiver.addEventListener("click", toggleReceiver);
  els.openInbox.addEventListener("click", openInbox);
  els.copyIp.addEventListener("click", () => copyText(els.sessionIp.textContent, "IP"));
  els.copyPort.addEventListener("click", () => copyText(els.sessionPort.textContent, "Port"));
  els.copyCode.addEventListener("click", () => copyText(els.sessionCode.textContent, "Code"));

  document.addEventListener("dragover", (event) => {
    const types = event.dataTransfer?.types ?? [];
    if (!types.includes("Files") && !types.includes("text/uri-list")) return;
    event.preventDefault();
    const ready = state.activeView === "send" && !sender.busy();
    els.dropZone.classList.toggle("dragging", ready);
    event.dataTransfer.dropEffect = ready ? "copy" : "none";
  });
  document.addEventListener("dragleave", (event) => {
    if (!event.relatedTarget) els.dropZone.classList.remove("dragging");
  });
  document.addEventListener("drop", (event) => {
    const { files, types } = event.dataTransfer ?? {};
    if (!files?.length && !types?.includes("text/uri-list")) return;
    event.preventDefault();
    els.dropZone.classList.remove("dragging");
    if (state.activeView === "send") addFiles(files);
  });
}

let resumeStorage;
try { resumeStorage = window.localStorage; } catch { /* Keep transfer state in memory. */ }
const sender = createSender({
  createId,
  resumeStorage,
  prepareBody: isAndroidRuntime ? readFileBody : undefined,
  addActivity,
  updateActivity,
  updateTransferMonitor,
  onStateChange() {
    if (sender.cancelling() && document.activeElement === els.cancelSend) restoreSendFocus = true;
    syncSendControls();
  }
});

const settingsUI = mountSettings({ root: els.settingsPanel, invoke, showToast });

const hotspotUI = mountHotspot({
  invoke,
  bridge: native.hotspotBridge,
  canChange: () => !updating && !sender.busy() && !state.activities.some((activity) => activity.kind === "receiving"),
  copy: copyText,
  connectionInfo: () => state.receiver ? { ip: selectedReceiverIp(), port: state.receiver.port, code: state.receiver.code } : null,
  connected: ({ ip, port, code }) => {
    state.selectedReceiver = null;
    state.manuallyPairedReceiver = null;
    state.hotspotAddress = true;
    els.peerIp.value = ip; els.peerPort.value = String(port); els.peerCode.value = code;
    state.validationErrors = {}; state.sendError = "";
    renderSendErrors(); syncSendControls();
  },
  onChange: () => syncSendControls(),
  refreshNetwork: async () => {
    state.selectedReceiver = null;
    state.manuallyPairedReceiver = null;
    state.hotspotAddress = false;
    for (const input of [els.peerIp, els.peerPort, els.peerCode]) input.value = "";
    state.validationErrors = {};
    renderSendErrors();
    await loadDeviceProfile();
    receiverDiscovery.stop();
    updateDiscoveryActivity();
    renderDiscoveredReceivers();
  },
  ensureReceiver: async (address) => {
    state.receiver = await invoke("start_receiver", { receiverName: native.deviceName() });
    await loadDeviceProfile();
    if (address && state.networkIps.some((candidate) => candidate.ip === address)) state.selectedIp = address;
    renderReceiver();
  }
});

const trustedUI = mountTrustedDevices({
  invoke,
  isReceiveView: () => state.activeView === "receive",
  canPoll: () => Boolean(state.receiver) || state.activeView === "send" || state.activeView === "settings",
  showToast,
  changed: () => { renderDiscoveredReceivers(); syncSendControls(); },
  paired: ({ ip, port }, peer) => {
    const current = endpointFromFields();
    if (!peer || current.ip !== ip || current.port !== port) return;
    state.manuallyPairedReceiver = { id: peer.id, ip, port };
    els.peerCode.value = "";
    syncSendControls();
  },
  deviceName: () => state.deviceName
});

const updateUI = mountUpdater({
  root: els.settingsPanel,
  updates: native.updates,
  notice: document.querySelector("#update-notice"),
  openSettings: () => {
    setView("settings");
    document.querySelector("#check-update").focus();
  },
  blocked: () => {
    if (sender.busy() || state.activities.some((activity) => activity.kind === "receiving")) {
      return "Finish your current transfer before updating.";
    }
    if (hotspotUI.busy() || hotspotUI.active()) {
      return "Disconnect the PulseDrop hotspot and reconnect to the internet before updating.";
    }
    if (state.receiver || changingReceiver) return "Stop receiving before checking for updates.";
    return null;
  },
  onBusy: (busy) => {
    updating = busy;
    els.toggleReceiver.disabled = busy;
    syncSendControls();
  }
});

bindEvents();
document.querySelectorAll("[data-app-version]").forEach((element) => { element.textContent = `v${version}`; });
setView(viewFromLocation(), { replaceHistory: true, focus: false });
renderFiles();
renderReceiver();
renderActivities();
hideBootScreen();
loadDeviceProfile();

function checkForUpdateNotice() {
  if (!document.hidden && navigator.onLine && !hotspotUI.busy() && !hotspotUI.active()) {
    void updateUI.checkAvailability();
  }
}
if (native.updates?.check) {
  document.addEventListener("visibilitychange", checkForUpdateNotice);
  window.addEventListener("online", checkForUpdateNotice);
  window.setInterval(checkForUpdateNotice, 5 * 60 * 1000);
  checkForUpdateNotice();
}

let stopReceiveEvents = native.subscribeReceiver(handleReceiveProgress, createId);
function subscribeFileDrops() {
  return native.subscribeFileDrops(
    (dragging) => els.dropZone.classList.toggle("dragging", dragging && state.activeView === "send" && !sender.busy()),
    (files, skipped) => {
      if (state.activeView !== "send" || sender.busy()) {
        files.forEach((file) => file.release());
        return;
      }
      addFiles(files);
      if (skipped) showToast("Some items could not be added. Drop individual, readable files.");
    }
  );
}
let stopFileDrops = subscribeFileDrops();
window.addEventListener("pagehide", (event) => {
  stopReceiveEvents();
  stopFileDrops();
  if (!event.persisted) state.files.forEach((file) => file.release?.());
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    stopReceiveEvents = native.subscribeReceiver(handleReceiveProgress, createId);
    stopFileDrops = subscribeFileDrops();
  }
});

mountGlass(els.appShell);
