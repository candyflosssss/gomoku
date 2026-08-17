// 强化 hard AI 专项检查：
// - VCT 双活三杀
// - VCF 连续冲四
// - AI 默认按 Renju 禁手思考
// - 公开 winAt 仍保持自由规则（六连也算胜）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = vm.createContext({ Math, console, window: {} });
vm.runInContext(
  readFileSync(new URL("../web/gomoku-core.js", import.meta.url), "utf8"),
  context
);
const core = context.window.GomokuCore;
const { SIZE, CELL_COUNT, BLACK, WHITE, EMPTY } = core;

const empty = () => Array(CELL_COUNT).fill(EMPTY);
const at = (row, col) => row * SIZE + col;

// 1. VCT：白棋一手形成双活三，hard 必须选择中心点。
{
  const board = empty();
  board[at(7, 6)] = WHITE;
  board[at(7, 8)] = WHITE;
  board[at(6, 7)] = WHITE;
  board[at(8, 7)] = WHITE;
  const move = core.aiMove(board, WHITE, "hard");
  assert.equal(move, at(7, 7), "hard AI should find the double-three VCT move");
}

// 2. VCF：黑棋有两个冲四线路，hard 应选择立即获胜或强制路线。
{
  const board = empty();
  board[at(7, 2)] = WHITE;
  for (const col of [3, 4, 5]) board[at(7, col)] = BLACK;
  for (const col of [3, 4, 5]) board[at(8, col)] = BLACK;
  const move = core.aiMove(board, BLACK, "hard");
  assert.ok([at(7, 6), at(8, 6), at(8, 2)].includes(move), `unexpected VCF move ${move}`);
}

// 3. AI 默认启用禁手：黑棋不会走三三禁手点。
{
  const board = empty();
  board[at(7, 6)] = BLACK;
  board[at(7, 8)] = BLACK;
  board[at(6, 7)] = BLACK;
  board[at(8, 7)] = BLACK;
  const center = at(7, 7);
  const inspect = core.inspectMove(board, center, BLACK);
  assert.equal(inspect.legal, false);
  assert.match(inspect.reason, /double-three/);
  const move = core.aiMove(board, BLACK, "hard");
  assert.notEqual(move, center, "hard AI should avoid a forbidden move");
}

// 4. AI 禁手开关：关闭后黑棋三三禁手点对 AI 视为合法。
{
  const board = empty();
  board[at(7, 6)] = BLACK;
  board[at(7, 8)] = BLACK;
  board[at(6, 7)] = BLACK;
  board[at(8, 7)] = BLACK;
  const center = at(7, 7);
  core.setAiRenju(false);
  assert.equal(core.getAiRenju(), false);
  assert.equal(core.inspectMove(board, center, BLACK).legal, true);
  core.setAiRenju(true);
  assert.equal(core.getAiRenju(), true);
  assert.equal(core.inspectMove(board, center, BLACK).legal, false);
}

// 5. 公开 winAt 仍保持自由规则：黑棋六连在 UI 判定中仍算胜。
{
  const board = empty();
  for (let col = 0; col < 6; col += 1) board[at(7, col)] = BLACK;
  const line = core.winAt(board, at(7, 3));
  assert.ok(line && line.length >= 5, "public winAt should keep free-rule six-in-a-row win");
}

// 6. hard 性能上限：复杂中盘局面单步不超过 2200ms。
{
  const board = empty();
  board[at(7, 7)] = BLACK;
  board[at(7, 8)] = WHITE;
  board[at(6, 7)] = BLACK;
  board[at(6, 8)] = WHITE;
  board[at(5, 7)] = BLACK;
  board[at(5, 6)] = WHITE;
  board[at(7, 6)] = BLACK;
  board[at(6, 9)] = WHITE;
  const started = performance.now();
  const move = core.aiMove(board, BLACK, "hard");
  const elapsed = performance.now() - started;
  assert.ok(move >= 0 && board[move] === EMPTY, "hard AI returned a valid empty cell");
  assert.ok(elapsed < 2200, `hard AI too slow: ${elapsed.toFixed(0)}ms`);
}

console.log("Gomoku hard AI passed: VCT, VCF, renju awareness, performance");
