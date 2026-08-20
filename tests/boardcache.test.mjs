import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = vm.createContext({ Math, console, performance, window: {} });
vm.runInContext(readFileSync(new URL("../web/gomoku-core.js", import.meta.url), "utf8"), context);

const core = context.window.GomokuCore;
const MoveGen = context.window.GomokuMoveGen;
const Patterns = context.window.GomokuPatterns;
const Search = context.window.GomokuSearch;
const BoardState = context.window.GomokuBoardState.BoardState;
const { BLACK, WHITE, EMPTY, SIZE, CELL_COUNT } = core;

function empty() {
  return Array(CELL_COUNT).fill(EMPTY);
}

function at(row, column) {
  return row * SIZE + column;
}

function sampleBoard() {
  const board = empty();
  const stones = [
    [7, 7, BLACK], [7, 8, WHITE], [6, 7, BLACK], [6, 8, WHITE],
    [5, 7, BLACK], [5, 6, WHITE], [8, 7, BLACK], [8, 8, WHITE],
    [7, 6, BLACK], [6, 9, WHITE], [4, 7, BLACK], [9, 8, WHITE]
  ];
  for (const [row, column, mark] of stones) board[at(row, column)] = mark;
  return board;
}

function makeState() {
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
    forcedMoves: false,
    threatOrder: false,
    threatEval: false,
    nodeVcf: false,
    nodeVcfDefense: false,
    lmr: false,
    killers: Array.from({ length: 16 }, () => [-1, -1]),
    history: [new Int32Array(CELL_COUNT), new Int32Array(CELL_COUNT), new Int32Array(CELL_COUNT)]
  };
}

assert.ok(BoardState, "GomokuBoardState.BoardState should be exported");

{
  const board = sampleBoard();
  const bs = new BoardState(board.slice(), 2);
  assert.deepEqual(bs.totalPair(), Patterns.evaluatePair(board));
  for (let index = 0; index < CELL_COUNT; index += 1) {
    assert.deepEqual(bs.linePairAt(index), Patterns.linePairScoreAt(board, index));
  }
}

{
  const board = sampleBoard();
  const bs = new BoardState(board.slice(), 2);
  assert.deepEqual(bs.candidateList(), MoveGen.candidateSet(board, 2));

  let applied = 0;
  for (let index = 0; index < CELL_COUNT && applied < 10; index += 1) {
    if (bs.board[index] !== EMPTY) continue;
    const mark = applied % 2 === 0 ? BLACK : WHITE;
    bs.apply(index, mark);
    assert.deepEqual(bs.linePairAt(index), Patterns.linePairScoreAt(bs.board, index));
    assert.deepEqual(bs.candidateList(), MoveGen.candidateSet(bs.board, 2));
    bs.undo();
    assert.equal(bs.board[index], EMPTY);
    assert.deepEqual(bs.totalPair(), Patterns.evaluatePair(bs.board));
    applied += 1;
  }
}

{
  const board = sampleBoard();
  const bs = new BoardState(board.slice(), 2);
  const options = { width: 10, prefilter: 20, staged: true };
  const cached = MoveGen.rankedMoves(board, BLACK, 10, { ...options, candidates: bs.candidateList() });
  const original = MoveGen.rankedMoves(board, BLACK, 10, options);
  assert.deepEqual(cached, original);
}

{
  const boardCached = sampleBoard();
  const boardOld = sampleBoard();
  const bs = new BoardState(boardCached, 2);
  const cached = Search.pvs(
    boardCached, BLACK, 4, -Search.INF, Search.INF, 0,
    makeState(), new Map(), undefined, bs.totalPair(), bs
  );
  const old = Search.pvs(
    boardOld, BLACK, 4, -Search.INF, Search.INF, 0,
    makeState(), new Map(), undefined, Patterns.evaluatePair(boardOld)
  );
  assert.equal(cached.score, old.score);
  assert.equal(cached.move, old.move);
  assert.deepEqual(Array.from(boardCached), Array.from(boardOld));
}

console.log("Gomoku BoardState passed: cache, candidates, pvs equivalence");
