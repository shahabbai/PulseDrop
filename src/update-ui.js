/** @typedef {import("./native-types").UpdateStatus} UpdateStatus */
/** @typedef {import("./native-types").NativeUpdates} NativeUpdates */

/** @param {UpdateStatus} state */
function statusMessage(state) {
  switch (state.phase) {
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
 *  onBusy: (busy: boolean) => void, wait?: () => Promise<void> }} options
 */
export function mountUpdater({ root, updates, blocked, onBusy,
  wait = () => new Promise((resolve) => setTimeout(resolve, 350))
}) {
  const button = /** @type {HTMLButtonElement} */ (root.querySelector("#check-update"));
  const message = /** @type {HTMLElement} */ (root.querySelector("#update-status"));
  const progress = /** @type {HTMLProgressElement} */ (root.querySelector("#update-progress"));
  /** @type {UpdateStatus} */
  let state = { phase: "idle" };
  let busy = false;
  let pendingInstall = false;

  /** @param {UpdateStatus} next */
  function render(next) {
    state = next;
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
    button.textContent = pendingInstall ? "Install update" : "Check for updates";
  }

  async function run() {
    if (!updates || busy) return;
    const reason = blocked();
    if (reason) {
      message.textContent = reason;
      return;
    }
    busy = true;
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
}
