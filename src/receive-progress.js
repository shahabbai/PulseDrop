function nonnegative(value) {
  return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
}

function normalize(update) {
  if (!update || !update.transfer_id || !["receiving", "completed", "failed", "cancelled"].includes(update.phase)) return null;
  const size = nonnegative(update.size);
  const received = update.phase === "completed" ? size : Math.min(size, nonnegative(update.received));
  return {
    id: update.transfer_id,
    name: String(update.name || "Incoming file"),
    size,
    received,
    speed: update.phase === "receiving" ? nonnegative(update.speed) : 0,
    phase: update.phase,
    kind: update.phase === "completed" ? "received" : update.phase,
    progress: update.phase === "completed" ? 100 : Math.min(99, size ? received / size * 100 : 0),
    error: String(update.error || ""),
    direction: "receive"
  };
}

// Correlate live events and the existing completion event, independently of
// filenames. Keep active uploads and a bounded terminal history for deduping.
export function createReceiveProgress() {
  const transfers = new Map();
  let latest = null;

  function summary() {
    const active = [...transfers.values()].filter((item) => item.phase === "receiving");
    if (!active.length) return latest && { ...latest, activeCount: 0 };
    const size = active.reduce((sum, item) => sum + item.size, 0);
    const received = active.reduce((sum, item) => sum + item.received, 0);
    return {
      name: active.length === 1 ? active[0].name : `${active.length} incoming files`,
      size, received,
      speed: active.reduce((sum, item) => sum + item.speed, 0),
      progress: Math.min(99, size ? received / size * 100 : 0),
      kind: "receiving", phase: "receiving", activeCount: active.length
    };
  }

  return {
    accept(update) {
      const item = normalize(update);
      if (!item) return null;
      const previous = transfers.get(item.id);
      if (previous && previous.phase !== "receiving") return null;
      if (previous && item.received < previous.received) return null;
      transfers.set(item.id, item);
      latest = item;
      const terminal = [...transfers.values()].filter((entry) => entry.phase !== "receiving");
      for (const old of terminal.slice(0, Math.max(0, terminal.length - 128))) transfers.delete(old.id);
      return { item, completed: item.phase === "completed", summary: summary() };
    }
  };
}
