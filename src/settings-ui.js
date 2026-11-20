/** @param {string} status */
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

/**
 * @param {HTMLElement | null} card
 * @param {HTMLElement | null} statusEl
 * @param {HTMLElement | null} messageEl
 * @param {HTMLElement | null} detailEl
 * @param {HTMLButtonElement | null} fixButton
 * @param {import("./native-types").Diagnostic} item
 */
function renderDiagnostic(card, statusEl, messageEl, detailEl, fixButton, item) {
  if (!card || !statusEl || !messageEl || !detailEl || !fixButton) return;
  const diagnostic = item;
  const status = (diagnostic.status || "unknown").toLowerCase();
  card.dataset.status = status;
  statusEl.textContent = statusLabel(status);
  messageEl.textContent = diagnostic.message || "Could not read this check.";
  detailEl.textContent = diagnostic.detail || diagnostic.title || "No details available";
  fixButton.disabled = !diagnostic.can_fix;
}

/**
 * @param {{root: HTMLElement | null, invoke?: import("./native-types").Invoke, showToast: (message: string) => void}} options
 */
export function mountSettings({ root, invoke, showToast }) {
  /** @param {string} id */
  const el = (id) => /** @type {HTMLElement | null} */ (root?.querySelector(`#${id}`) ?? null);
  /** @param {string} id */
  const button = (id) => /** @type {HTMLButtonElement | null} */ (root?.querySelector(`button#${id}`) ?? null);
  const els = {
    settingsAppPath: el("settings-app-path"),
    networkCard: el("network-card"),
    networkStatus: el("network-status"),
    networkMessage: el("network-message"),
    networkDetail: el("network-detail"),
    fixNetwork: button("fix-network"),
    firewallCard: el("firewall-card"),
    firewallStatus: el("firewall-status"),
    firewallMessage: el("firewall-message"),
    firewallDetail: el("firewall-detail"),
    fixFirewall: button("fix-firewall")
  };
  let lastRequest = 0;
  let fixing = false;

  /** @param {import("./native-types").Diagnostics} data */
  function renderWindowsDiagnostics(data) {
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

  /** @param {string} message */
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
    if (!root) return;
    const request = ++lastRequest;
    renderDiagnosticsLoading();

    if (!invoke) {
      renderDiagnosticsUnavailable("Run inside PulseDrop to check Windows settings.");
      return;
    }

    try {
      const diagnostics = await invoke("windows_diagnostics");
      if (request === lastRequest) renderWindowsDiagnostics(diagnostics);
    } catch (error) {
      if (request !== lastRequest) return;
      renderWindowsDiagnostics({
        is_windows: true,
        app_path: "Diagnostics failed",
        network: {
          status: "unknown",
          message: "PulseDrop could not check the network profile.",
          detail: error instanceof Error ? error.message : String(error),
          can_fix: false
        },
        firewall: {
          status: "unknown",
          message: "PulseDrop could not check Windows Firewall.",
          detail: error instanceof Error ? error.message : String(error),
          can_fix: false
        }
      });
    }
  }

  /**
   * @param {"fix_windows_network_profile" | "fix_windows_firewall"} command
   * @param {HTMLButtonElement} button
   */
  async function runWindowsFix(command, button) {
    if (!invoke) {
      showToast("Run inside PulseDrop to apply this fix");
      return;
    }

    if (fixing) return;
    fixing = true;
    const previousLabel = button.textContent;
    button.textContent = "Working";
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    showToast("Windows may ask for permission to apply this fix");

    try {
      await invoke(command);
      showToast("Fix finished. Refreshing checks...");
      await loadWindowsDiagnostics();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
      await loadWindowsDiagnostics();
    } finally {
      button.textContent = previousLabel;
      button.removeAttribute("aria-busy");
      fixing = false;
    }
  }

  const theme = root?.querySelector("select#theme-select");
  if (theme instanceof HTMLSelectElement) {
    theme.value = window.PulseDropTheme.getTheme();
    theme.addEventListener("change", () => {
      if (theme.value === "light" || theme.value === "dark") window.PulseDropTheme.setTheme(theme.value);
    });
  }
  const motion = root?.querySelector("input#reduce-motion");
  if (motion instanceof HTMLInputElement) {
    try { motion.checked = localStorage.getItem("pulsedrop.reduceMotion") === "true"; }
    catch { /* Use the system motion preference when storage is unavailable. */ }
    document.documentElement.classList.toggle("reduce-motion", motion.checked);
    motion.addEventListener("change", () => {
      document.documentElement.classList.toggle("reduce-motion", motion.checked);
      try { localStorage.setItem("pulsedrop.reduceMotion", String(motion.checked)); }
      catch { /* Unavailable storage must not block preferences. */ }
    });
  }

  button("settings-refresh")?.addEventListener("click", loadWindowsDiagnostics);
  const { fixNetwork, fixFirewall } = els;
  fixNetwork?.addEventListener("click", () => runWindowsFix("fix_windows_network_profile", fixNetwork));
  fixFirewall?.addEventListener("click", () => runWindowsFix("fix_windows_firewall", fixFirewall));
  return { refresh: loadWindowsDiagnostics };
}
