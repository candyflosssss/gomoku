// 五子棋端到端联机审计（自研）：静态服务 + 五子棋房间服务 + 三个无头浏览器，
// 覆盖 建房(公开+密码) → 密码校验 → 加入 → 准备 → 开局 → 剪刀石头布 → P2P 落子
// → 五连胜负 → 观战同步 → 再来一局。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dirname, "..");
const host = "127.0.0.1";
const chromeExecutable = process.env.GOMOKU_CHROME || "google-chrome";
const processes = [];
let taskDirectory = "";

function sleep(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolveReady);
  });
  const { port } = server.address();
  await new Promise((resolveClosed) => server.close(resolveClosed));
  return port;
}

function start(label, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: repository,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  });
  const record = { label, child, output: "" };
  const append = (chunk) => { record.output = `${record.output}${chunk}`.slice(-32_768); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  processes.push(record);
  return record;
}

async function stop(record) {
  if (record.child.exitCode !== null || !record.child.pid) return;
  try {
    process.kill(-record.child.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  await Promise.race([
    new Promise((resolveExit) => record.child.once("exit", resolveExit)),
    sleep(1_500)
  ]);
  if (record.child.exitCode === null) {
    try {
      process.kill(-record.child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

async function waitForHttp(url, record) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // still starting
    }
    if (record.child.exitCode !== null) break;
    await sleep(100);
  }
  throw new Error(`${record.label} did not become ready\n${record.output}`);
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
  }

  async open() {
    await new Promise((resolveOpen, reject) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

async function createPage(debugPort) {
  const response = await fetch(`http://${host}:${debugPort}/json/new?about:blank`, { method: "PUT" });
  assert.ok(response.ok);
  const target = await response.json();
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  return cdp;
}

async function waitFor(page, expression, label, attempts = 200) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const value = await page.evaluate(expression);
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

async function navigate(page, url) {
  await page.send("Page.navigate", { url });
  await waitFor(page, `location.href === ${JSON.stringify(url)} && document.readyState === "complete"`, url);
}

function js(...lines) {
  return lines.join("\n");
}

async function main() {
  const [staticPort, roomPort, hostDebugPort, guestDebugPort, specDebugPort] = await Promise.all([
    freePort(), freePort(), freePort(), freePort(), freePort()
  ]);
  const origin = `http://${host}:${staticPort}`;
  const apiBase = `http://${host}:${roomPort}/api/gomoku`;
  const gameUrl = `${origin}/index.html?testAuth=disabled&api=${encodeURIComponent(apiBase)}`;

  const staticServer = start("static server", "python3", [
    "-m", "http.server", String(staticPort), "--bind", host, "--directory", join(repository, "web")
  ]);
  const roomServer = start("gomoku room server", process.execPath, ["server/room-server.mjs"], {
    env: {
      ...process.env,
      GOMOKU_HOST: host,
      GOMOKU_PORT: String(roomPort),
      GOMOKU_ALLOWED_ORIGIN: origin,
      GOMOKU_AUTH_REQUIRED: "false",
      GOMOKU_VIEW_RATE_LIMIT: "10000"
    }
  });
  await Promise.all([
    waitForHttp(`${origin}/index.html`, staticServer),
    waitForHttp(`${apiBase}/health`, roomServer)
  ]);

  taskDirectory = mkdtempSync(join(process.env.TMPDIR || repository, ".gomoku-p2p-"));
  const chromeArgs = (debugPort, profile) => [
    "--headless=new",
    "--no-sandbox",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "about:blank"
  ];
  const hostProfile = join(taskDirectory, "host-profile");
  const guestProfile = join(taskDirectory, "guest-profile");
  const specProfile = join(taskDirectory, "spec-profile");
  mkdirSync(hostProfile);
  mkdirSync(guestProfile);
  mkdirSync(specProfile);
  const hostChrome = start("host Chrome", chromeExecutable, chromeArgs(hostDebugPort, hostProfile));
  const guestChrome = start("guest Chrome", chromeExecutable, chromeArgs(guestDebugPort, guestProfile));
  const specChrome = start("spec Chrome", chromeExecutable, chromeArgs(specDebugPort, specProfile));
  await Promise.all([
    waitForHttp(`http://${host}:${hostDebugPort}/json/version`, hostChrome),
    waitForHttp(`http://${host}:${guestDebugPort}/json/version`, guestChrome),
    waitForHttp(`http://${host}:${specDebugPort}/json/version`, specChrome)
  ]);

  const hostPage = await createPage(hostDebugPort);
  const guestPage = await createPage(guestDebugPort);
  const specPage = await createPage(specDebugPort);
  console.log("[1] servers + 3 chrome pages ready");

  const roomApi = (path) => fetch(`${apiBase}${path}`).then((response) => response.json());
  let roomCodeValue = "";
  const roomState = async () => (await roomApi(`/rooms/${roomCodeValue}`)).room.state;

  try {
    // ---------- 双方进入联机面板 ----------
    await Promise.all([navigate(hostPage, gameUrl), navigate(guestPage, gameUrl)]);
    console.log("[2] pages navigated");
    await waitFor(hostPage, `document.querySelector('.mode-card[data-mode="net"]') !== null`, "menu");
    console.log("[3] menu ready");

    // ---------- 人机先手禁手：开关、玩家拒绝、AI 合法兜底 ----------
    const renjuAudit = await hostPage.evaluate(js(
      `(() => {
        document.querySelector('.mode-card[data-mode="ai"]').click();
        const toggle = document.querySelector('#ai-renju');
        const defaultOn = toggle.classList.contains('on') && toggle.getAttribute('aria-pressed') === 'true';
        toggle.click();
        const toggledOff = !toggle.classList.contains('on') && toggle.getAttribute('aria-pressed') === 'false';
        startAiGame('easy', core.BLACK, false);
        const freeMode = !core.getAiRenju();
        startAiGame('easy', core.BLACK, true);
        const renjuMode = core.getAiRenju();

        const at = (row, column) => row * core.SIZE + column;
        game.board = Array(core.CELL_COUNT).fill(core.EMPTY);
        for (const index of [at(7, 6), at(7, 8), at(6, 7), at(8, 7)]) game.board[index] = core.BLACK;
        game.history = [];
        game.turn = core.BLACK;
        const forbidden = at(7, 7);
        const moved = applyMove(forbidden, core.BLACK);
        const fallback = core.aiMove(game.board, core.BLACK, 'easy');
        return {
          defaultOn,
          toggledOff,
          freeMode,
          renjuMode,
          moved,
          historyLength: game.history.length,
          fallback,
          fallbackLegal: fallback !== forbidden && core.isMoveLegal(game.board, fallback, core.BLACK)
        };
      })()`
    ));
    assert.equal(renjuAudit.defaultOn, true, "renju toggle defaults on");
    assert.equal(renjuAudit.toggledOff, true, "renju toggle can be disabled");
    assert.equal(renjuAudit.freeMode, true, "free mode reaches the core");
    assert.equal(renjuAudit.renjuMode, true, "renju mode reaches the core");
    assert.equal(renjuAudit.moved, false, "player black forbidden move is rejected");
    assert.equal(renjuAudit.historyLength, 0, "rejected move does not enter history");
    assert.equal(renjuAudit.fallbackLegal, true, "AI replaces a forbidden move with a legal move");
    await navigate(hostPage, gameUrl);
    console.log("[3.5] AI renju toggle passed");

    const enterNet = (page, nickname) => page.evaluate(js(
      `(() => {
        document.querySelector('.mode-card[data-mode="net"]').click();
        const input = document.querySelector('#net-nickname');
        input.value = ${JSON.stringify(nickname)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`
    ));
    await enterNet(hostPage, "主机");
    await enterNet(guestPage, "客人");
    console.log("[4] net panels entered");

    // ---------- 创建公开 + 密码房间 ----------
    await hostPage.evaluate(js(
      `(() => {
        document.querySelector('#create-visibility').click();
        document.querySelector('#create-password').value = 'abc123';
        document.querySelector('#create-submit').click();
        return true;
      })()`
    ));
    const code = await waitFor(hostPage,
      `(document.querySelector('#screen-lobby').classList.contains('active') && document.querySelector('#lobby-code').textContent.trim().length === 6) ? document.querySelector('#lobby-code').textContent.trim() : ''`,
      "host lobby code");
    assert.match(code, /^[A-Z0-9]{6}$/);
    roomCodeValue = code;
    console.log(`room ${code} created (public + password)`);

    // ---------- 公开列表可见 ----------
    const listed = await roomApi("/rooms/public");
    assert.ok(listed.rooms.some((room) => room.code === code && room.hasPassword), "public list shows room");

    // ---------- 错误密码被拒 ----------
    await guestPage.evaluate(js(
      `(() => {
        document.querySelectorAll('.tabs button').forEach((button) => { if (button.dataset.tab === 'join') button.click(); });
        const input = document.querySelector('#join-code');
        input.value = ${JSON.stringify(code)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#join-password').value = 'wrong';
        document.querySelector('#join-submit').click();
        return true;
      })()`
    ));
    await waitFor(guestPage,
      `document.querySelector('#toast').classList.contains('error')`,
      "wrong password toast");
    const toastText = await guestPage.evaluate(`document.querySelector('#toast').textContent`);
    assert.match(toastText, /密码/, `wrong password rejected: ${toastText}`);

    // ---------- 正确密码加入 ----------
    await guestPage.evaluate(js(
      `(() => {
        document.querySelector('#join-password').value = 'abc123';
        document.querySelector('#join-submit').click();
        return true;
      })()`
    ));
    await waitFor(guestPage,
      `document.querySelector('#screen-lobby').classList.contains('active')`,
      "guest lobby");
    const lobbyNames = await guestPage.evaluate(
      `document.querySelector('#slot-black-name').textContent + '|' + document.querySelector('#slot-white-name').textContent`
    );
    assert.match(lobbyNames, /主机/);
    assert.match(lobbyNames, /客人/);

    // ---------- 准备 + 开局 ----------
    await hostPage.evaluate(`document.querySelector('#ready-btn').click(); true`);
    await guestPage.evaluate(`document.querySelector('#ready-btn').click(); true`);
    await waitFor(hostPage, `!document.querySelector('#start-btn').disabled`, "start enabled");
    await hostPage.evaluate(`document.querySelector('#start-btn').click(); true`);
    await Promise.all([
      waitFor(hostPage, `document.querySelector('#screen-rps').classList.contains('active')`, "host rps screen"),
      waitFor(guestPage, `document.querySelector('#screen-rps').classList.contains('active')`, "guest rps screen")
    ]);

    // ---------- 剪刀石头布：主机石头 vs 客人剪刀 → 主机执黑 ----------
    const rpsButtons = (page, choice) => page.evaluate(
      `document.querySelector('.rps-buttons button[data-choice="${choice}"]').click(); true`
    );
    await Promise.all([
      waitFor(hostPage, `!document.querySelector('#rps-choose').hidden && !document.querySelector('.rps-buttons button').disabled`, "host rps ready"),
      waitFor(guestPage, `!document.querySelector('#rps-choose').hidden && !document.querySelector('.rps-buttons button').disabled`, "guest rps ready")
    ]);
    await rpsButtons(hostPage, "rock");
    await rpsButtons(guestPage, "scissors");
    await Promise.all([
      waitFor(hostPage, `document.querySelector('#screen-game').classList.contains('active')`, "host game screen"),
      waitFor(guestPage, `document.querySelector('#screen-game').classList.contains('active')`, "guest game screen")
    ]);
    const hostWho = await hostPage.evaluate(`document.querySelector('#game-who').textContent`);
    assert.match(hostWho, /执黑/, `host should be black after RPS: ${hostWho}`);
    const guestWho = await guestPage.evaluate(`document.querySelector('#game-who').textContent`);
    assert.match(guestWho, /执白/, `guest should be white after RPS: ${guestWho}`);

    // ---------- P2P 直连 ----------
    let p2pDirect = false;
    try {
      await waitFor(hostPage,
        `document.querySelector('#conn-badge')?.textContent === 'P2P 直连'`,
        "P2P direct connection", 250);
      p2pDirect = true;
      console.log("P2P data channel established");
    } catch (error) {
      console.warn(`P2P direct not observed (${error.message}) — server fallback covers moves`);
    }

    // ---------- 观战者加入（对局进行中） ----------
    await navigate(specPage, gameUrl);
    await waitFor(specPage, `document.querySelector('.mode-card[data-mode="net"]') !== null`, "spec menu");
    await specPage.evaluate(js(
      `(() => {
        document.querySelector('.mode-card[data-mode="net"]').click();
        const input = document.querySelector('#net-nickname');
        input.value = '观众';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelectorAll('.tabs button').forEach((button) => { if (button.dataset.tab === 'join') button.click(); });
        const codeInput = document.querySelector('#join-code');
        codeInput.value = ${JSON.stringify(code)};
        codeInput.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#join-password').value = 'abc123';
        document.querySelector('#join-spectate').click();
        document.querySelector('#join-submit').click();
        return true;
      })()`
    ));
    await waitFor(specPage,
      `document.querySelector('#screen-game').classList.contains('active')`,
      "spectator game screen");
    const specWho = await specPage.evaluate(`document.querySelector('#game-who').textContent`);
    assert.match(specWho, /观战/, `spectator badge: ${specWho}`);

    // ---------- 落子：主机横线五连取胜 ----------
    const clickCell = (page, row, column) => page.evaluate(js(
      `(() => {
        const canvas = document.querySelector('#board');
        const rect = canvas.getBoundingClientRect();
        const size = rect.width / 16;
        const x = rect.left + size + ${column} * size;
        const y = rect.top + size + ${row} * size;
        const element = document.elementFromPoint(x, y);
        const options = { clientX: x, clientY: y, bubbles: true, cancelable: true };
        element.dispatchEvent(new PointerEvent('pointermove', options));
        element.dispatchEvent(new MouseEvent('click', options));
        return true;
      })()`
    ));
    const moves = [
      ["host", 0, 0], ["guest", 1, 0],
      ["host", 0, 1], ["guest", 1, 1],
      ["host", 0, 2], ["guest", 1, 2],
      ["host", 0, 3], ["guest", 1, 3],
      ["host", 0, 4]
    ];
    let expectedMoves = 0;
    async function waitRoomMove(minMoves, label) {
      for (let attempt = 0; attempt < 150; attempt += 1) {
        const state = await roomState();
        if (state && state.moveCount >= minMoves) return state;
        await sleep(100);
      }
      throw new Error(`Timed out waiting for ${label}`);
    }
    for (const [side, row, column] of moves) {
      await clickCell(side === "host" ? hostPage : guestPage, row, column);
      expectedMoves += 1;
      await waitRoomMove(expectedMoves, `move ${expectedMoves} applied`);
    }

    // ---------- 胜负 ----------
    const finalState = await roomState();
    assert.equal(finalState.moveCount, 9, "move count");
    assert.equal(finalState.reason, "five", "win reason");
    assert.equal(finalState.winLine.length, 5, "win line");
    await waitFor(hostPage,
      `document.querySelector('#result-layer').classList.contains('show') && document.querySelector('#result-title').textContent.includes('你赢了')`,
      "host win overlay");
    await waitFor(guestPage,
      `document.querySelector('#result-layer').classList.contains('show') && document.querySelector('#result-title').textContent.includes('你输了')`,
      "guest loss overlay");
    await waitFor(specPage,
      `document.querySelector('#result-layer').classList.contains('show')`,
      "spectator result overlay");

    // ---------- 再来一局 → 回到出拳 ----------
    await hostPage.evaluate(`document.querySelector('#result-actions .primary-btn').click(); true`);
    await guestPage.evaluate(`document.querySelector('#result-actions .primary-btn').click(); true`);
    await Promise.all([
      waitFor(hostPage, `document.querySelector('#screen-rps').classList.contains('active')`, "host rematch rps"),
      waitFor(guestPage, `document.querySelector('#screen-rps').classList.contains('active')`, "guest rematch rps")
    ]);
    const roundAfter = (await roomApi(`/rooms/${roomCodeValue}`)).room.roundNumber;
    assert.ok(roundAfter >= 2, `round number advanced: ${roundAfter}`);

    console.log(`Gomoku P2P e2e passed: public+password room, RPS first move, ${p2pDirect ? "P2P direct moves" : "server-fallback moves"}, win, spectator, rematch`);
    process.exitCode = 0;
  } finally {
    for (const page of [hostPage, guestPage, specPage]) page.close();
    for (const record of [...processes].reverse()) await stop(record);
    if (taskDirectory) rmSync(taskDirectory, { recursive: true, force: true });
  }
}

main().catch(async (error) => {
  console.error(error);
  console.error("process outputs:\n" + processes.map((record) => (
    `--- ${record.label} ---\n${record.output}`
  )).join("\n"));
  for (const record of [...processes].reverse()) await stop(record);
  if (taskDirectory) rmSync(taskDirectory, { recursive: true, force: true });
  process.exitCode = 1;
});
