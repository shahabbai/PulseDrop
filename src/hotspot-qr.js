import { validateHotspot } from "./hotspot.js";
import { validateReceiver } from "./ui.js";

function privateAddress(address) {
  const parts = String(address).split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168));
}

function validReceiver(receiver) {
  return receiver && privateAddress(receiver.ip) && Object.keys(validateReceiver(receiver)).length === 0;
}

const escape = (value) => String(value).replace(/[\\;,:\"]/g, "\\$&");

// Standard Wi-Fi QR fields also work with phone camera apps. PD carries an
// optional, versioned pairing endpoint understood only by PulseDrop.
export function encodeHotspotQr({ ssid, password, receiver }) {
  if (Object.keys(validateHotspot({ ssid, password })).length) throw new Error("Invalid Wi-Fi credentials");
  const pairing = validReceiver(receiver) ? `PD:${btoa(JSON.stringify({ version: 1, ip: receiver.ip, port: Number(receiver.port), code: receiver.code }))};` : "";
  return `WIFI:T:WPA;S:${escape(ssid)};P:${escape(password)};H:false;${pairing};`;
}

export function decodeHotspotQr(text) {
  if (typeof text !== "string" || text.length > 2048 || !text.startsWith("WIFI:")) throw new Error("This is not a Wi-Fi connection QR. Scan the QR shown in PulseDrop’s Receive screen.");
  const fields = new Map();
  let key = "", value = "", inValue = false, escaped = false;
  for (const char of text.slice(5)) {
    if (escaped) { if (inValue) value += char; else key += char; escaped = false; }
    else if (char === "\\") escaped = true;
    else if (char === ";") {
      if (key) { if (!inValue || fields.has(key)) throw new Error("Ambiguous Wi-Fi QR. Scan a new code from the receiver."); fields.set(key, value); }
      key = ""; value = ""; inValue = false;
    } else if (char === ":" && !inValue) inValue = true;
    else if (inValue) value += char;
    else key += char;
  }
  if (escaped || key || value || fields.get("T") !== "WPA" || fields.get("H") === "true") throw new Error("Use the receiver’s visible WPA2 hotspot QR code.");
  const credentials = { ssid: fields.get("S") || "", password: fields.get("P") || "" };
  if (Object.keys(validateHotspot(credentials)).length) throw new Error("The QR contains invalid Wi-Fi credentials. Create a new hotspot and scan again.");
  if (fields.has("PD")) {
    try {
      const receiver = JSON.parse(atob(fields.get("PD")));
      if (receiver.version !== 1 || !validReceiver(receiver)) throw new Error();
      credentials.receiver = { ip: receiver.ip, port: Number(receiver.port), code: receiver.code };
    } catch { throw new Error("The receiver details in this QR are invalid. Scan a new code from PulseDrop."); }
  }
  return credentials;
}

export async function qrMatrix(text) {
  const { default: qrcode } = await import("qrcode-generator");
  qrcode.stringToBytes = (value) => Array.from(new TextEncoder().encode(value));
  const qr = qrcode(0, "M"); qr.addData(text, "Byte"); qr.make();
  return qr;
}

export async function paintHotspotQr(canvas, text, current = () => true) {
  const qr = await qrMatrix(text), margin = 4, scale = 5;
  if (!current()) return;
  const width = (qr.getModuleCount() + margin * 2) * scale;
  canvas.width = width; canvas.height = width;
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff"; context.fillRect(0, 0, width, width);
  context.fillStyle = "#000";
  for (let y = 0; y < qr.getModuleCount(); y++) for (let x = 0; x < qr.getModuleCount(); x++) {
    if (qr.isDark(y, x)) context.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
  }
}
