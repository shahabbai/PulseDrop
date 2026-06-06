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

function createId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return String(Date.now()) + "-" + String(Math.random());
}

const els = {
  appShell: document.querySelector("#app-shell"),
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
  els.transferMonitor.classList.toggle("is-complete", details.kind === "complete" || percent >= 100);
  els.transferMonitor.classList.toggle("is-failed", details.kind === "failed");
  els.transferName.textContent = details.name || "Transfer";
  els.transferPercent.textContent = Math.round(percent) + "%";
  els.transferFill.style.width = percent + "%";
  els.transferBytes.textContent = totalBytes
    ? formatBytes(loadedBytes) + " of " + formatBytes(totalBytes)
    : formatBytes(loadedBytes);
  els.transferSpeed.textContent = details.speed ? formatSpeed(details.speed) : "0 B/s";
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => els.toast.classList.remove("show"), 2600);
}

function setBusy(button, busy) {
  button.disabled = busy;
  if (button.dataset.label === undefined) {
    button.dataset.label = button.textContent.trim();
  }
}

function normalizeView(mode) {
  return mode === "send" || mode === "receive" || mode === "settings" ? mode : "home";
}

function viewFromLocation() {
  return normalizeView(window.location.hash.replace("#", ""));
}

function writeViewHistory(view, replaceHistory) {
  const hash = view === "home" ? "#home" : `#${view}`;
  const stateValue = { view };

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
  state.activeView = nextView;

  els.appShell.dataset.view = nextView;
  els.homeScreen.hidden = !isHome;
  els.workflowScreen.hidden = isHome;
  els.sendPanel.hidden = nextView !== "send";
  els.receivePanel.hidden = nextView !== "receive";
  els.settingsPanel.hidden = nextView !== "settings";

  if (options.updateHistory !== false) {
    writeViewHistory(nextView, Boolean(options.replaceHistory));
  }

  if (!isHome) {
    const titles = {
      send: "Send Files",
      receive: "Receive Files",
      settings: "Settings"
    };
    els.workflowKicker.textContent = nextView === "settings" ? "System" : nextView;
    els.workflowTitle.textContent = titles[nextView] || "PulseDrop";
    if (nextView === "settings") loadWindowsDiagnostics();
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  }
}

function bindModeButtonGlow(button) {
  if (!button) return;

  const resetGlow = () => {
    button.style.setProperty("--mx", "50%");
    button.style.setProperty("--my", "50%");
  };

  button.addEventListener("pointermove", (event) => {
    const rect = button.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    button.style.setProperty("--mx", `${Math.max(0, Math.min(100, x))}%`);
    button.style.setProperty("--my", `${Math.max(0, Math.min(100, y))}%`);
  });

  button.addEventListener("pointerleave", resetGlow);
  resetGlow();
}

function renderFiles() {
  els.fileList.innerHTML = "";
  const total = state.files.reduce((sum, file) => sum + file.size, 0);
  els.queueTotal.textContent = formatBytes(total);

  if (state.files.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-list";
    empty.textContent = "No files selected";
    els.fileList.append(empty);
    return;
  }

  state.files.forEach((file, index) => {
    const row = document.createElement("li");
    row.className = "file-row";
    row.innerHTML = `
      <div>
        <strong title="${escapeAttr(file.name)}">${escapeHtml(file.name)}</strong>
        <span>${formatBytes(file.size)}</span>
      </div>
      <button class="remove-file" type="button" title="Remove file" aria-label="Remove file">
        <svg class="icon"><use href="#icon-trash"></use></svg>
      </button>
    `;
    row.querySelector("button").addEventListener("click", () => {
      state.files.splice(index, 1);
      renderFiles();
    });
    els.fileList.append(row);
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
  els.sessionIp.textContent = receiverIp || "--";
  els.sessionPort.textContent = active && state.receiver.port ? state.receiver.port : "--";
  els.sessionCode.textContent = active && state.receiver.code ? state.receiver.code : "--";
  els.inboxPath.textContent = active && state.receiver.inbox_dir ? state.receiver.inbox_dir : "Not started";
  els.toggleReceiver.title = active ? "Stop receiver" : "Start receiver";
  els.toggleReceiver.setAttribute("aria-label", els.toggleReceiver.title);
  els.toggleReceiver.classList.toggle("is-live", active);
  els.toggleReceiver.innerHTML = active
    ? '<svg class="icon"><use href="#icon-stop"></use></svg>'
    : '<svg class="icon"><use href="#icon-play"></use></svg>';
  renderNetworkChoices();
}

function addActivity(activity) {
  state.activities.unshift({
    id: createId(),
    progress: 0,
    ...activity
  });
  state.activities = state.activities.slice(0, 12);
  renderActivities();
}

function updateActivity(id, patch) {
  const item = state.activities.find((activity) => activity.id === id);
  if (!item) return;
  Object.assign(item, patch);
  renderActivities();
}

function renderActivities() {
  els.activityList.innerHTML = "";
  els.activityTotal.textContent = state.activities.length ? state.activities.length + " recent" : "Idle";
  els.inboxCount.textContent = state.inboxCount + " " + (state.inboxCount === 1 ? "file" : "files");

  if (state.activities.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-list";
    empty.textContent = "No transfers yet";
    els.activityList.append(empty);
    return;
  }

  state.activities.forEach((activity) => {
    const progress = clampPercent(activity.progress || 0);
    const row = document.createElement("li");
    row.className = "activity-row " + (activity.kind || "");

    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.title = activity.name || "";
    name.textContent = activity.name || "";
    const label = document.createElement("span");
    label.textContent = activity.label || "";
    info.append(name, label);

    const meter = document.createElement("div");
    meter.className = "activity-meter";
    const percent = document.createElement("span");
    percent.className = "activity-percent";
    percent.textContent = Math.round(progress) + "%";
    meter.append(percent);
    if (activity.speed) {
      const speed = document.createElement("span");
      speed.className = "activity-speed";
      speed.textContent = formatSpeed(activity.speed);
      meter.append(speed);
    }

    const track = document.createElement("div");
    track.className = "progress-track";
    const fill = document.createElement("div");
    fill.className = "progress-fill";
    fill.style.width = progress + "%";
    track.append(fill);

    row.append(info, meter, track);
    els.activityList.append(row);
  });
}

function addFiles(fileList) {
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
    els.statusDot.classList.add("online");
    els.deviceName.textContent = profile.name;
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
      state.receiver = await invoke("start_receiver");
      state.selectedIp = preferredIp || state.receiver.ip_address || selectedReceiverIp();
      if (!els.peerIp.value) els.peerIp.value = state.selectedIp || "";
      if (!els.peerPort.value) els.peerPort.value = state.receiver.port || "";
      showToast("Receiver is online");
    }
    renderReceiver();
  } catch (error) {
    showToast(String(error));
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
  return `Could not reach ${endpoint.ip}:${endpoint.port}. Check the PC IP, keep both devices on the same Wi-Fi, and allow PulseDrop through Windows Firewall on Private networks.`;
}

async function checkReceiver(endpoint) {
  const url = receiverUrl(endpoint, "/health");
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeout = window.setTimeout(() => controller && controller.abort(), receiverCheckTimeoutMs);

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      cache: "no-store",
      signal: controller ? controller.signal : undefined
    });

    if (response.status === 404 || response.status === 405) {
      return;
    }

    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || `Receiver returned HTTP ${response.status}`);
    }
  } catch (error) {
    if (error.name === "AbortError" || error instanceof TypeError || /failed to fetch|networkerror/i.test(error.message || "")) {
      throw new Error(receiverUnavailableMessage(endpoint));
    }
    throw new Error(error.message || receiverUnavailableMessage(endpoint));
  } finally {
    window.clearTimeout(timeout);
  }
}

function uploadTimeoutMs(fileSize) {
  const slowNetworkBudget = Math.ceil((fileSize || 0) / (128 * 1024)) * 1000;
  return Math.min(30 * 60 * 1000, Math.max(2 * 60 * 1000, slowNetworkBudget + 30 * 1000));
}

async function uploadBodyForFile(file, activityId) {
  if (!isAndroidRuntime) return file;

  updateActivity(activityId, {
    label: "Preparing file",
    progress: 1
  });

  try {
    return await file.arrayBuffer();
  } catch (error) {
    throw new Error(`Could not read selected file: ${error.message || error}`);
  }
}

async function sendFile(file, endpoint, activityId, progressContext = {}) {
  const uploadBody = await uploadBodyForFile(file, activityId);

  return new Promise((resolve, reject) => {
    const url = receiverUrl(endpoint, "/upload");
    url.searchParams.set("name", file.name);

    const xhr = new XMLHttpRequest();
    const startedAt = performance.now();
    let settled = false;
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

    function fail(message) {
      if (settled) return;
      settled = true;
      updateActivity(activityId, {
        label: message,
        kind: "failed",
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
        kind: "failed",
        active: false
      });
      reject(new Error(message));
    }

    xhr.open("POST", url.toString(), true);
    xhr.timeout = uploadTimeoutMs(file.size);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      const total = event.lengthComputable ? event.total : file.size;
      publishProgress(event.loaded, total);
    };
    xhr.onload = () => {
      if (settled) return;
      settled = true;
      if (xhr.status >= 200 && xhr.status < 300) {
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
      } else {
        const message = xhr.responseText || "Upload failed with HTTP " + xhr.status;
        fail(message);
      }
    };
    xhr.onerror = () => fail(receiverUnavailableMessage(endpoint));
    xhr.onabort = () => fail("Transfer was cancelled");
    xhr.ontimeout = () => fail("Transfer timed out before the receiver answered");
    publishProgress(0, file.size, progressContext.totalBytes ? ((progressContext.completedBytes || 0) / progressContext.totalBytes) * 100 : 0);
    xhr.send(uploadBody);
  });
}

async function sendSelectedFiles() {
  const endpoint = {
    ip: els.peerIp.value.trim(),
    port: Number(els.peerPort.value.trim()),
    code: els.peerCode.value.trim()
  };

  if (!endpoint.ip || !endpoint.port || !endpoint.code) {
    showToast("Enter peer IP, port, and code");
    return;
  }

  if (state.files.length === 0) {
    showToast("Select at least one file");
    return;
  }

  const queue = Array.from(state.files);
  const totalBytes = queue.reduce((sum, file) => sum + file.size, 0);
  let completedBytes = 0;
  let sent = 0;
  let failed = 0;

  setBusy(els.sendFiles, true);
  updateTransferMonitor({
    name: "Checking receiver",
    totalLoaded: 0,
    totalBytes,
    percent: 0,
    speed: 0,
    active: true
  });

  try {
    showToast("Checking receiver...");
    await checkReceiver(endpoint);
  } catch (error) {
    updateTransferMonitor({
      name: "Receiver unavailable",
      totalLoaded: 0,
      totalBytes,
      percent: 0,
      speed: 0,
      kind: "failed",
      active: false
    });
    showToast(String(error.message || error));
    setBusy(els.sendFiles, false);
    return;
  }

  for (const file of queue) {
    const activityId = createId();
    addActivity({
      id: activityId,
      name: file.name,
      label: "Sending",
      kind: "sending",
      progress: 0,
      speed: 0
    });
    updateTransferMonitor({
      name: file.name,
      totalLoaded: completedBytes,
      totalBytes,
      percent: totalBytes ? (completedBytes / totalBytes) * 100 : 0,
      speed: 0,
      active: true
    });

    try {
      await sendFile(file, endpoint, activityId, { completedBytes, totalBytes });
      sent += 1;
      completedBytes += file.size;
      updateTransferMonitor({
        name: file.name,
        loaded: file.size,
        total: file.size,
        totalLoaded: completedBytes,
        totalBytes,
        percent: totalBytes ? (completedBytes / totalBytes) * 100 : 100,
        speed: 0,
        active: completedBytes < totalBytes
      });
    } catch (error) {
      failed += 1;
      updateActivity(activityId, {
        label: String(error.message || error),
        kind: "failed",
        speed: 0
      });
      showToast(String(error.message || error));
    }
  }

  setBusy(els.sendFiles, false);
  if (sent > 0) {
    const complete = failed === 0;
    updateTransferMonitor({
      name: complete ? "Transfer complete" : sent + " sent, " + failed + " failed",
      totalLoaded: completedBytes,
      totalBytes,
      percent: totalBytes ? (completedBytes / totalBytes) * 100 : 100,
      speed: 0,
      kind: complete ? "complete" : "failed",
      active: false
    });
    showToast(sent + " " + (sent === 1 ? "file" : "files") + " sent");
  } else {
    updateTransferMonitor({
      name: "Transfer failed",
      totalLoaded: completedBytes,
      totalBytes,
      percent: totalBytes ? (completedBytes / totalBytes) * 100 : 0,
      speed: 0,
      kind: "failed",
      active: false
    });
  }
}

function copyText(text, label) {
  if (!text || text === "--") return;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(String(text));
  }
  showToast(`${label} copied`);
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
      return "PC only";
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
    els.settingsAppPath.textContent = data.app_path || (data.is_windows ? "Installed path unavailable" : "Windows receiver only");
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
  [els.homeSend, els.homeReceive].forEach((button) => {
    if (!button) return;
    bindModeButtonGlow(button);
    button.addEventListener("click", () => setView(button.dataset.mode));
  });
  if (els.homeSettings) {
    els.homeSettings.addEventListener("click", () => setView("settings"));
  }
  els.backHome.addEventListener("click", () => {
    if (state.activeView !== "home" && window.history.state && window.history.state.view === state.activeView) {
      window.history.back();
      return;
    }
    setView("home", { replaceHistory: true });
  });

  window.addEventListener("popstate", (event) => {
    const nextView = event.state && event.state.view ? event.state.view : viewFromLocation();
    setView(nextView, { updateHistory: false });
  });

  els.fileInput.addEventListener("change", (event) => addFiles(event.target.files));
  els.clearFiles.addEventListener("click", () => {
    state.files = [];
    els.fileInput.value = "";
    renderFiles();
    resetTransferMonitor();
  });
  els.sendFiles.addEventListener("click", sendSelectedFiles);
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

  await listen("file-received", (event) => {
    const payload = event.payload;
    state.inboxCount += 1;
    addActivity({
      name: payload.name,
      label: `Received ${formatBytes(payload.size)}`,
      kind: "received",
      progress: 100
    });
  });
}

bindEvents();
setView("home", { replaceHistory: true });
renderFiles();
renderReceiver();
renderActivities();
hideBootScreen();
loadDeviceProfile();
bindTauriEvents();



