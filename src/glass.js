/** @typedef {import("./vendor/liquid-glass/engine").GlassView} GlassView */

/**
 * @param {HTMLElement} shell
 * @param {MediaQueryList} contrast
 */
function mountButtonHighlights(shell, contrast) {
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const root = document.documentElement;
  /** @type {HTMLButtonElement | null} */
  let active = null;
  /** @type {{button: HTMLButtonElement, x: number, y: number} | null} */
  let pointer = null;
  let frame = 0;

  function clear() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    pointer = null;
    active?.removeAttribute("data-glass-hover");
    active = null;
  }

  function reflect() {
    frame = 0;
    if (!pointer || !pointer.button.matches(':hover:enabled:not([aria-disabled="true"])')) {
      clear();
      return;
    }

    const { button, x, y } = pointer;
    if (active !== button) {
      active?.removeAttribute("data-glass-hover");
      active = button;
    }

    const { left, top, width, height } = active.getBoundingClientRect();
    const percent = (/** @type {number} */ offset, /** @type {number} */ size) =>
      `${Math.max(0, Math.min(100, 100 * offset / size))}%`;
    active.style.setProperty("--glass-hover-x", percent(x - left, width));
    active.style.setProperty("--glass-hover-y", percent(y - top, height));
    if (!active.hasAttribute("data-glass-hover")) active.dataset.glassHover = "";
  }

  shell.addEventListener("pointermove", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button") : null;
    if (!button || event.pointerType !== "mouse" || reducedMotion.matches || contrast.matches || root.classList.contains("reduce-motion")) {
      clear();
      return;
    }
    pointer = { button, x: event.clientX, y: event.clientY };
    if (!frame) frame = requestAnimationFrame(reflect);
  }, { passive: true });
  shell.addEventListener("pointerleave", clear);
  shell.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse") clear();
  }, { passive: true });
  window.addEventListener("blur", clear);
  reducedMotion.addEventListener("change", clear);
  contrast.addEventListener("change", clear);
}

/** @param {CanvasRenderingContext2D} ctx @param {CSSStyleDeclaration} colors */
function paintScene(ctx, colors) {
  const color = (/** @type {string} */ name) => colors.getPropertyValue(name).trim();
  const { width, height } = ctx.canvas;
  ctx.setTransform(width / 1100, 0, 0, height / 760, 0, 0);
  ctx.fillStyle = color("--color-bg");
  ctx.fillRect(0, 0, 1100, 760);

  for (const [x, y, radius, name] of /** @type {[number, number, number, string][]} */ ([
    [15, 225, 400, "--scene-blue"],
    [540, 725, 660, "--scene-indigo"],
    [1040, 355, 565, "--scene-teal"]
  ])) {
    const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
    const hue = color(name);
    glow.addColorStop(0, hue);
    glow.addColorStop(1, `${hue}00`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 1100, 760);
  }

  const ribbon = ctx.createLinearGradient(30, 380, 1060, 460);
  const fold = color("--scene-fold");
  const rim = color("--scene-edge");
  ribbon.addColorStop(0, fold);
  ribbon.addColorStop(.48, `${fold.slice(0, 7)}18`);
  ribbon.addColorStop(.84, rim);
  ribbon.addColorStop(1, fold);
  ctx.beginPath();
  ctx.moveTo(-80, 105);
  ctx.bezierCurveTo(205, 234, 140, 690, 552, 643);
  ctx.bezierCurveTo(842, 609, 861, 265, 1180, 186);
  ctx.lineTo(1180, 226);
  ctx.bezierCurveTo(886, 330, 873, 640, 543, 697);
  ctx.bezierCurveTo(132, 753, 164, 328, -80, 154);
  ctx.closePath();
  ctx.fillStyle = ribbon;
  ctx.fill();

  const edge = ctx.createLinearGradient(0, 380, 1100, 420);
  edge.addColorStop(0, rim);
  edge.addColorStop(.35, fold);
  edge.addColorStop(.82, rim);
  edge.addColorStop(1, `${rim.slice(0, 7)}00`);
  ctx.strokeStyle = edge;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-60, 132);
  ctx.bezierCurveTo(195, 260, 135, 715, 547, 664);
  ctx.bezierCurveTo(853, 628, 863, 309, 1160, 209);
  ctx.stroke();
}

/** @param {HTMLElement} shell */
export function mountGlass(shell) {
  const contrast = matchMedia("(prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active)");
  mountButtonHighlights(shell, contrast);

  const scene = shell.querySelector("canvas.glass-scene");
  const sceneContext = scene instanceof HTMLCanvasElement && scene.getContext("2d");
  if (!sceneContext) return;

  const root = document.documentElement;
  /** @type {Map<HTMLElement, GlassView>} */
  const views = new Map();
  /** @type {import("./vendor/liquid-glass/engine").GlassEngine | null} */
  let engine = null;
  let requestedEngine = false;
  let frame = 0;
  let paintedScene = "";

  function schedule() {
    if (frame === 0) frame = requestAnimationFrame(update);
  }

  const update = () => {
    frame = 0;
    const { clientWidth: width, clientHeight: height } = shell;
    if (contrast.matches || !width || !height) return;
    const key = `${width}:${height}:${root.dataset.theme}`;
    if (key !== paintedScene) {
      sceneContext.canvas.width = width;
      sceneContext.canvas.height = height;
      paintScene(sceneContext, getComputedStyle(root));
      paintedScene = key;
    }

    if (!requestedEngine) {
      requestedEngine = true;
      import("./vendor/liquid-glass/engine").then(({ getGlassEngine }) => {
        engine = getGlassEngine();
        schedule();
      }).catch(() => { /* Keep the CSS material if shader initialization fails. */ });
    }

    if (!engine) return;
    const sceneBounds = shell.getBoundingClientRect();
    const pageBounds = shell.querySelector(".page-content")?.getBoundingClientRect() ?? sceneBounds;
    for (const host of shell.querySelectorAll("[data-glass]")) {
      if (!(host instanceof HTMLElement)) continue;
      const rect = host.getBoundingClientRect();
      const viewport = host.dataset.glass === "dock" ? sceneBounds : pageBounds;
      const visible = rect.width > 2 && rect.height > 2 && rect.bottom > viewport.top && rect.top < viewport.bottom;
      const view = views.get(host);
      if (visible) {
        if (view) view.dirty = true;
        else addLens(engine, host, shell, sceneContext.canvas, views);
      } else if (view) {
        engine.remove(view);
        view.lost();
        view.canvas.remove();
        views.delete(host);
      }
    }
    engine.wake();
  };

  const resize = new ResizeObserver(schedule);
  resize.observe(shell);
  for (const host of shell.querySelectorAll("[data-glass]")) resize.observe(host);
  const changes = new MutationObserver(schedule);
  changes.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  changes.observe(shell, { attributes: true, attributeFilter: ["data-view"] });
  shell.querySelector(".page-content")?.addEventListener("scroll", schedule, { passive: true });
  contrast.addEventListener("change", () => {
    if (contrast.matches) {
      for (const view of views.values()) {
        engine?.remove(view);
        view.lost();
        view.canvas.remove();
      }
      views.clear();
    }
    schedule();
  });
  schedule();
}

/**
 * @param {import("./vendor/liquid-glass/engine").GlassEngine} engine
 * @param {HTMLElement} host
 * @param {HTMLElement} shell
 * @param {HTMLCanvasElement} scene
 * @param {Map<HTMLElement, GlassView>} views
 */
function addLens(engine, host, shell, scene, views) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  canvas.className = "glass-refraction";
  canvas.setAttribute("aria-hidden", "true");
  host.prepend(canvas);
  /** @type {import("./vendor/liquid-glass/engine").GlassLens | null} */
  let lens = null;
  /** @type {GlassView} */
  const view = {
    canvas, ctx, dirty: true, visible: true,
    step: () => false,
    lens(refresh) {
      if (lens && !refresh) return lens;
      const rect = host.getBoundingClientRect();
      const sceneRect = shell.getBoundingClientRect();
      const { width, height } = rect;
      if (width < 2 || height < 2) return null;
      const style = getComputedStyle(host);
      const tint = engine.resolveColor(style.getPropertyValue("--glass-tint").trim());
      /** @type {import("./vendor/liquid-glass/engine").Rgb} */
      const color = [tint[0], tint[1], tint[2]];
      const unit = Math.min(width, height, 120) / 120;
      const dock = host.dataset.glass === "dock";
      const command = host.dataset.glass === "command";
      const rimWidth = command ? 8 : 13;
      lens = {
        left: -host.clientLeft, top: -host.clientTop, width, height, unit,
        cx: width / 2, cy: height / 2, hx: width / 2, hy: height / 2,
        radius: parseFloat(style.borderTopLeftRadius), bodyX: 0, bevel: (rimWidth + 4) / unit, band: rimWidth / unit,
        shadow: 0, shadowSoftness: 1, shadowOffset: 0, strength: .85,
        color, surface: color, edgeClear: 0,
        cursorLight: false, screenX: 0, screenY: 0,
        tune: { rim: .95, reflection: .65, inner: .6, saturation: 1.2 },
        refraction: {
          paint(back) {
            back.drawImage(scene, sceneRect.left - rect.left, sceneRect.top - rect.top);
          },
          refract: dock ? 40 : 30, magnify: 0, dispersion: .13,
          blurCenter: dock ? 4.2 : 3.2, blurEdge: 1.1, frost: tint[3]
        }
      };
      return lens;
    },
    drawn: () => {
      if (!host.hasAttribute("data-glass-ready")) host.dataset.glassReady = "";
    },
    lost: () => { delete host.dataset.glassReady; }
  };
  views.set(host, view);
  engine.add(view);
}
