// UI validation only; the receiver protocol and request construction stay in main.js.
export function validateReceiver({ ip, port, code }) {
  const errors = {};
  if (!ip) {
    errors["peer-ip"] = "Choose a nearby device or enter its IP address.";
  } else {
    try {
      const url = new URL(`http://${ip}/`);
      const bracketedIpv6 = /^\[[0-9a-f:.]+\]$/i.test(ip);
      if (!url.hostname || url.username || url.password || url.port
        || /[\s/?#\\]/.test(ip) || (ip.includes(":") && !bracketedIpv6)) {
        throw new Error("Invalid receiver address");
      }
    } catch {
      errors["peer-ip"] = "Enter a valid IP address or hostname without a port.";
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors["peer-port"] = "Enter a port between 1 and 65535.";
  }
  if (!/^\d{6}$/.test(code)) {
    errors["peer-code"] = "Enter the 6-digit code shown on the receiver.";
  }
  return errors;
}
