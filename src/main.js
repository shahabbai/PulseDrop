import { createReceiverDiscovery } from "./discovery.js";
import { validateReceiver } from "./ui.js";
import { createReceiveProgress } from "./receive-progress.js";
import { readFileBody } from "./file-body.js";
import { version } from "../package.json";

const tauri = window.__TAURI__;
const invoke = tauri && tauri.core && tauri.core.invoke;
const listen = tauri && tauri.event && tauri.event.listen;
const opener = tauri && tauri.opener;

const bootScreen = document.querySelector("#boot-screen");
const isAndroidRuntime = /Android/i.test(window.navigator.userAgent || "");
const receiverCheckTimeoutMs = 7000;

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
state.sending = false;
state.discoveryScanning = false;
state.validationErrors = {};
state.sendError = "";
state.scrollPositions = {};
const queuedFileIds = new WeakMap();
const queuedFileStates = new WeakMap();
const incomingProgress = createReceiveProgress();
let sendSession = null;
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
  reduceMotion: document.querySelector("#reduce-motion"),
  homeScreen: document.querySelector("#home-screen"),
  workflowScreen: document.querySelector("#workflow-screen"),
  homeSend: document.querySelector("#home-send"),
  homeReceive: document.querySelector("#home-receive"),
  homeSettings: document.querySelector("#home-settings"),
  backHome: document.querySelector("#back-home"),
  workflowKicker: document.querySelector("#workflow-kicker"),
  workflowTitle: document.querySelector("#workflow-title"),
  sendPanel: document.querySelector("#send-panel"),
  receivePanel: document.querySelector("#receive-panel"),
  settingsPanel: document.querySelector("#settings-panel"),
  statusDot: document.querySelector("#status-dot"),
  deviceName: document.querySelector("#device-name"),
  devicePlatform: document.querySelector("#device-platform"),
  localIp: document.querySelector("#local-ip"),
  receiverState: document.querySelector("#receiver-state"),
  inboxCount: document.querySelector("#inbox-count"),
  peerIp: document.querySelector("#peer-ip"),
  peerPort: document.querySelector("#peer-port"),
  peerCode: document.querySelector("#peer-code"),
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
  settingsRefresh: document.querySelector("#settings-refresh"),
  settingsAppPath: document.querySelector("#settings-app-path"),
  networkCard: document.querySelector("#network-card"),
  networkStatus: document.querySelector("#network-status"),
  networkMessage: document.querySelector("#network-message"),
  networkDetail: document.querySelector("#network-detail"),
  fixNetwork: document.querySelector("#fix-network"),
  firewallCard: document.querySelector("#firewall-card"),
  firewallStatus: document.querySelector("#firewall-status"),
  firewallMessage: document.querySelector("#firewall-message"),
  firewallDetail: document.querySelector("#firewall-detail"),
  fixFirewall: document.querySelector("#fix-firewall"),
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
    els.refreshReceivers.disabled = scanning || state.sending;
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
    button.disabled = state.sending;
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
    name.textContent = peer.name;
    const address = document.createElement("small");
    address.textContent = `${peer.platform} · ${peer.ip}:${peer.port}`;
    info.append(name, address);
    const action = document.createElement("span");
    action.className = "receiver-choice-action";
    action.textContent = selected ? "Selected" : "Select";
    button.append(icon, info, action);
    button.addEventListener("click", () => {
      if (state.sending) return;
      if (!selected) els.peerCode.value = "";
      state.selectedReceiver = peer;
      els.peerIp.value = peer.ip;
      els.peerPort.value = String(peer.port);
      state.validationErrors = {};
      state.sendError = "";
      renderSendErrors();
      renderDiscoveredReceivers();
      els.peerCode.focus();
      showToast("Enter the code shown on the receiving device");
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
  const bridge = window.PulseDropAndroid;
  if (bridge && typeof bridge.setDiscoveryActive === "function") {
    try {
      bridge.setDiscoveryActive(!document.hidden && (browsing || Boolean(state.receiver)));
    } catch (error) {
      console.warn("Could not enable Android LAN discovery", error);
    }
  }
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatSpeed(bytesPerSecond) {
  return formatBytes(Math.max(0, bytesPerSecond || 0)) + "/s";
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
  els.workflowKicker.textContent = "Workspace";
  els.workflowTitle.textContent = { home: "Home", send: "Send files", receive: "Receive files", settings: "Settings" }[nextView];

  if (options.updateHistory !== false) {
    writeViewHistory(nextView, Boolean(options.replaceHistory));
  }

  if (nextView === "settings") loadWindowsDiagnostics();
  els.mainContent.scrollTop = state.scrollPositions[nextView] || 0;
  if (options.focus !== false) {
    const heading = document.querySelector(isHome ? "#home-title" : `#${nextView}-title`);
    heading.focus({ preventScroll: true });
  }
}

function syncSendControls() {
  const focusWasSend = document.activeElement === els.sendFiles;
  const focusWasCancel = document.activeElement === els.cancelSend;
  els.cancelSend.hidden = !state.sending;
  els.sendFiles.hidden = state.sending;
  els.cancelSend.disabled = Boolean(sendSession?.cancelRequested);
  els.cancelSend.textContent = sendSession?.cancelRequested ? "Cancelling…" : "Cancel transfer";
  els.sendFiles.disabled = state.sending || state.files.length === 0;
  if (state.sending && focusWasSend && !els.cancelSend.disabled) els.cancelSend.focus({ preventScroll: true });
  if (!state.sending && focusWasCancel) els.sendFiles.focus({ preventScroll: true });
  els.clearFiles.disabled = state.sending || state.files.length === 0;
  els.fileInput.disabled = state.sending;
  for (const input of [els.peerIp, els.peerPort, els.peerCode]) input.disabled = state.sending;
  els.refreshReceivers.disabled = !invoke || state.sending || state.discoveryScanning;
  els.sendFiles.setAttribute("aria-busy", String(state.sending));
  els.sendFiles.querySelector("span").textContent = state.sending ? "Sending…" : "Send files";
  els.sendHint.textContent = state.sending ? "Keep both devices open until the transfer finishes."
    : state.files.length ? "Choose a receiver and enter its pairing code." : "Add files and choose a receiver to get started.";
  document.querySelectorAll(".remove-file, .receiver-choice").forEach((button) => { button.disabled = state.sending; });
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
      <button class="remove-file" type="button" title="Remove ${escapeAttr(file.name)}" aria-label="Remove ${escapeAttr(file.name)}" ${state.sending ? "disabled" : ""}>
        <svg class="icon" aria-hidden="true"><use href="#icon-close"></use></svg>
      </button>
    `;
    row.querySelector("button").addEventListener("click", () => {
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
  els.receiverStateDescription.textContent = active ? "Select this device on your sender, then enter the pairing code below." : "Start receiving to make this device visible on your network.";
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
  state.activities = state.activities.filter((item) => ["receiving", "sending"].includes(item.kind) || recent++ < 12);
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
  els.receiveLabel.textContent = summary.kind === "receiving" ? "Receiving" : summary.kind === "received" ? "File received" : summary.kind === "cancelled" ? "Transfer cancelled" : "Transfer interrupted";
  els.receivePercent.textContent = `${Math.round(summary.progress)}%`;
  els.receiveProgress.setAttribute("aria-valuenow", String(Math.round(summary.progress)));
  els.receiveFill.style.width = `${summary.progress}%`;
  els.receiveBytes.textContent = `${formatBytes(summary.received)} of ${formatBytes(summary.size)}`;
  els.receiveSpeed.textContent = summary.kind === "receiving" ? formatSpeed(summary.speed)
    : summary.kind === "received" ? "Saved to Inbox" : summary.kind === "cancelled" ? "Incomplete file removed" : "Ask the sender to retry";
  const announcement = summary.kind === "receiving" ? `Receiving ${summary.activeCount} ${summary.activeCount === 1 ? "file" : "files"}.`
    : summary.kind === "received" ? "File received and saved to Inbox." : summary.kind === "cancelled" ? "Incoming transfer cancelled. Incomplete file removed." : "An incoming transfer was interrupted.";
  if (els.receiveAnnouncement.textContent !== announcement) els.receiveAnnouncement.textContent = announcement;
}

async function cancelIncoming(transferId = null) {
  const ids = state.activities.filter((item) => item.direction === "receive" && item.kind === "receiving" && (!transferId || item.id === transferId)).map((item) => item.id);
  if (!ids.length) return;
  ids.forEach((id) => receiveCancellation.add(id));
  const active = state.activities.filter((item) => item.direction === "receive" && item.kind === "receiving");
  els.cancelReceive.disabled = active.every((item) => receiveCancellation.has(item.id));
  els.cancelReceive.textContent = els.cancelReceive.disabled ? "Cancelling…" : active.length > 1 ? "Cancel all incoming" : "Cancel file";
  renderActivities();
  try { await invoke("cancel_receive", { transferId }); }
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
    const canCancel = activity.direction === "receive" && activity.kind === "receiving";
    if (!canCancel && document.activeElement === button) document.querySelector("#receive-title").focus({ preventScroll: true });
    button.hidden = !canCancel;
    button.disabled = receiveCancellation.has(activity.id);
    button.textContent = button.disabled ? "Cancelling…" : "Cancel";
    button.setAttribute("aria-label", `Cancel receiving ${activity.name}`);
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
  if (state.sending) return;
  const incoming = Array.from(fileList || []);
  const existing = new Set(state.files.map((file) => `${file.name}-${file.size}-${file.lastModified}`));
  for (const file of incoming) {
    const key = `${file.name}-${file.size}-${file.lastModified}`;
    if (!existing.has(key)) {
      state.files.push(file);
      existing.add(key);
    }
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
    state.selectedIp = profile.primary_ip || (state.networkIps[0] && state.networkIps[0].ip) || null;
    els.statusDot.classList.toggle("online", Boolean(state.selectedIp));
    const bridge = window.PulseDropAndroid;
    els.deviceName.textContent = bridge && typeof bridge.deviceName === "function"
      ? bridge.deviceName() : profile.name;
    els.devicePlatform.textContent = `${profile.platform} ${profile.arch}`;
    els.localIp.textContent = state.selectedIp || "No network";
    els.localIp.title = state.networkIps.map((address) => address.label || address.ip).join("\n");
    renderNetworkChoices();
  } catch (error) {
    els.deviceName.textContent = "Device unavailable";
    els.localIp.textContent = "Network unavailable";
    showToast(String(error));
  }
}

async function toggleReceiver() {
  if (!invoke) {
    showToast("Run inside Tauri to start receiving");
    return;
  }

  setBusy(els.toggleReceiver, true);
  try {
    if (state.receiver) {
      await invoke("stop_receiver");
      state.receiver = null;
      showToast("Receiver stopped");
    } else {
      const preferredIp = state.selectedIp;
      const bridge = window.PulseDropAndroid;
      const receiverName = bridge && typeof bridge.deviceName === "function" ? bridge.deviceName() : null;
      state.receiver = await invoke("start_receiver", { receiverName });
      state.selectedIp = preferredIp || state.receiver.ip_address || selectedReceiverIp();
      showToast("Receiver is online");
    }
    renderReceiver();
  } catch (error) {
    showToast(String(error));
    els.receiverDiscoveryStatus.hidden = false;
    els.receiverDiscoveryStatus.dataset.error = "true";
    els.receiverDiscoveryStatus.textContent = `Could not change the receiver state: ${String(error.message || error)}. Try again or check your network.`;
  } finally {
    setBusy(els.toggleReceiver, false);
  }
}

async function openInbox() {
  if (!state.receiver || !state.receiver.inbox_dir) {
    showToast("Start receiver first");
    return;
  }

  const androidBridge = window.PulseDropAndroid;
  const looksLikeAndroidPath = String(state.receiver.inbox_dir || "").startsWith("/storage/emulated/");

  try {
    if (androidBridge && typeof androidBridge.openInbox === "function") {
      androidBridge.openInbox();
      showToast("Opening Android Downloads");
      return;
    }

    if (isAndroidRuntime || looksLikeAndroidPath) {
      showToast("Open Downloads, then PulseDrop/Inbox");
      return;
    }

    if (invoke) {
      await invoke("open_inbox");
    } else if (opener && opener.openPath) {
      await opener.openPath(state.receiver.inbox_dir);
    }
  } catch (error) {
    showToast(String(error));
  }
}

function receiverUrl(endpoint, path) {
  const url = new URL(`http://${endpoint.ip}:${endpoint.port}${path}`);
  url.searchParams.set("code", endpoint.code);
  return url;
}

function receiverUnavailableMessage(endpoint) {
  return `Could not reach ${endpoint.ip}:${endpoint.port}. Keep the receiver open, check its address, and connect both devices to the same local network. If it stays unavailable, check its firewall or VPN settings.`;
}

function cancelledError(session) {
  const error = new Error(session.reason || "Transfer cancelled");
  error.name = "TransferCancelledError";
  return error;
}

function checkCancellation(session) {
  if (session.cancelRequested || session.controller.signal.aborted) throw cancelledError(session);
}

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
    const payload = response.ok ? await response.json() : null;
    return { ok: response.ok, phase: payload?.phase };
  }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

async function cancelSending(byReceiver = false) {
  const session = sendSession;
  if (!session || session.cancelRequested) return;
  session.cancelRequested = true;
  session.restoreSendFocus = document.activeElement === els.cancelSend;
  session.reason = byReceiver ? "Cancelled by receiving device" : "Transfer cancelled";
  syncSendControls();
  session.cancelPromise = (async () => {
    try {
      if (!byReceiver && session.supportsCancellation && session.activeId) {
        const id = session.activeId;
        const response = await transferRequest(session.endpoint, "/cancel", id, "POST");
        if (response.ok && response.phase === "completed") session.savedTransferId = id;
      }
    } catch { /* A broken connection still needs a local abort. */ }
    finally { session.controller.abort(); }
  })();
  await session.cancelPromise;
}

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
  } catch (error) {
    checkCancellation(session);
    if (error.name === "AbortError" || error instanceof TypeError) throw new Error(receiverUnavailableMessage(endpoint));
    throw error;
  } finally { clearTimeout(timeout); session.controller.signal.removeEventListener("abort", abort); }
}

function uploadTimeoutMs(fileSize) {
  const slowNetworkBudget = Math.ceil((fileSize || 0) / (128 * 1024)) * 1000;
  return Math.min(30 * 60 * 1000, Math.max(2 * 60 * 1000, slowNetworkBudget + 30 * 1000));
}

async function uploadBodyForFile(file, activityId, session) {
  checkCancellation(session);
  if (!isAndroidRuntime) return file;
  updateActivity(activityId, { label: "Preparing file", progress: 0 });
  try { return await readFileBody(file, session.controller.signal); }
  catch (error) { checkCancellation(session); throw error; }
}

async function sendFile(file, endpoint, activityId, progressContext, session) {
  const uploadBody = await uploadBodyForFile(file, activityId, session);
  checkCancellation(session);

  return new Promise((resolve, reject) => {
    const url = receiverUrl(endpoint, "/upload");
    const transferId = session.activeId;
    url.searchParams.set("name", file.name);
    url.searchParams.set("transfer_id", transferId);

    const xhr = new XMLHttpRequest();
    const startedAt = performance.now();
    let settled = false;
    let checkingFailure = false;
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
        if (!settled && session.activeId === transferId && status?.phase === "cancelled") await cancelSending(true);
      } catch { /* The upload itself reports connection errors. */ }
      if (!settled && !signal.aborted) pollTimer = setTimeout(poll, 350);
    }
    let latestLoaded = 0;
    let lastLoaded = 0;
    let lastTime = startedAt;
    let lastSpeed = 0;

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
            await cancelSending(true);
          }
        }
      } catch { /* Report the original error when status cannot be reached. */ }
      fail(session.cancelRequested ? session.reason : message);
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
    xhr.send(uploadBody);
    if (session.supportsCancellation) pollTimer = setTimeout(poll, 350);
  });
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
  if (state.sending) return;
  const endpoint = { ip: els.peerIp.value.trim(), port: Number(els.peerPort.value.trim()), code: els.peerCode.value.trim() };
  state.validationErrors = validateReceiver(endpoint);
  state.sendError = "";
  renderSendErrors(true);
  if (Object.keys(state.validationErrors).length || !state.files.length) return;
  const queue = Array.from(state.files);
  const totalBytes = queue.reduce((sum, file) => sum + file.size, 0);
  const session = { controller: new AbortController(), endpoint, cancelRequested: false, activeId: null, loaded: 0 };
  sendSession = session;
  state.sending = true;
  syncSendControls();
  let sent = 0, failed = 0, completedBytes = 0;
  updateTransferMonitor({ name: "Checking receiver", totalBytes, percent: 0, active: true });
  try {
    await checkReceiver(endpoint, session);
    for (const file of queue) {
      checkCancellation(session);
      const activityId = createId();
      session.activeId = createId();
      session.loaded = completedBytes;
      addActivity({ id: activityId, file, name: file.name, label: "Sending", kind: "sending", direction: "send", progress: 0, speed: 0 });
      updateTransferMonitor({ name: file.name, totalLoaded: completedBytes, totalBytes, percent: totalBytes ? completedBytes / totalBytes * 100 : 0, speed: 0, active: true });
      try {
        await sendFile(file, endpoint, activityId, { completedBytes, totalBytes }, session);
        sent += 1;
        completedBytes += file.size;
      } catch (error) {
        const cancelled = error.name === "TransferCancelledError" || session.cancelRequested;
        updateActivity(activityId, { kind: cancelled ? "cancelled" : "failed", label: error.message, speed: 0 });
        if (cancelled) throw error;
        failed += 1;
        state.sendError = error.message;
      } finally { session.activeId = null; }
    }
  } catch (error) {
    if (error.name !== "TransferCancelledError" && !session.cancelRequested) {
      failed += 1;
      state.sendError = String(error.message || error);
    }
  } finally {
    if (session.cancelPromise) await session.cancelPromise;
    session.controller.abort();
    const cancelled = session.cancelRequested && sent < queue.length;
    if (cancelled) {
      for (const file of queue) {
        const previous = queuedFileStates.get(file);
        if (!previous || previous.kind !== "sent") updateQueuedFile(file, { ...previous, kind: "cancelled" });
      }
    }
    state.sending = false;
    sendSession = null;
    syncSendControls();
    renderSendErrors(Boolean(state.sendError));
    const complete = sent === queue.length;
    updateTransferMonitor({
      name: complete ? "Transfer complete" : cancelled ? session.reason || "Transfer cancelled" : "Transfer failed",
      totalLoaded: complete ? totalBytes : Math.min(totalBytes, session.loaded || completedBytes), totalBytes,
      percent: complete ? 100 : Math.min(99, totalBytes ? (session.loaded || completedBytes) / totalBytes * 100 : 0),
      speed: 0, kind: complete ? "complete" : cancelled ? "cancelled" : "failed", active: false
    });
    showToast(complete ? `${sent} ${sent === 1 ? "file" : "files"} sent` : cancelled ? "Transfer cancelled. Completed files were kept." : state.sendError || `${failed} files failed`);
    if (session.restoreSendFocus && state.activeView === "send") els.sendFiles.focus({ preventScroll: true });
  }
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

function statusLabel(status) {
  switch ((status || "unknown").toLowerCase()) {
    case "ok":
      return "Good";
    case "warn":
      return "Needs fix";
    case "unsupported":
      return "Not applicable";
    default:
      return "Unknown";
  }
}

function renderDiagnostic(card, statusEl, messageEl, detailEl, fixButton, item) {
  if (!card) return;
  const diagnostic = item || {};
  const status = (diagnostic.status || "unknown").toLowerCase();
  card.dataset.status = status;
  statusEl.textContent = statusLabel(status);
  messageEl.textContent = diagnostic.message || "Could not read this check.";
  detailEl.textContent = diagnostic.detail || diagnostic.title || "No details available";
  fixButton.disabled = !diagnostic.can_fix;
}

function renderWindowsDiagnostics(diagnostics) {
  const data = diagnostics || {};
  if (els.settingsAppPath) {
    els.settingsAppPath.textContent = data.app_path || "Installed path unavailable on this platform";
    els.settingsAppPath.title = els.settingsAppPath.textContent;
  }
  renderDiagnostic(els.networkCard, els.networkStatus, els.networkMessage, els.networkDetail, els.fixNetwork, data.network);
  renderDiagnostic(els.firewallCard, els.firewallStatus, els.firewallMessage, els.firewallDetail, els.fixFirewall, data.firewall);
}

function renderDiagnosticsLoading() {
  renderWindowsDiagnostics({
    is_windows: true,
    app_path: "Checking...",
    network: {
      status: "unknown",
      message: "Checking Windows network mode...",
      detail: "Waiting for diagnostics",
      can_fix: false
    },
    firewall: {
      status: "unknown",
      message: "Checking inbound access for PulseDrop...",
      detail: "Waiting for diagnostics",
      can_fix: false
    }
  });
}

function renderDiagnosticsUnavailable(message) {
  renderWindowsDiagnostics({
    is_windows: false,
    app_path: "Windows receiver only",
    network: {
      status: "unsupported",
      message,
      detail: "Open Settings on the Windows PC app to change Public or Private mode.",
      can_fix: false
    },
    firewall: {
      status: "unsupported",
      message,
      detail: "Open Settings on the Windows PC app to add PulseDrop to Windows Firewall.",
      can_fix: false
    }
  });
}

async function loadWindowsDiagnostics() {
  if (!els.settingsPanel) return;
  renderDiagnosticsLoading();

  if (!invoke) {
    renderDiagnosticsUnavailable("Run inside PulseDrop to check Windows settings.");
    return;
  }

  try {
    const diagnostics = await invoke("windows_diagnostics");
    renderWindowsDiagnostics(diagnostics);
  } catch (error) {
    renderWindowsDiagnostics({
      is_windows: true,
      app_path: "Diagnostics failed",
      network: {
        status: "unknown",
        message: "PulseDrop could not check the network profile.",
        detail: String(error.message || error),
        can_fix: false
      },
      firewall: {
        status: "unknown",
        message: "PulseDrop could not check Windows Firewall.",
        detail: String(error.message || error),
        can_fix: false
      }
    });
  }
}

async function runWindowsFix(command, button) {
  if (!invoke) {
    showToast("Run inside PulseDrop to apply this fix");
    return;
  }

  const previousLabel = button.textContent;
  button.textContent = "Working";
  setBusy(button, true);
  showToast("Windows may ask for permission to apply this fix");

  try {
    await invoke(command);
    showToast("Fix finished. Refreshing checks...");
    await loadWindowsDiagnostics();
  } catch (error) {
    showToast(String(error.message || error));
  } finally {
    button.textContent = previousLabel;
    setBusy(button, false);
  }
}
function bindEvents() {
  els.cancelSend.addEventListener("click", () => cancelSending());
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
    state.files = [];
    els.fileInput.value = "";
    renderFiles();
    resetTransferMonitor();
  });
  els.sendFiles.addEventListener("click", sendSelectedFiles);
  els.refreshReceivers.addEventListener("click", () => receiverDiscovery.refresh());
  for (const input of [els.peerIp, els.peerPort]) {
    input.addEventListener("input", () => {
      if (state.selectedReceiver) els.peerCode.value = "";
      state.selectedReceiver = null;
      renderDiscoveredReceivers();
    });
  }
  for (const input of [els.peerIp, els.peerPort, els.peerCode]) {
    input.addEventListener("input", () => {
      delete state.validationErrors[input.id];
      state.sendError = "";
      renderSendErrors();
    });
  }
  els.reduceMotion.addEventListener("change", () => {
    document.documentElement.classList.toggle("reduce-motion", els.reduceMotion.checked);
    try { localStorage.setItem("pulsedrop.reduceMotion", String(els.reduceMotion.checked)); } catch { /* Unavailable storage must not block preferences. */ }
  });
  document.addEventListener("visibilitychange", updateDiscoveryActivity);
  window.addEventListener("pagehide", () => receiverDiscovery.stop());
  els.toggleReceiver.addEventListener("click", toggleReceiver);
  els.openInbox.addEventListener("click", openInbox);
  els.copyIp.addEventListener("click", () => copyText(els.sessionIp.textContent, "IP"));
  els.copyPort.addEventListener("click", () => copyText(els.sessionPort.textContent, "Port"));
  els.copyCode.addEventListener("click", () => copyText(els.sessionCode.textContent, "Code"));
  if (els.settingsRefresh) els.settingsRefresh.addEventListener("click", loadWindowsDiagnostics);
  if (els.fixNetwork) els.fixNetwork.addEventListener("click", () => runWindowsFix("fix_windows_network_profile", els.fixNetwork));
  if (els.fixFirewall) els.fixFirewall.addEventListener("click", () => runWindowsFix("fix_windows_firewall", els.fixFirewall));

  ["dragenter", "dragover"].forEach((name) => {
    els.dropZone.addEventListener(name, (event) => {
      event.preventDefault();
      els.dropZone.classList.add("dragging");
    });
  });

  ["dragleave", "drop"].forEach((name) => {
    els.dropZone.addEventListener(name, (event) => {
      event.preventDefault();
      els.dropZone.classList.remove("dragging");
    });
  });

  els.dropZone.addEventListener("drop", (event) => addFiles(event.dataTransfer.files));
}

async function bindTauriEvents() {
  if (!listen) return;

  await listen("file-receive-progress", (event) => handleReceiveProgress(event.payload));
  await listen("file-received", (event) => {
    const payload = event.payload;
    handleReceiveProgress({
      ...payload,
      transfer_id: payload.transfer_id || createId(),
      phase: "completed",
      received: payload.size
    });
  });
}

bindEvents();
document.querySelectorAll("[data-app-version]").forEach((element) => { element.textContent = `v${version}`; });
try { els.reduceMotion.checked = localStorage.getItem("pulsedrop.reduceMotion") === "true"; } catch { /* Use the system motion preference when storage is unavailable. */ }
document.documentElement.classList.toggle("reduce-motion", els.reduceMotion.checked);
setView(viewFromLocation(), { replaceHistory: true, focus: false });
renderFiles();
renderReceiver();
renderActivities();
hideBootScreen();
loadDeviceProfile();
bindTauriEvents();



