// 五子棋核心逻辑（自研）：15×15 棋盘、胜负判定、候选点生成、三档 AI。
// 挂载为 window.GomokuCore，供 index.html 与联机层使用，也可在 Node 中直接测试。

(() => {
  "use strict";

  const SIZE = 15;
  const CELL_COUNT = SIZE * SIZE;
  const EMPTY = 0;
  const BLACK = 1;
  const WHITE = 2;
  const DIRECTIONS = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1]
  ];

  function other(mark) {
    return mark === BLACK ? WHITE : BLACK;
  }

  // 以 index 为落子点，判断 mark 是否形成五连；返回连成线的格子数组或 null。
  function winAt(board, index) {
    const mark = board[index];
    if (!mark) return null;
    const row = Math.floor(index / SIZE);
    const column = index % SIZE;
    for (const [dr, dc] of DIRECTIONS) {
      const line = [index];
      for (let step = 1; step < 5; step += 1) {
        const nr = row - dr * step;
        const nc = column - dc * step;
        if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) break;
        const at = nr * SIZE + nc;
        if (board[at] !== mark) break;
        line.unshift(at);
      }
      for (let step = 1; step < 5; step += 1) {
        const nr = row + dr * step;
        const nc = column + dc * step;
        if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) break;
        const at = nr * SIZE + nc;
        if (board[at] !== mark) break;
        line.push(at);
      }
      if (line.length >= 5) return line;
    }
    return null;
  }

  // 以 index 为落子点，统计某方向上的连续同色长度与两端开放性。
  function runInfo(board, index, mark, direction) {
    const [dr, dc] = direction;
    const row = Math.floor(index / SIZE);
    const column = index % SIZE;
    let count = 1;
    let openEnds = 0;
    for (const sign of [-1, 1]) {
      let step = 1;
      let open = false;
      while (true) {
        const nr = row + dr * sign * step;
        const nc = column + dc * sign * step;
        if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) break;
        const at = nr * SIZE + nc;
        const value = board[at];
        if (value === mark) {
          count += 1;
        } else if (value === EMPTY) {
          open = true;
          break;
        } else {
          break;
        }
        step += 1;
      }
      if (open) openEnds += 1;
    }
    return { count, openEnds };
  }

  function runScore(count, openEnds) {
    if (count >= 5) return 1_000_000;
    if (count === 4) return openEnds === 2 ? 200_000 : openEnds === 1 ? 20_000 : 0;
    if (count === 3) return openEnds === 2 ? 8_000 : openEnds === 1 ? 600 : 0;
    if (count === 2) return openEnds === 2 ? 500 : openEnds === 1 ? 60 : 0;
    if (count === 1) return openEnds === 2 ? 12 : openEnds === 1 ? 2 : 0;
    return 0;
  }

  // 假想 mark 落在 index 后，该点在四个方向上的威胁分值总和。
  function pointScore(board, index, mark) {
    let score = 0;
    for (const direction of DIRECTIONS) {
      const { count, openEnds } = runInfo(board, index, mark, direction);
      score += runScore(count, openEnds);
    }
    return score;
  }

  // 全盘评估：对 mark 的所有行段（四方向）打分求和，作为局面价值。
  function boardScore(board, mark) {
    let total = 0;
    for (const [dr, dc] of DIRECTIONS) {
      for (let start = 0; start < SIZE; start += 1) {
        const cells = [];
        if (dr === 0) {
          for (let column = 0; column < SIZE; column += 1) {
            cells.push(start * SIZE + column);
          }
        } else if (dc === 0) {
          for (let row = 0; row < SIZE; row += 1) {
            cells.push(row * SIZE + start);
          }
        } else if (dr === 1 && dc === 1) {
          const row0 = start;
          const col0 = 0;
          let row = row0;
          let column = col0;
          while (row < SIZE && column < SIZE) {
            cells.push(row * SIZE + column);
            row += 1;
            column += 1;
          }
          if (start > 0) {
            row = 0;
            column = start;
            while (row < SIZE && column < SIZE) {
              cells.push(row * SIZE + column);
              row += 1;
              column += 1;
            }
          }
        } else {
          const row0 = start;
          let row = row0;
          let column = SIZE - 1;
          while (row < SIZE && column >= 0) {
            cells.push(row * SIZE + column);
            row += 1;
            column -= 1;
          }
          if (start > 0) {
            row = 0;
            column = start - 1;
            while (row < SIZE && column >= 0) {
              cells.push(row * SIZE + column);
              row += 1;
              column -= 1;
            }
          }
        }
        let run = 0;
        let openBefore = false;
        let openAfter = false;
        for (let index = 0; index <= cells.length; index += 1) {
          const value = index < cells.length ? board[cells[index]] : -1;
          if (value === mark) {
            run += 1;
            continue;
          }
          if (value === EMPTY) {
            if (run > 0) {
              openAfter = index < cells.length;
              total += runScore(run, (openBefore ? 1 : 0) + (openAfter ? 1 : 0));
              run = 0;
            }
            openBefore = true;
            openAfter = false;
          } else {
            if (run > 0) {
              total += runScore(run, (openBefore ? 1 : 0));
              run = 0;
            }
            openBefore = false;
            openAfter = false;
          }
        }
      }
    }
    return total;
  }

  // 空位且与任一棋子曼哈顿距离 ≤ 1 的候选点集合（开局空盘时取中心）。
  function candidateSet(board) {
    const occupied = [];
    for (let index = 0; index < CELL_COUNT; index += 1) {
      if (board[index]) occupied.push(index);
    }
    if (!occupied.length) return [Math.floor(CELL_COUNT / 2)];
    const seen = new Uint8Array(CELL_COUNT);
    const result = [];
    for (const at of occupied) {
      const row = Math.floor(at / SIZE);
      const column = at % SIZE;
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          const nr = row + dr;
          const nc = column + dc;
          if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) continue;
          const index = nr * SIZE + nc;
          if (!board[index] && !seen[index]) {
            seen[index] = 1;
            result.push(index);
          }
        }
      }
    }
    return result;
  }

  // 能否下一步直接五连；返回落点，无则 -1。
  function findImmediateWin(board, mark) {
    for (const index of candidateSet(board)) {
      board[index] = mark;
      const line = winAt(board, index);
      board[index] = EMPTY;
      if (line) return index;
    }
    return -1;
  }

  // 按「进攻分 + 防守分」排序后的候选点（前 limit 个）。
  function rankedMoves(board, mark, limit = 12) {
    const opponent = other(mark);
    const scored = [];
    for (const index of candidateSet(board)) {
      board[index] = mark;
      const attack = pointScore(board, index, mark);
      board[index] = EMPTY;
      board[index] = opponent;
      const defense = pointScore(board, index, opponent);
      board[index] = EMPTY;
      scored.push({ index, score: attack * 1.0 + defense * 0.92 });
    }
    scored.sort((left, right) => right.score - left.score);
    return scored.slice(0, limit).map((item) => item.index);
  }

  // α-β 搜索：返回 { score, move }，score 从当前 mark 视角评估。
  function search(board, mark, depth, alpha, beta, candidates, nodeBudget, budgetRef) {
    budgetRef.count -= 1;
    if (budgetRef.count <= 0) {
      return { score: boardScore(board, mark) - boardScore(board, other(mark)), move: -1 };
    }
    if (depth === 0) {
      const score = boardScore(board, mark) - boardScore(board, other(mark));
      return { score, move: -1 };
    }
    const moves = candidates(board, mark);
    if (!moves.length) return { score: 0, move: -1 };
    let bestMove = moves[0];
    let bestScore = -Infinity;
    for (const index of moves) {
      board[index] = mark;
      const win = winAt(board, index);
      let score;
      if (win) {
        score = 1_000_000 + depth;
      } else {
        const result = search(board, other(mark), depth - 1, -beta, -alpha, candidates, nodeBudget, budgetRef);
        score = -result.score;
      }
      board[index] = EMPTY;
      if (score > bestScore) {
        bestScore = score;
        bestMove = index;
      }
      if (bestScore > alpha) alpha = bestScore;
      if (alpha >= beta) break;
    }
    return { score: bestScore, move: bestMove };
  }

  function aiMove(board, aiMark, level) {
    if (!board.some((value) => value)) {
      return Math.floor(CELL_COUNT / 2);
    }
    const opponent = other(aiMark);
    const win = findImmediateWin(board, aiMark);
    if (win >= 0) return win;
    const block = findImmediateWin(board, opponent);
    if (block >= 0) return block;

    if (level === "easy") {
      const moves = candidateSet(board);
      const scored = moves
        .map((index) => {
          board[index] = aiMark;
          const attack = pointScore(board, index, aiMark);
          board[index] = EMPTY;
          return { index, score: attack };
        })
        .sort((left, right) => right.score - left.score);
      if (Math.random() < 0.6) {
        const top = scored.slice(0, Math.max(1, Math.floor(scored.length * 0.3)));
        return top[Math.floor(Math.random() * top.length)].index;
      }
      return scored[0].index;
    }

    if (level === "medium") {
      const moves = rankedMoves(board, aiMark, 1);
      return moves[0];
    }

    // hard：强化引擎。AI 默认按 Renju 禁手思考；
    // 玩家侧规则由 UI 后续接入 GomokuCore.inspectMove / isMoveLegal。
    if (window.GomokuAi) {
      const info = window.GomokuAi.bestMove(board, aiMark, "hard", {
        timeMs: 2000,
        maxDepth: 14,
        vcf: true,
        vcfTime: 400,
        vct: true,
        vctTime: 300,
        search: { rootWidth: 20, rootPrefilter: 48, width: 10, prefilter: 16 }
      });
      if (info && info.index >= 0 && board[info.index] === EMPTY) return info.index;
    }
    return rankedMoves(board, aiMark, 1)[0];
  }

  window.GomokuCore = Object.freeze({
    SIZE,
    CELL_COUNT,
    EMPTY,
    BLACK,
    WHITE,
    other,
    winAt,
    candidateSet,
    rankedMoves,
    boardScore,
    pointScore,
    findImmediateWin,
    aiMove
  });
})();

/* ============ 强化 hard 引擎 ============ */

(function () {
  "use strict";
  if (typeof globalThis.performance === "undefined") {
    globalThis.performance = { now: function () { return Date.now(); } };
  }
})();

/* 五子棋规则模块（标准连珠 / Renju）
 * - 15×15 棋盘，黑棋先手。
 * - 黑棋禁手：三三、四四、长连（六连及以上）。
 * - 白棋无禁手，五连与长连均胜。
 * - 黑棋五连优先于同时形成的禁手。
 */
(function (global) {
  "use strict";

  const SIZE = 15;
  const CELL_COUNT = SIZE * SIZE;
  const EMPTY = 0;
  const BLACK = 1;
  const WHITE = 2;
  const DIRECTIONS = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1]
  ];

  // 规则模式：renju = AI 考虑禁手；free = AI 不考虑禁手。
  let MODE = "renju";

  function setMode(mode) {
    MODE = mode === "free" ? "free" : "renju";
  }

  function getMode() {
    return MODE;
  }

  function other(mark) {
    return mark === BLACK ? WHITE : BLACK;
  }

  function onBoard(row, column) {
    return row >= 0 && row < SIZE && column >= 0 && column < SIZE;
  }

  function indexOf(row, column) {
    return row * SIZE + column;
  }

  /* 以 index 为起点，沿 direction 收集一段连续同色子。
   * 返回按 direction 方向排列的格子索引数组。 */
  function contiguousRun(board, index, mark, direction) {
    const [dr, dc] = direction;
    const row = Math.floor(index / SIZE);
    const column = index % SIZE;
    const line = [index];
    for (const sign of [-1, 1]) {
      let step = 1;
      while (true) {
        const nr = row + dr * sign * step;
        const nc = column + dc * sign * step;
        if (!onBoard(nr, nc)) break;
        const at = indexOf(nr, nc);
        if (board[at] !== mark) break;
        if (sign === -1) line.unshift(at);
        else line.push(at);
        step += 1;
      }
    }
    return line;
  }

  /* 落子 index 后，返回 mark 在四个方向上的连续长度。 */
  function runLengths(board, index, mark) {
    const result = [];
    for (const direction of DIRECTIONS) {
      result.push({ direction, line: contiguousRun(board, index, mark, direction) });
    }
    return result;
  }

  /* 胜负判定：返回连成五（或长连）的格子数组；无则 null。 */
  function winAt(board, index) {
    const mark = board[index];
    if (!mark) return null;
    for (const direction of DIRECTIONS) {
      const line = contiguousRun(board, index, mark, direction);
      if (line.length >= 5) return line;
    }
    return null;
  }

  function isWinMove(board, index, mark) {
    if (board[index] !== EMPTY) return false;
    board[index] = mark;
    let win = false;
    if (MODE === "free" || mark === WHITE) {
      win = Boolean(winAt(board, index));
    } else {
      // 黑棋只有恰好五连算胜；六连及以上是长连禁手，不是胜利。
      for (const direction of DIRECTIONS) {
        if (contiguousRun(board, index, BLACK, direction).length === 5) {
          win = true;
          break;
        }
      }
    }
    board[index] = EMPTY;
    return win;
  }

  /* 返回一条线（同一 direction）在 index 前后各 radius 格以内的所有索引。 */
  function lineWindow(board, index, direction, radius) {
    const [dr, dc] = direction;
    const row = Math.floor(index / SIZE);
    const column = index % SIZE;
    const result = [];
    for (let step = -radius; step <= radius; step += 1) {
      const nr = row + dr * step;
      const nc = column + dc * step;
      if (onBoard(nr, nc)) result.push(indexOf(nr, nc));
    }
    return result;
  }

  function sortedKey(indices) {
    return indices.slice().sort((a, b) => a - b).join(",");
  }

  function lineEndsOpen(board, line, direction) {
    const [dr, dc] = direction;
    const first = line[0];
    const last = line[line.length - 1];
    const fr = Math.floor(first / SIZE) - dr;
    const fc = (first % SIZE) - dc;
    const lr = Math.floor(last / SIZE) + dr;
    const lc = (last % SIZE) + dc;
    const openBefore = onBoard(fr, fc) && board[indexOf(fr, fc)] === EMPTY;
    const openAfter = onBoard(lr, lc) && board[indexOf(lr, lc)] === EMPTY;
    return openBefore && openAfter;
  }

  /* 黑棋三三禁手：统计该落子参与的“活三”个数。
   * 活三定义：存在一个空点 q，黑下在 q 后能形成两端全空的连续活四，
   * 且活四包含当前落子。按“活四中除 q 外的三颗黑子集合”去重。 */
  function openThreeGroups(board, index) {
    const groups = new Set();
    for (const direction of DIRECTIONS) {
      const windowCells = lineWindow(board, index, direction, 5);
      for (const q of windowCells) {
        if (q === index || board[q] !== EMPTY) continue;
        board[q] = BLACK;
        const line = contiguousRun(board, q, BLACK, direction);
        if (
          line.length === 4 &&
          line.includes(index) &&
          lineEndsOpen(board, line, direction)
        ) {
          const others = line.filter((cell) => cell !== q);
          groups.add(sortedKey(others));
        }
        board[q] = EMPTY;
      }
    }
    return groups.size;
  }

  /* 黑棋四四禁手：统计该落子参与的“四”的个数。
   * 四定义：存在一个空点 q，黑下在 q 后能形成五连。
   * 按“五连中除 q 外的四颗黑子集合”去重，因此活四只算一个四。 */
  function fourGroups(board, index) {
    const groups = new Set();
    for (const direction of DIRECTIONS) {
      const windowCells = lineWindow(board, index, direction, 5);
      for (const q of windowCells) {
        if (q === index || board[q] !== EMPTY) continue;
        board[q] = BLACK;
        const line = contiguousRun(board, q, BLACK, direction);
        if (line.length === 5 && line.includes(index)) {
          const others = line.filter((cell) => cell !== q);
          groups.add(sortedKey(others));
        }
        board[q] = EMPTY;
      }
    }
    return groups.size;
  }

  /* 长连：黑棋形成 6 个及以上连续子。 */
  function overlineLength(board, index) {
    let longest = 0;
    for (const direction of DIRECTIONS) {
      const line = contiguousRun(board, index, BLACK, direction);
      if (line.length > longest) longest = line.length;
    }
    return longest;
  }

  /* 假定 index 为空点，模拟 mark 落子，返回：
   * { legal, win, forbidden, reason } */
  function inspectMove(board, index, mark) {
    if (board[index] !== EMPTY) {
      return { legal: false, win: false, forbidden: false, reason: "occupied" };
    }
    if (MODE === "free") {
      board[index] = mark;
      const win = Boolean(winAt(board, index));
      board[index] = EMPTY;
      return { legal: true, win, forbidden: false, reason: win ? "five" : "" };
    }
    if (mark === WHITE) {
      board[index] = WHITE;
      const win = Boolean(winAt(board, index));
      board[index] = EMPTY;
      return { legal: true, win, forbidden: false, reason: win ? "five" : "" };
    }

    // 黑棋
    board[index] = BLACK;
    let exactFive = false;
    for (const direction of DIRECTIONS) {
      const line = contiguousRun(board, index, BLACK, direction);
      if (line.length === 5) {
        exactFive = true;
        break;
      }
    }
    if (exactFive) {
      board[index] = EMPTY;
      return { legal: true, win: true, forbidden: false, reason: "five" };
    }

    const overline = overlineLength(board, index) >= 6;
    const doubleFour = fourGroups(board, index) >= 2;
    const doubleThree = openThreeGroups(board, index) >= 2;

    board[index] = EMPTY;

    if (overline && doubleFour) {
      return { legal: false, win: false, forbidden: true, reason: "overline+double-four" };
    }
    if (overline && doubleThree) {
      return { legal: false, win: false, forbidden: true, reason: "overline+double-three" };
    }
    if (overline) {
      return { legal: false, win: false, forbidden: true, reason: "overline" };
    }
    if (doubleFour && doubleThree) {
      return { legal: false, win: false, forbidden: true, reason: "double-three+double-four" };
    }
    if (doubleFour) {
      return { legal: false, win: false, forbidden: true, reason: "double-four" };
    }
    if (doubleThree) {
      return { legal: false, win: false, forbidden: true, reason: "double-three" };
    }
    return { legal: true, win: false, forbidden: false, reason: "" };
  }

  function isMoveLegal(board, index, mark) {
    return inspectMove(board, index, mark).legal;
  }

  const Rules = {
    SIZE,
    CELL_COUNT,
    EMPTY,
    BLACK,
    WHITE,
    DIRECTIONS,
    setMode,
    getMode,
    other,
    onBoard,
    indexOf,
    contiguousRun,
    runLengths,
    winAt,
    isWinMove,
    lineWindow,
    lineEndsOpen,
    openThreeGroups,
    fourGroups,
    overlineLength,
    inspectMove,
    isMoveLegal
  };

  global.GomokuRules = Rules;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = Rules;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);


/* 棋型识别与评估模块。
 * 1) evaluate(board, mark)：全盘四方向扫描，返回 mark 视角的威胁评估分。
 * 2) movePotential(board, index, mark)：落子后该点产生的进攻威胁值，用于招法排序。
 */
(function (global) {
  "use strict";

  const RULES = global.GomokuRules;
  const SIZE = RULES.SIZE;
  const CELL_COUNT = RULES.CELL_COUNT;
  const EMPTY = RULES.EMPTY;
  const BLACK = RULES.BLACK;
  const WHITE = RULES.WHITE;
  const DIRECTIONS = RULES.DIRECTIONS;

  const SCORE = {
    WIN: 10000000,
    OPEN_FOUR: 1000000,
    FOUR: 120000,
    LIVE_THREE: 30000,
    SLEEP_THREE: 4500,
    LIVE_TWO: 900,
    SLEEP_TWO: 160,
    SINGLE: 20
  };

  // 预计算所有扫描线（长度 >= 5）。
  const LINES = (() => {
    const lines = [];
    for (let row = 0; row < SIZE; row += 1) {
      const line = [];
      for (let col = 0; col < SIZE; col += 1) line.push(row * SIZE + col);
      lines.push(line);
    }
    for (let col = 0; col < SIZE; col += 1) {
      const line = [];
      for (let row = 0; row < SIZE; row += 1) line.push(row * SIZE + col);
      lines.push(line);
    }
    for (let start = 0; start < SIZE; start += 1) {
      const down = [];
      const up = [];
      for (let step = 0; step < SIZE - start; step += 1) {
        down.push((start + step) * SIZE + step);
        up.push((start + step) * SIZE + (SIZE - 1 - step));
      }
      if (down.length >= 5) lines.push(down);
      if (up.length >= 5) lines.push(up);
      if (start > 0) {
        const down2 = [];
        const up2 = [];
        for (let step = 0; step < SIZE - start; step += 1) {
          down2.push(step * SIZE + (start + step));
          up2.push(step * SIZE + (SIZE - 1 - start - step));
        }
        if (down2.length >= 5) lines.push(down2);
        if (up2.length >= 5) lines.push(up2);
      }
    }
    return lines;
  })();

  const LINES_BY_INDEX = (() => {
    const result = [];
    for (let i = 0; i < CELL_COUNT; i += 1) result.push([]);
    for (let li = 0; li < LINES.length; li += 1) {
      const cells = LINES[li];
      for (const index of cells) result[index].push(li);
    }
    return result;
  })();

  const LINE_BUFFERS = LINES.map(() => ({ black: new Int8Array(17), white: new Int8Array(17) }));
  const USED_BUFFERS = LINES.map(() => ({ black: new Uint8Array(17), white: new Uint8Array(17) }));

  function encodeCells(board, cells, mark, buffer) {
    buffer[0] = 2; // 边界用 2
    const n = cells.length;
    for (let i = 0; i < n; i += 1) {
      const value = board[cells[i]];
      buffer[i + 1] = value === mark ? 1 : value === EMPTY ? 0 : 2;
    }
    buffer[n + 1] = 2;
    return buffer;
  }

  function matchPattern(line, used, start, pattern) {
    for (let i = 0; i < pattern.length; i += 1) {
      if (used[start + i] || line[start + i] !== pattern[i]) return false;
    }
    return true;
  }

  function markRange(used, start, length) {
    for (let i = 0; i < length; i += 1) used[start + i] = 1;
  }

  function countShape(line, used, pattern, score) {
    let total = 0;
    const n = line.length - pattern.length;
    for (let start = 0; start <= n; start += 1) {
      if (!matchPattern(line, used, start, pattern)) continue;
      total += score;
      markRange(used, start, pattern.length);
    }
    return total;
  }

  function windowMarks(line, start, length) {
    let marks = 0;
    let empties = 0;
    for (let i = 0; i < length; i += 1) {
      if (line[start + i] === 1) marks += 1;
      else if (line[start + i] === 0) empties += 1;
    }
    return { marks, empties };
  }

  /* 对一条扫描线（已编码，两端是边界 2）按棋型优先级打分。 */
  function scoreEncodedLine(line, used) {
    used.fill(0);
    let score = 0;

    // 五连直接返回，避免重复计分。
    for (let start = 0; start + 5 <= line.length; start += 1) {
      if (matchPattern(line, used, start, [1, 1, 1, 1, 1])) {
        return SCORE.WIN;
      }
    }

    // 活四：011110
    score += countShape(line, used, [0, 1, 1, 1, 1, 0], SCORE.OPEN_FOUR);

    // 冲四：包含一端被封或带跳的四。
    const fours = [
      [2, 1, 1, 1, 1, 0],
      [0, 1, 1, 1, 1, 2],
      [1, 0, 1, 1, 1],
      [1, 1, 0, 1, 1],
      [1, 1, 1, 0, 1]
    ];
    for (const pattern of fours) {
      score += countShape(line, used, pattern, SCORE.FOUR);
    }

    // 活三：连续活三和两种跳活三。
    score += countShape(line, used, [0, 1, 1, 1, 0], SCORE.LIVE_THREE);
    score += countShape(line, used, [0, 1, 1, 0, 1, 0], SCORE.LIVE_THREE);
    score += countShape(line, used, [0, 1, 0, 1, 1, 0], SCORE.LIVE_THREE);

    // 眠三：未被更高棋型消耗掉的“5 窗内 3 子”都按眠三处理。
    const n3 = line.length - 5;
    for (let start = 0; start <= n3; start += 1) {
      if (used[start + 2] || windowMarks(line, start, 5).marks !== 3) continue;
      score += SCORE.SLEEP_THREE;
      markRange(used, start, 5);
    }

    // 活二：5 窗内 2 子。
    for (let start = 0; start <= n3; start += 1) {
      if (used[start + 2] || windowMarks(line, start, 5).marks !== 2) continue;
      score += SCORE.LIVE_TWO;
      markRange(used, start, 5);
    }

    // 眠二 / 单子：5 窗内 1 子。
    for (let start = 0; start <= n3; start += 1) {
      if (used[start + 2]) continue;
      const { marks, empties } = windowMarks(line, start, 5);
      if (marks === 1 && empties === 4) {
        score += SCORE.SINGLE;
        markRange(used, start, 5);
      }
    }
    return score;
  }

  function scoreLine(board, cells, mark, buffer, used) {
    return scoreEncodedLine(encodeCells(board, cells, mark, buffer), used);
  }

  /* 计算一条扫描线对黑白双方的分值贡献。 */
  function linePairScore(board, li) {
    const cells = LINES[li];
    const buffers = LINE_BUFFERS[li];
    const used = USED_BUFFERS[li];
    const black = scoreLine(board, cells, BLACK, buffers.black, used.black);
    const white = scoreLine(board, cells, WHITE, buffers.white, used.white);
    return { black, white };
  }

  function evaluatePair(board) {
    let black = 0;
    let white = 0;
    for (let li = 0; li < LINES.length; li += 1) {
      const pair = linePairScore(board, li);
      black += pair.black;
      white += pair.white;
    }
    return { black, white };
  }

  /* 只计算经过 index 的四条线，用于搜索中的增量评估。 */
  function linePairScoreAt(board, index) {
    let black = 0;
    let white = 0;
    for (const li of LINES_BY_INDEX[index]) {
      const pair = linePairScore(board, li);
      black += pair.black;
      white += pair.white;
    }
    return { black, white };
  }

  function pairValue(pair, mark) {
    return mark === BLACK ? pair.black - pair.white : pair.white - pair.black;
  }

  function evaluate(board, mark) {
    return pairValue(evaluatePair(board), mark);
  }

  /* 预分配局部窗口，避免搜索中反复分配数组。 */
  const LOCAL_WINDOW = new Int8Array(11);
  const NORMALIZED_WINDOW = new Int8Array(11);

  function localLine(board, index, direction) {
    const [dr, dc] = direction;
    const row = Math.floor(index / SIZE);
    const column = index % SIZE;
    for (let step = -5; step <= 5; step += 1) {
      const nr = row + dr * step;
      const nc = column + dc * step;
      if (!RULES.onBoard(nr, nc)) {
        LOCAL_WINDOW[step + 5] = -1;
      } else {
        LOCAL_WINDOW[step + 5] = board[nr * SIZE + nc];
      }
    }
    return LOCAL_WINDOW;
  }

  function lineContainsCenter(normalized, pattern, center) {
    const n = normalized.length - pattern.length;
    for (let start = 0; start <= n; start += 1) {
      if (start + pattern.length <= center || start > center) continue;
      let ok = true;
      for (let i = 0; i < pattern.length; i += 1) {
        if (normalized[start + i] !== pattern[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  }

  function shapeScoreOnLine(line, center, mark) {
    // 归一化到预分配数组：1=己方，0=空，2=对方/边界。
    for (let i = 0; i < line.length; i += 1) {
      const value = line[i];
      NORMALIZED_WINDOW[i] = value === mark ? 1 : value === EMPTY ? 0 : 2;
    }
    const normalized = NORMALIZED_WINDOW;

    // 连续长度与开放端。
    let count = 1;
    let openEnds = 0;
    for (const sign of [-1, 1]) {
      let step = 1;
      let open = false;
      while (center + sign * step >= 0 && center + sign * step < normalized.length) {
        const value = normalized[center + sign * step];
        if (value === 1) count += 1;
        else if (value === 0) {
          open = true;
          break;
        } else {
          break;
        }
        step += 1;
      }
      if (open) openEnds += 1;
    }

    if (count >= 5) return SCORE.WIN;
    if (count === 4) {
      if (openEnds === 2) return SCORE.OPEN_FOUR;
      if (openEnds === 1) return SCORE.FOUR;
    }

    // 带跳冲四 / 眠三 / 活二：统计包含中心的 5 窗。
    const n5 = normalized.length - 5;
    let fourSeen = false;
    let liveThreeSeen = false;
    let threeSeen = false;
    let twoSeen = false;
    for (let start = 0; start <= n5; start += 1) {
      if (start + 5 <= center || start > center) continue;
      let marks = 0;
      let zeros = 0;
      for (let i = 0; i < 5; i += 1) {
        if (normalized[start + i] === 1) marks += 1;
        else if (normalized[start + i] === 0) zeros += 1;
      }
      if (marks === 4 && zeros === 1) fourSeen = true;
      if (marks === 3 && zeros === 2) threeSeen = true;
      if (marks === 2 && zeros === 3) twoSeen = true;
    }

    // 跳活三：6 窗内形成 011010 或 010110。
    liveThreeSeen =
      lineContainsCenter(normalized, [0, 1, 1, 0, 1, 0], center) ||
      lineContainsCenter(normalized, [0, 1, 0, 1, 1, 0], center);
    if (!liveThreeSeen && count === 3 && openEnds === 2) liveThreeSeen = true;

    if (fourSeen) return SCORE.FOUR;
    if (liveThreeSeen) return SCORE.LIVE_THREE;
    if (threeSeen) return SCORE.SLEEP_THREE;
    if (twoSeen) return SCORE.LIVE_TWO;
    if (count === 1) return SCORE.SINGLE;
    return 0;
  }

  /* 若 mark 落在 index，该点产生的进攻价值。 */
  function movePotential(board, index, mark) {
    if (board[index] !== EMPTY) return 0;
    board[index] = mark;
    let total = 0;
    let highThreats = 0;
    for (const direction of DIRECTIONS) {
      const value = shapeScoreOnLine(localLine(board, index, direction), 5, mark);
      total += value;
      if (value >= SCORE.LIVE_THREE) highThreats += 1;
    }
    board[index] = EMPTY;
    // 组合威胁加成：同一点同时产生多个活三/活四时非常危险。
    if (highThreats >= 2) total += Math.floor(total * 0.35);
    return total;
  }

  const Patterns = {
    LINES,
    LINES_BY_INDEX,
    LINE_BUFFERS,
    USED_BUFFERS,
    SCORE,
    encodeCells,
    scoreEncodedLine,
    scoreLine,
    linePairScore,
    evaluatePair,
    linePairScoreAt,
    pairValue,
    evaluate,
    localLine,
    shapeScoreOnLine,
    movePotential
  };

  global.GomokuPatterns = Patterns;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = Patterns;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);


/* 候选点生成与招法排序。 */
(function (global) {
  "use strict";

  const RULES = global.GomokuRules;
  const PATTERNS = global.GomokuPatterns;
  const SIZE = RULES.SIZE;
  const CELL_COUNT = RULES.CELL_COUNT;
  const EMPTY = RULES.EMPTY;
  const BLACK = RULES.BLACK;
  const WHITE = RULES.WHITE;
  const DIRECTIONS = RULES.DIRECTIONS;
  const CENTER = Math.floor(CELL_COUNT / 2);

  function candidateSet(board, radius) {
    const r = radius || 2;
    const seen = new Uint8Array(CELL_COUNT);
    const result = [];
    let occupied = 0;
    for (let index = 0; index < CELL_COUNT; index += 1) {
      if (!board[index]) continue;
      occupied += 1;
      const row = Math.floor(index / SIZE);
      const column = index % SIZE;
      const r0 = Math.max(0, row - r);
      const r1 = Math.min(SIZE - 1, row + r);
      const c0 = Math.max(0, column - r);
      const c1 = Math.min(SIZE - 1, column + r);
      for (let nr = r0; nr <= r1; nr += 1) {
        for (let nc = c0; nc <= c1; nc += 1) {
          const at = nr * SIZE + nc;
          if (!board[at] && !seen[at]) {
            seen[at] = 1;
            result.push(at);
          }
        }
      }
    }
    if (!occupied) return [CENTER];
    return result;
  }

  function runScoreQuick(count, openEnds) {
    if (count >= 5) return 10000000;
    if (count === 4) return openEnds === 2 ? 900000 : openEnds === 1 ? 90000 : 0;
    if (count === 3) return openEnds === 2 ? 25000 : openEnds === 1 ? 2500 : 0;
    if (count === 2) return openEnds === 2 ? 700 : openEnds === 1 ? 100 : 0;
    if (count === 1) return openEnds === 2 ? 12 : openEnds === 1 ? 2 : 0;
    return 0;
  }

  function quickPointScore(board, index, mark) {
    let score = 0;
    for (const [dr, dc] of DIRECTIONS) {
      const row = Math.floor(index / SIZE);
      const column = index % SIZE;
      let count = 1;
      let openEnds = 0;
      for (const sign of [-1, 1]) {
        let step = 1;
        let open = false;
        while (step < 5) {
          const nr = row + dr * sign * step;
          const nc = column + dc * sign * step;
          if (!RULES.onBoard(nr, nc)) break;
          const value = board[nr * SIZE + nc];
          if (value === mark) count += 1;
          else if (value === EMPTY) {
            open = true;
            break;
          } else {
            break;
          }
          step += 1;
        }
        if (open) openEnds += 1;
      }
      score += runScoreQuick(count, openEnds);

      for (let offset = -4; offset <= 0; offset += 1) {
        const c = centerOfWindow(index, offset, dr, dc);
        if (c === null) continue;
        let marks = 0;
        let empties = 0;
        for (let step = 0; step < 5; step += 1) {
          const nr = Math.floor(index / SIZE) + dr * (offset + step);
          const nc = (index % SIZE) + dc * (offset + step);
          const value = board[nr * SIZE + nc];
          if (value === mark) marks += 1;
          else if (value === EMPTY) empties += 1;
        }
        if (marks === 4 && empties === 1) score += 80000;
        else if (marks === 3 && empties === 2) score += 1800;
        else if (marks === 2 && empties === 3) score += 120;
      }
    }
    return score;
  }

  /* 同时计算进攻与防守快速分，减少一次方向扫描。 */
  function quickPairScore(board, index, mark) {
    const opponent = RULES.other(mark);
    let attack = 0;
    let defense = 0;
    for (const [dr, dc] of DIRECTIONS) {
      const row = Math.floor(index / SIZE);
      const column = index % SIZE;
      let ownCount = 1;
      let ownOpen = 0;
      let oppCount = 1;
      let oppOpen = 0;
      for (const sign of [-1, 1]) {
        let step = 1;
        let ownOpenSide = false;
        let oppOpenSide = false;
        let ownDone = false;
        let oppDone = false;
        while (step < 5 && (!ownDone || !oppDone)) {
          const nr = row + dr * sign * step;
          const nc = column + dc * sign * step;
          if (!RULES.onBoard(nr, nc)) break;
          const value = board[nr * SIZE + nc];
          if (!ownDone) {
            if (value === mark) ownCount += 1;
            else if (value === EMPTY) {
              ownOpenSide = true;
              ownDone = true;
            } else {
              ownDone = true;
            }
          }
          if (!oppDone) {
            if (value === opponent) oppCount += 1;
            else if (value === EMPTY) {
              oppOpenSide = true;
              oppDone = true;
            } else {
              oppDone = true;
            }
          }
          step += 1;
        }
        if (ownOpenSide) ownOpen += 1;
        if (oppOpenSide) oppOpen += 1;
      }
      attack += runScoreQuick(ownCount, ownOpen);
      defense += runScoreQuick(oppCount, oppOpen);

      for (let offset = -4; offset <= 0; offset += 1) {
        const c = centerOfWindow(index, offset, dr, dc);
        if (c === null) continue;
        let ownMarks = 0;
        let oppMarks = 0;
        let empties = 0;
        for (let step = 0; step < 5; step += 1) {
          const nr = Math.floor(index / SIZE) + dr * (offset + step);
          const nc = (index % SIZE) + dc * (offset + step);
          const value = board[nr * SIZE + nc];
          if (value === mark) ownMarks += 1;
          else if (value === opponent) oppMarks += 1;
          else if (value === EMPTY) empties += 1;
        }
        if (ownMarks === 4 && empties === 1) attack += 80000;
        else if (ownMarks === 3 && empties === 2) attack += 1800;
        else if (ownMarks === 2 && empties === 3) attack += 120;
        if (oppMarks === 4 && empties === 1) defense += 80000;
        else if (oppMarks === 3 && empties === 2) defense += 1800;
        else if (oppMarks === 2 && empties === 3) defense += 120;
      }
    }
    return attack + defense;
  }

  function centerOfWindow(index, offset, dr, dc) {
    const nr = Math.floor(index / SIZE) + dr * offset;
    const nc = (index % SIZE) + dc * offset;
    if (!RULES.onBoard(nr, nc)) return null;
    return nr * SIZE + nc;
  }

  /* 生成带评分的候选招法。默认先快筛再精排。 */
  function rankedMoves(board, mark, limit, options) {
    const opts = options || {};
    const width = opts.width || 18;
    const prefilter = opts.prefilter || 48;
    const ttMove = opts.ttMove === undefined ? -1 : opts.ttMove;
    const killers = opts.killers || [];
    const history = opts.history || null;
    const opponent = RULES.other(mark);

    const candidates = candidateSet(board, 2);
    if (candidates.length === 1 && candidates[0] === CENTER && !board[CENTER]) {
      return [{ index: CENTER, score: 0, attack: 0, defense: 0, priority: 0 }];
    }

    // 先快速粗排。
    const quick = new Array(candidates.length);
    for (let i = 0; i < candidates.length; i += 1) {
      const index = candidates[i];
      quick[i] = { index, quick: quickPairScore(board, index, mark) };
    }
    quick.sort((a, b) => b.quick - a.quick);

    const pool = [];
    const take = Math.min(prefilter, quick.length);
    for (let i = 0; i < take; i += 1) pool.push(quick[i].index);

    // 成五点与挡五点从全部候选中强制进入候选池，避免快筛漏掉。
    for (const index of candidates) {
      if (pool.includes(index) || board[index] !== EMPTY) continue;
      if (RULES.isWinMove(board, index, mark) || RULES.isWinMove(board, index, opponent)) {
        pool.push(index);
      }
    }
    // 置换表首选手进入候选池（用于排序，不替代战术强制点）。
    if (ttMove >= 0 && !pool.includes(ttMove)) pool.push(ttMove);

    // 精排。
    const scored = [];
    const winMoves = [];
    const blockMoves = [];
    for (const index of pool) {
      if (board[index] !== EMPTY) continue;
      const inspect = RULES.inspectMove(board, index, mark);
      if (!inspect.legal) continue;
      let attack = PATTERNS.movePotential(board, index, mark);
      let defense = PATTERNS.movePotential(board, index, opponent);
      let priority = 0;
      if (inspect.win) {
        priority = 1000000000;
        winMoves.push(index);
      } else if (RULES.isWinMove(board, index, opponent)) {
        priority = 900000000;
        defense += 5000000;
        blockMoves.push(index);
      } else if (attack >= PATTERNS.SCORE.OPEN_FOUR) {
        priority = 800000000;
      } else if (defense >= PATTERNS.SCORE.OPEN_FOUR) {
        priority = 700000000;
      }
      const historyBonus = history ? Math.min(history[mark][index], 24000) : 0;
      scored.push({
        index,
        attack,
        defense,
        score: attack + Math.floor(defense * 0.94) + priority,
        priority,
        historyBonus
      });
    }

    scored.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.index - b.index;
    });

    // 若有一击制胜点，只保留这些点，极大缩小分支。
    if (winMoves.length > 0) {
      const chosen = winMoves.slice(0, Math.max(1, Math.min(winMoves.length, width)));
      return chosen.map((index) => {
        const item = scored.find((entry) => entry.index === index);
        return item || { index, score: 1000000000, attack: 10000000, defense: 0, priority: 1000000000 };
      });
    }

    // 对方成五点必须全部保留。
    const result = [];
    const seen = new Set();
    for (const index of blockMoves) {
      const item = scored.find((entry) => entry.index === index);
      if (item) {
        result.push(item);
        seen.add(index);
      }
    }
    for (const item of scored) {
      if (result.length >= width) break;
      if (seen.has(item.index)) continue;
      result.push(item);
      seen.add(item.index);
    }
    if (ttMove >= 0 && !seen.has(ttMove)) {
      const item = scored.find((entry) => entry.index === ttMove);
      if (item) result.push(item);
    }
    const killerRank = (index) => {
      if (index === killers[0]) return 0;
      if (index === killers[1]) return 1;
      return 2;
    };
    result.sort((a, b) => {
      if (a.index === ttMove) return -1;
      if (b.index === ttMove) return 1;
      const ak = killerRank(a.index);
      const bk = killerRank(b.index);
      if (ak !== bk) return ak - bk;
      const av = a.score + (a.historyBonus || 0);
      const bv = b.score + (b.historyBonus || 0);
      return bv - av;
    });
    return result.slice(0, width);
  }

  function findImmediateWin(board, mark) {
    const candidates = candidateSet(board, 2);
    for (const index of candidates) {
      if (board[index] === EMPTY && RULES.isWinMove(board, index, mark)) return index;
    }
    return -1;
  }

  const MoveGen = {
    candidateSet,
    quickPointScore,
    quickPairScore,
    rankedMoves,
    findImmediateWin
  };

  global.GomokuMoveGen = MoveGen;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = MoveGen;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);


/* 搜索模块：Negamax + PVS + αβ + Zobrist 置换表 + 迭代加深。 */
(function (global) {
  "use strict";

  const RULES = global.GomokuRules;
  const PATTERNS = global.GomokuPatterns;
  const MOVEGEN = global.GomokuMoveGen;
  const SIZE = RULES.SIZE;
  const CELL_COUNT = RULES.CELL_COUNT;
  const EMPTY = RULES.EMPTY;
  const BLACK = RULES.BLACK;
  const WHITE = RULES.WHITE;

  const INF = 1000000000;
  const MATE = 100000000;

  // 确定性伪随机数，保证哈希可复现。
  function makeZobrist() {
    let seed = 0x9e3779b9;
    const rand = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) || 1;
    };
    const table = [];
    for (let color = 0; color < 3; color += 1) {
      table.push(new Uint32Array(CELL_COUNT));
      for (let i = 0; i < CELL_COUNT; i += 1) table[color][i] = rand();
    }
    return table;
  }
  const ZOBRIST = makeZobrist();
  const TURN_HASH = [0, ZOBRIST[BLACK][0], ZOBRIST[WHITE][0]];

  function hashBoard(board) {
    let hash = 0;
    for (let i = 0; i < CELL_COUNT; i += 1) {
      const value = board[i];
      if (value) hash = (hash ^ ZOBRIST[value][i]) >>> 0;
    }
    return hash >>> 0;
  }

  function keyFor(board, mark) {
    return ((hashBoard(board) ^ TURN_HASH[mark]) >>> 0);
  }

  function keyForHash(hash, mark) {
    return ((hash ^ TURN_HASH[mark]) >>> 0);
  }

  function deadlinePassed(state) {
    if (state.deadline === 0) return false;
    return performance.now() > state.deadline;
  }

  function evaluateLeaf(pair, mark, state) {
    if (state && deadlinePassed(state)) state.stop = true;
    return PATTERNS.pairValue(pair, mark);
  }

  /* 主搜索。返回 { score, move, nodes }。score 从当前 mark 视角。 */
  function pvs(board, mark, depth, alpha, beta, ply, state, tt, boardHash, pair) {
    state.nodes += 1;
    if ((state.nodes & 511) === 0 && deadlinePassed(state)) {
      state.stop = true;
      return { score: evaluateLeaf(pair, mark, state), move: -1 };
    }

    if (boardHash === undefined) boardHash = hashBoard(board);
    const key = keyForHash(boardHash, mark);
    const entry = state.noTT ? undefined : tt.get(key);
    const ttMove = entry && entry.move !== undefined ? entry.move : -1;
    const alpha0 = alpha;

    if (!state.noTT && entry && entry.depth >= depth && entry.key === key) {
      let score = entry.score;
      if (score >= MATE - 100) score -= ply;
      else if (score <= -MATE + 100) score += ply;
      if (entry.flag === 0) return { score, move: entry.move, tt: true };
      if (entry.flag === 1 && score <= alpha) return { score, move: entry.move, tt: true };
      if (entry.flag === 2 && score >= beta) return { score, move: entry.move, tt: true };
    }

    if (depth <= 0) {
      const score = evaluateLeaf(pair, mark, state);
      tt.set(key, { key, depth: 0, flag: 0, score, move: -1 });
      return { score, move: -1 };
    }

    const useRootWidth = ply === 0 && state.rootWidth > 0;
    const width = useRootWidth ? state.rootWidth : state.width;
    const prefilter = useRootWidth ? state.rootPrefilter : state.prefilter;
    const killers = state.killers[ply] || [-1, -1];
    const moves = MOVEGEN.rankedMoves(board, mark, width, {
      width,
      prefilter,
      ttMove,
      killers,
      history: state.history
    });
    if (!moves.length) {
      const score = 0;
      if (!state.noTT) tt.set(key, { key, depth, flag: 0, score, move: -1 });
      return { score, move: -1 };
    }

    let bestMove = moves[0].index;
    let bestScore = -INF;
    let flag = 1; // upper bound

    for (let i = 0; i < moves.length; i += 1) {
      const index = moves[i].index;
      const before = PATTERNS.linePairScoreAt(board, index);
      board[index] = mark;
      const after = PATTERNS.linePairScoreAt(board, index);
      const childPair = {
        black: pair.black - before.black + after.black,
        white: pair.white - before.white + after.white
      };
      const win = RULES.winAt(board, index);
      let score;
      if (win) {
        score = MATE - ply;
      } else {
        let nextDepth = depth - 1;
        // 强制着法延伸：一方刚形成冲四/活四时多搜一层。
        const attack = moves[i].attack;
        if (attack >= PATTERNS.SCORE.FOUR && depth <= 3) nextDepth += 1;
        const childHash = (boardHash ^ ZOBRIST[mark][index]) >>> 0;
        let child;
        if (i === 0) {
          child = pvs(board, RULES.other(mark), nextDepth, -beta, -alpha, ply + 1, state, tt, childHash, childPair);
        } else {
          child = pvs(board, RULES.other(mark), nextDepth, -alpha - 1, -alpha, ply + 1, state, tt, childHash, childPair);
          const zeroScore = -child.score;
          if (!state.stop && zeroScore > alpha && zeroScore < beta) {
            child = pvs(board, RULES.other(mark), nextDepth, -beta, -alpha, ply + 1, state, tt, childHash, childPair);
          }
        }
        score = -child.score;
      }
      board[index] = EMPTY;

      if (state.stop) {
        if (bestScore === -INF) bestScore = score;
        break;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMove = index;
      }
      if (bestScore > alpha) {
        alpha = bestScore;
        flag = 0; // exact
      }
      if (alpha >= beta) {
        flag = 2; // lower bound
        if (killers[0] !== index) {
          killers[1] = killers[0];
          killers[0] = index;
        }
        state.history[mark][index] += depth * depth;
        break;
      }
    }

    if (!state.noTT) tt.set(key, { key, depth, flag, score: bestScore, move: bestMove });
    return { score: bestScore, move: bestMove };
  }

  function iterate(board, mark, timeMs, maxDepth, opts) {
    const options = opts || {};
    const tt = new Map();
    const start = performance.now();
    const state = {
      nodes: 0,
      stop: false,
      deadline: start + timeMs,
      width: options.width || 12,
      prefilter: options.prefilter || 20,
      rootWidth: options.rootWidth || options.width || 16,
      rootPrefilter: options.rootPrefilter || options.prefilter || 32,
      killers: Array.from({ length: 64 }, () => [-1, -1]),
      history: [new Int32Array(CELL_COUNT), new Int32Array(CELL_COUNT), new Int32Array(CELL_COUNT)]
    };
    const rootPair = PATTERNS.evaluatePair(board);
    let best = null;
    let bestDepth = 0;
    let lastScore = 0;
    for (let depth = 2; depth <= maxDepth; depth += 1) {
      const before = state.nodes;
      // 简单渐进窗口：上一轮分数附近先试零窗口。
      let alpha = -INF;
      let beta = INF;
      let result;
      if (depth >= 4 && Math.abs(lastScore) < MATE - 200) {
        const windowSize = 6000 + depth * 1500;
        result = pvs(board, mark, depth, lastScore - windowSize, lastScore + windowSize, 0, state, tt, undefined, rootPair);
        if (!state.stop && (result.score <= lastScore - windowSize || result.score >= lastScore + windowSize)) {
          result = pvs(board, mark, depth, -INF, INF, 0, state, tt, undefined, rootPair);
        }
      } else {
        result = pvs(board, mark, depth, -INF, INF, 0, state, tt, undefined, rootPair);
      }
      if (state.stop) break;
      best = result;
      bestDepth = depth;
      lastScore = result.score;
      if (result.score >= MATE - 200) break;
      if (performance.now() - start > timeMs * 0.9 && depth >= 6) break;
    }
    return {
      index: best ? best.move : -1,
      score: best ? best.score : PATTERNS.pairValue(rootPair, mark),
      depth: bestDepth,
      nodes: state.nodes,
      timeMs: performance.now() - start
    };
  }

  const Search = {
    MATE,
    INF,
    hashBoard,
    keyFor,
    pvs,
    iterate
  };

  global.GomokuSearch = Search;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = Search;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);


/* 战术求解：
 * - VCF：连续冲四取胜。
 * - VCT-lite：先做活三，随后进入 VCF；用于补齐“活三做杀”的第一层证明。
 */
(function (global) {
  "use strict";

  const RULES = global.GomokuRules;
  const MOVEGEN = global.GomokuMoveGen;
  const SIZE = RULES.SIZE;
  const CELL_COUNT = RULES.CELL_COUNT;
  const EMPTY = RULES.EMPTY;
  const BLACK = RULES.BLACK;
  const WHITE = RULES.WHITE;
  const DIRECTIONS = RULES.DIRECTIONS;

  const MAX_VCF_DEPTH = 16;

  /* 全局：所有“再走一手即成五”的空点。黑棋长连不算成五。 */
  function winningPoints(board, attacker) {
    const result = [];
    const seen = new Set();
    const candidates = MOVEGEN.candidateSet(board, 2);
    for (const index of candidates) {
      if (seen.has(index) || board[index] !== EMPTY) continue;
      if (RULES.isWinMove(board, index, attacker)) {
        seen.add(index);
        result.push(index);
      }
    }
    return result;
  }

  /* 已落 index 后，该点参与产生的所有成五威胁点。 */
  function winningPointsForMove(board, index, attacker) {
    const result = [];
    const seen = new Set();
    for (const direction of DIRECTIONS) {
      const cells = RULES.lineWindow(board, index, direction, 5);
      for (const q of cells) {
        if (seen.has(q) || q === index || board[q] !== EMPTY) continue;
        if (RULES.isWinMove(board, q, attacker)) {
          seen.add(q);
          result.push(q);
        }
      }
    }
    return result;
  }

  /* 已落 index 后，该点参与产生的所有“活三点”：
   * 攻击方若下在 q，能形成两端全空的连续活四。 */
  function openThreePointsForMove(board, index, attacker) {
    const result = [];
    const seen = new Set();
    for (const direction of DIRECTIONS) {
      const cells = RULES.lineWindow(board, index, direction, 5);
      for (const q of cells) {
        if (seen.has(q) || q === index || board[q] !== EMPTY) continue;
        board[q] = attacker;
        const line = RULES.contiguousRun(board, q, attacker, direction);
        if (line.length === 4 && line.includes(index) && RULES.lineEndsOpen(board, line, direction)) {
          seen.add(q);
          result.push(q);
        }
        board[q] = EMPTY;
      }
    }
    return result;
  }

  /* 生成所有能形成“四”的强制手（不含直接成五）。 */
  function forcingMoves(board, attacker) {
    const result = [];
    const candidates = MOVEGEN.candidateSet(board, 2);
    for (const index of candidates) {
      if (board[index] !== EMPTY) continue;
      const inspect = RULES.inspectMove(board, index, attacker);
      if (!inspect.legal || inspect.win) continue;
      board[index] = attacker;
      const points = winningPointsForMove(board, index, attacker);
      board[index] = EMPTY;
      if (points.length >= 1) result.push({ index, points, winPoints: points });
    }
    result.sort((a, b) => b.points.length - a.points.length || a.index - b.index);
    return result;
  }

  /* 生成所有只做活三、不直接形成四的进攻手。 */
  function openThreeMoves(board, attacker) {
    const result = [];
    const candidates = MOVEGEN.candidateSet(board, 2);
    for (const index of candidates) {
      if (board[index] !== EMPTY) continue;
      const inspect = RULES.inspectMove(board, index, attacker);
      if (!inspect.legal || inspect.win) continue;
      board[index] = attacker;
      const points = winningPointsForMove(board, index, attacker);
      let threes = [];
      if (points.length === 0) {
        threes = openThreePointsForMove(board, index, attacker);
      }
      board[index] = EMPTY;
      if (threes.length >= 1) result.push({ index, threePoints: threes });
    }
    result.sort((a, b) => b.threePoints.length - a.threePoints.length || a.index - b.index);
    return result;
  }

  function makeHash(board, attacker, depth) {
    let hash = attacker + ":" + depth + ":";
    let mix = 0;
    for (let i = 0; i < CELL_COUNT; i += 1) {
      const value = board[i];
      if (value) mix = (mix * 31 + (value + 1) * (i + 1)) | 0;
    }
    return hash + mix;
  }

  /* VCF：连续冲四取胜。 */
  function dfsVcf(board, attacker, defender, depth, seen, deadline) {
    if (deadline && performance.now() > deadline) throw new Error("vcf-timeout");
    if (depth > MAX_VCF_DEPTH) return null;

    const immediate = MOVEGEN.findImmediateWin(board, attacker);
    if (immediate >= 0) return [immediate];

    if (MOVEGEN.findImmediateWin(board, defender) >= 0) return null;

    const key = makeHash(board, attacker, depth);
    if (seen.has(key)) return null;
    seen.add(key);

    const attacks = forcingMoves(board, attacker);
    for (const attack of attacks) {
      const index = attack.index;
      board[index] = attacker;
      const points = attack.winPoints;

      // 一手形成两个成五点：对手只能挡一个，我方必胜。
      if (points.length >= 2) {
        board[index] = EMPTY;
        return [index];
      }
      if (points.length === 0) {
        board[index] = EMPTY;
        continue;
      }

      const defenses = points.filter((q) => {
        if (board[q] !== EMPTY) return false;
        return RULES.isMoveLegal(board, q, defender);
      });
      if (!defenses.length) {
        board[index] = EMPTY;
        return [index];
      }

      let allDefensesSolved = true;
      for (const q of defenses) {
        board[q] = defender;
        if (RULES.winAt(board, q)) {
          board[q] = EMPTY;
          allDefensesSolved = false;
          break;
        }
        const rest = dfsVcf(board, attacker, defender, depth + 1, seen, deadline);
        board[q] = EMPTY;
        if (!rest) {
          allDefensesSolved = false;
          break;
        }
      }

      board[index] = EMPTY;
      if (allDefensesSolved) {
        return [index];
      }
    }
    return null;
  }

  /* 返回连续冲四的第一手杀棋点；找不到返回 -1。 */
  function cloneForTactics(board) {
    const copy = new Uint8Array(CELL_COUNT);
    for (let i = 0; i < CELL_COUNT; i += 1) copy[i] = board[i];
    return copy;
  }

  function findVcf(board, attacker, timeMs) {
    if (!board.some((value) => value)) return -1;
    const work = cloneForTactics(board);
    const defender = RULES.other(attacker);
    const seen = new Set();
    const deadline = timeMs ? performance.now() + timeMs : 0;
    try {
      const path = dfsVcf(work, attacker, defender, 0, seen, deadline);
      return path ? path[0] : -1;
    } catch (error) {
      if (error && error.message === "vcf-timeout") return -1;
      throw error;
    }
  }

  /* 根层活三的防守点生成：
   * 1) 所有活三点
   * 2) 活三相关直线 ±5 内的空点（覆盖堵两端、交叉点）
   * 3) 进攻点周围一圈
   * 4) 防守方所有四/活三反击点
   */
  function openThreeDefenses(board, attack, defender) {
    const set = new Set();
    for (const q of attack.threePoints) set.add(q);

    for (const direction of DIRECTIONS) {
      const cells = RULES.lineWindow(board, attack.index, direction, 5);
      for (const q of cells) {
        if (board[q] === EMPTY) set.add(q);
      }
    }

    const row = Math.floor(attack.index / SIZE);
    const column = attack.index % SIZE;
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        if (!dr && !dc) continue;
        const nr = row + dr;
        const nc = column + dc;
        if (RULES.onBoard(nr, nc)) {
          const q = nr * SIZE + nc;
          if (board[q] === EMPTY) set.add(q);
        }
      }
    }

    // 防守方自己的强制反击点。
    for (const gain of forcingMoves(board, defender)) {
      if (board[gain.index] === EMPTY) set.add(gain.index);
    }
    for (const gain of openThreeMoves(board, defender)) {
      if (board[gain.index] === EMPTY) set.add(gain.index);
    }

    return [...set].filter((q) => RULES.isMoveLegal(board, q, defender));
  }

  /* VCT-lite：先做活三，任意合法防守后仍存在 VCF，则证明取胜。 */
  function findVctLite(board, attacker, timeMs) {
    if (!board.some((value) => value)) return -1;
    const work = cloneForTactics(board);
    const defender = RULES.other(attacker);
    const deadline = timeMs ? performance.now() + timeMs : 0;
    const attacks = openThreeMoves(work, attacker);
    if (!attacks.length) return -1;

    for (const attack of attacks) {
      if (deadline && performance.now() > deadline) return -1;
      work[attack.index] = attacker;

      // 进攻后对方能直接成五，则这条做杀路线不成立。
      if (MOVEGEN.findImmediateWin(work, defender) >= 0) {
        work[attack.index] = EMPTY;
        continue;
      }

      const defenses = openThreeDefenses(work, attack, defender);
      if (!defenses.length) {
        work[attack.index] = EMPTY;
        return attack.index;
      }

      let allDefensesSolved = true;
      for (const q of defenses) {
        if (work[q] !== EMPTY) continue;
        work[q] = defender;
        let defenderWon = Boolean(RULES.winAt(work, q));
        let rest = -1;
        if (!defenderWon) {
          const remain = deadline ? deadline - performance.now() : 0;
          if (remain <= 0) {
            work[q] = EMPTY;
            work[attack.index] = EMPTY;
            return -1;
          }
          rest = findVcf(work, attacker, remain);
        }
        work[q] = EMPTY;
        if (defenderWon || rest < 0) {
          allDefensesSolved = false;
          break;
        }
      }

      work[attack.index] = EMPTY;
      if (allDefensesSolved) return attack.index;
    }
    return -1;
  }

  /* 生成所有四威胁或活三威胁手。 */
  function allThreatMoves(board, attacker) {
    const result = [];
    const candidates = MOVEGEN.candidateSet(board, 2);
    for (const index of candidates) {
      if (board[index] !== EMPTY) continue;
      const inspect = RULES.inspectMove(board, index, attacker);
      if (!inspect.legal || inspect.win) continue;
      board[index] = attacker;
      const winPoints = winningPointsForMove(board, index, attacker);
      const threePoints = winPoints.length ? [] : openThreePointsForMove(board, index, attacker);
      board[index] = EMPTY;
      if (winPoints.length || threePoints.length) {
        result.push({ index, winPoints, threePoints });
      }
    }
    result.sort((a, b) => (
      b.winPoints.length - a.winPoints.length ||
      b.threePoints.length - a.threePoints.length ||
      a.index - b.index
    ));
    return result;
  }

  /* 完整威胁空间搜索：允许连续活三做杀 + 连续冲四。 */
  function tss(board, attacker, defender, depth, state, seen) {
    state.nodes += 1;
    if (state.deadline && performance.now() > state.deadline) throw new Error("vct-timeout");
    if (state.maxNodes && state.nodes > state.maxNodes) throw new Error("vct-node-limit");
    if (depth > state.maxDepth) return null;

    const immediate = MOVEGEN.findImmediateWin(board, attacker);
    if (immediate >= 0) return [immediate];

    if (MOVEGEN.findImmediateWin(board, defender) >= 0) return null;

    const key = makeHash(board, attacker, depth);
    if (seen.has(key)) return null;
    seen.add(key);

    const attacks = allThreatMoves(board, attacker);
    if (!attacks.length) return null;

    for (const attack of attacks) {
      if (state.deadline && performance.now() > state.deadline) throw new Error("vct-timeout");
      const index = attack.index;
      board[index] = attacker;

      if (attack.winPoints.length >= 2) {
        board[index] = EMPTY;
        return [index];
      }

      let defenses;
      if (attack.winPoints.length === 1) {
        defenses = attack.winPoints.filter((q) => (
          board[q] === EMPTY && RULES.isMoveLegal(board, q, defender)
        ));
      } else {
        defenses = openThreeDefenses(board, attack, defender);
      }

      if (!defenses.length) {
        board[index] = EMPTY;
        return [index];
      }

      let allDefensesSolved = true;
      for (const q of defenses) {
        board[q] = defender;
        if (RULES.winAt(board, q)) {
          board[q] = EMPTY;
          allDefensesSolved = false;
          break;
        }
        const rest = tss(board, attacker, defender, depth + 1, state, seen);
        board[q] = EMPTY;
        if (!rest) {
          allDefensesSolved = false;
          break;
        }
      }

      board[index] = EMPTY;
      if (allDefensesSolved) return [index];
    }
    return null;
  }

  /* 完整 VCT：连续活三/冲四的威胁空间搜索。 */
  function findVct(board, attacker, timeMs, maxDepth) {
    if (!board.some((value) => value)) return -1;
    const work = cloneForTactics(board);
    const defender = RULES.other(attacker);
    const state = {
      deadline: timeMs ? performance.now() + timeMs : 0,
      maxDepth: maxDepth || 10,
      maxNodes: 0,
      nodes: 0
    };
    const seen = new Set();
    try {
      const path = tss(work, attacker, defender, 0, state, seen);
      return path ? path[0] : -1;
    } catch (error) {
      if (error && (error.message === "vct-timeout" || error.message === "vct-node-limit")) return -1;
      throw error;
    }
  }

  const Threats = {
    MAX_VCF_DEPTH,
    winningPoints,
    winningPointsForMove,
    openThreePointsForMove,
    forcingMoves,
    openThreeMoves,
    openThreeDefenses,
    allThreatMoves,
    findVcf,
    findVctLite,
    findVct
  };

  global.GomokuThreats = Threats;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = Threats;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);


/* 开局库：目前采用“启发式开局策略”，只在前两手提供稳定选择，
 * 避免时间搜索在对称局面里随机摇摆。命名开局库（花月/浦月等）
 * 后续有可靠数据源时再补。
 */
(function (global) {
  "use strict";

  const RULES = global.GomokuRules;
  const MOVEGEN = global.GomokuMoveGen;
  const PATTERNS = global.GomokuPatterns;
  const SIZE = RULES.SIZE;
  const CELL_COUNT = RULES.CELL_COUNT;
  const CENTER = Math.floor(CELL_COUNT / 2);

  function stoneCount(board) {
    let count = 0;
    for (let i = 0; i < CELL_COUNT; i += 1) {
      if (board[i]) count += 1;
    }
    return count;
  }

  function centerAndAdjacencyScore(board, index, mark) {
    const opponent = RULES.other(mark);
    const row = Math.floor(index / SIZE);
    const column = index % SIZE;
    const centerDistance = Math.abs(row - 7) + Math.abs(column - 7);

    let nearOpponent = 0;
    for (let i = 0; i < CELL_COUNT; i += 1) {
      if (board[i] !== opponent) continue;
      const distance = Math.abs(Math.floor(i / SIZE) - row) + Math.abs((i % SIZE) - column);
      if (distance <= 2) nearOpponent = Math.max(nearOpponent, 3 - distance);
    }

    const attack = PATTERNS.movePotential(board, index, mark);
    const defense = PATTERNS.movePotential(board, index, opponent);
    return attack + Math.floor(defense * 0.94) + 160 - centerDistance * 12 + nearOpponent * 220;
  }

  function find(board, mark) {
    const count = stoneCount(board);
    if (count === 0) return CENTER;
    if (count > 2) return -1;

    const moves = MOVEGEN.candidateSet(board, 2);
    let bestIndex = -1;
    let bestScore = -Infinity;
    for (const index of moves) {
      if (board[index] !== RULES.EMPTY) continue;
      if (!RULES.isMoveLegal(board, index, mark)) continue;
      const score = centerAndAdjacencyScore(board, index, mark);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    return bestIndex;
  }

  const Opening = {
    version: "0.2.0-heuristic",
    find
  };

  global.GomokuOpening = Opening;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = Opening;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);


/* AI 入口：即时胜负 -> VCF -> 迭代加深搜索。 */
(function (global) {
  "use strict";

  const RULES = global.GomokuRules;
  const MOVEGEN = global.GomokuMoveGen;
  const SEARCH = global.GomokuSearch;
  const THREATS = global.GomokuThreats;
  const OPENING = global.GomokuOpening;
  const PATTERNS = global.GomokuPatterns;
  const SIZE = RULES.SIZE;
  const CELL_COUNT = RULES.CELL_COUNT;
  const EMPTY = RULES.EMPTY;
  const BLACK = RULES.BLACK;
  const WHITE = RULES.WHITE;

  function cloneBoard(board) {
    const copy = new Uint8Array(CELL_COUNT);
    for (let i = 0; i < CELL_COUNT; i += 1) copy[i] = board[i];
    return copy;
  }

  function isBoardEmpty(board) {
    for (let i = 0; i < CELL_COUNT; i += 1) {
      if (board[i]) return false;
    }
    return true;
  }

  /* 入门：贪心 + 少量随机。 */
  function easyMove(board, mark) {
    if (isBoardEmpty(board)) return Math.floor(CELL_COUNT / 2);
    const immediate = MOVEGEN.findImmediateWin(board, mark);
    if (immediate >= 0) return immediate;
    const block = MOVEGEN.findImmediateWin(board, RULES.other(mark));
    if (block >= 0) return block;

    const moves = MOVEGEN.rankedMoves(board, mark, 10, { prefilter: 28, width: 10 });
    const topCount = Math.max(1, Math.min(4, moves.length));
    if (Math.random() < 0.45) {
      return moves[Math.floor(Math.random() * topCount)].index;
    }
    return moves[0].index;
  }

  /* 选择难度配置。 */
  function configFor(level) {
    if (level === "easy") return { timeMs: 30, maxDepth: 2, vcf: false };
    if (level === "hard") {
      return {
        timeMs: 4000,
        maxDepth: 14,
        vcf: true,
        vcfTime: 500,
        vct: true,
        vctTime: 300,
        search: { rootWidth: 20, rootPrefilter: 48, width: 10, prefilter: 16 }
      };
    }
    return {
      timeMs: 260,
      maxDepth: 7,
      vcf: true,
      vcfTime: 80,
      vct: true,
      vctTime: 80,
      search: { rootWidth: 14, rootPrefilter: 30, width: 8, prefilter: 12 }
    };
  }

  function bestMove(boardInput, mark, level, options) {
    const board = boardInput instanceof Uint8Array ? boardInput : cloneBoard(boardInput);
    const cfg = Object.assign({}, configFor(level || "hard"), options || {});
    const opponent = RULES.other(mark);
    const startedAt = performance.now();
    const remaining = () => Math.max(0, cfg.timeMs - (performance.now() - startedAt));

    if (isBoardEmpty(board)) {
      // 黑棋标准开局走天元。
      return { index: Math.floor(CELL_COUNT / 2), score: 0, depth: 0, nodes: 0, reason: "opening" };
    }

    // 开局库。
    const book = OPENING.find(board, mark);
    if (book >= 0) return { index: book, score: 0, depth: 0, nodes: 0, reason: "book" };

    // 1. 自己直接成五。
    const win = MOVEGEN.findImmediateWin(board, mark);
    if (win >= 0) return { index: win, score: SEARCH.MATE, depth: 0, nodes: 0, reason: "five" };

    // 2. 必须挡对方成五。
    const block = MOVEGEN.findImmediateWin(board, opponent);
    if (block >= 0) return { index: block, score: SEARCH.MATE - 1, depth: 0, nodes: 0, reason: "block-five" };

    // 3. VCF：连续冲四证明取胜。
    if (cfg.vcf) {
      try {
        const vcf = THREATS.findVcf(board, mark, Math.min(cfg.vcfTime, remaining()));
        if (vcf >= 0) return { index: vcf, score: SEARCH.MATE, depth: 0, nodes: 0, reason: "vcf" };
      } catch (error) {
        // 超时按无杀处理。
      }
    }

    // 4. VCT：先做活三，随后用 VCF 完成杀棋。
    if (cfg.vct) {
      try {
        const vct = THREATS.findVct(board, mark, Math.min(cfg.vctTime, remaining()));
        if (vct >= 0) return { index: vct, score: SEARCH.MATE, depth: 0, nodes: 0, reason: "vct" };
      } catch (error) {
        // 超时按无杀处理。
      }
    }

    // 5. 正常搜索。
    const result = SEARCH.iterate(board, mark, remaining(), cfg.maxDepth, cfg.search);
    if (result.index >= 0) {
      result.reason = "search";
      return result;
    }

    const fallback = MOVEGEN.rankedMoves(board, mark, 4, { prefilter: 24, width: 4 });
    return {
      index: fallback.length ? fallback[0].index : Math.floor(CELL_COUNT / 2),
      score: 0,
      depth: 0,
      nodes: 0,
      reason: "fallback"
    };
  }

  const Ai = {
    easyMove,
    bestMove,
    configFor
  };

  global.GomokuAi = Ai;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = Ai;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);


/* 桥接：浏览器下 window === globalThis；Node vm 测试下显式复制到 window。 */

(function () {
  "use strict";
  const g = typeof globalThis !== "undefined" ? globalThis : this;
  const names = ["GomokuRules", "GomokuPatterns", "GomokuMoveGen", "GomokuSearch", "GomokuThreats", "GomokuOpening", "GomokuAi"];
  for (const name of names) {
    if (g && g[name] && !window[name]) window[name] = g[name];
  }
})();

/* PR 版 AI 禁手开关：false 时 AI 不考虑禁手，按自由规则进攻。 */
const AI_CONSIDER_FORBIDDEN = true;
window.GomokuRules.setMode(AI_CONSIDER_FORBIDDEN ? "renju" : "free");

/* 补充公开接口：供朋友后续接玩家侧禁手规则。 */

(function () {
  "use strict";
  if (!window.GomokuRules || !window.GomokuCore) return;
  const base = window.GomokuCore;
  window.GomokuCore = Object.freeze(Object.assign({}, base, {
    inspectMove: window.GomokuRules.inspectMove,
    isMoveLegal: window.GomokuRules.isMoveLegal,
    setAiRenju: function (enabled) { window.GomokuRules.setMode(enabled ? "renju" : "free"); },
    getAiRenju: function () { return window.GomokuRules.getMode() === "renju"; },
    bestMoveInfo: function (board, mark, level, options) {
      return window.GomokuAi.bestMove(board, mark, level || "hard", options);
    }
  }));
})();

