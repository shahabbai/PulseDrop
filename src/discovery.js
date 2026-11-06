// One bounded scan at a time. Late results from a hidden/previous view are ignored.
export function createReceiverDiscovery({ scan, onChange, intervalMs = 5000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let active = false;
  let generation = 0;
  let pending = false;
  let timer;
  let receivers = [];

  async function refresh() {
    if (!active || pending) return;
    clearTimer(timer);
    pending = true;
    const current = generation;
    onChange({ receivers, scanning: true, error: null });
    try {
      const found = await scan();
      if (active && current === generation) {
        receivers = found;
        onChange({ receivers, scanning: false, error: null });
      }
    } catch (error) {
      if (active && current === generation) {
        receivers = [];
        onChange({ receivers, scanning: false, error: String(error.message || error) });
      }
    } finally {
      pending = false;
      if (active) timer = setTimer(refresh, current === generation ? intervalMs : 0);
    }
  }

  return {
    start() {
      if (active) return;
      active = true;
      generation += 1;
      receivers = [];
      refresh();
    },
    stop() {
      active = false;
      generation += 1;
      clearTimer(timer);
    },
    refresh
  };
}
