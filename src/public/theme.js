// This blocking, external script runs before the stylesheet to avoid a theme flash.
(() => {
  const storageKey = "pulsedrop.theme";
  const backgrounds = { dark: "#0b1424", light: "#eaf1fb" };
  /** @type {import("../native-types").Theme} */
  let current = "dark";

  /** @param {import("../native-types").Theme} theme */
  function apply(theme) {
    current = theme;
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", backgrounds[theme]);

    window.PulseDropNative.setTheme(theme);
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
