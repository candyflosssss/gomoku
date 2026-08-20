import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../web/gomoku-core.js", import.meta.url), "utf8");

function loadCore(overrides = {}) {
  const context = vm.createContext({ Math, console, performance, window: {}, ...overrides });
  vm.runInContext(source, context);
  return { context, core: context.window.GomokuCore };
}

{
  const { context, core } = loadCore();
  assert.equal(core.SIZE, 15, "web default board size stays 15x15");
  assert.equal(core.CELL_COUNT, 225);
  assert.equal(context.window.GomokuRules.SIZE, 15);
  const board = Array(core.CELL_COUNT).fill(core.EMPTY);
  const result = core.bestMoveInfo(board, core.BLACK, "hard");
  const center = Math.floor((core.SIZE - 1) / 2);
  assert.equal(result.index, center * core.SIZE + center);
}

{
  const { context, core } = loadCore({ GomokuBoardSize: 11 });
  assert.equal(core.SIZE, 11, "GomokuBoardSize can override before load");
  assert.equal(core.CELL_COUNT, 121);
  assert.equal(context.window.GomokuRules.SIZE, 11);
  assert.ok(context.window.GomokuBoardState.BoardState, "BoardState follows the overridden size");
  const board = Array(core.CELL_COUNT).fill(core.EMPTY);
  const result = core.bestMoveInfo(board, core.BLACK, "hard");
  const center = Math.floor((core.SIZE - 1) / 2);
  assert.equal(result.index, center * core.SIZE + center);
}

console.log("Gomoku board size passed: default 15, override 11");
