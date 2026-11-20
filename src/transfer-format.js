/** @param {number} bytes */
export function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

/** @param {number} bytesPerSecond */
export function formatSpeed(bytesPerSecond) {
  return formatBytes(Math.max(0, bytesPerSecond || 0)) + "/s";
}
