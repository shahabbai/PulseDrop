export function createQrScanner({ video, canvas, permission = async () => {}, onCode, onError, onState = () => {}, getMedia = (constraints) => navigator.mediaDevices.getUserMedia(constraints), decode, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
  let generation = 0, stream, timer, active = false;
  async function stop() {
    generation++; active = false; clearTimer(timer);
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null; video.srcObject = null; onState(false);
    await permission(false).catch(() => {});
  }
  async function start() {
    const cleanup = stop(), token = generation, started = now();
    await cleanup;
    if (token !== generation) return;
    active = true; onState(true);
    try {
      await permission(true);
      if (token !== generation) return;
      const acquired = await getMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      if (token !== generation) { acquired.getTracks().forEach((track) => track.stop()); return; }
      stream = acquired; video.srcObject = stream; await video.play();
      const read = decode || (await import("jsqr")).default;
      if (token !== generation) return;
      async function tick() {
        if (!active || token !== generation) return;
        try {
          if (now() - started > 60000) throw new Error("No QR found yet. Move closer to the other device and scan again, or choose a QR image.");
          if (video.readyState >= 2 && video.videoWidth) {
            canvas.width = Math.min(video.videoWidth, 640);
            canvas.height = Math.round(canvas.width * video.videoHeight / video.videoWidth);
            const context = canvas.getContext("2d", { willReadFrequently: true });
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const frame = context.getImageData(0, 0, canvas.width, canvas.height);
            const found = read(frame.data, frame.width, frame.height, { inversionAttempts: "dontInvert" });
            if (found) { await stop(); await onCode(found.data); return; }
          }
          timer = setTimer(tick, 180);
        } catch (error) { await stop(); onError(error); }
      }
      await tick();
    } catch (error) {
      if (token !== generation) return;
      await stop(); onError(error);
    }
  }
  return { start, stop, active: () => active };
}

export async function decodeQrImage(file) {
  if (!file || file.size > 10 * 1024 * 1024) throw new Error("Choose a QR image smaller than 10 MB.");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error("Could not read that image. Choose a clear picture of the receiver’s QR.")); image.src = url; });
    const canvas = document.createElement("canvas"), ratio = Math.min(1, 1200 / Math.max(image.width, image.height));
    canvas.width = Math.round(image.width * ratio); canvas.height = Math.round(image.height * ratio);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const frame = context.getImageData(0, 0, canvas.width, canvas.height);
    const { default: jsQR } = await import("jsqr");
    const code = jsQR(frame.data, frame.width, frame.height);
    if (!code) throw new Error("No QR found in that image. Use a clear picture of PulseDrop’s connection QR.");
    return code.data;
  } finally { URL.revokeObjectURL(url); }
}
