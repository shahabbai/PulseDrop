/** @typedef {import("./native-types").UpdateStatus} UpdateStatus */
/** @typedef {import("./native-types").NativeUpdates} NativeUpdates */

const CHECK_INTERVAL = 60 * 60 * 1000;
const RETRY_INTERVAL = 5 * 60 * 1000;
const DISMISSED_VERSION = "pulsedrop.dismissedUpdateVersion";

/** @param {UpdateStatus} state */
function statusMessage(state) {
  switch (state.phase) {
    case "available": return `PulseDrop ${state.version} is available.`;
    case "checking": return "Checking GitHub for updates…";
    case "downloading": return `Downloading PulseDrop ${state.version}…`;
    case "installing": return `Installing PulseDrop ${state.version}. Follow any system prompts.`;
    case "current": return "You’re running the latest version.";
    case "permission": return "Allow PulseDrop to install apps in Android Settings and return here to continue.";
    case "ready": return state.message || "Confirm the update in Android’s installer. If you closed it, select Install update.";
    case "error": return state.message || "Could not update PulseDrop. Try again.";
    default: return "Download and install the latest version from GitHub.";
  }
}

/**
 * @param {{ root: HTMLElement, updates?: NativeUpdates, blocked: () => string | null,
 *  onBusy: (busy: boolean) => void, notice?: HTMLElement, openSettings?: () => void,
 *  wait?: () => Promise<void> }} options
 */
export function mountUpdater({ root, updates, blocked, onBusy, notice, openSettings,
  wait = () => new Promise((resolve) => setTimeout(resolve, 350))
}) {
  const button = /** @type {HTMLButtonElement} */ (root.querySelector("#check-update"));
  const message = /** @type {HTMLElement} */ (root.querySelector("#update-status"));
  const progress = /** @type {HTMLProgressElement} */ (root.querySelector("#update-progress"));
  const noticeText = notice?.querySelector("#update-notice-text");
  /** @type {UpdateStatus} */
  let state = { phase: "idle" };
  let busy = false;
  let pendingInstall = false;
  let checkingAvailability = false;
  let nextCheck = 0;
  let manualChecks = 0;
  /** @type {string | null} */
  let availableVersion = null;
  /** @type {string | null} */
  let dismissedVersion = null;
  try { dismissedVersion = root.ownerDocument?.defaultView?.localStorage.getItem(DISMISSED_VERSION) ?? null; }
  catch { /* The notice can still be dismissed for this session. */ }

  function renderNotice() {
    if (!notice || !noticeText) return;
    notice.hidden = busy || pendingInstall || !availableVersion || dismissedVersion === availableVersion;
    if (!notice.hidden) {
      const text = statusMessage({ phase: "available", version: availableVersion ?? undefined });
      if (noticeText.textContent !== text) noticeText.textContent = text;
    }
  }

  /** @param {UpdateStatus} next */
  function render(next) {
    state = next;
    if (next.phase === "current") availableVersion = null;
    pendingInstall = next.phase === "permission" || next.phase === "ready";
    const status = statusMessage(next);
    if (message.textContent !== status) message.textContent = status;
    progress.hidden = next.phase !== "downloading";
    if (!progress.hidden && next.total && next.received !== undefined) {
      progress.max = next.total;
      progress.value = Math.min(next.received, next.total);
    } else {
      progress.removeAttribute("value");
    }
    button.textContent = pendingInstall || availableVersion ? "Install update" : "Check for updates";
    renderNotice();
  }

  async function checkAvailability(now = Date.now()) {
    if (!updates?.check || busy || pendingInstall || checkingAvailability || now < nextCheck) return;
    checkingAvailability = true;
    const revision = manualChecks;
    try {
      const version = await updates.check();
      nextCheck = now + CHECK_INTERVAL;
      if (revision !== manualChecks) return;
      const previouslyAvailable = availableVersion;
      availableVersion = version;
      if (version) render({ phase: "available", version });
      else if (previouslyAvailable) render({ phase: "idle" });
    } catch { nextCheck = now + RETRY_INTERVAL; }
    finally { checkingAvailability = false; }
  }

  async function run() {
    if (!updates || busy) return;
    const reason = blocked();
    if (reason) {
      message.textContent = reason;
      return;
    }
    manualChecks++;
    busy = true;
    renderNotice();
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    onBusy(true);
    try {
      if (pendingInstall && updates.install) {
        await updates.install();
        await wait();
        render(await updates.status());
        return;
      }
      render({ phase: "checking" });
      await updates.start();
      do {
        render(await updates.status());
        if (!["checking", "downloading", "installing"].includes(state.phase)) break;
        await wait();
      } while (true);
    } catch (error) {
      render({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      busy = false;
      button.disabled = false;
      button.removeAttribute("aria-busy");
      onBusy(false);
      renderNotice();
    }
  }

  if (updates) {
    button.addEventListener("click", run);
    if (updates.install) {
      root.ownerDocument?.addEventListener("visibilitychange", async () => {
        if (root.ownerDocument.hidden || busy || !pendingInstall) return;
        try {
          const latest = await updates.status();
          if (!busy) render(latest);
        } catch { /* The install button remains available for a retry. */ }
      });
    }
  } else {
    button.disabled = true;
    message.textContent = "Updates are unavailable in this build of PulseDrop.";
  }
  notice?.querySelector("#view-update")?.addEventListener("click", () => openSettings?.());
  notice?.querySelector("#dismiss-update")?.addEventListener("click", () => {
    if (!availableVersion) return;
    dismissedVersion = availableVersion;
    try { root.ownerDocument?.defaultView?.localStorage.setItem(DISMISSED_VERSION, dismissedVersion); }
    catch { /* Keep the dismissal in memory. */ }
    renderNotice();
  });
  return { checkAvailability };
}
