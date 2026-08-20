// 五子棋核心逻辑（自研）：15×15 棋盘、胜负判定、候选点生成、三档 AI。
// 挂载为 global.GomokuCore，供 index.html 与联机层使用，也可在 Node 中直接测试。

(function (global) {
  "use strict";

  const CONFIGURED_SIZE = Number(global && global.GomokuBoardSize);
  const SIZE = Number.isInteger(CONFIGURED_SIZE) && CONFIGURED_SIZE >= 9 && CONFIGURED_SIZE <= 19
    ? CONFIGURED_SIZE
    : 15;
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

  function chooseAiMove(board, aiMark, level) {
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
    if (global.GomokuAi) {
      const info = global.GomokuAi.bestMove(board, aiMark, "hard");
      if (info && info.index >= 0 && board[info.index] === EMPTY) return info.index;
    }
    return rankedMoves(board, aiMark, 1)[0];
  }

  function aiMove(board, aiMark, level) {
    const preferred = chooseAiMove(board, aiMark, level);
    const rules = global.GomokuRules;
    if (!rules || rules.getMode() !== "renju" || aiMark !== BLACK) return preferred;
    if (preferred >= 0 && preferred < CELL_COUNT && rules.isMoveLegal(board, preferred, aiMark)) {
      return preferred;
    }
    for (const index of rankedMoves(board, aiMark, CELL_COUNT)) {
      if (rules.isMoveLegal(board, index, aiMark)) return index;
    }
    for (let index = 0; index < CELL_COUNT; index += 1) {
      if (rules.isMoveLegal(board, index, aiMark)) return index;
    }
    return -1;
  }

  global.GomokuCore = Object.freeze({
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
})(typeof globalThis !== "undefined" ? globalThis : this);

/* ============ 强化 hard 引擎 ============ */

(function () {
  "use strict";
  if (typeof globalThis.performance === "undefined") {
    globalThis.performance = { now: function () { return Date.now(); } };
  }
})();

/* 五子棋规则模块（标准连珠 / Renju）
 * - 棋盘尺寸由 GomokuBoardSize 参数决定（默认 15）。
 * - 黑棋禁手：三三、四四、长连（六连及以上）。
 * - 白棋无禁手，五连与长连均胜。
 * - 黑棋五连优先于同时形成的禁手。
 */
(function (global) {
  "use strict";

  const CONFIGURED_SIZE = Number(global && global.GomokuBoardSize);
  const SIZE = Number.isInteger(CONFIGURED_SIZE) && CONFIGURED_SIZE >= 9 && CONFIGURED_SIZE <= 19
    ? CONFIGURED_SIZE
    : 15;
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

  /* 预计算行/列，以及每个格子沿 4 个方向的射线和 ±5 窗口。
   * -1 表示越界。供 contiguousRun / lineWindow / 禁手检查复用。
   */
  const ROW = new Int8Array(CELL_COUNT);
  const COL = new Int8Array(CELL_COUNT);
  for (let i = 0; i < CELL_COUNT; i += 1) {
    ROW[i] = Math.floor(i / SIZE);
    COL[i] = i % SIZE;
  }
  const RAY_CELLS = (() => {
    const table = new Int16Array(CELL_COUNT * DIRECTIONS.length * 21);
    table.fill(-1);
    for (let index = 0; index < CELL_COUNT; index += 1) {
      const base = index * DIRECTIONS.length * 21;
      for (let d = 0; d < DIRECTIONS.length; d += 1) {
        const [dr, dc] = DIRECTIONS[d];
        const dirBase = base + d * 21;
        for (let step = -10; step <= 10; step += 1) {
          const nr = ROW[index] + dr * step;
          const nc = COL[index] + dc * step;
          if (onBoard(nr, nc)) table[dirBase + step + 10] = nr * SIZE + nc;
        }
      }
    }
    return table;
  })();
  const WINDOW_CELLS = (() => {
    const table = new Int16Array(CELL_COUNT * DIRECTIONS.length * 11);
    table.fill(-1);
    for (let index = 0; index < CELL_COUNT; index += 1) {
      const base = index * DIRECTIONS.length * 11;
      for (let d = 0; d < DIRECTIONS.length; d += 1) {
        const [dr, dc] = DIRECTIONS[d];
        const dirBase = base + d * 11;
        for (let step = -5; step <= 5; step += 1) {
          const nr = ROW[index] + dr * step;
          const nc = COL[index] + dc * step;
          if (onBoard(nr, nc)) table[dirBase + step + 5] = nr * SIZE + nc;
        }
      }
    }
    return table;
  })();

  /* 静态 ±5 窗口列表：radius=5 是禁手检查的唯一热点半径。
   * 预先生成只含合法格子的数组并复用，避免 fourGroups/openThreeGroups
   * 每次调用 lineWindowAt 都分配新数组。
   */
  const LINE_WINDOW_LISTS = (() => {
    const lists = new Array(CELL_COUNT);
    for (let index = 0; index < CELL_COUNT; index += 1) {
      const dirs = new Array(DIRECTIONS.length);
      const base = index * DIRECTIONS.length * 11;
      for (let d = 0; d < DIRECTIONS.length; d += 1) {
        const cells = [];
        const dirBase = base + d * 11;
        for (let step = -5; step <= 5; step += 1) {
          const at = WINDOW_CELLS[dirBase + step + 5];
          if (at >= 0) cells.push(at);
        }
        dirs[d] = Int16Array.from(cells);
      }
      lists[index] = dirs;
    }
    return lists;
  })();

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
  function contiguousRunAt(board, index, mark, directionIndex) {
    const base = (index * DIRECTIONS.length + directionIndex) * 21;
    const line = [index];
    for (const sign of [-1, 1]) {
      let step = 1;
      while (step <= 10) {
        const at = RAY_CELLS[base + 10 + sign * step];
        if (at < 0 || board[at] !== mark) break;
        if (sign === -1) line.unshift(at);
        else line.push(at);
        step += 1;
      }
    }
    return line;
  }

  function contiguousRun(board, index, mark, direction) {
    const d = typeof direction === "number" ? direction : DIRECTIONS.indexOf(direction);
    return contiguousRunAt(board, index, mark, d);
  }

  /* 落子 index 后，返回 mark 在四个方向上的连续长度。 */
  function runLengths(board, index, mark) {
    const result = [];
    for (let d = 0; d < DIRECTIONS.length; d += 1) {
      result.push({ direction: DIRECTIONS[d], line: contiguousRunAt(board, index, mark, d) });
    }
    return result;
  }

  /* 胜负判定：返回连成五（或长连）的格子数组；无则 null。 */
  function winAt(board, index) {
    const mark = board[index];
    if (!mark) return null;
    for (let d = 0; d < DIRECTIONS.length; d += 1) {
      const line = contiguousRunAt(board, index, mark, d);
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
      for (let d = 0; d < DIRECTIONS.length; d += 1) {
        if (contiguousRunAt(board, index, BLACK, d).length === 5) {
          win = true;
          break;
        }
      }
    }
    board[index] = EMPTY;
    return win;
  }

  /* 返回一条线（同一 direction）在 index 前后各 radius 格以内的所有索引。 */
  function lineWindowAt(board, index, directionIndex, radius) {
    if (radius === 5) return LINE_WINDOW_LISTS[index][directionIndex];
    const result = [];
    const base = (index * DIRECTIONS.length + directionIndex) * 11;
    for (let step = -radius; step <= radius; step += 1) {
      const at = WINDOW_CELLS[base + step + 5];
      if (at >= 0) result.push(at);
    }
    return result;
  }

  function lineWindow(board, index, direction, radius) {
    const d = typeof direction === "number" ? direction : DIRECTIONS.indexOf(direction);
    return lineWindowAt(board, index, d, radius);
  }

  /* 用 CELL_COUNT 进制整数替代字符串 key，避免热点里的 sort/join/字符串分配。 */
  function sortedKey(indices) {
    const sorted = indices.slice().sort((a, b) => a - b);
    let key = 0;
    for (const value of sorted) key = key * CELL_COUNT + value;
    return key;
  }

  function lineEndsOpen(board, line, directionIndex) {
    const d = typeof directionIndex === "number" ? directionIndex : DIRECTIONS.indexOf(directionIndex);
    const [dr, dc] = DIRECTIONS[d];
    const first = line[0];
    const last = line[line.length - 1];
    const fr = ROW[first] - dr;
    const fc = COL[first] - dc;
    const lr = ROW[last] + dr;
    const lc = COL[last] + dc;
    const openBefore = onBoard(fr, fc) && board[fr * SIZE + fc] === EMPTY;
    const openAfter = onBoard(lr, lc) && board[lr * SIZE + lc] === EMPTY;
    return openBefore && openAfter;
  }

  /* 黑棋三三禁手：统计该落子参与的“活三”个数。
   * 活三定义：存在一个空点 q，黑下在 q 后能形成两端全空的连续活四，
   * 且活四包含当前落子。按“活四中除 q 外的三颗黑子集合”去重。 */
  function openThreeGroups(board, index) {
    const groups = new Set();
    for (let d = 0; d < DIRECTIONS.length; d += 1) {
      const windowCells = lineWindowAt(board, index, d, 5);
      for (const q of windowCells) {
        if (q === index || board[q] !== EMPTY) continue;
        board[q] = BLACK;
        const line = contiguousRunAt(board, q, BLACK, d);
        if (
          line.length === 4 &&
          line.includes(index) &&
          lineEndsOpen(board, line, d)
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
    for (let d = 0; d < DIRECTIONS.length; d += 1) {
      const windowCells = lineWindowAt(board, index, d, 5);
      for (const q of windowCells) {
        if (q === index || board[q] !== EMPTY) continue;
        board[q] = BLACK;
        const line = contiguousRunAt(board, q, BLACK, d);
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
    for (let d = 0; d < DIRECTIONS.length; d += 1) {
      const line = contiguousRunAt(board, index, BLACK, d);
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
    for (let d = 0; d < DIRECTIONS.length; d += 1) {
      const line = contiguousRunAt(board, index, BLACK, d);
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

  /* 预计算：每个格子沿 4 个方向、±5 格以内的棋盘索引。
   * -1 表示越界。这是给 localLine/movePotential 使用的查询表，
   * 用空间换掉每步的 row/column 与 onBoard 运算。
   * flat 布局：((index * 4) + direction) * 11 + (step + 5)。
   */
  const LOCAL_LINE_CELLS = (() => {
    const table = new Int16Array(CELL_COUNT * DIRECTIONS.length * 11);
    table.fill(-1);
    for (let index = 0; index < CELL_COUNT; index += 1) {
      const row = Math.floor(index / SIZE);
      const column = index % SIZE;
      const base = index * DIRECTIONS.length * 11;
      for (let d = 0; d < DIRECTIONS.length; d += 1) {
        const [dr, dc] = DIRECTIONS[d];
        const lineBase = base + d * 11;
        for (let step = -5; step <= 5; step += 1) {
          const nr = row + dr * step;
          const nc = column + dc * step;
          if (RULES.onBoard(nr, nc)) {
            table[lineBase + step + 5] = nr * SIZE + nc;
          }
        }
      }
    }
    return table;
  })();

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

  /* 兼容旧签名：direction 也可以是 DIRECTIONS 数组。 */
  function localLine(board, index, direction) {
    let directionIndex = direction;
    if (!Number.isInteger(directionIndex)) {
      directionIndex = DIRECTIONS.indexOf(direction);
    }
    return localLineAt(board, index, directionIndex);
  }

  /* 从预计算表填充 LOCAL_WINDOW，避免每步重复计算坐标与越界。 */
  function localLineAt(board, index, directionIndex) {
    const base = (index * DIRECTIONS.length + directionIndex) * 11;
    for (let i = 0; i < 11; i += 1) {
      const at = LOCAL_LINE_CELLS[base + i];
      LOCAL_WINDOW[i] = at < 0 ? -1 : board[at];
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

  /* 对已归一化的 11 格窗口计算棋型分。 */
  function scoreNormalizedLine(normalized, center) {
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

  function shapeScoreOnLine(line, center, mark) {
    // 归一化到预分配数组：1=己方，0=空，2=对方/边界。
    for (let i = 0; i < line.length; i += 1) {
      const value = line[i];
      NORMALIZED_WINDOW[i] = value === mark ? 1 : value === EMPTY ? 0 : 2;
    }
    return scoreNormalizedLine(NORMALIZED_WINDOW, center);
  }

  /* 从同一条 raw line（center 为空）同时计算 mark 与 opponent 的棋型分。
   * 这样 movePotential 攻防只用填一次方向窗口，不用落两次子。 */
  /* 从同一条 raw line（center 为空）同时计算 mark 与 opponent 的棋型分。
   * center 固定为 5，只服务 movePotentialPair；一次扫描同时维护双方状态，
   * 不再对同一窗口归一化两次、评分两次。 */
  /* 从同一条 raw line（center 为空）同时计算 mark 与 opponent 的棋型分。
   * 实测合并成一次扫描在真实搜索里反而更慢（jumpSeen 引入额外开销），
   * 因此保留两遍归一化 + scoreNormalizedLine 的稳定版本。
   * TODO(perf)：若后续要合并，需要去掉每窗口的闭包/函数调用，重新做 profile。 */
  function shapePairOnRawLine(line, mark, opponent) {
    for (let i = 0; i < line.length; i += 1) {
      const value = line[i];
      NORMALIZED_WINDOW[i] = value === mark ? 1 : value === EMPTY ? 0 : 2;
    }
    NORMALIZED_WINDOW[5] = 1; // center 是本次要评估的落点
    const attack = scoreNormalizedLine(NORMALIZED_WINDOW, 5);

    for (let i = 0; i < line.length; i += 1) {
      const value = line[i];
      NORMALIZED_WINDOW[i] = value === opponent ? 1 : value === EMPTY ? 0 : 2;
    }
    NORMALIZED_WINDOW[5] = 1;
    const defense = scoreNormalizedLine(NORMALIZED_WINDOW, 5);
    return { attack, defense };
  }

  /* 同时计算 index 落 mark 的进攻分和落 opponent 的防守分。
   * 等价于旧 movePotential(board,index,mark) + movePotential(board,index,opponent)，
   * 但每个方向只填一次 LOCAL_WINDOW。 */
  function movePotentialPair(board, index, mark) {
    if (board[index] !== EMPTY) return { attack: 0, defense: 0 };
    const opponent = RULES.other(mark);
    let attack = 0;
    let defense = 0;
    let attackHighThreats = 0;
    let defenseHighThreats = 0;
    for (let d = 0; d < DIRECTIONS.length; d += 1) {
      const pair = shapePairOnRawLine(localLineAt(board, index, d), mark, opponent);
      attack += pair.attack;
      defense += pair.defense;
      if (pair.attack >= SCORE.LIVE_THREE) attackHighThreats += 1;
      if (pair.defense >= SCORE.LIVE_THREE) defenseHighThreats += 1;
    }
    // 组合威胁加成：同一点同时产生多个活三/活四时非常危险。
    // 注意旧 movePotential 对进攻和防守都各自计算该加成。
    if (attackHighThreats >= 2) attack += Math.floor(attack * 0.35);
    if (defenseHighThreats >= 2) defense += Math.floor(defense * 0.35);
    return { attack, defense };
  }

  /* 保留旧单边接口，供只需要进攻分的调用方使用。 */
  function movePotential(board, index, mark) {
    return movePotentialPair(board, index, mark).attack;
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
    LOCAL_LINE_CELLS,
    localLine,
    localLineAt,
    shapeScoreOnLine,
    shapePairOnRawLine,
    movePotentialPair,
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
  const CENTER = (() => { const c = Math.floor((SIZE - 1) / 2); return c * SIZE + c; })();

  /* 预计算行/列，避免候选粗排里反复 Math.floor / %。 */
  const ROW = new Int8Array(CELL_COUNT);
  const COL = new Int8Array(CELL_COUNT);
  for (let i = 0; i < CELL_COUNT; i += 1) {
    ROW[i] = Math.floor(i / SIZE);
    COL[i] = i % SIZE;
  }

  /* 预计算 quickPairScore 的 5 格窗口。
   * flat 布局：((index * 4) + direction) * 25 + (offset + 4) * 5 + step。
   * 起点越界时整窗保持 -1；起点合法但个别格子越界时也填 -1，
   * 与旧实现读 undefined 后不计入 marks/empties 的行为一致。
   */
  const QUICK_WINDOW_CELLS = (() => {
    const table = new Int16Array(CELL_COUNT * DIRECTIONS.length * 25);
    table.fill(-1);
    for (let index = 0; index < CELL_COUNT; index += 1) {
      const row = ROW[index];
      const column = COL[index];
      const base0 = index * DIRECTIONS.length * 25;
      for (let d = 0; d < DIRECTIONS.length; d += 1) {
        const [dr, dc] = DIRECTIONS[d];
        const dirBase = base0 + d * 25;
        for (let offset = -4; offset <= 0; offset += 1) {
          const startRow = row + dr * offset;
          const startCol = column + dc * offset;
          if (!RULES.onBoard(startRow, startCol)) continue;
          const winBase = dirBase + (offset + 4) * 5;
          for (let step = 0; step < 5; step += 1) {
            const nr = startRow + dr * step;
            const nc = startCol + dc * step;
            // 旧实现这里不检查 onBoard，直接用 row*SIZE+col 读棋盘；
            // 为保证分值完全一致，越界但索引落在 0..CELL_COUNT-1 时必须保留“绕行索引”。
            const at = nr * SIZE + nc;
            table[winBase + step] = (at >= 0 && at < CELL_COUNT) ? at : -1;
          }
        }
      }
    }
    return table;
  })();

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
    const lineBase0 = index * DIRECTIONS.length * 11;
    const windowBase0 = index * DIRECTIONS.length * 25;

    for (let d = 0; d < DIRECTIONS.length; d += 1) {
      // 1) 连续子与开放端：直接从预计算方向线读取。
      const lineBase = lineBase0 + d * 11;
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
          const at = PATTERNS.LOCAL_LINE_CELLS[lineBase + 5 + sign * step];
          if (at < 0) break;
          const value = board[at];
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

      // 2) 5 格窗口统计：从预计算窗口表读取，省掉 centerOfWindow 和坐标运算。
      const windowBase = windowBase0 + d * 25;
      for (let offset = -4; offset <= 0; offset += 1) {
        const base = windowBase + (offset + 4) * 5;
        if (QUICK_WINDOW_CELLS[base] < 0) continue;
        let ownMarks = 0;
        let oppMarks = 0;
        let empties = 0;
        for (let step = 0; step < 5; step += 1) {
          const at = QUICK_WINDOW_CELLS[base + step];
          const value = at < 0 ? -1 : board[at];
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

  function moveBucket(board, index, mark, attack, defense, inspect) {
    const opponent = RULES.other(mark);
    if (inspect && inspect.win) return 0;
    if (RULES.isWinMove(board, index, opponent)) return 1;
    if (attack >= PATTERNS.SCORE.OPEN_FOUR) return 2;
    if (defense >= PATTERNS.SCORE.OPEN_FOUR) return 3;
    if (attack >= PATTERNS.SCORE.FOUR) return 4;
    if (defense >= PATTERNS.SCORE.FOUR) return 5;
    return 9;
  }

  function moveStage(board, index, mark, attack, defense, inspect) {
    const opponent = RULES.other(mark);
    if (inspect && inspect.win) return 0;
    if (RULES.isWinMove(board, index, opponent)) return 1;
    if (attack >= PATTERNS.SCORE.OPEN_FOUR) return 2;
    if (defense >= PATTERNS.SCORE.OPEN_FOUR) return 3;
    if (attack >= PATTERNS.SCORE.FOUR) return 4;
    if (defense >= PATTERNS.SCORE.FOUR) return 5;
    if (attack >= PATTERNS.SCORE.LIVE_THREE && defense >= PATTERNS.SCORE.LIVE_THREE) return 6;
    if (attack >= PATTERNS.SCORE.LIVE_THREE) return 7;
    if (defense >= PATTERNS.SCORE.LIVE_THREE) return 8;
    return 9;
  }

  function stageBonus(stage) {
    switch (stage) {
      case 0: return 1000000000;
      case 1: return 900000000;
      case 2: return 180000;
      case 3: return 150000;
      case 4: return 90000;
      case 5: return 70000;
      case 6: return 32000;
      case 7: return 12000;
      case 8: return 9000;
      default: return 0;
    }
  }

  function urgentMoves(board, mark, limit) {
    const opponent = RULES.other(mark);
    const candidates = candidateSet(board, 2);
    const seen = new Uint8Array(CELL_COUNT);
    const result = [];

    function add(index, priority, reason, attack, defense) {
      if (index < 0 || seen[index] || board[index] !== EMPTY) return;
      const inspect = RULES.inspectMove(board, index, mark);
      if (!inspect.legal) return;
      seen[index] = 1;
      result.push({
        index,
        priority,
        reason,
        attack: attack || 0,
        defense: defense || 0,
        score: priority + (attack || 0) + Math.floor((defense || 0) * 0.94)
      });
    }

    for (const index of candidates) {
      if (board[index] !== EMPTY) continue;
      if (RULES.isWinMove(board, index, mark)) add(index, 1000000000, "win", PATTERNS.SCORE.WIN, 0);
    }
    for (const index of candidates) {
      if (board[index] !== EMPTY) continue;
      if (RULES.isWinMove(board, index, opponent)) add(index, 900000000, "block-win", 0, PATTERNS.SCORE.WIN);
    }

    for (const index of candidates) {
      if (board[index] !== EMPTY || seen[index]) continue;
      const inspect = RULES.inspectMove(board, index, mark);
      if (!inspect.legal) continue;
      const pair = PATTERNS.movePotentialPair(board, index, mark);
      const attack = pair.attack;
      const defense = pair.defense;
      if (attack >= PATTERNS.SCORE.OPEN_FOUR) add(index, 800000000, "open-four", attack, defense);
      else if (defense >= PATTERNS.SCORE.OPEN_FOUR) add(index, 760000000, "block-open-four", attack, defense);
      else if (attack >= PATTERNS.SCORE.FOUR) add(index, 620000000, "four", attack, defense);
      else if (defense >= PATTERNS.SCORE.FOUR) add(index, 590000000, "block-four", attack, defense);
      else if (attack >= PATTERNS.SCORE.LIVE_THREE && defense >= PATTERNS.SCORE.LIVE_THREE) {
        add(index, 360000000, "two-way-three", attack, defense);
      }
    }

    result.sort((a, b) => b.score - a.score || a.index - b.index);
    return result.slice(0, limit || result.length);
  }

  /* 生成带评分的候选招法。默认先快筛再精排。 */
  function rankedMoves(board, mark, limit, options) {
    const opts = options || {};
    const width = opts.width || 18;
    const prefilter = opts.prefilter || 48;
    const ttMove = opts.ttMove === undefined ? -1 : opts.ttMove;
    const killers = opts.killers || [];
    const history = opts.history || null;
    const staged = opts.staged === true;
    const opponent = RULES.other(mark);

    // TODO(phase-C)：候选列表可进一步完全增量维护；当前 SearchBoard 已保证顺序与旧版一致。
    const candidates = opts.candidates || candidateSet(board, 2);
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

    // 威胁视图候选注入：成五/挡五之外的冲四、活三点也强制进入候选池。
    // 这些点可能被 quickPairScore 快筛压出 prefilter，但往往是拆网/反杀关键。
    const threatState = opts.threatState || null;
    if (threatState) {
      const addThreatCells = (cells) => {
        for (const index of cells) {
          if (board[index] !== EMPTY || pool.includes(index)) continue;
          pool.push(index);
        }
      };
      addThreatCells(threatState.winCells(mark));
      addThreatCells(threatState.winCells(opponent));
      addThreatCells(threatState.fourCells(mark));
      addThreatCells(threatState.fourCells(opponent));
      addThreatCells(threatState.openThreeCells(mark));
      addThreatCells(threatState.openThreeCells(opponent));
    }

    // 节点级防守 VCF 感知传入的防守点：对手连续冲四杀首着的成五挡点。
    const defenseCells = opts.defenseCells || null;
    if (defenseCells) {
      for (const index of defenseCells) {
        if (board[index] !== EMPTY || pool.includes(index)) continue;
        pool.push(index);
      }
    }

    if (opts.urgent) {
      const urgent = urgentMoves(board, mark, opts.urgentLimit || Math.max(width, 12));
      for (const move of urgent) {
        if (!pool.includes(move.index)) pool.push(move.index);
      }
    }

    // 精排。
    const scored = [];
    const winMoves = [];
    const blockMoves = [];
    for (const index of pool) {
      if (board[index] !== EMPTY) continue;
      const inspect = RULES.inspectMove(board, index, mark);
      if (!inspect.legal) continue;
      const pair = PATTERNS.movePotentialPair(board, index, mark);
      let attack = pair.attack;
      let defense = pair.defense;
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
      // 威胁视图小额加分：不改变阶段归属，只在同阶段内打破同分 tie，
      // 让“挡冲四/挡活三/自己做威胁”的点优先于同样分数的普通点。
      let threatBonus = 0;
      if (threatState) {
        if (threatState.isWinCell(index, mark)) threatBonus += 2000000;
        else if (threatState.isWinCell(index, opponent)) threatBonus += 1500000;
        if (threatState.isFourCell(index, opponent)) threatBonus += 20000;
        if (threatState.isFourCell(index, mark)) threatBonus += 15000;
        if (threatState.isOpenThreeCell(index, opponent)) threatBonus += 8000;
        if (threatState.isOpenThreeCell(index, mark)) threatBonus += 6000;
      }
      // 防守 VCF 杀棋首着：这些点本身可能没有四/活三形状分，但能直接拆掉连续冲四。
      if (defenseCells && defenseCells.indexOf(index) >= 0) threatBonus += 240000;
      const bucket = opts.bucketOrder ? moveBucket(board, index, mark, attack, defense, inspect) : 9;
      const stage = staged ? moveStage(board, index, mark, attack, defense, inspect) : 9;
      scored.push({
        index,
        attack,
        defense,
        score: attack + Math.floor(defense * 0.94) + priority + threatBonus,
        priority,
        bucket,
        stage,
        stageBonus: staged ? stageBonus(stage) : 0,
        historyBonus
      });
    }

    scored.sort((a, b) => {
      if (opts.bucketOrder && a.bucket !== b.bucket) return a.bucket - b.bucket;
      const av = a.score + (a.stageBonus || 0);
      const bv = b.score + (b.stageBonus || 0);
      if (av !== bv) return bv - av;
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
    if (staged && blockMoves.length > 0) {
      return blockMoves.map((index) => scored.find((entry) => entry.index === index)).filter(Boolean).slice(0, width);
    }

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
      if (opts.bucketOrder && a.bucket !== b.bucket) return a.bucket - b.bucket;
      const av = a.score + (a.stageBonus || 0) + (a.historyBonus || 0);
      const bv = b.score + (b.stageBonus || 0) + (b.historyBonus || 0);
      return bv - av;
    });
    return result.slice(0, width);
  }

  function tacticalMoves(board, mark, limit, options) {
    const opts = options || {};
    const opponent = RULES.other(mark);
    const candidates = opts.candidates || candidateSet(board, 2);
    const result = [];
    const winMoves = [];
    const blockMoves = [];

    for (const index of candidates) {
      if (board[index] !== EMPTY) continue;
      const inspect = RULES.inspectMove(board, index, mark);
      if (!inspect.legal) continue;

      const opponentWin = RULES.isWinMove(board, index, opponent);
      let attack = 0;
      let defense = 0;
      let priority = 0;
      if (inspect.win) {
        attack = PATTERNS.SCORE.WIN;
        priority = 1000000000;
      } else if (opponentWin) {
        defense = PATTERNS.SCORE.WIN;
        priority = 900000000;
      } else {
        const pair = PATTERNS.movePotentialPair(board, index, mark);
        attack = pair.attack;
        defense = pair.defense;
        if (attack >= PATTERNS.SCORE.FOUR) priority = attack >= PATTERNS.SCORE.OPEN_FOUR ? 800000000 : 620000000;
        else if (defense >= PATTERNS.SCORE.FOUR) priority = defense >= PATTERNS.SCORE.OPEN_FOUR ? 700000000 : 560000000;
        else continue;
      }

      const stage = moveStage(board, index, mark, attack, defense, inspect);
      const item = {
        index,
        attack,
        defense,
        score: priority + attack + Math.floor(defense * 0.94) + stageBonus(stage),
        priority,
        stage,
        stageBonus: stageBonus(stage)
      };
      result.push(item);
      if (stage === 0) winMoves.push(item);
      else if (stage === 1) blockMoves.push(item);
    }

    const sorter = (a, b) => b.score - a.score || a.index - b.index;
    if (winMoves.length) return winMoves.sort(sorter).slice(0, limit || winMoves.length);
    if (blockMoves.length) return blockMoves.sort(sorter).slice(0, limit || blockMoves.length);
    result.sort(sorter);
    return result.slice(0, limit || opts.width || result.length);
  }

  function findImmediateWin(board, mark, candidates) {
    // TODO(VCT-cache)：候选列表可由 SearchBoard 提供，避免战术搜索里全盘生成。
    const pool = candidates || candidateSet(board, 2);
    for (const index of pool) {
      if (board[index] === EMPTY && RULES.isWinMove(board, index, mark)) return index;
    }
    return -1;
  }

  const MoveGen = {
    candidateSet,
    quickPointScore,
    quickPairScore,
    moveBucket,
    moveStage,
    urgentMoves,
    rankedMoves,
    tacticalMoves,
    findImmediateWin
  };

  global.GomokuMoveGen = MoveGen;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = MoveGen;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);


/* Structured threat analysis for staged move generation. */
(function (global) {
  "use strict";

  const RULES = global.GomokuRules;
  const PATTERNS = global.GomokuPatterns;
  const SIZE = RULES.SIZE;
  const EMPTY = RULES.EMPTY;
  const DIRECTIONS = RULES.DIRECTIONS;

  const KIND = {
    FORBIDDEN: "forbidden",
    FIVE: "five",
    OPEN_FOUR: "open-four",
    FOUR: "four",
    B4F3: "b4f3",
    DOUBLE_THREE: "double-three",
    OPEN_THREE: "open-three",
    QUIET: "quiet"
  };

  function addUnique(list, seen, index) {
    if (index < 0 || seen.has(index)) return;
    seen.add(index);
    list.push(index);
  }

  function uniqueSorted(values) {
    return [...new Set(values)].sort((a, b) => a - b);
  }

  function winningPointsFromPlaced(board, gain, attacker) {
    const result = [];
    const seen = new Set();
    for (const direction of DIRECTIONS) {
      const cells = RULES.lineWindow(board, gain, direction, 5);
      for (const q of cells) {
        if (q === gain || board[q] !== EMPTY) continue;
        if (RULES.isWinMove(board, q, attacker)) addUnique(result, seen, q);
      }
    }
    return result;
  }

  function openThreePointsFromPlaced(board, gain, attacker) {
    const result = [];
    const seen = new Set();
    for (const direction of DIRECTIONS) {
      const cells = RULES.lineWindow(board, gain, direction, 5);
      for (const q of cells) {
        if (q === gain || board[q] !== EMPTY) continue;
        board[q] = attacker;
        const line = RULES.contiguousRun(board, q, attacker, direction);
        if (line.length === 4 && line.includes(gain) && RULES.lineEndsOpen(board, line, direction)) {
          addUnique(result, seen, q);
        }
        board[q] = EMPTY;
      }
    }
    return result;
  }

  function threatSeverity(kind) {
    switch (kind) {
      case KIND.FIVE: return 100;
      case KIND.OPEN_FOUR: return 90;
      case KIND.FOUR: return 80;
      case KIND.B4F3: return 70;
      case KIND.DOUBLE_THREE: return 60;
      case KIND.OPEN_THREE: return 45;
      default: return 0;
    }
  }

  function threatScore(kind, attack, costs, threePoints) {
    const base = threatSeverity(kind) * 100000;
    return base + attack + costs.length * 24000 + threePoints.length * 8000;
  }

  function nearbyRests(board, gain, mark) {
    const rests = [];
    const seen = new Set();
    const row = Math.floor(gain / SIZE);
    const column = gain % SIZE;
    for (const [dr, dc] of DIRECTIONS) {
      for (const sign of [-1, 1]) {
        for (let step = 1; step <= 4; step += 1) {
          const nr = row + dr * sign * step;
          const nc = column + dc * sign * step;
          if (!RULES.onBoard(nr, nc)) break;
          const at = nr * SIZE + nc;
          if (board[at] === mark) addUnique(rests, seen, at);
          else if (board[at] !== EMPTY) break;
        }
      }
    }
    return rests;
  }

  function analyzeMove(board, index, mark) {
    if (board[index] !== EMPTY) {
      return {
        gain: index,
        mark,
        legal: false,
        forbiddenReason: "occupied",
        kind: KIND.FORBIDDEN,
        costs: [],
        threePoints: [],
        rests: [],
        attack: 0,
        severity: 0,
        score: 0
      };
    }

    const inspect = RULES.inspectMove(board, index, mark);
    if (!inspect.legal) {
      return {
        gain: index,
        mark,
        legal: false,
        forbiddenReason: inspect.reason || "illegal",
        kind: KIND.FORBIDDEN,
        costs: [],
        threePoints: [],
        rests: [],
        attack: 0,
        severity: 0,
        score: 0
      };
    }

    const attack = PATTERNS.movePotential(board, index, mark);
    if (inspect.win) {
      return {
        gain: index,
        mark,
        legal: true,
        forbiddenReason: "",
        kind: KIND.FIVE,
        costs: [],
        threePoints: [],
        rests: nearbyRests(board, index, mark),
        attack,
        severity: threatSeverity(KIND.FIVE),
        score: threatScore(KIND.FIVE, attack, [], [])
      };
    }

    board[index] = mark;
    const costs = winningPointsFromPlaced(board, index, mark);
    const threePoints = openThreePointsFromPlaced(board, index, mark);
    const rests = nearbyRests(board, index, mark);
    board[index] = EMPTY;

    let kind = KIND.QUIET;
    if (costs.length >= 2) kind = KIND.OPEN_FOUR;
    else if (costs.length === 1 && threePoints.length > 0) kind = KIND.B4F3;
    else if (costs.length === 1) kind = KIND.FOUR;
    else if (threePoints.length >= 2) kind = KIND.DOUBLE_THREE;
    else if (threePoints.length === 1) kind = KIND.OPEN_THREE;

    return {
      gain: index,
      mark,
      legal: true,
      forbiddenReason: "",
      kind,
      costs: uniqueSorted(costs),
      threePoints: uniqueSorted(threePoints),
      rests,
      attack,
      severity: threatSeverity(kind),
      score: threatScore(kind, attack, costs, threePoints)
    };
  }

  function analyzePair(board, index, mark) {
    const opponent = RULES.other(mark);
    const self = analyzeMove(board, index, mark);
    const opp = analyzeMove(board, index, opponent);
    return {
      index,
      mark,
      opponent,
      self,
      opponentThreat: opp,
      attack: self.attack,
      defense: opp.attack,
      score: self.score + Math.floor(opp.score * 0.94)
    };
  }

  const ThreatModel = {
    KIND,
    analyzeMove,
    analyzePair,
    winningPointsFromPlaced,
    openThreePointsFromPlaced,
    threatSeverity
  };

  global.GomokuThreatModel = ThreatModel;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = ThreatModel;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);


/* Staged move picker for tactical positions. */
(function (global) {
  "use strict";

  const RULES = global.GomokuRules;
  const MOVEGEN = global.GomokuMoveGen;
  const THREAT = global.GomokuThreatModel;
  const CELL_COUNT = RULES.CELL_COUNT;
  const EMPTY = RULES.EMPTY;

  const STAGE = {
    SELF_FIVE: 0,
    DEFEND_OPP_FIVE: 1,
    SELF_OPEN_FOUR: 2,
    DEFEND_OPP_OPEN_FOUR: 3,
    SELF_FOUR: 4,
    DEFEND_OPP_FOUR: 5,
    DOUBLE_THREAT: 6,
    MAIN: 9
  };

  function stageFor(pair) {
    const kind = THREAT.KIND;
    if (pair.self.kind === kind.FIVE) return STAGE.SELF_FIVE;
    if (pair.opponentThreat.kind === kind.FIVE) return STAGE.DEFEND_OPP_FIVE;
    if (pair.self.kind === kind.OPEN_FOUR) return STAGE.SELF_OPEN_FOUR;
    if (pair.opponentThreat.kind === kind.OPEN_FOUR) return STAGE.DEFEND_OPP_OPEN_FOUR;
    if (pair.self.kind === kind.FOUR || pair.self.kind === kind.B4F3) return STAGE.SELF_FOUR;
    if (pair.opponentThreat.kind === kind.FOUR || pair.opponentThreat.kind === kind.B4F3) return STAGE.DEFEND_OPP_FOUR;
    if (pair.self.kind === kind.DOUBLE_THREE || pair.opponentThreat.kind === kind.DOUBLE_THREE) return STAGE.DOUBLE_THREAT;
    return STAGE.MAIN;
  }

  function stagePriority(stage) {
    switch (stage) {
      case STAGE.SELF_FIVE: return 1000000000;
      case STAGE.DEFEND_OPP_FIVE: return 900000000;
      case STAGE.SELF_OPEN_FOUR: return 760000000;
      case STAGE.DEFEND_OPP_OPEN_FOUR: return 700000000;
      case STAGE.SELF_FOUR: return 520000000;
      case STAGE.DEFEND_OPP_FOUR: return 480000000;
      case STAGE.DOUBLE_THREAT: return 220000000;
      default: return 0;
    }
  }

  function addCandidate(pool, seen, board, index) {
    if (index < 0 || index >= CELL_COUNT || seen[index] || board[index] !== EMPTY) return;
    seen[index] = 1;
    pool.push(index);
  }

  function candidatePool(board, mark, opts) {
    const seen = new Uint8Array(CELL_COUNT);
    const pool = [];
    const candidates = MOVEGEN.candidateSet(board, 2);
    for (const index of candidates) addCandidate(pool, seen, board, index);

    const ttMove = opts.ttMove === undefined ? -1 : opts.ttMove;
    addCandidate(pool, seen, board, ttMove);
    return pool;
  }

  function toMove(pair, stage, opts) {
    const history = opts.history || null;
    const historyBonus = history ? Math.min(history[pair.mark][pair.index], 24000) : 0;
    const priority = stagePriority(stage);
    return {
      index: pair.index,
      attack: pair.attack,
      defense: pair.defense,
      score: priority + pair.score,
      priority,
      stage,
      threat: pair.self,
      opponentThreat: pair.opponentThreat,
      historyBonus
    };
  }

  function sortMoves(moves, opts) {
    const ttMove = opts.ttMove === undefined ? -1 : opts.ttMove;
    const killers = opts.killers || [];
    const killerRank = (index) => {
      if (index === killers[0]) return 0;
      if (index === killers[1]) return 1;
      return 2;
    };
    moves.sort((a, b) => {
      if (a.index === ttMove) return -1;
      if (b.index === ttMove) return 1;
      if (a.stage !== b.stage) return a.stage - b.stage;
      const ak = killerRank(a.index);
      const bk = killerRank(b.index);
      if (ak !== bk) return ak - bk;
      const av = a.score + (a.historyBonus || 0);
      const bv = b.score + (b.historyBonus || 0);
      if (av !== bv) return bv - av;
      return a.index - b.index;
    });
    return moves;
  }

  function forcedCutoffStage(stage) {
    return stage <= STAGE.DEFEND_OPP_FIVE || stage === STAGE.SELF_OPEN_FOUR;
  }

  function pickForced(board, mark, limit, options) {
    const opts = options || {};
    const moves = pick(board, mark, limit, opts);
    if (!moves.length) return [];
    const bestStage = moves[0].stage;
    if (!forcedCutoffStage(bestStage)) return [];
    return moves.filter((move) => move.stage === bestStage);
  }

  function pick(board, mark, limit, options) {
    const opts = options || {};
    const width = limit || opts.width || 18;
    const pool = candidatePool(board, mark, opts);
    if (!pool.length) return [];

    const moves = [];
    let bestStage = STAGE.MAIN;
    for (const index of pool) {
      const pair = THREAT.analyzePair(board, index, mark);
      if (!pair.self.legal) continue;
      const stage = stageFor(pair);
      if (stage < bestStage) bestStage = stage;
      moves.push(toMove(pair, stage, opts));
    }

    if (!moves.length) return [];

    const sorted = sortMoves(moves, opts);
    if (forcedCutoffStage(bestStage)) {
      return sorted.filter((move) => move.stage === bestStage).slice(0, width);
    }
    return sorted.slice(0, width);
  }

  const MovePicker = {
    STAGE,
    stageFor,
    pick,
    pickForced
  };

  global.GomokuMovePicker = MovePicker;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = MovePicker;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);


/* 搜索共享棋盘状态（A+B 缓存）。
 *
 * A：线分缓存。
 *   整盘扫描线是固定集合，落一子只影响经过该点的 4 条线。
 *   这里缓存每条线的黑/白分值，搜索中的 before/after 评估改为读缓存。
 *
 * B：候选集生成优化。
 *   维护升序 stones 列表，candidateList() 只遍历已有棋子（而非全盘 121 格），
 *   并严格复刻 MOVEGEN.candidateSet 的发现顺序，保证搜索树与旧版一致。
 *
 * TODO(phase-C)：如果后续还要继续提速，可以把 candidateList() 改成
 * nearCount + 有序候选列表的完全增量维护；当前实现先保证行为一致和 undo 正确。
 */
(function (global) {
  "use strict";

  const RULES = global.GomokuRules;
  const PATTERNS = global.GomokuPatterns;
  const SIZE = RULES.SIZE;
  const CELL_COUNT = RULES.CELL_COUNT;
  const EMPTY = RULES.EMPTY;
  const LINES = PATTERNS.LINES;
  const LINES_BY_INDEX = PATTERNS.LINES_BY_INDEX;
  const CENTER = Math.floor((SIZE - 1) / 2) * SIZE + Math.floor((SIZE - 1) / 2);
  const BLACK = RULES.BLACK;
  const WHITE = RULES.WHITE;

  /* 把一条线编码为 [2, ..., 2]：1=己方，0=空，2=对方/边界。 */
  function encodeLine(board, line, mark) {
    const enc = new Int8Array(line.length + 2);
    enc[0] = 2;
    enc[line.length + 1] = 2;
    for (let i = 0; i < line.length; i += 1) {
      const value = board[line[i]];
      enc[i + 1] = value === mark ? 1 : value === EMPTY ? 0 : 2;
    }
    return enc;
  }

  /* 从一条编码线推导三类威胁点。
   * isBlack 用于黑棋长连语义：只有“恰好形成五连”才算成五/四的证明点。
   * 返回去重后的 line 下标数组（不是棋盘 index）。
   */
  function computeLineThreats(line, enc, isBlack) {
    const n = line.length;
    const win = [];
    const four = [];
    const three = [];
    const seenWin = new Uint8Array(n);
    const seenFour = new Uint8Array(n);
    const seenThree = new Uint8Array(n);

    for (let p = 1; p + 4 <= n; p += 1) {
      let ones = 0;
      let zeroPos = -1;
      for (let j = 0; j < 5; j += 1) {
        const v = enc[p + j];
        if (v === 1) ones += 1;
        else if (v === 0) zeroPos = p + j;
      }
      if (ones === 4 && zeroPos >= 0) {
        // 白棋只要五连；黑棋要求窗口外不是黑子，避免形成长连。
        if (!isBlack || (enc[p - 1] !== 1 && enc[p + 5] !== 1)) {
          const cell = zeroPos - 1;
          if (!seenWin[cell]) {
            seenWin[cell] = 1;
            win.push(cell);
          }
        }
      }
      if (ones === 3) {
        let zeros = 0;
        const zeroCells = [];
        for (let j = 0; j < 5; j += 1) {
          if (enc[p + j] === 0) {
            zeros += 1;
            zeroCells.push(p + j - 1);
          }
        }
        if (zeros === 2 && (!isBlack || (enc[p - 1] !== 1 && enc[p + 5] !== 1))) {
          for (const cell of zeroCells) {
            if (!seenFour[cell]) {
              seenFour[cell] = 1;
              four.push(cell);
            }
          }
        }
      }
    }

    for (let p = 1; p + 5 <= n; p += 1) {
      if (enc[p] !== 0 || enc[p + 5] !== 0) continue;
      let ones = 0;
      const zeroCells = [];
      for (let j = 1; j <= 4; j += 1) {
        const v = enc[p + j];
        if (v === 1) ones += 1;
        else if (v === 0) zeroCells.push(p + j - 1);
      }
      if (ones === 2 && zeroCells.length === 2) {
        for (const cell of zeroCells) {
          if (!seenThree[cell]) {
            seenThree[cell] = 1;
            three.push(cell);
          }
        }
      }
    }

    return { win, four, three };
  }

  /* 按升序插入 stones，保证 candidateList 的发现顺序与旧 candidateSet 完全一致。 */
  function sortedInsert(array, value) {
    let lo = 0;
    let hi = array.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (array[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    array.splice(lo, 0, value);
    return lo;
  }

  function sortedRemove(array, value) {
    let lo = 0;
    let hi = array.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (array[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    if (array[lo] === value) array.splice(lo, 1);
  }

  function adjustListAndCount(list, counts, cell, delta) {
    const old = counts[cell];
    const next = old + delta;
    if (next < 0) throw new Error("BoardState: negative threat count");
    counts[cell] = next;
    if (old === 0 && next > 0) list.push(cell);
    else if (old > 0 && next === 0) {
      const at = list.indexOf(cell);
      if (at >= 0) list.splice(at, 1);
    }
  }

  function refreshEffectiveThree(state, cell, mark) {
    const raw = state.threeCounts[mark][cell] > 0;
    const blocked = state.winCounts[mark][cell] > 0 || state.fourCounts[mark][cell] > 0;
    const should = raw && !blocked;
    const current = state.effectiveThreeCounts[mark][cell] > 0;
    if (should !== current) {
      if (should) {
        state.effectiveThreeCounts[mark][cell] = 1;
        state.effectiveOpenThreeLists[mark].push(cell);
      } else {
        state.effectiveThreeCounts[mark][cell] = 0;
        const at = state.effectiveOpenThreeLists[mark].indexOf(cell);
        if (at >= 0) state.effectiveOpenThreeLists[mark].splice(at, 1);
      }
    }
  }

  function applyLineSets(state, line, mark, sets, delta) {
    const winList = state.winCellLists[mark];
    const fourList = state.fourCellLists[mark];
    const threeList = state.openThreeCellLists[mark];
    const winCounts = state.winCounts[mark];
    const fourCounts = state.fourCounts[mark];
    const threeCounts = state.threeCounts[mark];
    // 威胁线数总计：同一格在两条线上都是冲四/活三点时，统计会大于格点数。
    // 叶子评估用它给“跨线组合威胁”加小项。
    state.threatLineTotalState[mark].four += sets.four.length * delta;
    state.threatLineTotalState[mark].three += sets.three.length * delta;
    for (const pos of sets.win) adjustListAndCount(winList, winCounts, line[pos], delta);
    for (const pos of sets.four) adjustListAndCount(fourList, fourCounts, line[pos], delta);
    for (const pos of sets.three) adjustListAndCount(threeList, threeCounts, line[pos], delta);
    // 有效活三 = 原始活三 且 不是成五/冲四点。
    for (const pos of sets.win) refreshEffectiveThree(state, line[pos], mark);
    for (const pos of sets.four) refreshEffectiveThree(state, line[pos], mark);
    for (const pos of sets.three) refreshEffectiveThree(state, line[pos], mark);
  }

  function BoardState(boardInput, radius) {
    this.radius = radius || 2;
    // 必须和搜索共用同一个数组：搜索通过 board[index]=mark 落子，
    // BoardState 的 apply/undo 也直接改这个数组；如果这里复制，两边会分叉。
    this.board = Array.isArray(boardInput) || boardInput instanceof Uint8Array
      ? boardInput
      : Uint8Array.from(boardInput);

    this.blackLines = new Int32Array(LINES.length);
    this.whiteLines = new Int32Array(LINES.length);
    this.blackTotal = 0;
    this.whiteTotal = 0;

    // 威胁视图：每条线黑白编码 + 每个空点的成五/四/活三摘要。
    this.encBlack = new Array(LINES.length);
    this.encWhite = new Array(LINES.length);
    this.winCellLists = [null, [], []];
    this.fourCellLists = [null, [], []];
    this.openThreeCellLists = [null, [], []];
    this.effectiveOpenThreeLists = [null, [], []];
    this.winCounts = [null, new Uint8Array(CELL_COUNT), new Uint8Array(CELL_COUNT)];
    this.fourCounts = [null, new Uint8Array(CELL_COUNT), new Uint8Array(CELL_COUNT)];
    this.threeCounts = [null, new Uint8Array(CELL_COUNT), new Uint8Array(CELL_COUNT)];
    this.effectiveThreeCounts = [null, new Uint8Array(CELL_COUNT), new Uint8Array(CELL_COUNT)];
    this.threatLineTotalState = [null, { four: 0, three: 0 }, { four: 0, three: 0 }];

    // 升序石子列表：candidateList() 用它按旧版顺序生成候选点。
    this.stones = [];
    this.moveStack = [];
    this.candidateSeen = new Uint8Array(CELL_COUNT);

    // 初始化线分与威胁视图。
    for (let li = 0; li < LINES.length; li += 1) {
      const line = LINES[li];
      const pair = PATTERNS.linePairScore(this.board, li);
      this.blackLines[li] = pair.black;
      this.whiteLines[li] = pair.white;
      this.blackTotal += pair.black;
      this.whiteTotal += pair.white;

      const encBlack = encodeLine(this.board, line, BLACK);
      const encWhite = encodeLine(this.board, line, WHITE);
      this.encBlack[li] = encBlack;
      this.encWhite[li] = encWhite;
      applyLineSets(this, line, BLACK, computeLineThreats(line, encBlack, true), 1);
      applyLineSets(this, line, WHITE, computeLineThreats(line, encWhite, false), 1);
    }

    for (let i = 0; i < CELL_COUNT; i += 1) {
      if (this.board[i] !== EMPTY) sortedInsert(this.stones, i);
    }
  }

  /* 落子并增量更新线分 + 编码线 + 威胁摘要。undo() 可恢复。 */
  BoardState.prototype.apply = function apply(index, mark) {
    if (this.board[index] !== EMPTY) {
      throw new Error(`BoardState.apply: index ${index} is not empty`);
    }

    const lineIds = LINES_BY_INDEX[index];
    const savedLines = new Array(lineIds.length);

    // 先记录旧状态。
    for (let i = 0; i < lineIds.length; i += 1) {
      const li = lineIds[i];
      const line = LINES[li];
      const pos = line.indexOf(index);
      const oldBlack = this.blackLines[li];
      const oldWhite = this.whiteLines[li];
      const encBlack = this.encBlack[li];
      const encWhite = this.encWhite[li];
      savedLines[i] = {
        li,
        pos,
        black: oldBlack,
        white: oldWhite,
        oldEncBlack: encBlack[pos + 1],
        oldEncWhite: encWhite[pos + 1],
        oldSetsBlack: computeLineThreats(line, encBlack, true),
        oldSetsWhite: computeLineThreats(line, encWhite, false)
      };
    }

    this.board[index] = mark;

    let deltaBlack = 0;
    let deltaWhite = 0;
    for (let i = 0; i < lineIds.length; i += 1) {
      const li = lineIds[i];
      const line = LINES[li];
      const rec = savedLines[i];
      const pair = PATTERNS.linePairScore(this.board, li);
      this.blackLines[li] = pair.black;
      this.whiteLines[li] = pair.white;
      deltaBlack += pair.black - rec.black;
      deltaWhite += pair.white - rec.white;

      const valueBlack = mark === BLACK ? 1 : 2;
      const valueWhite = mark === WHITE ? 1 : 2;
      rec.newEncBlack = valueBlack;
      rec.newEncWhite = valueWhite;
      this.encBlack[li][rec.pos + 1] = valueBlack;
      this.encWhite[li][rec.pos + 1] = valueWhite;

      const newSetsBlack = computeLineThreats(line, this.encBlack[li], true);
      const newSetsWhite = computeLineThreats(line, this.encWhite[li], false);
      rec.newSetsBlack = newSetsBlack;
      rec.newSetsWhite = newSetsWhite;

      applyLineSets(this, line, BLACK, rec.oldSetsBlack, -1);
      applyLineSets(this, line, WHITE, rec.oldSetsWhite, -1);
      applyLineSets(this, line, BLACK, newSetsBlack, 1);
      applyLineSets(this, line, WHITE, newSetsWhite, 1);
    }

    this.blackTotal += deltaBlack;
    this.whiteTotal += deltaWhite;
    sortedInsert(this.stones, index);
    this.moveStack.push({ index, savedLines, deltaBlack, deltaWhite });
  };

  /* 撤销最近一次 apply。 */
  BoardState.prototype.undo = function undo() {
    const record = this.moveStack.pop();
    if (!record) throw new Error("BoardState.undo: empty move stack");

    this.board[record.index] = EMPTY;
    for (const rec of record.savedLines) {
      const line = LINES[rec.li];
      applyLineSets(this, line, BLACK, rec.newSetsBlack, -1);
      applyLineSets(this, line, WHITE, rec.newSetsWhite, -1);
      this.encBlack[rec.li][rec.pos + 1] = rec.oldEncBlack;
      this.encWhite[rec.li][rec.pos + 1] = rec.oldEncWhite;
      applyLineSets(this, line, BLACK, rec.oldSetsBlack, 1);
      applyLineSets(this, line, WHITE, rec.oldSetsWhite, 1);
      this.blackLines[rec.li] = rec.black;
      this.whiteLines[rec.li] = rec.white;
    }
    this.blackTotal -= record.deltaBlack;
    this.whiteTotal -= record.deltaWhite;
    sortedRemove(this.stones, record.index);
  };

  BoardState.prototype.winCells = function winCells(mark) {
    return this.winCellLists[mark];
  };

  BoardState.prototype.fourCells = function fourCells(mark) {
    return this.fourCellLists[mark];
  };

  BoardState.prototype.openThreeCells = function openThreeCells(mark) {
    return this.effectiveOpenThreeLists[mark];
  };

  BoardState.prototype.isWinCell = function isWinCell(index, mark) {
    return this.winCounts[mark][index] > 0;
  };

  BoardState.prototype.isFourCell = function isFourCell(index, mark) {
    return this.fourCounts[mark][index] > 0;
  };

  BoardState.prototype.isOpenThreeCell = function isOpenThreeCell(index, mark) {
    return this.effectiveThreeCounts[mark][index] > 0;
  };

  /* 返回该方所有方向上的冲四/原始活三线数总计（同一格可计多条线）。 */
  BoardState.prototype.threatLineTotals = function threatLineTotals(mark) {
    return this.threatLineTotalState[mark];
  };

  /* 经过 index 的 4 条线当前黑白分值，等价于 PATTERNS.linePairScoreAt(board, index)。 */
  BoardState.prototype.linePairAt = function linePairAt(index) {
    let black = 0;
    let white = 0;
    const lineIds = LINES_BY_INDEX[index];
    for (let i = 0; i < lineIds.length; i += 1) {
      const li = lineIds[i];
      black += this.blackLines[li];
      white += this.whiteLines[li];
    }
    return { black, white };
  };

  /* 全盘黑白总分，等价于 PATTERNS.evaluatePair(board)。 */
  BoardState.prototype.totalPair = function totalPair() {
    return { black: this.blackTotal, white: this.whiteTotal };
  };

  /* 生成与 MOVEGEN.candidateSet(board, radius) 顺序一致的候选点列表。 */
  BoardState.prototype.candidateList = function candidateList() {
    const seen = this.candidateSeen;
    seen.fill(0);
    const result = [];
    const r = this.radius;

    for (const index of this.stones) {
      const row = Math.floor(index / SIZE);
      const column = index % SIZE;
      const r0 = Math.max(0, row - r);
      const r1 = Math.min(SIZE - 1, row + r);
      const c0 = Math.max(0, column - r);
      const c1 = Math.min(SIZE - 1, column + r);
      for (let nr = r0; nr <= r1; nr += 1) {
        for (let nc = c0; nc <= c1; nc += 1) {
          const at = nr * SIZE + nc;
          if (!this.board[at] && !seen[at]) {
            seen[at] = 1;
            result.push(at);
          }
        }
      }
    }

    if (!this.stones.length) return [CENTER];
    return result;
  };

  const BoardStateApi = {
    BoardState
  };

  global.GomokuBoardState = BoardStateApi;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = BoardStateApi;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);


/* 搜索模块：Negamax + PVS + αβ + Zobrist 置换表 + 迭代加深。 */
(function (global) {
  "use strict";

  const RULES = global.GomokuRules;
  const PATTERNS = global.GomokuPatterns;
  const MOVEGEN = global.GomokuMoveGen;
  const MOVEPICKER = global.GomokuMovePicker;
  const BOARD_STATE = global.GomokuBoardState;
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

  /* 威胁网络小项：线分逐线相加看不到“同一格跨多线”的组合威胁。
   * 这里只加“组合”部分：双线冲四、冲四/活三的格点数差异。
   * 权重保持很小，只用于打破同分，不改变阶段排序。 */
  function threatNetworkBonus(bs, mark) {
    const opponent = RULES.other(mark);
    const mine = bs.threatLineTotals(mark);
    const opp = bs.threatLineTotals(opponent);
    const myFourCells = bs.fourCellLists[mark].length;
    const oppFourCells = bs.fourCellLists[opponent].length;
    const myThreeCells = bs.openThreeCells(mark).length;
    const oppThreeCells = bs.openThreeCells(opponent).length;
    const myDoubleFour = Math.max(0, mine.four - myFourCells);
    const oppDoubleFour = Math.max(0, opp.four - oppFourCells);
    const raw = (myDoubleFour - oppDoubleFour) * 30000
      + (myFourCells - oppFourCells) * 4000
      + (myThreeCells - oppThreeCells) * 1200;
    // 阶段缩放：开局子少时线分值本身很小，固定威胁权重会盖过正常棋理；
    // 10 子以下完全关闭，12 子后逐步完全生效。
    const stoneCount = bs.stones.length;
    const phase = Math.min(1, Math.max(0, (stoneCount - 10) / 12));
    return Math.round(raw * phase);
  }

  function evaluateLeaf(pair, mark, state, bs) {
    if (state && deadlinePassed(state)) state.stop = true;
    let score = PATTERNS.pairValue(pair, mark);
    if (state && state.threatEval && bs) score += threatNetworkBonus(bs, mark);
    return score;
  }

  function quiesce(board, mark, alpha, beta, ply, state, tt, boardHash, pair, qDepth, bs) {
    state.nodes += 1;
    if ((state.nodes & 511) === 0 && deadlinePassed(state)) {
      state.stop = true;
      return { score: evaluateLeaf(pair, mark, state, bs), move: -1 };
    }

    const moves = qDepth > 0 ? MOVEGEN.tacticalMoves(board, mark, state.qWidth, { candidates: bs ? bs.candidateList() : undefined }) : [];
    const forcedBlock = moves.length > 0 && moves[0].stage === 1;
    const standPat = evaluateLeaf(pair, mark, state, bs);
    if (!forcedBlock) {
      if (standPat >= beta) return { score: beta, move: -1 };
      if (standPat > alpha) alpha = standPat;
    }

    if (qDepth <= 0 || moves.length === 0) return { score: standPat, move: -1 };

    let bestScore = forcedBlock ? -INF : standPat;
    let bestMove = -1;
    for (let i = 0; i < moves.length; i += 1) {
      const index = moves[i].index;
      const before = bs ? bs.linePairAt(index) : PATTERNS.linePairScoreAt(board, index);
      if (bs) {
        bs.apply(index, mark);
      } else {
        board[index] = mark;
      }
      const after = bs ? bs.linePairAt(index) : PATTERNS.linePairScoreAt(board, index);
      const childPair = {
        black: pair.black - before.black + after.black,
        white: pair.white - before.white + after.white
      };
      const win = RULES.winAt(board, index);
      let score;
      if (win) {
        score = MATE - ply;
      } else {
        const childHash = (boardHash ^ ZOBRIST[mark][index]) >>> 0;
        const child = quiesce(board, RULES.other(mark), -beta, -alpha, ply + 1, state, tt, childHash, childPair, qDepth - 1, bs);
        score = -child.score;
      }
      if (bs) bs.undo(); else board[index] = EMPTY;

      if (state.stop) {
        if (bestScore === -INF) bestScore = standPat;
        break;
      }
      if (score > bestScore) {
        bestScore = score;
        bestMove = index;
      }
      if (bestScore > alpha) alpha = bestScore;
      if (alpha >= beta) break;
    }
    return { score: bestScore, move: bestMove };
  }

  /* 主搜索。返回 { score, move, nodes }。score 从当前 mark 视角。 */
  function pvs(board, mark, depth, alpha, beta, ply, state, tt, boardHash, pair, bs) {
    state.nodes += 1;
    if ((state.nodes & 511) === 0 && deadlinePassed(state)) {
      state.stop = true;
      return { score: evaluateLeaf(pair, mark, state, bs), move: -1 };
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
      const leaf = state.qsearch ? quiesce(board, mark, alpha, beta, ply, state, tt, boardHash, pair, state.qDepth, bs) : { score: evaluateLeaf(pair, mark, state, bs), move: -1 };
      const score = leaf.score;
      tt.set(key, { key, depth: 0, flag: 0, score, move: -1 });
      return { score, move: leaf.move };
    }

    // 节点级攻击方 QVCF（威胁视图棋力项）：
    // 浅层且己方存在四威胁时，用 2ms 小预算跑一次连续冲四证明；
    // 命中就返回杀棋首着，不生成候选。该逻辑由 state.nodeVcf 控制。
    let nodeVcfMove = -1;
    const nodeVcfBudget = state.nodeVcf ? (state.nodeVcfBudget || 6) : 0;
    const nodeVcfUsed = state.nodeVcf ? (state.nodeVcfUsed || 0) : 0;
    if (state.nodeVcf && bs && ply > 0 && depth <= state.nodeVcfDepth
      && nodeVcfUsed < nodeVcfBudget
      && bs.fourCells(mark).length >= 2) {
      const Tactics = global.GomokuThreats;
      if (Tactics && (!state.deadline || state.deadline - performance.now() > 4)) {
        const timeBudget = Math.min(
          state.nodeVcfTime || 2,
          nodeVcfBudget - nodeVcfUsed,
          state.deadline ? state.deadline - performance.now() - 1 : 2
        );
        if (timeBudget > 0) {
          const started = performance.now();
          const vcf = Tactics.findVcf(board, mark, timeBudget, Tactics.MAX_VCF_DEPTH || 16);
          state.nodeVcfUsed = nodeVcfUsed + (performance.now() - started);
          if (vcf >= 0 && board[vcf] === EMPTY && RULES.isMoveLegal(board, vcf, mark)) {
            nodeVcfMove = vcf;
          }
        }
      }
    }
    if (nodeVcfMove >= 0) {
      const score = MATE - ply;
      if (!state.noTT) tt.set(key, { key, depth, flag: 0, score, move: nodeVcfMove });
      return { score, move: nodeVcfMove, nodeVcf: true };
    }

    // 节点级强制着法（威胁视图棋力项）：
    // 1) 己方存在直接成五点：立即取胜，不必继续生成/排序；
    // 2) 对方存在直接成五点：只允许在挡点里搜索；没有合法挡点则判负。
    // 该逻辑由 state.forcedMoves 控制：iterate 生产路径默认开启；
    // 直接调用 pvs 的旧测试不传该字段时行为与旧版完全一致。
    let forcedCandidates = null;
    if (state.forcedMoves && bs) {
      const opponent = RULES.other(mark);
      const ownWins = bs.winCells(mark);
      for (let w = 0; w < ownWins.length; w += 1) {
        const index = ownWins[w];
        if (board[index] === EMPTY && RULES.isMoveLegal(board, index, mark)) {
          const score = MATE - ply;
          if (!state.noTT) tt.set(key, { key, depth, flag: 0, score, move: index });
          return { score, move: index, forcedWin: true };
        }
      }
      const oppWins = bs.winCells(opponent);
      if (oppWins.length) {
        const blocks = [];
        for (let w = 0; w < oppWins.length; w += 1) {
          const index = oppWins[w];
          if (board[index] === EMPTY && RULES.isMoveLegal(board, index, mark)) blocks.push(index);
        }
        if (!blocks.length) {
          // 己方无法阻止对方下一手成五。
          const score = -(MATE - (ply + 1));
          if (!state.noTT) tt.set(key, { key, depth, flag: 0, score, move: -1 });
          return { score, move: -1, forcedLoss: true };
        }
        forcedCandidates = blocks;
      }
    }

    // 节点级防守 VCF 感知（威胁视图棋力项）：
    // 浅层检测到对手存在连续冲四杀时，只把该杀棋首着的防守点交给 movegen 高排序；
    // 不限制搜索，只改变候选顺序，避免把“反冲四可破”的局面误剪枝。
    let defenseCells = null;
    if (state.nodeVcfDefense && bs && ply > 0 && depth <= state.nodeVcfDefenseDepth) {
      const nodeVcfDefenseBudget = state.nodeVcfDefenseBudget || 4;
      const nodeVcfDefenseUsed = state.nodeVcfDefenseUsed || 0;
      const opponent = RULES.other(mark);
      if (nodeVcfDefenseUsed < nodeVcfDefenseBudget && bs.fourCells(opponent).length > 0) {
        const Tactics = global.GomokuThreats;
        if (Tactics && (!state.deadline || state.deadline - performance.now() > 4)) {
          const timeBudget = Math.min(
            state.nodeVcfDefenseTime || 2,
            nodeVcfDefenseBudget - nodeVcfDefenseUsed,
            state.deadline ? state.deadline - performance.now() - 1 : 2
          );
          if (timeBudget > 0) {
            const started = performance.now();
            const oppVcf = Tactics.findVcf(board, opponent, timeBudget, Tactics.MAX_VCF_DEPTH || 16);
            state.nodeVcfDefenseUsed = nodeVcfDefenseUsed + (performance.now() - started);
            if (oppVcf >= 0 && board[oppVcf] === EMPTY && RULES.isMoveLegal(board, oppVcf, opponent)) {
              // winningPointsForMove 要求进攻手已落到盘上；forcingMoves 内部会
              // apply/undo 并返回该冲四的成五点（即防守点）。
              const gains = Tactics.forcingMoves(board, opponent, bs);
              let points = null;
              for (const gain of gains) {
                if (gain.index === oppVcf) {
                  points = gain.winPoints;
                  break;
                }
              }
              const defs = [];
              if (points) {
                for (const q of points) {
                  if (board[q] === EMPTY && RULES.isMoveLegal(board, q, mark)) defs.push(q);
                }
              }
              if (defs.length) defenseCells = defs;
            }
          }
        }
      }
    }

    const useRootWidth = ply === 0 && state.rootWidth > 0;
    let width = useRootWidth ? state.rootWidth : state.width;
    let prefilter = useRootWidth ? state.rootPrefilter : state.prefilter;
    if (forcedCandidates) {
      width = forcedCandidates.length;
      prefilter = forcedCandidates.length;
    }
    const killers = state.killers[ply] || [-1, -1];
    const moveOptions = {
      width,
      prefilter,
      ttMove: forcedCandidates && forcedCandidates.indexOf(ttMove) < 0 ? -1 : ttMove,
      killers,
      history: state.history,
      staged: state.staged,
      bucketOrder: state.bucketOrder,
      urgent: forcedCandidates ? false : state.urgent,
      urgentLimit: state.urgentLimit,
      threatState: forcedCandidates ? undefined : (state.threatOrder && bs && ply > 0 ? bs : undefined),
      defenseCells: forcedCandidates ? undefined : defenseCells,
      candidates: forcedCandidates || (bs ? bs.candidateList() : undefined)
    };
    let moves = null;
    if (!forcedCandidates && state.movePicker && MOVEPICKER && (ply <= state.movePickerPly || depth <= state.movePickerDepth)) {
      moves = MOVEPICKER.pickForced(board, mark, width, moveOptions);
    }
    if (!moves || moves.length === 0) {
      moves = MOVEGEN.rankedMoves(board, mark, width, moveOptions);
    }
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
      const before = bs ? bs.linePairAt(index) : PATTERNS.linePairScoreAt(board, index);
      if (bs) {
        bs.apply(index, mark);
      } else {
        board[index] = mark;
      }
      const after = bs ? bs.linePairAt(index) : PATTERNS.linePairScoreAt(board, index);
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
        const fullDepth = nextDepth;
        // 浅层 LMR：靠后的安静着法先降 1 层做零窗口；威胁着法、杀点、挡点不降层。
        // 根节点不降层：浅层根候选被降层会改变开局首选（例如第 4 手 D4/G7 抖动）。
        if (state.lmr && ply > 0 && i >= state.lmrStart && depth >= state.lmrMinDepth) {
          const move = moves[i];
          const tactical = move.attack >= PATTERNS.SCORE.LIVE_THREE
            || move.defense >= PATTERNS.SCORE.LIVE_THREE;
          const threatCell = bs && (
            bs.isWinCell(index, mark) || bs.isWinCell(index, RULES.other(mark)) ||
            bs.isFourCell(index, mark) || bs.isFourCell(index, RULES.other(mark)) ||
            bs.isOpenThreeCell(index, mark) || bs.isOpenThreeCell(index, RULES.other(mark))
          );
          const killer = killers[0] === index || killers[1] === index;
          if (!tactical && !threatCell && !killer) {
            nextDepth = Math.max(0, nextDepth - (state.lmrReduction || 1));
          }
        }
        const childHash = (boardHash ^ ZOBRIST[mark][index]) >>> 0;
        let child;
        if (i === 0) {
          child = pvs(board, RULES.other(mark), nextDepth, -beta, -alpha, ply + 1, state, tt, childHash, childPair, bs);
        } else {
          child = pvs(board, RULES.other(mark), nextDepth, -alpha - 1, -alpha, ply + 1, state, tt, childHash, childPair, bs);
          const zeroScore = -child.score;
          if (!state.stop && zeroScore > alpha && (nextDepth < fullDepth || zeroScore < beta)) {
            child = pvs(board, RULES.other(mark), fullDepth, -beta, -alpha, ply + 1, state, tt, childHash, childPair, bs);
          }
        }
        score = -child.score;
      }
      if (bs) bs.undo(); else board[index] = EMPTY;

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
      movePicker: options.movePicker === true,
      movePickerPly: options.movePickerPly || 1,
      movePickerDepth: options.movePickerDepth || 3,
      staged: options.staged === true,
      bucketOrder: options.bucketOrder === true,
      qsearch: options.qsearch === true,
      qDepth: options.qDepth || 2,
      qWidth: options.qWidth || 6,
      urgent: options.urgent === true,
      urgentLimit: options.urgentLimit || 16,
      forcedMoves: options.forcedMoves !== false,
      threatOrder: options.threatOrder !== false,
      threatEval: options.threatEval !== false,
      nodeVcf: options.nodeVcf !== false,
      nodeVcfDepth: options.nodeVcfDepth || 1,
      nodeVcfTime: options.nodeVcfTime || 2,
      nodeVcfBudget: options.nodeVcfBudget || 6,
      nodeVcfUsed: 0,
      nodeVcfDefense: options.nodeVcfDefense !== false,
      nodeVcfDefenseDepth: options.nodeVcfDefenseDepth || 2,
      nodeVcfDefenseTime: options.nodeVcfDefenseTime || 2,
      nodeVcfDefenseBudget: options.nodeVcfDefenseBudget || 4,
      nodeVcfDefenseUsed: 0,
      lmr: options.lmr !== false,
      lmrMinDepth: options.lmrMinDepth || 4,
      lmrStart: options.lmrStart || 4,
      lmrReduction: options.lmrReduction || 1,
      killers: Array.from({ length: 64 }, () => [-1, -1]),
      history: [new Int32Array(CELL_COUNT), new Int32Array(CELL_COUNT), new Int32Array(CELL_COUNT)]
    };
    // A+B 缓存：默认开启；测试或对照可通过 cacheBoard:false 走旧路径。
    const bs = BOARD_STATE && options.cacheBoard !== false
      ? new BOARD_STATE.BoardState(board, 2)
      : null;
    const rootPair = bs ? bs.totalPair() : PATTERNS.evaluatePair(board);
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
        result = pvs(board, mark, depth, lastScore - windowSize, lastScore + windowSize, 0, state, tt, undefined, rootPair, bs);
        if (!state.stop && (result.score <= lastScore - windowSize || result.score >= lastScore + windowSize)) {
          result = pvs(board, mark, depth, -INF, INF, 0, state, tt, undefined, rootPair, bs);
        }
      } else {
        result = pvs(board, mark, depth, -INF, INF, 0, state, tt, undefined, rootPair, bs);
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
  const PATTERNS = global.GomokuPatterns;
  const SIZE = RULES.SIZE;
  const CELL_COUNT = RULES.CELL_COUNT;
  const EMPTY = RULES.EMPTY;
  const BLACK = RULES.BLACK;
  const WHITE = RULES.WHITE;
  const DIRECTIONS = RULES.DIRECTIONS;

  const MAX_VCF_DEPTH = 16;
  const BOARD_STATE = global.GomokuBoardState;

  /* SearchBoard 复用辅助：
   * 当全局 GomokuBoardState 存在时，VCT/VCF 的候选列表和落子/撤销都走缓存；
   * 否则完全退回旧实现，便于单独加载 threats 的测试继续工作。 */
  function makeTacticState(board) {
    if (BOARD_STATE && BOARD_STATE.BoardState) return new BOARD_STATE.BoardState(board, 2);
    return null;
  }
  function tacticCandidates(bs, board) {
    return bs ? bs.candidateList() : MOVEGEN.candidateSet(board, 2);
  }
  function tacticApply(bs, board, index, mark) {
    if (bs) bs.apply(index, mark);
    else board[index] = mark;
  }
  function tacticUndo(bs, board, index) {
    if (bs) bs.undo();
    else board[index] = EMPTY;
  }

  /* 成五检测优先读 BoardState 威胁视图；无视图时退回旧扫描。 */
  function tacticImmediateWin(bs, board, attacker) {
    if (bs) {
      const wins = bs.winCells(attacker);
      if (wins.length) return wins[0];
    }
    return MOVEGEN.findImmediateWin(board, attacker, tacticCandidates(bs, board));
  }

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
  function forcingMoves(board, attacker, bs) {
    const result = [];
    // 威胁视图优先：只枚举已确认的冲四点，避免逐点摆子扫描。
    const candidates = bs ? bs.fourCells(attacker) : tacticCandidates(bs, board);
    for (const index of candidates) {
      if (board[index] !== EMPTY) continue;
      const inspect = RULES.inspectMove(board, index, attacker);
      if (!inspect.legal || inspect.win) continue;
      const double = bs ? bs.fourCounts[attacker][index] + bs.threeCounts[attacker][index] : 0;
      tacticApply(bs, board, index, attacker);
      const points = winningPointsForMove(board, index, attacker);
      tacticUndo(bs, board, index);
      if (points.length >= 1) result.push({ index, points, winPoints: points, double });
    }
    result.sort((a, b) => b.points.length - a.points.length || b.double - a.double || a.index - b.index);
    return result;
  }

  /* 生成所有只做活三、不直接形成四的进攻手。 */
  function openThreeMoves(board, attacker, bs) {
    const result = [];
    // 威胁视图优先：只枚举有效活三点。
    const candidates = bs ? bs.openThreeCells(attacker) : tacticCandidates(bs, board);
    for (const index of candidates) {
      if (board[index] !== EMPTY) continue;
      const inspect = RULES.inspectMove(board, index, attacker);
      if (!inspect.legal || inspect.win) continue;
      const double = bs ? bs.threeCounts[attacker][index] + bs.fourCounts[attacker][index] : 0;
      tacticApply(bs, board, index, attacker);
      const points = winningPointsForMove(board, index, attacker);
      let threes = [];
      if (points.length === 0) {
        threes = openThreePointsForMove(board, index, attacker);
      }
      tacticUndo(bs, board, index);
      if (threes.length >= 1) result.push({ index, threePoints: threes, double });
    }
    result.sort((a, b) => b.threePoints.length - a.threePoints.length || b.double - a.double || a.index - b.index);
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
  function dfsVcf(board, attacker, defender, depth, seen, deadline, maxDepth, bs) {
    if (deadline && performance.now() > deadline) throw new Error("vcf-timeout");
    if (depth > maxDepth) return null;

    const immediate = tacticImmediateWin(bs, board, attacker);
    if (immediate >= 0) return [immediate];

    if (tacticImmediateWin(bs, board, defender) >= 0) return null;

    const key = makeHash(board, attacker, depth);
    if (seen.has(key)) return null;
    seen.add(key);

    const attacks = forcingMoves(board, attacker, bs);
    for (const attack of attacks) {
      const index = attack.index;
      tacticApply(bs, board, index, attacker);
      const points = attack.winPoints;

      // 一手形成两个成五点：对手只能挡一个，我方必胜。
      if (points.length >= 2) {
        tacticUndo(bs, board, index);
        return [index];
      }
      if (points.length === 0) {
        tacticUndo(bs, board, index);
        continue;
      }

      const defenses = points.filter((q) => {
        if (board[q] !== EMPTY) return false;
        return RULES.isMoveLegal(board, q, defender);
      });
      if (!defenses.length) {
        tacticUndo(bs, board, index);
        return [index];
      }

      let allDefensesSolved = true;
      for (const q of defenses) {
        tacticApply(bs, board, q, defender);
        if (RULES.winAt(board, q)) {
          tacticUndo(bs, board, q);
          allDefensesSolved = false;
          break;
        }
        const rest = dfsVcf(board, attacker, defender, depth + 1, seen, deadline, maxDepth, bs);
        tacticUndo(bs, board, q);
        if (!rest) {
          allDefensesSolved = false;
          break;
        }
      }

      tacticUndo(bs, board, index);
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

  function findVcf(board, attacker, timeMs, maxDepth) {
    if (!board.some((value) => value)) return -1;
    // 预算 <= 0 表示跳过本阶段；0 不是“不限时”。
    if (!(timeMs > 0)) return -1;
    const work = cloneForTactics(board);
    const bs = makeTacticState(work);
    const defender = RULES.other(attacker);
    const seen = new Set();
    const deadline = performance.now() + timeMs;
    const depthLimit = maxDepth || MAX_VCF_DEPTH;
    try {
      const path = dfsVcf(work, attacker, defender, 0, seen, deadline, depthLimit, bs);
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
  function openThreeDefenses(board, attack, defender, bs) {
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
    for (const gain of forcingMoves(board, defender, bs)) {
      if (board[gain.index] === EMPTY) set.add(gain.index);
    }
    for (const gain of openThreeMoves(board, defender, bs)) {
      if (board[gain.index] === EMPTY) set.add(gain.index);
    }

    return [...set].filter((q) => RULES.isMoveLegal(board, q, defender));
  }

  /* VCT-lite：先做活三，任意合法防守后仍存在 VCF，则证明取胜。 */
  function findVctLite(board, attacker, timeMs) {
    if (!board.some((value) => value)) return -1;
    // 预算 <= 0 表示跳过本阶段；0 不是“不限时”。
    if (!(timeMs > 0)) return -1;
    const work = cloneForTactics(board);
    const bs = makeTacticState(work);
    const defender = RULES.other(attacker);
    const deadline = performance.now() + timeMs;
    const attacks = openThreeMoves(work, attacker, bs);
    if (!attacks.length) return -1;

    for (const attack of attacks) {
      if (deadline && performance.now() > deadline) return -1;
      tacticApply(bs, work, attack.index, attacker);

      // 进攻后对方能直接成五，则这条做杀路线不成立。
      if (tacticImmediateWin(bs, work, defender) >= 0) {
        tacticUndo(bs, work, attack.index);
        continue;
      }

      const defenses = openThreeDefenses(work, attack, defender, bs);
      if (!defenses.length) {
        tacticUndo(bs, work, attack.index);
        return attack.index;
      }

      let allDefensesSolved = true;
      for (const q of defenses) {
        if (work[q] !== EMPTY) continue;
        tacticApply(bs, work, q, defender);
        let defenderWon = Boolean(RULES.winAt(work, q));
        let rest = -1;
        if (!defenderWon) {
          const remain = deadline ? deadline - performance.now() : 0;
          if (remain <= 0) {
            tacticUndo(bs, work, q);
            tacticUndo(bs, work, attack.index);
            return -1;
          }
          rest = findVcf(work, attacker, remain);
        }
        tacticUndo(bs, work, q);
        if (defenderWon || rest < 0) {
          allDefensesSolved = false;
          break;
        }
      }

      tacticUndo(bs, work, attack.index);
      if (allDefensesSolved) return attack.index;
    }
    return -1;
  }

  /* 生成所有四威胁或活三威胁手。 */
  function allThreatMoves(board, attacker, bs) {
    const result = [];
    const candidates = bs
      ? bs.fourCells(attacker).concat(bs.openThreeCells(attacker))
      : tacticCandidates(bs, board);
    for (const index of candidates) {
      if (board[index] !== EMPTY) continue;
      const inspect = RULES.inspectMove(board, index, attacker);
      if (!inspect.legal || inspect.win) continue;
      const double = bs ? bs.fourCounts[attacker][index] + bs.threeCounts[attacker][index] : 0;
      tacticApply(bs, board, index, attacker);
      const winPoints = winningPointsForMove(board, index, attacker);
      const threePoints = winPoints.length ? [] : openThreePointsForMove(board, index, attacker);
      tacticUndo(bs, board, index);
      if (winPoints.length || threePoints.length) {
        result.push({ index, winPoints, threePoints, double });
      }
    }
    result.sort((a, b) => (
      b.winPoints.length - a.winPoints.length ||
      b.double - a.double ||
      b.threePoints.length - a.threePoints.length ||
      a.index - b.index
    ));
    return result;
  }

  /* 防守点排序：先试能同时成五/冲四/活三的反击点，再试普通挡点。 */
  function defensePriority(board, index, defender, attacker, bs) {
    let priority = 0;
    if (bs) {
      if (bs.isWinCell(index, defender)) priority += 1000000;
      if (bs.isWinCell(index, attacker)) priority += 900000;
      if (bs.isFourCell(index, defender)) priority += 20000;
      if (bs.isFourCell(index, attacker)) priority += 15000;
      if (bs.isOpenThreeCell(index, defender)) priority += 8000;
      if (bs.isOpenThreeCell(index, attacker)) priority += 6000;
    }
    return priority;
  }

  function sortDefenses(defenses, defender, attacker, bs) {
    defenses.sort((a, b) => (
      defensePriority(undefined, b, defender, attacker, bs) - defensePriority(undefined, a, defender, attacker, bs) ||
      a - b
    ));
    return defenses;
  }

  /* 完整威胁空间搜索：允许连续活三做杀 + 连续冲四。 */
  function tss(board, attacker, defender, depth, state, seen, bs) {
    state.nodes += 1;
    if (state.deadline && performance.now() > state.deadline) throw new Error("vct-timeout");
    if (state.maxNodes && state.nodes > state.maxNodes) throw new Error("vct-node-limit");
    if (depth > state.maxDepth) return null;

    const immediate = tacticImmediateWin(bs, board, attacker);
    if (immediate >= 0) return [immediate];

    if (tacticImmediateWin(bs, board, defender) >= 0) return null;

    const key = makeHash(board, attacker, depth);
    if (seen.has(key)) return null;
    seen.add(key);

    const attacks = allThreatMoves(board, attacker, bs);
    if (!attacks.length) return null;

    for (const attack of attacks) {
      if (state.deadline && performance.now() > state.deadline) throw new Error("vct-timeout");
      const index = attack.index;
      tacticApply(bs, board, index, attacker);

      if (attack.winPoints.length >= 2) {
        tacticUndo(bs, board, index);
        return [index];
      }

      let defenses;
      if (attack.winPoints.length === 1) {
        defenses = attack.winPoints.filter((q) => (
          board[q] === EMPTY && RULES.isMoveLegal(board, q, defender)
        ));
      } else {
        defenses = openThreeDefenses(board, attack, defender, bs);
      }
      if (defenses.length > 1) sortDefenses(defenses, defender, attacker, bs);

      if (!defenses.length) {
        tacticUndo(bs, board, index);
        return [index];
      }

      let allDefensesSolved = true;
      for (const q of defenses) {
        tacticApply(bs, board, q, defender);
        if (RULES.winAt(board, q)) {
          tacticUndo(bs, board, q);
          allDefensesSolved = false;
          break;
        }
        const rest = tss(board, attacker, defender, depth + 1, state, seen, bs);
        tacticUndo(bs, board, q);
        if (!rest) {
          allDefensesSolved = false;
          break;
        }
      }

      tacticUndo(bs, board, index);
      if (allDefensesSolved) return [index];
    }
    return null;
  }

  /* 完整 VCT：连续活三/冲四的威胁空间搜索。 */
  function findVct(board, attacker, timeMs, maxDepth) {
    if (!board.some((value) => value)) return -1;
    // 预算 <= 0 表示跳过本阶段；0 不是“不限时”。
    if (!(timeMs > 0)) return -1;
    const work = cloneForTactics(board);
    const bs = makeTacticState(work);
    const defender = RULES.other(attacker);
    const immediate = tacticImmediateWin(bs, work, attacker);
    if (immediate >= 0) return immediate;
    if (tacticImmediateWin(bs, work, defender) >= 0) return -1;

    // 安静局面快速退出：优先读 BoardState 威胁视图；无视图时退回 movePotentialPair 保守过滤。
    if (bs) {
      if (!bs.fourCells(attacker).length && !bs.openThreeCells(attacker).length) return -1;
    } else {
      const candidates = tacticCandidates(bs, work);
      let hasThreatStart = false;
      for (const index of candidates) {
        if (work[index] !== EMPTY) continue;
        const pair = PATTERNS.movePotentialPair(work, index, attacker);
        if (pair.attack >= PATTERNS.SCORE.LIVE_THREE) {
          hasThreatStart = true;
          break;
        }
      }
      if (!hasThreatStart) return -1;
    }

    const state = {
      deadline: performance.now() + timeMs,
      maxDepth: maxDepth || 10,
      maxNodes: 0,
      nodes: 0
    };
    const seen = new Set();
    try {
      const path = tss(work, attacker, defender, 0, state, seen, bs);
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
  const CENTER_ROW = Math.floor((SIZE - 1) / 2);
  const CENTER_COLUMN = CENTER_ROW;
  const CENTER = CENTER_ROW * SIZE + CENTER_COLUMN;

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
    const centerDistance = Math.abs(row - CENTER_ROW) + Math.abs(column - CENTER_COLUMN);

    let nearOpponent = 0;
    for (let i = 0; i < CELL_COUNT; i += 1) {
      if (board[i] !== opponent) continue;
      const distance = Math.abs(Math.floor(i / SIZE) - row) + Math.abs((i % SIZE) - column);
      if (distance <= 2) nearOpponent = Math.max(nearOpponent, 3 - distance);
    }

    const pair = PATTERNS.movePotentialPair(board, index, mark);
    return pair.attack + Math.floor(pair.defense * 0.94) + 160 - centerDistance * 12 + nearOpponent * 220;
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
  const BOARD_STATE = global.GomokuBoardState;
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

  function centerIndex() {
    const center = Math.floor((SIZE - 1) / 2);
    return center * SIZE + center;
  }

  function isBoardEmpty(board) {
    for (let i = 0; i < CELL_COUNT; i += 1) {
      if (board[i]) return false;
    }
    return true;
  }

  /* 找“对 mark 合法”的成五点：黑棋挡五时挡点可能是禁手。 */
  function firstLegalImmediateWin(board, mark) {
    const pool = MOVEGEN.candidateSet(board, 2);
    for (const index of pool) {
      if (board[index] !== EMPTY) continue;
      if (!RULES.isWinMove(board, index, mark)) continue;
      if (!RULES.isMoveLegal(board, index, mark)) continue;
      return index;
    }
    return -1;
  }

  function firstLegalBlock(board, mark) {
    const opponent = RULES.other(mark);
    const pool = MOVEGEN.candidateSet(board, 2);
    for (const index of pool) {
      if (board[index] !== EMPTY) continue;
      if (!RULES.isWinMove(board, index, opponent)) continue;
      if (!RULES.isMoveLegal(board, index, mark)) continue;
      return index;
    }
    return -1;
  }

  function checkMoveSafety(board, index, mark, vcfTime, bs, vctTime, vctState, vctMaxDepth) {
    if (index < 0 || board[index] !== EMPTY) return { safe: false, reason: "illegal" };
    const opponent = RULES.other(mark);

    /* 对手 VCT 检测：只在对手仍有四/活三起点且总预算未耗尽时执行。 */
    function checkOpponentVct(targetBoard) {
      if (!(vctTime > 0) || !vctState) return null;
      const hasStart = bs
        ? (bs.fourCells(opponent).length > 0 || bs.openThreeCells(opponent).length > 0)
        : true;
      if (!hasStart) return null;
      const left = vctState.budget - vctState.used;
      if (left <= 0) return null;
      const budget = Math.min(vctTime, left);
      const started = performance.now();
      let vct = -1;
      try {
        vct = THREATS.findVct(targetBoard, opponent, budget, vctMaxDepth || 14);
      } catch (error) {
        vct = -1;
      }
      vctState.used += performance.now() - started;
      if (vct >= 0) return { safe: false, reason: "opponent-vct", reply: vct };
      return null;
    }

    // 威胁视图路径：apply/undo 与对手五/四摘要都走 BoardState；
    // 对手没有任何冲四点时不可能有 VCF，直接跳过 VCF 阶段。
    if (bs) {
      if (bs.board[index] !== EMPTY) return { safe: false, reason: "illegal" };
      const inspect = RULES.inspectMove(bs.board, index, mark);
      if (!inspect.legal) return { safe: false, reason: inspect.reason || "illegal" };

      bs.apply(index, mark);
      if (RULES.winAt(bs.board, index)) {
        bs.undo();
        return { safe: true, reason: "wins-now" };
      }

      const wins = bs.winCells(opponent);
      if (wins.length) {
        let reply = wins[0];
        for (const w of wins) {
          if (bs.board[w] === EMPTY && RULES.isMoveLegal(bs.board, w, opponent)) {
            reply = w;
            break;
          }
        }
        bs.undo();
        return { safe: false, reason: "opponent-five", reply };
      }

      if (vcfTime > 0 && bs.fourCells(opponent).length > 0) {
        try {
          const vcf = THREATS.findVcf(bs.board, opponent, vcfTime);
          if (vcf >= 0) {
            bs.undo();
            return { safe: false, reason: "opponent-vcf", reply: vcf };
          }
        } catch (error) {
          // Treat tactical timeout as unknown rather than unsafe.
        }
      }

      const vctUnsafe = checkOpponentVct(bs.board);
      if (vctUnsafe) {
        bs.undo();
        return vctUnsafe;
      }

      bs.undo();
      return { safe: true, reason: "safe" };
    }

    const inspect = RULES.inspectMove(board, index, mark);
    if (!inspect.legal) return { safe: false, reason: inspect.reason || "illegal" };

    board[index] = mark;
    if (RULES.winAt(board, index)) {
      board[index] = EMPTY;
      return { safe: true, reason: "wins-now" };
    }

    const immediate = MOVEGEN.findImmediateWin(board, opponent);
    if (immediate >= 0) {
      board[index] = EMPTY;
      return { safe: false, reason: "opponent-five", reply: immediate };
    }

    if (vcfTime > 0) {
      try {
        const vcf = THREATS.findVcf(board, opponent, vcfTime);
        if (vcf >= 0) {
          board[index] = EMPTY;
          return { safe: false, reason: "opponent-vcf", reply: vcf };
        }
      } catch (error) {
        // Treat tactical timeout as unknown rather than unsafe.
      }
    }

    const vctUnsafe = checkOpponentVct(board);
    if (vctUnsafe) {
      board[index] = EMPTY;
      return vctUnsafe;
    }

    board[index] = EMPTY;
    return { safe: true, reason: "safe" };
  }

  function safetySeverity(check) {
    if (check.safe) return 0;
    if (check.reason === "opponent-five") return 4;
    if (check.reason === "opponent-vcf") return 3;
    if (check.reason === "opponent-vct") return 2;
    if (check.reason === "illegal" || check.reason === "occupied") return 5;
    return 2;
  }

  /* 威胁密度自适应 VCT 预算：
   * 只有“我方有多个进攻起点、且对方存在多个冲四威胁”的尖锐局面才额外借时间；
   * 普通中盘密度再高也不借，避免 VCT 空转挤掉普通 AB 的完整第 7 层。
   * 额外预算最多 12ms（40 -> 52ms），仍受 remaining() 约束。 */
  function adaptiveVctBudget(bs, mark, baseBudget) {
    if (!bs || !(baseBudget > 0)) return baseBudget;
    const opponent = RULES.other(mark);
    const myThreats = bs.fourCells(mark).length + bs.openThreeCells(mark).length;
    const oppFours = bs.fourCells(opponent).length;
    if (myThreats >= 6 && oppFours >= 2) {
      return Math.max(baseBudget, Math.min(52, baseBudget + 12));
    }
    return baseBudget;
  }

  function chooseSafeRootMove(board, mark, preferred, cfg, remaining, prebuiltState) {
    const opponent = RULES.other(mark);
    const budget = remaining();
    // root safety 全程复用一个 BoardState：候选落子/撤销和五/四威胁判断都走增量视图。
    const threatState = prebuiltState || (BOARD_STATE && BOARD_STATE.BoardState
      ? new BOARD_STATE.BoardState(board, 2)
      : null);

    // 首选检查：预算再小也至少做“对手直接成五”的即时检查。
    const firstBudget = budget > 80
      ? Math.min(80, Math.floor(budget * 0.3))
      : Math.max(0, Math.min(24, budget));
    // 对手 VCT 检测的独立总预算：48ms；双活三 VCT 通常需要约 20ms 才能证明。
    const vctState = { used: 0, budget: Math.min(48, Math.max(0, budget)) };
    const firstVctBudget = firstBudget > 0 ? Math.min(24, vctState.budget) : 0;
    const first = checkMoveSafety(board, preferred, mark, firstBudget, threatState,
      firstVctBudget, vctState, cfg.vctMaxDepth || 14);
    if (first.safe) return { index: preferred, check: first, changed: false };

    // 首选不安全：扩大候选池继续找安全替代。
    const searchOpts = Object.assign({ width: 24, prefilter: 48 }, cfg.search || {}, {
      width: 24,
      prefilter: 48,
      staged: true,
      bucketOrder: false,
      urgent: true,
      urgentLimit: 24
    });
    const moves = MOVEGEN.rankedMoves(board, mark, 24, searchOpts);

    let bestUnsafe = null;
    let extrasUnsafe = null;
    let scanned = 0;
    const checked = new Set([preferred]);
    // bucket: "ranked" = 原 rankedMoves 候选；"extras" = 威胁视图补充候选。
    // 只有 extras 严格更安全时才允许替换原 tie-break 结果，
    // 避免“同样不安全”时只因为补充候选排前面就改变兜底着法。
    const checkCandidate = (index, bucket) => {
      if (index < 0 || checked.has(index) || board[index] !== EMPTY) return null;
      checked.add(index);
      const left = remaining();
      const perMove = left > 0 ? Math.max(0, Math.min(24, left)) : 0;
      const vctLeft = vctState.budget - vctState.used;
      const vctPerMove = vctLeft > 0 ? Math.min(20, vctLeft) : 0;
      const check = checkMoveSafety(board, index, mark, perMove, threatState,
        vctPerMove, vctState, cfg.vctMaxDepth || 14);
      scanned += 1;
      if (check.safe) return { index, check };
      const candidate = { index, check };
      if (bucket === "extras") {
        if (!extrasUnsafe || safetySeverity(check) < safetySeverity(extrasUnsafe.check)) {
          extrasUnsafe = candidate;
        }
      } else if (!bestUnsafe || safetySeverity(check) < safetySeverity(bestUnsafe.check)) {
        bestUnsafe = candidate;
      }
      return null;
    };

    const returnSafe = (safe) => ({
      index: safe.index,
      check: safe.check,
      changed: true,
      originalIndex: preferred,
      originalCheck: first,
      scanned
    });

    // 先按旧版顺序检查 rankedMoves 候选，保证“同严重度”时兜底着法与旧版一致；
    // 再用威胁视图补充 ranked 之外的点：挡五 -> 挡冲四 -> 己方反冲四 -> 挡活三 -> 己方活三。
    for (const move of moves) {
      const safe = checkCandidate(move.index, "ranked");
      if (safe) return returnSafe(safe);
    }

    if (threatState) {
      const extras = [];
      const collect = (cells, limit) => {
        for (const index of cells) {
          if (extras.length >= limit) return;
          if (index < 0 || checked.has(index) || board[index] !== EMPTY) continue;
          if (!RULES.isMoveLegal(board, index, mark)) continue;
          extras.push(index);
        }
      };
      collect(threatState.winCells(opponent), 4);
      collect(threatState.fourCells(opponent), 12);
      collect(threatState.fourCells(mark), 6);
      collect(threatState.openThreeCells(opponent), 10);
      collect(threatState.openThreeCells(mark), 4);

      for (const index of extras) {
        const safe = checkCandidate(index, "extras");
        if (safe) return returnSafe(safe);
      }
    }

    // 再把检测出的对手威胁点也纳入候选：这些点往往能挡掉五或 VCF 起点。
    const replies = [];
    if (first.reply !== undefined && first.reply !== null) replies.push(first.reply);
    if (bestUnsafe && bestUnsafe.check.reply !== undefined && bestUnsafe.check.reply !== null) {
      replies.push(bestUnsafe.check.reply);
    }
    if (extrasUnsafe && extrasUnsafe.check.reply !== undefined && extrasUnsafe.check.reply !== null) {
      replies.push(extrasUnsafe.check.reply);
    }
    for (const reply of replies) {
      const safe = checkCandidate(reply, "extras");
      if (safe) return returnSafe(safe);
    }

    // 第 6 轮：不仅试 VCF/VCT 杀棋首着本身，还反查它产生的防守点。
    // 冲四杀首着 -> 成五挡点；活三杀首着 -> openThreeDefenses 全集。
    if (threatState) {
      const defenseExtras = [];
      const addDefenseCells = (cells) => {
        for (const q of cells) {
          if (defenseExtras.length >= 24) return;
          if (q < 0 || checked.has(q) || board[q] !== EMPTY) continue;
          if (!RULES.isMoveLegal(board, q, mark)) continue;
          if (defenseExtras.includes(q)) continue;
          defenseExtras.push(q);
        }
      };
      const collectReplyDefenses = (reply) => {
        let attack = null;
        for (const gain of THREATS.forcingMoves(board, opponent, threatState)) {
          if (gain.index === reply) {
            attack = gain;
            break;
          }
        }
        if (!attack) {
          for (const three of THREATS.openThreeMoves(board, opponent, threatState)) {
            if (three.index === reply) {
              attack = three;
              break;
            }
          }
        }
        if (!attack) return;
        if (attack.winPoints && attack.winPoints.length) {
          addDefenseCells(attack.winPoints);
        } else if (attack.threePoints && attack.threePoints.length) {
          addDefenseCells(THREATS.openThreeDefenses(board, attack, mark, threatState));
        }
      };
      for (const reply of replies) collectReplyDefenses(reply);
      for (const index of defenseExtras) {
        const safe = checkCandidate(index, "extras");
        if (safe) return returnSafe(safe);
      }
    }

    // 没有安全替代时，选择严重度最低的不安全替代，并显式记录，不静默照走首选。
    // 同严重度优先保留 rankedMoves 的原顺序（tie-break 与旧版一致）。
    const fallback = bestUnsafe && (!extrasUnsafe || safetySeverity(bestUnsafe.check) <= safetySeverity(extrasUnsafe.check))
      ? bestUnsafe
      : extrasUnsafe;
    if (fallback && fallback.index !== preferred) {
      return {
        index: fallback.index,
        check: fallback.check,
        changed: true,
        originalIndex: preferred,
        originalCheck: first,
        safeFallbacksExhausted: true,
        scanned
      };
    }

    return {
      index: preferred,
      check: first,
      changed: false,
      safeFallbacksExhausted: true,
      scanned
    };
  }

  /* 入门：贪心 + 少量随机。 */
  function easyMove(board, mark) {
    if (isBoardEmpty(board)) return centerIndex();
    const immediate = firstLegalImmediateWin(board, mark);
    if (immediate >= 0) return immediate;
    const block = firstLegalBlock(board, mark);
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
        timeMs: 1200,
        maxDepth: 14,
        vcf: true,
        vcfTime: 40,
        vcfMaxDepth: 16,
        vct: true,
        // VCT 双活三样本约 20ms 即可证明；中盘无证明时不再空转 80ms，改为 40ms。
        vctTime: 40,
        vctMaxDepth: 14,
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
    const enhanced = cfg.enhanced === true;
    if (enhanced && cfg.search) {
      cfg.safeRoot = true;
      cfg.search = Object.assign({}, cfg.search, {
        movePicker: false,
        staged: true,
        qsearch: false,
        bucketOrder: false
      });
    }
    const opponent = RULES.other(mark);
    const startedAt = performance.now();
    const remaining = () => Math.max(0, cfg.timeMs - (performance.now() - startedAt));
    const phaseMs = { vcf: 0, vct: 0, search: 0 };
    // VCT 阶段按需构建一次根威胁视图，之后复用到 root safety，避免重复扫描。
    let rootThreatState = null;
    // root safety 需要独立预算；否则普通搜索会用光时间，安全检查只剩几 ms。
    // 总预算仍为 cfg.timeMs，这里只是从普通 AB 里预留一部分给安全检查。
    const safetyReserveMs = cfg.safeRoot ? Math.min(160, Math.floor(cfg.timeMs * 0.12)) : 0;
    const snapshotPhaseMs = () => ({ vcf: phaseMs.vcf, vct: phaseMs.vct, search: phaseMs.search });
    const finalize = (result, reason) => {
      result.phaseMs = snapshotPhaseMs();
      if (typeof result.timeMs !== "number") result.timeMs = performance.now() - startedAt;
      if (reason) result.reason = reason;
      return result;
    };

    if (isBoardEmpty(board)) {
      // 黑棋标准开局走天元。
      return finalize({ index: centerIndex(), score: 0, depth: 0, nodes: 0, reason: "opening" });
    }

    // 开局库。
    const book = OPENING.find(board, mark);
    if (book >= 0) return finalize({ index: book, score: 0, depth: 0, nodes: 0, reason: "book" });

    // 1. 自己直接成五。
    const win = firstLegalImmediateWin(board, mark);
    if (win >= 0) return finalize({ index: win, score: SEARCH.MATE, depth: 0, nodes: 0, reason: "five" });

    // 2. 必须挡对方成五（挡点必须对 mark 合法，黑棋可能是禁手）。
    const block = firstLegalBlock(board, mark);
    if (block >= 0) return finalize({ index: block, score: SEARCH.MATE - 1, depth: 0, nodes: 0, reason: "block-five" });

    // 3. VCF: continuous four proof. Zero budget skips the phase.
    if (cfg.vcf && cfg.vcfTime > 0) {
      const budget = Math.min(cfg.vcfTime, remaining());
      if (budget > 0) {
        const started = performance.now();
        try {
          const vcf = THREATS.findVcf(board, mark, budget, cfg.vcfMaxDepth || 16);
          phaseMs.vcf = performance.now() - started;
          if (vcf >= 0) return finalize({ index: vcf, score: SEARCH.MATE, depth: 0, nodes: 0, reason: "vcf" });
        } catch (error) {
          phaseMs.vcf = performance.now() - started;
          // Timeout means no proof.
        }
      }
    }

    // 4. VCT: live-three then VCF. Zero budget skips the phase.
    if (cfg.vct && cfg.vctTime > 0) {
      const baseBudget = Math.min(cfg.vctTime, remaining());
      if (baseBudget > 0) {
        if (!rootThreatState && BOARD_STATE && BOARD_STATE.BoardState) {
          rootThreatState = new BOARD_STATE.BoardState(board, 2);
        }
        const budget = adaptiveVctBudget(rootThreatState, mark, baseBudget);
        const started = performance.now();
        try {
          const vct = THREATS.findVct(board, mark, budget, cfg.vctMaxDepth || 14);
          phaseMs.vct = performance.now() - started;
          if (vct >= 0) return finalize({ index: vct, score: SEARCH.MATE, depth: 0, nodes: 0, reason: "vct" });
        } catch (error) {
          phaseMs.vct = performance.now() - started;
          // Timeout means no proof.
        }
      }
    }

    // 5. 正常搜索（给 root safety 预留预算）。
    const searchBudget = Math.max(0, remaining() - safetyReserveMs);
    const result = SEARCH.iterate(board, mark, searchBudget, cfg.maxDepth, cfg.search);
    phaseMs.search = Number(result.timeMs) || 0;
    if (result.index >= 0) {
      finalize(result, "search");
      if (cfg.safeRoot) {
        const safeMove = chooseSafeRootMove(board, mark, result.index, cfg, remaining, rootThreatState);
        result.safe = safeMove.check.safe;
        result.safetyReason = safeMove.check.reason;
        if (typeof safeMove.scanned === "number") result.safeFallbacksScanned = safeMove.scanned;
        if (safeMove.safeFallbacksExhausted) result.safeFallbacksExhausted = true;
        if (safeMove.changed) {
          result.originalIndex = safeMove.originalIndex;
          result.originalSafetyReason = safeMove.originalCheck.reason;
          result.index = safeMove.index;
          result.reason = safeMove.check.safe ? "search-safe-fallback" : "search-unsafe-fallback";
          result.safe = safeMove.check.safe;
          result.safetyReason = safeMove.check.reason;
        }
      }
      return result;
    }

    const fallback = MOVEGEN.rankedMoves(board, mark, 4, { prefilter: 24, width: 4 });
    return finalize({
      index: fallback.length ? fallback[0].index : centerIndex(),
      score: 0,
      depth: 0,
      nodes: 0,
      reason: "fallback"
    });
  }

  const Ai = {
    easyMove,
    bestMove,
    configFor,
    // 内部测试钩子：验证 root safety 的对手 VCT 检测，不参与生产路径。
    checkMoveSafety
  };

  global.GomokuAi = Ai;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = Ai;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);


/* 桥接：浏览器下 window === globalThis；Node vm 测试和 Worker 下显式复制。 */

(function (global) {
  "use strict";
  const target = global.window || global;
  const names = [
    "GomokuCore",
    "GomokuRules",
    "GomokuPatterns",
    "GomokuMoveGen",
    "GomokuThreatModel",
    "GomokuMovePicker",
    "GomokuBoardState",
    "GomokuSearch",
    "GomokuThreats",
    "GomokuOpening",
    "GomokuAi"
  ];
  for (const name of names) {
    if (global && global[name] && !target[name]) target[name] = global[name];
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

/* PR 版 AI 禁手开关：false 时 AI 不考虑禁手，按自由规则进攻。 */
const AI_CONSIDER_FORBIDDEN = true;
(function (global) {
  "use strict";
  const target = global.window || global;
  if (target.GomokuRules) target.GomokuRules.setMode(AI_CONSIDER_FORBIDDEN ? "renju" : "free");
})(typeof globalThis !== "undefined" ? globalThis : this);

/* 补充公开接口：供朋友后续接玩家侧禁手规则。 */

(function (global) {
  "use strict";
  const target = global.window || global;
  if (!target.GomokuRules || !target.GomokuCore) return;
  const base = target.GomokuCore;
  target.GomokuCore = Object.freeze(Object.assign({}, base, {
    inspectMove: target.GomokuRules.inspectMove,
    isMoveLegal: target.GomokuRules.isMoveLegal,
    setAiRenju: function (enabled) { target.GomokuRules.setMode(enabled ? "renju" : "free"); },
    getAiRenju: function () { return target.GomokuRules.getMode() === "renju"; },
    bestMoveInfo: function (board, mark, level, options) {
      return target.GomokuAi.bestMove(board, mark, level || "hard", options);
    }
  }));
})(typeof globalThis !== "undefined" ? globalThis : this);
