import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = vm.createContext({ Math, console, performance, window: {} });
vm.runInContext(readFileSync(new URL("../web/gomoku-core.js", import.meta.url), "utf8"), context);

const core = context.window.GomokuCore;
const Rules = context.window.GomokuRules;
const MoveGen = context.window.GomokuMoveGen;
const Search = context.window.GomokuSearch;
const Threats = context.window.GomokuThreats;
const BoardState = context.window.GomokuBoardState.BoardState;
const { BLACK, WHITE, EMPTY, SIZE, CELL_COUNT } = core;
const { INF, MATE } = Search;

function empty() {
  return Array(CELL_COUNT).fill(EMPTY);
}

function at(row, column) {
  return row * SIZE + column;
}

function sameSet(a, b) {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

function bruteThreatSets(board) {
  const win = [0, new Set(), new Set()];
  const four = [0, new Set(), new Set()];
  const three = [0, new Set(), new Set()];
  for (let index = 0; index < CELL_COUNT; index += 1) {
    if (board[index] !== EMPTY) continue;
    for (const mark of [BLACK, WHITE]) {
      if (Rules.isWinMove(board, index, mark)) win[mark].add(index);
      board[index] = mark;
      const winPoints = Threats.winningPointsForMove(board, index, mark);
      if (winPoints.length) four[mark].add(index);
      else if (Threats.openThreePointsForMove(board, index, mark).length) three[mark].add(index);
      board[index] = EMPTY;
    }
  }
  return { win, four, three };
}

function searchState(forcedMoves = false) {
  return {
    nodes: 0,
    stop: false,
    deadline: 0,
    width: 8,
    prefilter: 14,
    rootWidth: 10,
    rootPrefilter: 24,
    staged: true,
    bucketOrder: false,
    qsearch: false,
    movePicker: false,
    urgent: false,
    noTT: true,
    forcedMoves,
    threatOrder: true,
    threatEval: true,
    nodeVcf: false,
    nodeVcfDefense: false,
    lmr: false,
    killers: Array.from({ length: 16 }, () => [-1, -1]),
    history: [new Int32Array(CELL_COUNT), new Int32Array(CELL_COUNT), new Int32Array(CELL_COUNT)]
  };
}

{
  const board = empty();
  for (const [row, column, mark] of [
    [7, 7, BLACK], [7, 8, BLACK], [7, 9, BLACK],
    [6, 7, WHITE], [8, 7, WHITE], [6, 8, WHITE], [8, 8, WHITE]
  ]) board[at(row, column)] = mark;
  const bs = new BoardState(board, 2);
  const expected = bruteThreatSets(board);
  for (const mark of [BLACK, WHITE]) {
    assert.ok(sameSet(expected.win[mark], new Set(bs.winCells(mark))), `win cells mark=${mark}`);
    assert.ok(sameSet(expected.four[mark], new Set(bs.fourCells(mark))), `four cells mark=${mark}`);
    assert.ok(sameSet(expected.three[mark], new Set(bs.openThreeCells(mark))), `three cells mark=${mark}`);
  }
}

{
  const board = empty();
  for (const col of [4, 5, 6, 7]) board[at(5, col)] = BLACK;
  const before = board.slice();
  const bs = new BoardState(board, 2);
  const result = Search.pvs(board, BLACK, 5, -INF, INF, 0, searchState(true), new Map(), undefined, bs.totalPair(), bs);
  assert.equal(result.forcedWin, true);
  assert.equal(result.score, MATE);
  assert.deepEqual(board, before);
}

{
  const board = empty();
  for (const col of [4, 5, 6, 7]) board[at(5, col)] = WHITE;
  const before = board.slice();
  const bs = new BoardState(board, 2);
  const result = Search.pvs(board, BLACK, 5, -INF, INF, 0, searchState(true), new Map(), undefined, bs.totalPair(), bs);
  assert.ok([at(5, 3), at(5, 8)].includes(result.move), `forced block should block an immediate five, got ${result.move}`);
  assert.deepEqual(board, before);
}

{
  const board = empty();
  for (const col of [4, 5, 6]) board[at(7, col)] = WHITE;
  const before = board.slice();
  const bs = new BoardState(board, 2);
  const state = searchState(false);
  state.nodeVcf = true;
  state.nodeVcfDepth = 2;
  state.nodeVcfTime = 2;
  const result = Search.pvs(board, WHITE, 2, -INF, INF, 1, state, new Map(), undefined, bs.totalPair(), bs);
  assert.equal(result.nodeVcf, true, "node QVCF should prove the continuous-four win");
  assert.equal(result.score, MATE - 1);
  assert.ok(result.move >= 0 && before[result.move] === EMPTY);
  assert.deepEqual(board, before);
}

{
  const board = empty();
  for (const c of [4, 5, 6, 7]) board[at(7, c)] = WHITE;
  board[at(6, 3)] = BLACK;
  board[at(8, 3)] = BLACK;
  board[at(6, 4)] = BLACK;
  board[at(8, 2)] = BLACK;
  const forbidden = at(7, 3);
  const legalBlock = at(7, 8);
  assert.equal(Rules.inspectMove(board, forbidden, BLACK).legal, false);
  assert.equal(Rules.inspectMove(board, legalBlock, BLACK).legal, true);
  const result = core.bestMoveInfo(board, BLACK, "hard");
  assert.equal(result.reason, "block-five");
  assert.equal(result.index, legalBlock);
}

{
  const board = empty();
  board[at(5, 5)] = BLACK;
  board[at(5, 6)] = BLACK;
  board[at(5, 7)] = WHITE;
  board[at(5, 8)] = WHITE;
  const defense = at(5, 9);
  const bs = new BoardState(board, 2);
  const candidates = bs.candidateList().filter((index) => index !== defense);
  const moves = MoveGen.rankedMoves(board, BLACK, 8, {
    width: 8, prefilter: 8, staged: true, candidates, defenseCells: [defense]
  });
  assert.equal(moves[0].index, defense, "defenseCells must be re-injected and rank first");
}

{
  const board = empty();
  for (const col of [4, 5, 6]) board[at(7, col)] = WHITE;
  const before = board.slice();
  const bs = new BoardState(board, 2);
  const state = searchState(false);
  state.nodeVcfDefense = true;
  state.nodeVcfDefenseDepth = 2;
  state.nodeVcfDefenseTime = 2;
  state.nodeVcfDefenseBudget = 6;
  state.nodeVcfDefenseUsed = 0;
  const vcf = Threats.findVcf(board, WHITE, 10);
  assert.ok(vcf >= 0);
  let points = null;
  for (const gain of Threats.forcingMoves(board, WHITE, bs)) {
    if (gain.index === vcf) points = gain.winPoints;
  }
  assert.ok(points && points.length > 0);
  const result = Search.pvs(board, BLACK, 2, -INF, INF, 1, state, new Map(), undefined, bs.totalPair(), bs);
  assert.ok(points.includes(result.move), `expected a VCF defense point ${points}, got ${result.move}`);
  assert.deepEqual(board, before);
  assert.ok(state.nodeVcfDefenseUsed > 0);
}

{
  const board = empty();
  board[at(7, 6)] = WHITE;
  board[at(7, 8)] = WHITE;
  board[at(6, 7)] = WHITE;
  board[at(8, 7)] = WHITE;
  const before = board.slice();
  const bs = new BoardState(board, 2);
  const warmBoard = board.slice();
  warmBoard[0] = BLACK;
  assert.ok(Threats.findVct(warmBoard, WHITE, 80) >= 0);
  const vctState = { used: 0, budget: 100 };
  const result = context.window.GomokuAi.checkMoveSafety(board, 0, BLACK, 5, bs, 80, vctState, 14);
  assert.equal(result.safe, false);
  assert.equal(result.reason, "opponent-vct");
  assert.equal(result.reply, at(7, 7));
  assert.deepEqual(board, before);
}

console.log("Gomoku threat view passed: forced moves, QVCF, defense VCF, root safety");
