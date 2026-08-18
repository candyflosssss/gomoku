// 五子棋联机层（自研）：独立房间服务客户端 + WebRTC P2P 传输 + 剪刀石头布 + 观战。
// 挂载为 window.GomokuNet。
//
// 传输模型：
//   - 服务器保存权威状态；房主在 P2P 直连时本地权威执行落子，
//     每步把最新状态推送到服务器（/sync），观战者与服务端回退据此收敛。
//   - 客户端所有界面更新统一走 onSnapshot；P2P 广播的状态会合并进快照回调。
//   - P2P 未连接或断线时自动回退到服务器 /move，双方靠轮询收敛。

(() => {
  "use strict";

  const config = window.GOMOK_CONFIG || {};
  const queryApi = new URLSearchParams(location.search).get("api");
  const queryApiUrl = queryApi ? new URL(queryApi, location.origin) : null;
  const queryApiAllowed = queryApiUrl && (
    queryApiUrl.origin === location.origin
    || ["localhost", "127.0.0.1", "::1"].includes(location.hostname)
  );
  const apiBase = String((queryApiAllowed ? queryApiUrl.href : "") || config.apiBase || "/api/gomoku")
    .replace(/\/+$/, "");
  const ICE_SERVERS = Array.isArray(config.iceServers) ? config.iceServers : [
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.l.google.com:19302" }
  ];
  const POLL_MS = 700;
  const HEARTBEAT_MS = 20_000;
  const P2P_CONNECT_TIMEOUT_MS = 10_000;
  const COMMAND_TIMEOUT_MS = 3_000;
  const SESSION_KEY_PREFIX = "gomoku_session_";

  let session = null; // { code, playerId, token, role }
  let snapshot = null; // 最新房间快照
  let disposed = false;
  let sessionEpoch = 0;
  let pollInFlight = false;

  const snapshotCallbacks = new Set();
  const statusCallbacks = new Set();

  // P2P 状态
  let peer = null;
  let channel = null;
  let peerHost = false;
  let peerStatus = "server"; // server | connecting | direct
  let connectTimer = 0;
  let signaling = false;
  let pendingCandidates = [];
  const pendingCommands = new Map();

  function sessionKey(code) {
    return `${SESSION_KEY_PREFIX}${String(code || "").toUpperCase()}`;
  }

  function persistSession() {
    try {
      localStorage.setItem(sessionKey(session.code), JSON.stringify(session));
    } catch {
      // 忽略存储失败
    }
  }

  function clearSession() {
    if (!session) return;
    try {
      localStorage.removeItem(sessionKey(session.code));
    } catch {
      // 忽略
    }
    session = null;
  }

  async function request(path, options = {}) {
    const { timeoutMs = 15_000, ...fetchOptions } = options;
    const timeoutSignal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
    const authHeaders = window.GomokuAuth
      ? await window.GomokuAuth.getAuthHeaders()
      : {};
    const response = await fetch(`${apiBase}${path}`, {
      ...fetchOptions,
      signal: fetchOptions.signal || timeoutSignal,
      headers: { "Content-Type": "application/json", ...authHeaders, ...(options.headers || {}) }
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      // 下方错误信息覆盖解析失败
    }
    if (!response.ok) {
      const error = new Error(payload?.error?.message || "联机服务暂时不可用");
      error.code = payload?.error?.code || "NETWORK_ERROR";
      throw error;
    }
    return payload;
  }

  function authBody(extra = {}) {
    return { ...extra, playerId: session.playerId, token: session.token };
  }

  function notifySnapshot() {
    for (const callback of snapshotCallbacks) {
      try {
        callback(snapshot);
      } catch (error) {
        console.error("Gomoku snapshot callback failed", error);
      }
    }
  }

  function notifyStatus() {
    for (const callback of statusCallbacks) {
      try {
        callback(peerStatus);
      } catch (error) {
        console.error("Gomoku status callback failed", error);
      }
    }
  }

  function setPeerStatus(next) {
    if (peerStatus === next) return;
    peerStatus = next;
    notifyStatus();
  }

  function applySnapshot(nextRoom) {
    if (!nextRoom) return false;
    if (snapshot?.code === nextRoom.code) {
      const currentRevision = Number.isInteger(snapshot.revision) ? snapshot.revision : -1;
      const nextRevision = Number.isInteger(nextRoom.revision) ? nextRoom.revision : -1;
      if (nextRevision < currentRevision) return false;
      const currentStateVersion = Number.isInteger(snapshot.state?.version) ? snapshot.state.version : -1;
      const nextStateVersion = Number.isInteger(nextRoom.state?.version) ? nextRoom.state.version : -1;
      if (nextRevision === currentRevision && nextStateVersion < currentStateVersion) return false;
    }
    snapshot = nextRoom;
    notifySnapshot();
    return true;
  }

  // ---- P2P ----

  function sendP2P(message) {
    if (channel?.readyState !== "open") return false;
    channel.send(JSON.stringify(message));
    return true;
  }

  async function sendSignal(signal, targetPlayerId) {
    if (!session || disposed) return;
    await request(`/rooms/${encodeURIComponent(session.code)}/signal`, {
      method: "POST",
      body: JSON.stringify(authBody({ signal, targetPlayerId }))
    });
  }

  async function addRemoteCandidate(candidate) {
    if (!peer?.remoteDescription) {
      pendingCandidates.push(candidate);
      return;
    }
    await peer.addIceCandidate(candidate);
  }

  async function flushCandidates() {
    for (const candidate of pendingCandidates.splice(0)) {
      await peer.addIceCandidate(candidate);
    }
  }

  async function handleSignal(item) {
    if (!peer || item.fromPlayerId !== remotePlayerId()) return;
    const signal = item.signal;
    if (signal?.description) {
      await peer.setRemoteDescription(signal.description);
      await flushCandidates();
      if (signal.description.type === "offer") {
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        await sendSignal({ description: peer.localDescription }, remotePlayerId());
      }
    } else if (signal?.candidate) {
      await addRemoteCandidate(signal.candidate);
    }
  }

  async function pollSignals() {
    if (signaling || disposed || !session || peerStatus === "direct") return;
    const epoch = sessionEpoch;
    signaling = true;
    while (epoch === sessionEpoch && !disposed && session && peerStatus !== "direct" && roomAlive()) {
      try {
        const payload = await request(`/rooms/${encodeURIComponent(session.code)}/signal`, {
          method: "POST",
          body: JSON.stringify(authBody({})),
          timeoutMs: 30_000
        });
        if (epoch !== sessionEpoch) break;
        for (const item of payload.signals || []) await handleSignal(item);
      } catch (error) {
        if (!disposed) console.warn("Gomoku P2P signaling retry", error);
      }
    }
    signaling = false;
  }

  function remotePlayerId() {
    const players = snapshot?.players || [];
    return players.find((player) => player.id !== session.playerId)?.id || "";
  }

  function bindChannel(nextChannel) {
    channel = nextChannel;
    channel.addEventListener("message", handleData);
    channel.addEventListener("open", () => {
      window.clearTimeout(connectTimer);
      setPeerStatus("direct");
      if (peerHost) publishState();
    });
    channel.addEventListener("close", () => enterServerFallback("P2P 连接已断开，切换服务器通道"));
    channel.addEventListener("error", () => enterServerFallback("P2P 通道异常，切换服务器通道"));
  }

  function enterServerFallback(reason) {
    if (!channel || disposed) return;
    console.warn(reason);
    rejectPending("P2P 已断开，请重试");
    window.clearTimeout(connectTimer);
    try {
      channel?.close();
    } catch {
      // 忽略
    }
    try {
      peer?.close();
    } catch {
      // 忽略
    }
    channel = null;
    peer = null;
    pendingCandidates = [];
    setPeerStatus("server");
  }

  function handleData(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "state" && !peerHost && message.state?.kind === "gomoku") {
      adoptLocalState(message.state);
      return;
    }
    if (message.type === "command" && peerHost) {
      try {
        const result = executeLocalMove(remotePlayerId(), message.index, message.version);
        sendP2P({ type: "command-result", requestId: message.requestId, state: result });
      } catch (error) {
        sendP2P({
          type: "command-error",
          requestId: message.requestId,
          error: { code: error.code || "COMMAND_FAILED", message: error.message },
          state: snapshot.state
        });
      }
      return;
    }
    if (message.type === "command-result" || message.type === "command-error") {
      const pending = pendingCommands.get(message.requestId);
      if (!pending) return;
      pendingCommands.delete(message.requestId);
      window.clearTimeout(pending.timer);
      if (message.state) adoptLocalState(message.state);
      if (message.type === "command-error") {
        pending.reject(Object.assign(new Error(message.error?.message || "落子失败"), {
          code: message.error?.code
        }));
        return;
      }
      pending.resolve();
    }
  }

  function rejectPending(message) {
    for (const pending of pendingCommands.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    pendingCommands.clear();
  }

  function adoptLocalState(state) {
    if (!state || state.kind !== "gomoku") return;
    applySnapshot({
      ...snapshot,
      state
    });
  }

  async function ensureP2P() {
    if (disposed || !session || session.role !== "player") return;
    if (!snapshot?.state || peer || channel) return;
    if (!["countdown", "rps", "playing"].includes(snapshot.status)) return;
    const remoteId = remotePlayerId();
    if (!remoteId) return;
    peerHost = snapshot.hostId === session.playerId;
    setPeerStatus("connecting");
    peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peer.addEventListener("icecandidate", (event) => {
      if (event.candidate) sendSignal({ candidate: event.candidate }, remoteId).catch(console.warn);
    });
    peer.addEventListener("connectionstatechange", () => {
      if (["failed", "disconnected", "closed"].includes(peer?.connectionState)) {
        enterServerFallback("P2P 连接中断，切换服务器通道");
      }
    });
    if (peerHost) {
      bindChannel(peer.createDataChannel("gomoku", { ordered: true }));
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await sendSignal({ description: peer.localDescription }, remoteId);
    } else {
      peer.addEventListener("datachannel", (event) => bindChannel(event.channel), { once: true });
    }
    connectTimer = window.setTimeout(
      () => enterServerFallback("P2P 连接超时，切换服务器通道"),
      P2P_CONNECT_TIMEOUT_MS
    );
    pollSignals();
  }

  // ---- 落子 ----

  function applyLocalMove(board, index, actorId) {
    const state = snapshot.state;
    if (!state || snapshot.status !== "playing") {
      throw Object.assign(new Error("当前没有进行中的对局"), { code: "MATCH_NOT_ACTIVE" });
    }
    if (state.winnerId) {
      throw Object.assign(new Error("本局已经结束"), { code: "MATCH_FINISHED" });
    }
    if (state.turnId !== actorId) {
      throw Object.assign(new Error("还没轮到你落子"), { code: "NOT_YOUR_TURN" });
    }
    if (!Number.isInteger(index) || index < 0 || index >= 225) {
      throw Object.assign(new Error("请选择有效的棋盘位置"), { code: "INVALID_CELL" });
    }
    if (board[index] !== 0) {
      throw Object.assign(new Error("这个位置已经有棋子了"), { code: "CELL_OCCUPIED" });
    }
    const mark = actorId === state.blackId ? 1 : 2;
    board[index] = mark;
    state.moveCount += 1;
    state.version += 1;
    state.updatedAt = Date.now();
    const line = window.GomokuCore.winAt(board, index);
    if (line) {
      state.winnerId = actorId;
      state.winnerMark = mark;
      state.winLine = line;
      state.reason = "five";
      snapshot.status = "finished";
    } else if (state.moveCount === 225) {
      state.draw = true;
      state.reason = "board-full";
      snapshot.status = "finished";
    } else {
      state.turnId = state.turnId === state.blackId ? state.whiteId : state.blackId;
    }
    return state;
  }

  function executeLocalMove(actorId, index, suppliedVersion) {
    if (suppliedVersion !== snapshot.state.version) {
      throw Object.assign(new Error("棋盘已经更新，请重试"), { code: "STATE_VERSION_MISMATCH" });
    }
    const state = applyLocalMove(snapshot.state.board, index, actorId);
    publishState();
    return state;
  }

  function publishState() {
    adoptLocalState(snapshot.state);
    sendP2P({ type: "state", state: snapshot.state });
    // 房主每步推送到服务器，供观战者与服务端回退收敛（失败静默重试由下一轮覆盖）。
    syncToServer().catch((error) => console.warn("Gomoku server sync failed", error));
  }

  async function syncToServer() {
    if (!session || session.role !== "player") return;
    const state = snapshot.state;
    // RPS 定先手前黑白标识为空，服务端状态与本地一致，无需（也无法）同步。
    if (!state || !state.blackId || !state.whiteId) return;
    await request(`/rooms/${encodeURIComponent(session.code)}/sync`, {
      method: "POST",
      body: JSON.stringify(authBody({ state }))
    });
  }

  function place(index) {
    if (peerStatus === "direct" && peerHost) {
      try {
        executeLocalMove(session.playerId, index, snapshot.state.version);
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (peerStatus === "direct") {
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          pendingCommands.delete(requestId);
          reject(new Error("P2P 落子确认超时，请重试"));
        }, COMMAND_TIMEOUT_MS);
        pendingCommands.set(requestId, { resolve, reject, timer });
        if (!sendP2P({ type: "command", requestId, index, version: snapshot.state.version })) {
          window.clearTimeout(timer);
          pendingCommands.delete(requestId);
          reject(new Error("P2P 连接已断开，请重试"));
        }
      });
    }
    return request(`/rooms/${encodeURIComponent(session.code)}/move`, {
      method: "POST",
      body: JSON.stringify(authBody({ index, version: snapshot.state.version }))
    }).then((payload) => {
      applySnapshot(payload.room);
    });
  }

  // ---- 房间操作 ----

  function roomAlive() {
    return Boolean(session && snapshot && !disposed);
  }

  function activateSession(nextSession, nextRoom = null) {
    sessionEpoch += 1;
    disposed = false;
    pollInFlight = false;
    session = nextSession;
    snapshot = null;
    persistSession();
    if (nextRoom) applySnapshot(nextRoom);
    startPolling();
  }

  async function createRoom({ nickname, visibility, password }) {
    const payload = await request("/rooms", {
      method: "POST",
      body: JSON.stringify({ nickname, visibility, password })
    });
    activateSession({
      code: payload.room.code,
      playerId: payload.playerId,
      token: payload.token,
      role: "player"
    }, payload.room);
    return snapshot;
  }

  async function joinRoom({ code, nickname, password, asSpectator = false }) {
    const payload = await request(`/rooms/${encodeURIComponent(code)}/join`, {
      method: "POST",
      body: JSON.stringify({ nickname, password, asSpectator })
    });
    activateSession({
      code: payload.room.code,
      playerId: payload.playerId,
      token: payload.token,
      role: payload.role || "player"
    }, payload.room);
    return snapshot;
  }

  async function listPublic() {
    const payload = await request("/rooms/public");
    return payload.rooms || [];
  }

  async function setReady(ready) {
    const payload = await request(`/rooms/${encodeURIComponent(session.code)}/ready`, {
      method: "POST",
      body: JSON.stringify(authBody({ ready: Boolean(ready) }))
    });
    applySnapshot(payload.room);
    return snapshot;
  }

  async function startMatch() {
    const payload = await request(`/rooms/${encodeURIComponent(session.code)}/start`, {
      method: "POST",
      body: JSON.stringify(authBody({}))
    });
    applySnapshot(payload.room);
    ensureP2P();
    return snapshot;
  }

  async function submitRps(choice) {
    const payload = await request(`/rooms/${encodeURIComponent(session.code)}/rps`, {
      method: "POST",
      body: JSON.stringify(authBody({ choice }))
    });
    applySnapshot(payload.room);
    return snapshot;
  }

  async function rematch() {
    const payload = await request(`/rooms/${encodeURIComponent(session.code)}/rematch`, {
      method: "POST",
      body: JSON.stringify(authBody({}))
    });
    applySnapshot(payload.room);
    ensureP2P();
    return snapshot;
  }

  async function rawRequest(action, extra = {}) {
    const payload = await request(`/rooms/${encodeURIComponent(session.code)}/${action}`, {
      method: "POST",
      body: JSON.stringify(authBody(extra))
    });
    if (payload.room) applySnapshot(payload.room);
    return payload;
  }

  async function leave() {
    if (!session) return;
    try {
      await request(`/rooms/${encodeURIComponent(session.code)}/leave`, {
        method: "POST",
        body: JSON.stringify(authBody({}))
      });
    } catch (error) {
      // 离开失败不阻塞本地清理
    }
    teardown();
    clearSession();
    snapshot = null;
    notifySnapshot();
  }

  function teardown() {
    sessionEpoch += 1;
    disposed = true;
    pollInFlight = false;
    window.clearTimeout(connectTimer);
    window.clearInterval(pollTimer);
    window.clearTimeout(heartbeatTimer);
    rejectPending("房间已离开");
    try {
      channel?.close();
    } catch {
      // 忽略
    }
    try {
      peer?.close();
    } catch {
      // 忽略
    }
    channel = null;
    peer = null;
    pendingCandidates = [];
    setPeerStatus("server");
  }

  // ---- 轮询与心跳 ----

  let pollTimer = 0;
  let heartbeatTimer = 0;

  function startPolling() {
    window.clearInterval(pollTimer);
    window.clearTimeout(heartbeatTimer);
    poll().catch(() => {});
    pollTimer = window.setInterval(poll, POLL_MS);
    heartbeatTimer = window.setTimeout(heartbeat, HEARTBEAT_MS);
  }

  async function poll() {
    if (!session || disposed || pollInFlight) return;
    const epoch = sessionEpoch;
    const code = session.code;
    pollInFlight = true;
    try {
      const payload = await request(`/rooms/${encodeURIComponent(code)}`);
      if (epoch !== sessionEpoch || code !== session?.code) return;
      applySnapshot(payload.room);
      ensureP2P().catch((error) => console.warn("Gomoku P2P setup failed", error));
    } catch (error) {
      if (epoch !== sessionEpoch) return;
      if (error.code === "ROOM_NOT_FOUND") {
        // 房间已过期：清理本地会话并通知界面
        clearSession();
        snapshot = null;
        notifySnapshot();
      } else if (["AUTH_FAILED", "ACCOUNT_MISMATCH", "LOGIN_REQUIRED"].includes(error.code)) {
        clearSession();
        snapshot = null;
        notifySnapshot();
      }
    } finally {
      if (epoch === sessionEpoch) pollInFlight = false;
    }
  }

  async function heartbeat() {
    if (!session || disposed) return;
    heartbeatTimer = window.setTimeout(heartbeat, HEARTBEAT_MS);
    try {
      await request(`/rooms/${encodeURIComponent(session.code)}/heartbeat`, {
        method: "POST",
        body: JSON.stringify(authBody({}))
      });
    } catch (error) {
      // 心跳失败由轮询兜底
    }
  }

  function resume(code) {
    if (!code) return false;
    try {
      const stored = JSON.parse(localStorage.getItem(sessionKey(code)) || "null");
      if (!stored?.playerId || !stored?.token || !stored?.code) return false;
      activateSession({
        code: stored.code,
        playerId: stored.playerId,
        token: stored.token,
        role: stored.role || "player"
      });
      return true;
    } catch {
      return false;
    }
  }

  function onSnapshot(callback) {
    if (typeof callback !== "function") return () => {};
    snapshotCallbacks.add(callback);
    if (snapshot) queueMicrotask(() => callback(snapshot));
    return () => snapshotCallbacks.delete(callback);
  }

  function onPeerStatus(callback) {
    if (typeof callback !== "function") return () => {};
    statusCallbacks.add(callback);
    queueMicrotask(() => callback(peerStatus));
    return () => statusCallbacks.delete(callback);
  }

  window.GomokuNet = Object.freeze({
    apiBase,
    get session() {
      return session;
    },
    get snapshot() {
      return snapshot;
    },
    get state() {
      return snapshot?.state || null;
    },
    get status() {
      return snapshot?.status || "idle";
    },
    get role() {
      return session?.role || "";
    },
    get code() {
      return session?.code || "";
    },
    get myId() {
      return session?.playerId || "";
    },
    get peerStatus() {
      return peerStatus;
    },
    createRoom,
    joinRoom,
    listPublic,
    setReady,
    startMatch,
    submitRps,
    rematch,
    rawRequest,
    leave,
    place,
    resume,
    onSnapshot,
    onPeerStatus
  });
})();
