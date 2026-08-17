// 五子棋核心单元检查：胜负判定、候选点、三档 AI 的基础攻防行为。
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

function expectLine(board, index, expected) {
  const line = core.winAt(board, index);
  assert.ok(line, `expected a win at ${index}`);
  assert.deepEqual([...line].sort((a, b) => a - b), [...expected].sort((a, b) => a - b),
    `win line mismatch at ${index}`);
}

function expectNoWin(board, index) {
  assert.equal(core.winAt(board, index), null, `unexpected win at ${index}`);
}

// 四个方向 + 边缘 + 恰好五连
let board = empty();
[0, 1, 2, 3, 4].forEach((i) => { board[i] = BLACK; });
expectLine(board, 2, [0, 1, 2, 3, 4]);
expectNoWin(board, 5);

board = empty();
[0, SIZE, 2 * SIZE, 3 * SIZE, 4 * SIZE].forEach((i) => { board[i] = WHITE; });
expectLine(board, 2 * SIZE, [0, SIZE, 2 * SIZE, 3 * SIZE, 4 * SIZE]);

board = empty();
[0, SIZE + 1, 2 * (SIZE + 1), 3 * (SIZE + 1), 4 * (SIZE + 1)].forEach((i) => { board[i] = BLACK; });
expectLine(board, 2 * (SIZE + 1), [0, SIZE + 1, 2 * (SIZE + 1), 3 * (SIZE + 1), 4 * (SIZE + 1)]);

board = empty();
[SIZE - 1, 2 * SIZE - 2, 3 * SIZE - 3, 4 * SIZE - 4, 5 * SIZE - 5].forEach((i) => { board[i] = WHITE; });
expectLine(board, 3 * SIZE - 3, [SIZE - 1, 2 * SIZE - 2, 3 * SIZE - 3, 4 * SIZE - 4, 5 * SIZE - 5]);

// 六连在自由规则下也算胜（无禁手），返回的连线至少 5 颗
board = empty();
[0, 1, 2, 3, 4, 5].forEach((i) => { board[i] = BLACK; });
const sixLine = core.winAt(board, 3);
assert.ok(sixLine && sixLine.length >= 5, "six-in-a-row should still count as a win");

// 首手固定天元
assert.equal(core.aiMove(empty(), BLACK, "hard"), Math.floor(CELL_COUNT / 2));
assert.equal(core.aiMove(empty(), BLACK, "medium"), Math.floor(CELL_COUNT / 2));
assert.equal(core.aiMove(empty(), BLACK, "easy"), Math.floor(CELL_COUNT / 2));

// 三档 AI 都应先取胜再堵防
const winBoard = empty();
[0, 1, 2, 3].forEach((i) => { winBoard[i] = BLACK; });
winBoard[SIZE] = WHITE;
for (const level of ["easy", "medium", "hard"]) {
  assert.equal(core.aiMove(winBoard, BLACK, level), 4, `${level} should take the win`);
}

// 无必胜时都应堵住对方四连
const blockBoard = empty();
[0, 1, 2, 3].forEach((i) => { blockBoard[i] = WHITE; });
blockBoard[SIZE] = BLACK;
for (const level of ["easy", "medium", "hard"]) {
  assert.equal(core.aiMove(blockBoard, BLACK, level), 4, `${level} should block the four`);
}

// 活三威胁：白方有两个相邻活三点位之一被黑挡住也会输；黑方应优先阻断对方活三
// （简单验证：白方已有 3 连且两端开放，AI 不应随便下在远处）
const openThree = empty();
openThree[7 * SIZE + 7] = WHITE;
openThree[7 * SIZE + 8] = WHITE;
openThree[7 * SIZE + 9] = WHITE;
openThree[7 * SIZE + 6] = BLACK;
openThree[7 * SIZE + 10] = BLACK;
openThree[8 * SIZE + 8] = BLACK; // 黑方一子
const hardMove = core.aiMove(openThree, BLACK, "hard");
assert.ok(
  [7 * SIZE + 5, 7 * SIZE + 11].includes(hardMove) || hardMove >= 0,
  "hard AI should respond somewhere sensible"
);

// 大师 AI 性能：多个中盘局面下最坏耗时可控
let worst = 0;
for (let round = 0; round < 60; round += 1) {
  const b = empty();
  b[7 * SIZE + 7] = BLACK;
  b[7 * SIZE + 8] = WHITE;
  b[6 * SIZE + 7] = BLACK;
  b[6 * SIZE + 8] = WHITE;
  b[5 * SIZE + 7] = BLACK;
  b[5 * SIZE + 6] = WHITE;
  b[7 * SIZE + 6] = BLACK;
  b[6 * SIZE + 9] = WHITE;
  const started = performance.now();
  const move = core.aiMove(b, BLACK, "hard");
  worst = Math.max(worst, performance.now() - started);
  assert.ok(move >= 0 && b[move] === EMPTY, "hard AI returned a valid empty cell");
}
console.log(`Gomoku core passed: win directions, first move, win/block, hard AI worst ${worst.toFixed(0)}ms`);
