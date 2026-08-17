(() => {
  "use strict";

  const config = window.GOMOKU_CONFIG || {};
  const storageKey = "gomoku_stats_v1";
  const adapter = window.GOMOKU_HOST_ADAPTER;
  let startedAt = 0;
  let settled = true;

  function read() {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || "{}");
    } catch {
      return {};
    }
  }

  function write(stats) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(stats));
    } catch {
      // Storage is optional in private browsing and embedded contexts.
    }
  }

  function emit(name, data = {}) {
    const detail = { game: "gomoku", ...data };
    window.dispatchEvent(new CustomEvent(`gomoku:${name}`, { detail }));
    adapter?.event?.(name, detail);
    if (config.parentOrigin && window.parent !== window) {
      window.parent.postMessage({ source: "gomoku", type: name, detail }, config.parentOrigin);
    }
  }

  function settle(score) {
    if (settled || !startedAt) return;
    const stats = read();
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    stats.plays ||= 0;
    stats.seconds = (stats.seconds || 0) + seconds;
    stats.lastPlayed = new Date().toISOString();
    if (Number.isFinite(score)) stats.bestScore = Math.max(stats.bestScore || 0, Math.round(score));
    write(stats);
    settled = true;
    adapter?.end?.(score);
    emit("end", { score: Number.isFinite(score) ? Math.round(score) : undefined, seconds });
  }

  window.GomokuHost = Object.freeze({
    start() {
      if (!settled) settle();
      const stats = read();
      stats.plays = (stats.plays || 0) + 1;
      stats.lastPlayed = new Date().toISOString();
      write(stats);
      startedAt = Date.now();
      settled = false;
      adapter?.start?.();
      emit("start");
    },
    end(score) {
      settle(Number(score));
    },
    event: emit,
    stats: read
  });

  emit("view");
  addEventListener("pagehide", () => settle());
})();
