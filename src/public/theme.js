// This blocking, external script runs before the stylesheet to avoid a theme flash.
(() => {
  const storageKey = "pulsedrop.theme";
  const backgrounds = { dark: "#1e2030", light: "#f5f1eb" };
  let current = "dark";

  function apply(theme) {
    current = theme;
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", backgrounds[theme]);

    // The web preference also controls native title bars and Android system bars.
    try {
      if (window.PulseDropAndroid && window.PulseDropAndroid.setTheme) {
        window.PulseDropAndroid.setTheme(theme);
      } else {
        const api = window.__TAURI__ && window.__TAURI__.window;
        if (api) api.getCurrentWindow().setTheme(theme).catch(() => {});
      }
    } catch { /* A native appearance failure must not block the interface. */ }
  }

  let saved;
  try { saved = localStorage.getItem(storageKey); } catch { /* Default to Dark. */ }
  apply(saved === "light" ? "light" : "dark");

  window.PulseDropTheme = Object.freeze({
    getTheme: () => current,
    setTheme(theme) {
      if (theme !== "light" && theme !== "dark") return;
      apply(theme);
      try { localStorage.setItem(storageKey, theme); } catch { /* Still apply this session's choice. */ }
    }
  });
})();
