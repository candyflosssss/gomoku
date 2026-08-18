// 五子棋独立房间服务（自研，不依赖任何门户站点）
//
// 职责：房间管理、公开房列表、密码校验、剪刀石头布判定、
//       WebRTC 信令中继（长轮询）、观战棋盘同步、服务端权威回退落子。
//
// 设计要点：
//   - 对局状态以「服务器权威」为最终真相；P2P 直连时由房主本地权威执行落子，
//     并在每次落子后把最新状态推送到服务器（/sync），观战者与服务端回退据此收敛。
//   - 剪刀石头布由服务器判定，防止「后手看先手出拳再应对」的作弊。
//   - 房间码为 6 位大写字符；公开房间可被公开列表浏览，密码以 SHA-256 哈希存储。
//
// 环境变量：GOMOKU_HOST（默认 127.0.0.1）、GOMOKU_PORT（默认 8798）、
//           GOMOKU_ALLOWED_ORIGIN（跨域白名单，逗号分隔）。

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { authenticateLogtoRequest, logtoAuthConfig } from "./logto-auth.mjs";

const HOST = process.env.GOMOKU_HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.GOMOKU_PORT || "8798", 10) || 8798;
const ALLOWED_ORIGINS = new Set(
  String(process.env.GOMOKU_ALLOWED_ORIGIN || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);
const API_PREFIX = "/api/gomoku";

const BOARD_SIZE = 15;
const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;
const PLAYER_CAPACITY = 2;
const SPECTATOR_CAPACITY = 20;
const COUNTDOWN_MS = 2_000;
const SIGNAL_TTL_MS = 30_000;
const SIGNAL_POLL_MS = 24_000;
const MAX_SIGNAL_QUEUE = 128;
const MAX_BODY_BYTES = 65_536;
const LOBBY_IDLE_MS = 20 * 60_000;
const PLAYING_IDLE_MS = 2 * 60 * 60_000;
const EMPTY_ROOM_MS = 60_000;
const MAX_PUBLIC_LIST = 30;
const VIEW_RATE_LIMIT = Number.parseInt(process.env.GOMOKU_VIEW_RATE_LIMIT || "120", 10) || 120;

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 6;
const NICKNAME_MAX = 16;
const PASSWORD_MAX = 32;

const RPS_CHOICES = Object.freeze({ rock: "rock", paper: "paper", scissors: "scissors" });
const RPS_BEATS = Object.freeze({ rock: "scissors", scissors: "paper", paper: "rock" });

const rooms = new Map();
const rateBuckets = new Map();

function clientKey(req, identity = null) {
  if (identity?.sub) return `account:${identity.sub}`;
  return String(req.socket.remoteAddress || "unknown");
}

function enforceRate(key, limit, windowMs, label) {
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { at: now, count: 0 };
  if (now - bucket.at >= windowMs) {
    bucket.at = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (bucket.count > limit) {
    const error = new HttpError(429, "RATE_LIMITED", `${label}操作过于频繁，请稍后再试`);
    error.retryAfter = Math.ceil((bucket.at + windowMs - now) / 1000);
    throw error;
  }
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function send(res, status, payload, req) {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.has(origin) || ALLOWED_ORIGINS.has("*"))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Gomoku-Id-Token");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (status === 204) {
    res.writeHead(204);
    res.end();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectBody(new HttpError(413, "BODY_TOO_LARGE", "请求内容过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) {
        resolveBody({});
        return;
      }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolveBody(value && typeof value === "object" ? value : {});
      } catch {
        rejectBody(new HttpError(400, "BAD_JSON", "请求体不是有效的 JSON"));
      }
    });
    req.on("error", rejectBody);
  });
}

function cleanNickname(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, NICKNAME_MAX);
}

function cleanPassword(value) {
  const password = String(value || "");
  if (!password) return "";
  return password.slice(0, PASSWORD_MAX);
}

function hashPassword(password) {
  return createHash("sha256").update(`gomoku-room:${password}`).digest("hex");
}

function roomCode() {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    let code = "";
    for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
      code += ROOM_CODE_ALPHABET[randomBytes(1)[0] % ROOM_CODE_ALPHABET.length];
    }
    if (!rooms.has(code)) return code;
  }
  throw new HttpError(503, "ROOM_EXHAUSTED", "暂时无法生成房间码，请重试");
}

function createPlayer(nickname, isHost = false, subject = null) {
  return {
    id: randomUUID(),
    token: randomBytes(24).toString("base64url"),
    nickname: cleanNickname(nickname),
    subject,
    isHost,
    ready: false,
    joinedAt: Date.now()
  };
}

function createSpectator(nickname, subject = null) {
  return {
    id: randomUUID(),
    token: randomBytes(24).toString("base64url"),
    nickname: cleanNickname(nickname),
    subject,
    joinedAt: Date.now()
  };
}

function freshMatchState(now) {
  return {
    kind: "gomoku",
    size: BOARD_SIZE,
    board: Array(CELL_COUNT).fill(0),
    blackId: null,
    whiteId: null,
    turnId: null,
    rps: {},
    rpsChosen: [],
    rpsResult: null,
    winnerId: null,
    winnerMark: null,
    winLine: [],
    draw: false,
    reason: null,
    forfeitPlayerId: null,
    moveCount: 0,
    version: 0,
    updatedAt: now
  };
}

function createRoom(body, req, identity) {
  enforceRate(`${clientKey(req, identity)}:create`, 5, 60_000, "建房");
  if (rooms.size >= 400) {
    throw new HttpError(503, "ROOM_LIMIT_REACHED", "当前房间较多，请稍后再试");
  }
  const nickname = cleanNickname(identity?.nickname || body.nickname);
  if (!nickname) throw new HttpError(400, "NICKNAME_REQUIRED", "请输入昵称");
  const visibility = body.visibility === "public" ? "public" : "private";
  const password = cleanPassword(body.password);
  const host = createPlayer(nickname, true, identity?.sub || null);
  const code = roomCode();
  const room = {
    code,
    visibility,
    passwordHash: password ? hashPassword(password) : "",
    hostId: host.id,
    status: "lobby",
    revision: 0,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    roundNumber: 0,
    countdownUntil: 0,
    rematch: {},
    players: new Map([[host.id, host]]),
    spectators: new Map(),
    signals: [],
    state: null
  };
  rooms.set(code, room);
  bump(room);
  return { room: publicRoom(room), playerId: host.id, token: host.token };
}

function getRoom(code) {
  const room = rooms.get(String(code || "").toUpperCase());
  if (!room) throw new HttpError(404, "ROOM_NOT_FOUND", "房间不存在或已经过期");
  return room;
}

function authenticate(room, body, identity) {
  const playerId = String(body.playerId || "");
  const token = String(body.token || "");
  const player = room.players.get(playerId) || room.spectators.get(playerId);
  if (!player || player.token !== token) {
    throw new HttpError(401, "AUTH_FAILED", "房间凭据无效，请重新加入");
  }
  if (identity && player.subject !== identity.sub) {
    throw new HttpError(401, "ACCOUNT_MISMATCH", "该房间凭据不属于当前登录账号");
  }
  return player;
}

function ensureAccountNotInRoom(room, identity) {
  if (!identity) return;
  const alreadyJoined = [...room.players.values(), ...room.spectators.values()]
    .some((member) => member.subject === identity.sub);
  if (alreadyJoined) throw new HttpError(409, "ACCOUNT_ALREADY_JOINED", "当前账号已经加入该房间");
}

function bump(room) {
  room.revision += 1;
  room.lastActivity = Date.now();
}

function refreshStatus(room) {
  const now = Date.now();
  if (room.status === "countdown" && now >= room.countdownUntil) {
    room.status = "rps";
    bump(room);
  }
  if (room.status === "rps" && room.state) {
    const players = [...room.players.values()];
    if (players.length === PLAYER_CAPACITY) {
      const chosen = players.filter((player) => room.state.rps[player.id]);
      if (chosen.length === PLAYER_CAPACITY) {
        resolveRps(room, players);
      }
    }
  }
}

function resolveRps(room, players) {
  const [first, second] = players;
  const firstChoice = room.state.rps[first.id];
  const secondChoice = room.state.rps[second.id];
  const state = room.state;
  if (RPS_BEATS[firstChoice] === secondChoice) {
    state.blackId = first.id;
    state.whiteId = second.id;
  } else if (RPS_BEATS[secondChoice] === firstChoice) {
    state.blackId = second.id;
    state.whiteId = first.id;
  } else {
    // 平局：清空双方出拳，重新来一轮
    state.rps = {};
    state.rpsChosen = [];
    state.version += 1;
    state.updatedAt = Date.now();
    bump(room);
    return;
  }
  state.turnId = state.blackId;
  state.rpsResult = {
    choices: { [first.id]: firstChoice, [second.id]: secondChoice },
    winnerId: state.blackId
  };
  state.rpsChosen = [first.id, second.id];
  state.version += 1;
  state.updatedAt = Date.now();
  room.status = "playing";
  bump(room);
}

const DIRECTIONS = [[0, 1], [1, 0], [1, 1], [1, -1]];

function winAt(board, index) {
  const size = BOARD_SIZE;
  const mark = board[index];
  if (!mark) return null;
  const row = Math.floor(index / size);
  const column = index % size;
  for (const [dr, dc] of DIRECTIONS) {
    const line = [index];
    for (let step = 1; step < 5; step += 1) {
      const nr = row - dr * step;
      const nc = column - dc * step;
      if (nr < 0 || nr >= size || nc < 0 || nc >= size) break;
      const at = nr * size + nc;
      if (board[at] !== mark) break;
      line.unshift(at);
    }
    for (let step = 1; step < 5; step += 1) {
      const nr = row + dr * step;
      const nc = column + dc * step;
      if (nr < 0 || nr >= size || nc < 0 || nc >= size) break;
      const at = nr * size + nc;
      if (board[at] !== mark) break;
      line.push(at);
    }
    if (line.length >= 5) return line;
  }
  return null;
}

function applyServerMove(room, player, body) {
  const state = room.state;
  if (!state || room.status !== "playing") {
    throw new HttpError(409, "MATCH_NOT_ACTIVE", "当前没有进行中的对局");
  }
  if (state.winnerId) throw new HttpError(409, "MATCH_FINISHED", "本局已经结束");
  if (state.turnId !== player.id) {
    throw new HttpError(409, "NOT_YOUR_TURN", "还没轮到你落子");
  }
  const index = body.index;
  if (!Number.isInteger(index) || index < 0 || index >= CELL_COUNT) {
    throw new HttpError(400, "INVALID_CELL", "请选择有效的棋盘位置");
  }
  if (state.board[index] !== 0) {
    throw new HttpError(409, "CELL_OCCUPIED", "这个位置已经有棋子了");
  }
  if (body.version !== undefined && body.version !== state.version) {
    throw new HttpError(409, "STATE_VERSION_MISMATCH", "棋盘已经更新，请刷新后重试");
  }
  const mark = player.id === state.blackId ? 1 : 2;
  state.board[index] = mark;
  state.moveCount += 1;
  state.version += 1;
  state.updatedAt = Date.now();
  const line = winAt(state.board, index);
  if (line) {
    state.winnerId = player.id;
    state.winnerMark = mark;
    state.winLine = line;
    state.reason = "five";
    room.status = "finished";
  } else if (state.moveCount === CELL_COUNT) {
    state.draw = true;
    state.reason = "board-full";
    room.status = "finished";
  } else {
    state.turnId = player.id === state.blackId ? state.whiteId : state.blackId;
  }
  bump(room);
}

function acceptHostSync(room, player, incoming) {
  if (!room.state) throw new HttpError(409, "MATCH_NOT_ACTIVE", "对局尚未开始");
  if (player.id !== room.hostId) {
    throw new HttpError(403, "HOST_ONLY", "只有房主可以同步棋盘状态");
  }
  if (incoming && incoming.kind !== "gomoku") {
    throw new HttpError(400, "INVALID_STATE", "状态类型无效");
  }
  const state = room.state;
  if (!Number.isInteger(incoming.version) || incoming.version < state.version) {
    throw new HttpError(409, "STATE_VERSION_MISMATCH", "服务器已有更新的棋盘状态");
  }
  if (
    !Array.isArray(incoming.board)
    || incoming.board.length !== CELL_COUNT
    || incoming.board.some((value) => ![0, 1, 2].includes(value))
  ) {
    throw new HttpError(400, "INVALID_STATE", "棋盘状态无效");
  }
  const blackIsPlayer = Boolean(incoming.blackId) && room.players.has(incoming.blackId);
  const whiteIsPlayer = Boolean(incoming.whiteId) && room.players.has(incoming.whiteId);
  if (!blackIsPlayer || !whiteIsPlayer || incoming.blackId === incoming.whiteId) {
    throw new HttpError(400, "INVALID_STATE", "黑白玩家标识无效");
  }
  if (incoming.turnId && ![incoming.blackId, incoming.whiteId].includes(incoming.turnId)) {
    throw new HttpError(400, "INVALID_STATE", "行动玩家标识无效");
  }
  const placed = incoming.board.reduce((sum, value) => sum + (value !== 0 ? 1 : 0), 0);
  if (incoming.moveCount !== placed) {
    throw new HttpError(400, "INVALID_STATE", "落子数量与棋盘不一致");
  }
  if (
    incoming.version === state.version
    && JSON.stringify(incoming.board) !== JSON.stringify(state.board)
  ) {
    throw new HttpError(409, "STATE_VERSION_CONFLICT", "同一版本的棋盘内容不一致");
  }
  const next = freshMatchState(Date.now());
  Object.assign(next, {
    board: incoming.board,
    blackId: incoming.blackId,
    whiteId: incoming.whiteId,
    turnId: incoming.turnId,
    winnerId: incoming.winnerId || null,
    winnerMark: incoming.winnerMark || null,
    winLine: Array.isArray(incoming.winLine) ? incoming.winLine : [],
    draw: Boolean(incoming.draw),
    reason: incoming.reason || null,
    moveCount: incoming.moveCount,
    version: incoming.version,
    updatedAt: Date.now()
  });
  if (next.winnerId) {
    room.status = "finished";
    if (!next.winLine.length) {
      const lastMarked = next.board.lastIndexOf(next.winnerMark);
      if (lastMarked >= 0) next.winLine = winAt(next.board, lastMarked) || [];
    }
  } else {
    room.status = "playing";
  }
  room.state = next;
  bump(room);
}

function playerPublic(player) {
  return { id: player.id, nickname: player.nickname, isHost: player.isHost, ready: player.ready };
}

function spectatorPublic(spectator) {
  return { id: spectator.id, nickname: spectator.nickname };
}

function statePublic(room, viewer) {
  const state = room.state;
  if (!state) return null;
  const isPlayer = room.players.has(viewer?.id);
  const publicState = {
    kind: state.kind,
    size: state.size,
    board: state.board,
    blackId: state.blackId,
    whiteId: state.whiteId,
    turnId: state.turnId,
    winnerId: state.winnerId,
    winnerMark: state.winnerMark,
    winLine: state.winLine,
    draw: state.draw,
    reason: state.reason,
    moveCount: state.moveCount,
    version: state.version,
    updatedAt: state.updatedAt,
    rpsChosen: state.rpsChosen,
    rpsResult: state.rpsResult,
    rpsMine: isPlayer ? Boolean(state.rps[viewer.id]) : false
  };
  return publicState;
}

function publicRoom(room) {
  return {
    code: room.code,
    visibility: room.visibility,
    hasPassword: Boolean(room.passwordHash),
    status: room.status,
    hostId: room.hostId,
    players: [...room.players.values()].map(playerPublic),
    spectators: [...room.spectators.values()].map(spectatorPublic),
    state: statePublic(room),
    revision: room.revision,
    roundNumber: room.roundNumber,
    countdownUntil: room.countdownUntil,
    createdAt: room.createdAt,
    lastActivity: room.lastActivity
  };
}

function publicListEntry(room) {
  return {
    code: room.code,
    hostNickname: room.players.get(room.hostId)?.nickname || "",
    playerCount: room.players.size,
    capacity: PLAYER_CAPACITY,
    spectatorCount: room.spectators.size,
    hasPassword: Boolean(room.passwordHash),
    status: room.status,
    createdAt: room.createdAt
  };
}

function listPublicRooms(req, identity) {
  enforceRate(`${clientKey(req, identity)}:list`, 60, 60_000, "刷新房间列表");
  const now = Date.now();
  const entries = [...rooms.values()]
    .filter((room) => room.visibility === "public" && room.players.size > 0)
    .sort((left, right) => right.lastActivity - left.lastActivity)
    .slice(0, MAX_PUBLIC_LIST)
    .map(publicListEntry);
  return { rooms: entries, now };
}

function forfeitRoom(room, loserId) {
  const state = room.state;
  const other = [...room.players.values()].find((player) => player.id !== loserId);
  if (state && !state.winnerId && room.status !== "finished" && other) {
    state.winnerId = other.id;
    state.winnerMark = other.id === state.blackId ? 1 : 2;
    state.winLine = [];
    state.reason = "forfeit";
    state.forfeitPlayerId = loserId;
    state.version += 1;
    state.updatedAt = Date.now();
    room.status = "finished";
    bump(room);
  }
}

function leaveRoom(room, player) {
  room.players.delete(player.id);
  room.spectators.delete(player.id);
  room.rematch = {};
  const state = room.state;
  if (room.status === "playing" && state && !state.winnerId) {
    forfeitRoom(room, player.id);
  }
  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }
  if (player.id === room.hostId) {
    room.hostId = [...room.players.values()][0].id;
    room.players.get(room.hostId).isHost = true;
  }
  bump(room);
}

function requestRematch(room, player) {
  if (room.status !== "finished") {
    throw new HttpError(409, "MATCH_ACTIVE", "对局还没有结束");
  }
  room.rematch[player.id] = true;
  const players = [...room.players.values()];
  const allReady = players.every((item) => room.rematch[item.id]);
  if (allReady) {
    room.roundNumber += 1;
    room.state = freshMatchState(Date.now());
    room.status = "countdown";
    room.countdownUntil = Date.now() + COUNTDOWN_MS;
    room.rematch = {};
    for (const item of players) item.ready = false;
    bump(room);
  } else {
    bump(room);
  }
}

function sweepRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const occupied = room.players.size + room.spectators.size > 0;
    if (!occupied) {
      if (now - room.lastActivity > EMPTY_ROOM_MS) rooms.delete(code);
      continue;
    }
    const limit = room.status === "playing" || room.status === "countdown"
      ? PLAYING_IDLE_MS
      : LOBBY_IDLE_MS;
    if (now - room.lastActivity > limit) rooms.delete(code);
  }
}

function registerSignal(room, from, body) {
  const targetPlayerId = String(body.targetPlayerId || "");
  const target = room.players.get(targetPlayerId) || room.spectators.get(targetPlayerId);
  if (!target || targetPlayerId === from.id) {
    throw new HttpError(400, "INVALID_SIGNAL_TARGET", "请选择有效的信令接收方");
  }
  const serialized = JSON.stringify(body.signal);
  if (serialized.length > 16_384) {
    throw new HttpError(413, "SIGNAL_TOO_LARGE", "P2P 信令内容过大");
  }
  const now = Date.now();
  room.signals = (room.signals || []).filter((item) => now - item.createdAt < SIGNAL_TTL_MS);
  room.signals.push({
    id: randomUUID(),
    fromPlayerId: from.id,
    targetPlayerId,
    signal: body.signal,
    createdAt: now
  });
  if (room.signals.length > MAX_SIGNAL_QUEUE) {
    room.signals.splice(0, room.signals.length - MAX_SIGNAL_QUEUE);
  }
  bump(room);
  return { signals: [] };
}

async function pollSignals(room, player, body) {
  if (body.signal !== undefined) return registerSignal(room, player, body);
  const deadline = Date.now() + SIGNAL_POLL_MS;
  while (Date.now() < deadline) {
    const now = Date.now();
    room.signals = (room.signals || []).filter((item) => now - item.createdAt < SIGNAL_TTL_MS);
    const index = room.signals.findIndex((item) => item.targetPlayerId === player.id);
    if (index >= 0) {
      const delivered = room.signals.splice(index, 1);
      return { signals: delivered.map((item) => ({
        fromPlayerId: item.fromPlayerId,
        signal: item.signal
      })) };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 120));
  }
  return { signals: [] };
}

async function route(req, res) {
  if (req.method === "OPTIONS") {
    send(res, 204, {}, req);
    return;
  }
  const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (url.pathname === `${API_PREFIX}/health` && req.method === "GET") {
    send(res, 200, { ok: true, service: "gomoku-rooms", now: Date.now() }, req);
    return;
  }

  let identity = null;
  try {
    identity = await authenticateLogtoRequest(req);
  } catch {
    throw new HttpError(401, "LOGIN_REQUIRED", "请先登录后再使用联机对战");
  }

  if (url.pathname === `${API_PREFIX}/rooms` && req.method === "POST") {
    const body = await readBody(req);
    const created = createRoom(body, req, identity);
    send(res, 201, created, req);
    return;
  }

  if (url.pathname === `${API_PREFIX}/rooms/public` && req.method === "GET") {
    send(res, 200, listPublicRooms(req, identity), req);
    return;
  }

  const match = url.pathname.match(
    new RegExp(`^${API_PREFIX}/rooms/([A-Z0-9]{6})(?:/([a-z]+))?$`, "i")
  );
  if (!match) throw new HttpError(404, "NOT_FOUND", "接口不存在");
  const room = getRoom(match[1]);
  const action = (match[2] || "").toLowerCase();
  refreshStatus(room);

  if (!action && req.method === "GET") {
    enforceRate(`${clientKey(req, identity)}:view`, VIEW_RATE_LIMIT, 60_000, "查看房间");
    send(res, 200, { room: publicRoom(room) }, req);
    return;
  }
  if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED", "请求方式不支持");

  const body = await readBody(req);

  if (action === "join") {
    enforceRate(`${clientKey(req, identity)}:join`, 30, 60_000, "加入房间");
    const asSpectator = Boolean(body.asSpectator);
    ensureAccountNotInRoom(room, identity);
    if (room.passwordHash && hashPassword(cleanPassword(body.password)) !== room.passwordHash) {
      throw new HttpError(403, "WRONG_PASSWORD", "房间密码不正确");
    }
    if (asSpectator) {
      if (room.spectators.size >= SPECTATOR_CAPACITY) {
        throw new HttpError(409, "ROOM_FULL", "观战位已满");
      }
      const nickname = cleanNickname(identity?.nickname || body.nickname);
      if (!nickname) throw new HttpError(400, "NICKNAME_REQUIRED", "请输入昵称");
      const spectator = createSpectator(nickname, identity?.sub || null);
      room.spectators.set(spectator.id, spectator);
      bump(room);
      send(res, 201, { room: publicRoom(room), playerId: spectator.id, token: spectator.token, role: "spectator" }, req);
      return;
    }
    if (room.status !== "lobby") {
      throw new HttpError(409, "ROOM_NOT_OPEN", "本局已经开始，无法作为玩家加入");
    }
    if (room.players.size >= PLAYER_CAPACITY) {
      throw new HttpError(409, "ROOM_FULL", "玩家位已满，可尝试观战");
    }
    const nickname = cleanNickname(identity?.nickname || body.nickname);
    if (!nickname) throw new HttpError(400, "NICKNAME_REQUIRED", "请输入昵称");
    const duplicate = [...room.players.values()].some(
      (item) => item.nickname.toLocaleLowerCase() === nickname.toLocaleLowerCase()
    );
    if (duplicate) throw new HttpError(409, "NICKNAME_TAKEN", "房间内已有同名玩家");
    const player = createPlayer(nickname, room.players.size === 0, identity?.sub || null);
    if (room.players.size === 0) room.hostId = player.id;
    room.players.set(player.id, player);
    bump(room);
    send(res, 201, { room: publicRoom(room), playerId: player.id, token: player.token, role: "player" }, req);
    return;
  }

  const player = authenticate(room, body, identity);

  if (action === "heartbeat") {
    bump(room);
    send(res, 200, { ok: true, room: publicRoom(room) }, req);
    return;
  }
  if (action === "ready") {
    if (room.status !== "lobby") {
      throw new HttpError(409, "MATCH_STARTED", "对局已经开始");
    }
    player.ready = Boolean(body.ready);
    bump(room);
    send(res, 200, { room: publicRoom(room) }, req);
    return;
  }
  if (action === "start") {
    if (player.id !== room.hostId) {
      throw new HttpError(403, "HOST_ONLY", "只有房主可以开始对局");
    }
    if (room.status !== "lobby") {
      throw new HttpError(409, "MATCH_STARTED", "对局已经开始");
    }
    const players = [...room.players.values()];
    if (players.length < PLAYER_CAPACITY) {
      throw new HttpError(409, "NOT_ENOUGH_PLAYERS", `至少需要 ${PLAYER_CAPACITY} 位玩家`);
    }
    if (players.some((item) => !item.ready)) {
      throw new HttpError(409, "NOT_READY", "还有玩家没有准备");
    }
    room.roundNumber += 1;
    room.state = freshMatchState(Date.now());
    room.status = "countdown";
    room.countdownUntil = Date.now() + COUNTDOWN_MS;
    room.rematch = {};
    for (const item of players) item.ready = false;
    bump(room);
    send(res, 200, { room: publicRoom(room) }, req);
    return;
  }
  if (action === "rps") {
    if (!room.state || room.status !== "rps") {
      throw new HttpError(409, "RPS_CLOSED", "现在不是出拳阶段");
    }
    if (room.players.get(player.id) !== player || room.spectators.has(player.id)) {
      throw new HttpError(403, "PLAYER_ONLY", "只有玩家可以出拳");
    }
    const choice = RPS_CHOICES[String(body.choice || "")];
    if (!choice) throw new HttpError(400, "INVALID_CHOICE", "请选择石头、剪刀或布");
    if (!room.state.rps[player.id]) {
      room.state.rps[player.id] = choice;
      room.state.rpsChosen = [...room.state.rpsChosen, player.id];
      bump(room);
    }
    refreshStatus(room);
    send(res, 200, { room: publicRoom(room) }, req);
    return;
  }
  if (action === "move") {
    applyServerMove(room, player, body);
    send(res, 200, { room: publicRoom(room) }, req);
    return;
  }
  if (action === "resign") {
    if (!room.state || room.status !== "playing") {
      throw new HttpError(409, "MATCH_NOT_ACTIVE", "当前没有进行中的对局");
    }
    if (!room.state.winnerId) forfeitRoom(room, player.id);
    send(res, 200, { room: publicRoom(room) }, req);
    return;
  }
  if (action === "sync") {
    acceptHostSync(room, player, body.state);
    send(res, 200, { room: publicRoom(room) }, req);
    return;
  }
  if (action === "signal") {
    const result = await pollSignals(room, player, body);
    send(res, 200, result, req);
    return;
  }
  if (action === "rematch") {
    requestRematch(room, player);
    send(res, 200, { room: publicRoom(room) }, req);
    return;
  }
  if (action === "leave") {
    leaveRoom(room, player);
    send(res, 200, { ok: true, room: publicRoom(room) }, req);
    return;
  }
  throw new HttpError(404, "NOT_FOUND", "接口不存在");
}

const server = createServer((req, res) => {
  route(req, res).catch((error) => {
    const status = error instanceof HttpError ? error.status : 500;
    const code = error instanceof HttpError ? error.code : "INTERNAL_ERROR";
    const message = error instanceof HttpError ? error.message : "服务器内部错误";
    if (!(error instanceof HttpError)) console.error("Gomoku room server error", error);
    send(res, status, { error: { code, message } }, req);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Gomoku room server listening on http://${HOST}:${PORT}${API_PREFIX}`);
  console.log(`Gomoku Logto authentication ${logtoAuthConfig.required ? "required" : "disabled"}`);
});

setInterval(sweepRooms, 60_000).unref();
