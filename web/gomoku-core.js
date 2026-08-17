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

    // hard：α-β 搜索，深度 6，候选裁剪到 8
    const budgetRef = { count: 8_000 };
    const narrowed = (boardRef, mark) => rankedMoves(boardRef, mark, 8);
    const result = search(board, aiMark, 6, -Infinity, Infinity, narrowed, null, budgetRef);
    return result.move >= 0 ? result.move : rankedMoves(board, aiMark, 1)[0];
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
