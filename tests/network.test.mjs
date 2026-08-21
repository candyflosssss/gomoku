// 五子棋联机层集成测试（无浏览器）：真实房间服务 + 真实 gomoku-net.js 客户端逻辑。
// 用模拟的 RTCPeerConnection 数据通道把两台客户端真实对接，走完 P2P 的 command/state
// 消息路径；另外单独验证无 P2P 时的服务器 /move 回退。覆盖：
//   公开+密码建房 → 公开列表 → 错误密码被拒 → 正确密码加入 → 观战加入 →
//   准备 → 开局 → 剪刀石头布定先手 → P2P 落子 → 五连胜负 → 观战同步 →
//   再来一局 → 认输 → 服务器回退落子。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const repository = fileURLToPath(new URL("..", import.meta.url));
const nodeExecutable = process.execPath;
const HOST_IP = "127.0.0.1";
const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function freePort() {
  const server = createServer();
  await new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, HOST_IP, resolveReady);
  });
  const { port } = server.address();
  await new Promise((resolveClosed) => server.close(resolveClosed));
  return port;
}

// ---------- 模拟 WebRTC：两条数据通道通过共享链路真实对接 ----------
function createFakeRtcLink() {
  const link = { hostChannel: null, guestChannel: null };
  return link;
}

function makeFakePeerFactory(link) {
  class FakeChannel {
    constructor() {
      this.readyState = "connecting";
      this.listeners = {};
      this.remote = null;
    }
    addEventListener(type, callback) {
      (this.listeners[type] ||= []).push(callback);
    }
    fire(type, event) {
      for (const callback of this.listeners[type] || []) callback(event);
    }
    send(data) {
      if (this.readyState === "open" && this.remote) this.remote.receive(data);
    }
    receive(data) {
      this.fire("message", { data });
    }
    close() {
      this.readyState = "closed";
    }
    open() {
      this.readyState = "open";
      this.fire("open", {});
    }
  }

  class FakePeer {
    constructor() {
      this.listeners = {};
      this.remoteDescription = null;
      this.localDescription = null;
      this.channel = null;
      this.connectionState = "connecting";
    }
    addEventListener(type, callback) {
      (this.listeners[type] ||= []).push(callback);
    }
    fire(type, event) {
      for (const callback of this.listeners[type] || []) callback(event);
    }
    createDataChannel(label) {
      this.channel = new FakeChannel();
      link.hostChannel = this.channel;
      return this.channel;
    }
    setRemoteDescription(description) {
      this.remoteDescription = description;
      if (description?.type === "offer" && !link.blocked) {
        const guestChannel = new FakeChannel();
        link.guestChannel = guestChannel;
        if (link.hostChannel) {
          link.hostChannel.remote = guestChannel;
          guestChannel.remote = link.hostChannel;
        }
        // 触发对方的 datachannel 事件（非房主侧绑定通道）
        this.fire("datachannel", { channel: guestChannel });
        // 简易：offer/answer 一定走通，直接打开两侧通道
        if (link.hostChannel) link.hostChannel.open();
        guestChannel.open();
      }
    }
    createOffer() {
      return { type: "offer", sdp: `fake-offer-${randomUUID()}` };
    }
    createAnswer() {
      return { type: "answer", sdp: `fake-answer-${randomUUID()}` };
    }
    async setLocalDescription(description) {
      this.localDescription = description;
      if (description?.type === "offer") {
        this.connectionState = "connected";
        this.fire("icecandidate", { candidate: null });
      }
    }
    async addIceCandidate() {
      // 无真实 ICE，忽略
    }
    close() {
      this.connectionState = "closed";
    }
  }
  return FakePeer;
}

// ---------- 客户端宿主（vm 上下文 + window/localStorage 桩） ----------
function createClient({ apiBase, rtcFactory, storage, coreSource }) {
  const windowShim = {
    GomokuCore: null,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  };
  const context = vm.createContext({
    console,
    Math,
    JSON,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    TypeError,
    RangeError,
    Date,
    Map,
    Set,
    RegExp,
    parseInt,
    parseFloat,
    isNaN,
    encodeURIComponent,
    decodeURIComponent,
    URL,
    URLSearchParams,
    queueMicrotask,
    crypto,
    fetch,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    window: windowShim,
    location: { hostname: HOST_IP, search: `?api=${encodeURIComponent(apiBase)}` },
    localStorage: storage,
    RTCPeerConnection: rtcFactory,
    __DSH_DEBUG__: true
  });
  vm.runInContext(coreSource, context, { filename: "gomoku-core.js" });
  vm.runInContext(
    readFileSync(`${repository}web/gomoku-net.js`, "utf8"),
    context,
    { filename: "gomoku-net.js" }
  );
  return windowShim.GomokuNet;
}

async function waitFor(label, fn, timeoutMs = 20_000) {
  const start = Date.now();
  let lastValue;
  while (Date.now() - start < timeoutMs) {
    lastValue = await fn();
    if (lastValue) return lastValue;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label} (last: ${JSON.stringify(lastValue)})`);
}

let roomServer;
let port;

async function startServer() {
  port = await freePort();
  roomServer = spawn(nodeExecutable, ["server/room-server.mjs"], {
    cwd: repository,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GOMOKU_HOST: HOST_IP,
      GOMOKU_PORT: String(port),
      GOMOKU_ALLOWED_ORIGIN: "*",
      GOMOKU_AUTH_REQUIRED: "false",
      GOMOKU_VIEW_RATE_LIMIT: "10000"
    }
  });
  let output = "";
  roomServer.stdout.on("data", (chunk) => { output += chunk; });
  roomServer.stderr.on("data", (chunk) => { output += chunk; });
  const apiBase = `http://${HOST_IP}:${port}/api/gomoku`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return apiBase;
    } catch {
      // 启动中
    }
    if (roomServer.exitCode !== null) throw new Error(`room server exited: ${output}`);
    await sleep(100);
  }
  throw new Error(`room server not ready: ${output}`);
}

async function stopServer() {
  if (!roomServer?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(roomServer.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-roomServer.pid, "SIGTERM");
    } catch {
      // 已退出
    }
  }
  await Promise.race([
    new Promise((resolveExit) => roomServer.once("exit", resolveExit)),
    sleep(1_000)
  ]);
}

async function main() {
  const apiBase = await startServer();
  console.log("[0] room server up");
  const coreSource = readFileSync(`${repository}web/gomoku-core.js`, "utf8");
  const makeStorage = () => {
    const map = new Map();
    return {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => map.set(key, String(value)),
      removeItem: (key) => map.delete(key)
    };
  };

  // 两个玩家 + 一个观战（主机与客人共享同一个 link，模拟同一对 WebRTC 连接）
  const playerLink = createFakeRtcLink();
  const hostClient = createClient({ apiBase, rtcFactory: makeFakePeerFactory(playerLink), storage: makeStorage(), coreSource });
  const guest = createClient({ apiBase, rtcFactory: makeFakePeerFactory(playerLink), storage: makeStorage(), coreSource });
  const specLink = createFakeRtcLink();
  const spectator = createClient({ apiBase, rtcFactory: makeFakePeerFactory(specLink), storage: makeStorage(), coreSource });
  console.log("[0.5] three clients built");

  // 回退场景客户端（在 try 外声明，供 finally 清理）
  let fallbackHostClient = null;
  let fallbackGuestClient = null;

  try {
    // ---- 创建公开 + 密码房间 ----
    const created = await hostClient.createRoom({ nickname: "主机", visibility: "public", password: "abc123" });
    console.log("[0.75] createRoom resolved");
    assert.equal(created.status, "lobby");
    const code = hostClient.code;
    assert.match(code, /^[A-Z0-9]{6}$/);
    console.log(`[1] room ${code} created (public + password)`);

    // ---- 公开列表可见 + 密码仅暴露 hasPassword（哈希不外泄） ----
    const listed = await hostClient.listPublic();
    const entry = listed.find((room) => room.code === code);
    assert.ok(entry, "public list contains room");
    assert.equal(entry.hasPassword, true);
    const raw = await fetch(`http://${HOST_IP}:${port}/api/gomoku/rooms/${code}`).then((response) => response.json());
    assert.equal(raw.room.hasPassword, true);
    assert.equal("passwordHash" in raw.room, false, "password hash must not leak to clients");

    // ---- 错误密码被拒 ----
    let rejected = null;
    try {
      await guest.joinRoom({ code, nickname: "客人", password: "wrong" });
    } catch (error) {
      rejected = error;
    }
    assert.ok(rejected, "wrong password rejected");
    assert.match(rejected.message, /密码/, `reject message mentions password: ${rejected.message}`);

    // ---- 正确密码加入 ----
    await guest.joinRoom({ code, nickname: "客人", password: "abc123" });
    assert.equal(guest.role, "player");
    await waitFor("guest sees two players", () => (guest.snapshot?.players?.length === 2 ? true : null));

    // ---- 密码房观战同样必须校验密码 ----
    await assert.rejects(
      spectator.joinRoom({ code, nickname: "观众", asSpectator: true }),
      /密码/
    );
    await spectator.joinRoom({ code, nickname: "观众", password: "abc123", asSpectator: true });
    assert.equal(spectator.role, "spectator");
    await waitFor("spectator listed", () => (spectator.snapshot?.spectators?.length === 1 ? true : null));

    // ---- 准备 + 开局 ----
    await hostClient.setReady(true);
    await guest.setReady(true);
    await waitFor("host start enabled", () => (
      hostClient.snapshot?.hostId === hostClient.myId && hostClient.snapshot?.players?.every((player) => player.ready) ? true : null
    ));
    await hostClient.startMatch();
    await waitFor("countdown", () => (hostClient.status === "countdown" ? true : null));
    await waitFor("rps phase", () => (hostClient.status === "rps" ? true : null), 10_000);
    console.log("[2] RPS phase reached");

    // ---- 剪刀石头布：主机石头 vs 客人剪刀 → 主机执黑 ----
    await hostClient.submitRps("rock");
    await guest.submitRps("scissors");
    await waitFor("playing", () => (hostClient.status === "playing" ? true : null), 15_000);
    assert.equal(hostClient.state.blackId, hostClient.myId, "host wins RPS and plays black");
    assert.equal(hostClient.state.turnId, hostClient.myId, "black moves first");
    console.log("[3] RPS decided: host plays black");

    // ---- P2P 直连 ----
    await waitFor("host P2P direct", () => (hostClient.peerStatus === "direct" ? true : null), 15_000);
    await waitFor("guest P2P direct", () => (guest.peerStatus === "direct" ? true : null), 15_000);
    console.log("[4] P2P data channel established both sides");

    // ---- 通过 P2P 交替落子，主机横线五连 ----
    const moves = [
      ["host", 0, 0], ["guest", 1, 0],
      ["host", 0, 1], ["guest", 1, 1],
      ["host", 0, 2], ["guest", 1, 2],
      ["host", 0, 3], ["guest", 1, 3],
      ["host", 0, 4]
    ];
    for (let round = 0; round < moves.length; round += 1) {
      const [side, row, column] = moves[round];
      const client = side === "host" ? hostClient : guest;
      const index = row * 15 + column;
      await client.place(index);
      await waitFor(`move ${round + 1} applied on ${side}`, () => (
        client.state?.moveCount === round + 1 ? true : null
      ));
    }
    assert.equal(hostClient.state.moveCount, 9);
    assert.equal(hostClient.state.winnerId, hostClient.myId, "host wins");
    assert.equal(hostClient.state.reason, "five");
    assert.equal(hostClient.state.winLine.length, 5);
    assert.equal(hostClient.status, "finished");
    console.log("[5] host won with five-in-a-row via P2P moves");

    // ---- 观战同步到终局 ----
    await waitFor("spectator sees final state", () => (
      spectator.state?.moveCount === 9 && spectator.state?.winnerId === hostClient.myId ? true : null
    ), 25_000);
    assert.deepEqual(
      JSON.parse(JSON.stringify(spectator.state.winLine)),
      JSON.parse(JSON.stringify(hostClient.state.winLine))
    );
    console.log("[6] spectator synced to final board");

    // ---- 再来一局 ----
    await hostClient.rematch();
    await guest.rematch();
    await waitFor("rematch countdown", () => (hostClient.status === "countdown" && hostClient.snapshot.roundNumber >= 2 ? true : null), 10_000);
    console.log(`[7] rematch started (round ${hostClient.snapshot.roundNumber})`);

    // ---- 第二轮：出拳后认输 ----
    await waitFor("second rps", () => (hostClient.status === "rps" ? true : null), 10_000);
    await hostClient.submitRps("paper");
    await guest.submitRps("rock");
    await waitFor("second playing", () => (hostClient.status === "playing" ? true : null), 15_000);
    await hostClient.rawRequest("resign");
    await waitFor("forfeit", () => (hostClient.state?.reason === "forfeit" ? true : null), 10_000);
    assert.equal(hostClient.state.winnerId, guest.myId, "guest wins by forfeit");
    console.log("[8] resign recorded: guest wins by forfeit");

    // ---- 服务器回退：新房间，P2P 永不连通 → 等超时回退后走 /move ----
    const neverOpenLink = { hostChannel: null, guestChannel: null, blocked: true };
    fallbackHostClient = createClient({ apiBase, rtcFactory: makeFakePeerFactory(neverOpenLink), storage: makeStorage(), coreSource });
    fallbackGuestClient = createClient({ apiBase, rtcFactory: makeFakePeerFactory(neverOpenLink), storage: makeStorage(), coreSource });
    await fallbackHostClient.createRoom({ nickname: "回退主机", visibility: "private" });
    const fbCode = fallbackHostClient.code;
    await fallbackGuestClient.joinRoom({ code: fbCode, nickname: "回退客人" });
    await fallbackHostClient.setReady(true);
    await fallbackGuestClient.setReady(true);
    await fallbackHostClient.startMatch();
    await waitFor("fb rps", () => (fallbackHostClient.status === "rps" ? true : null), 10_000);
    await fallbackHostClient.submitRps("rock");
    await fallbackGuestClient.submitRps("rock"); // 平局 → 重来
    await waitFor("fb rps tie reset", () => (fallbackHostClient.status === "rps" && !fallbackHostClient.state.rpsResult ? true : null), 10_000);
    await fallbackHostClient.submitRps("rock"); // 主机石头赢剪刀 → 执黑先手
    await fallbackGuestClient.submitRps("scissors");
    await waitFor("fb playing", () => (fallbackHostClient.status === "playing" ? true : null), 15_000);
    // P2P 永不连通，等 10s 超时回退到服务器
    await waitFor("fb fallback to server", () => (fallbackHostClient.peerStatus === "server" ? true : null), 15_000);
    assert.equal(fallbackHostClient.peerStatus, "server");
    // 服务器权威落子
    await fallbackHostClient.place(7 * 15 + 7);
    await waitFor("fb move 1 via server", () => (fallbackHostClient.state?.moveCount === 1 ? true : null), 10_000);
    // 客人先等轮询同步到第 1 手再落子，避免版本竞态（真实场景是重试一次）
    await waitFor("fb guest synced to move 1", () => (fallbackGuestClient.state?.moveCount === 1 ? true : null), 10_000);
    await fallbackGuestClient.place(7 * 15 + 8);
    await waitFor("fb move 2 via server", () => (fallbackGuestClient.state?.moveCount === 2 ? true : null), 10_000);
    await waitFor("fb host synced to move 2", () => (fallbackHostClient.state?.moveCount === 2 ? true : null), 10_000);
    assert.equal(fallbackHostClient.state.moveCount, 2);
    assert.equal(fallbackGuestClient.state.moveCount, 2);
    console.log("[9] server fallback moves work without P2P");

    // ---- 离开后复用同一客户端：新房间仍能同步成员、准备和猜拳 ----
    await Promise.all([hostClient.leave(), guest.leave(), spectator.leave()]);
    await hostClient.createRoom({ nickname: "复用主机", visibility: "private" });
    const reusedCode = hostClient.code;
    await guest.joinRoom({ code: reusedCode, nickname: "复用客人" });
    await waitFor("reused host sees guest", () => (
      hostClient.snapshot?.players?.length === 2 ? true : null
    ));
    await Promise.all([hostClient.setReady(true), guest.setReady(true)]);
    await waitFor("reused room ready", () => (
      hostClient.snapshot?.players?.every((player) => player.ready) ? true : null
    ));
    await hostClient.startMatch();
    await waitFor("reused room rps", () => (hostClient.status === "rps" ? true : null), 10_000);
    await Promise.all([hostClient.submitRps("rock"), guest.submitRps("scissors")]);
    await waitFor("reused room playing", () => (hostClient.status === "playing" ? true : null), 10_000);
    assert.equal(hostClient.state.blackId, hostClient.myId);
    console.log("[10] reused clients synchronized join, ready, and RPS state");

    console.log("Gomoku net integration passed: full room flow + P2P + reuse-after-leave regression");
    process.exitCode = 0;
  } finally {
    // 先让所有客户端离开，停止轮询/信令，再关服务
    for (const client of [hostClient, guest, spectator, fallbackHostClient, fallbackGuestClient]) {
      try {
        await client.leave();
      } catch {
        // 忽略
      }
    }
    await stopServer();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
