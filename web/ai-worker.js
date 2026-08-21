/* AI Web Worker: keeps hard-mode search off the UI thread. */
"use strict";

self.window = self;
importScripts("gomoku-core.js");

self.onmessage = (event) => {
  const data = event.data || {};
  try {
    const size = self.GomokuCore ? self.GomokuCore.CELL_COUNT : 225;
    const source = data.board && data.board.length === size ? data.board : new Array(size).fill(0);
    const board = Array.from(source);
    const mark = data.mark;
    const level = data.level || "hard";
    if (self.GomokuCore && self.GomokuCore.setAiRenju) {
      self.GomokuCore.setAiRenju(data.renju !== false);
    }
    const result = self.GomokuAi.bestMove(board, mark, level);
    self.postMessage({ ok: true, requestId: data.requestId, index: result.index, info: result });
  } catch (error) {
    self.postMessage({
      ok: false,
      requestId: data.requestId,
      error: String(error && error.message || error)
    });
  }
};
