(() => {
  "use strict";

  const config = window.GOMOK_CONFIG?.logto || {};
  const localTestBypass = ["localhost", "127.0.0.1", "::1"].includes(location.hostname)
    && new URLSearchParams(location.search).get("testAuth") === "disabled";
  if (localTestBypass) {
    const testProfile = { sub: "local-browser-test", nickname: "本地测试玩家", email: "" };
    window.GomokuAuth = Object.freeze({
      ready: Promise.resolve(),
      isAuthenticated: true,
      profile: testProfile,
      login: async () => {},
      register: async () => {},
      logout: () => {},
      subscribe(listener) {
        queueMicrotask(() => listener(testProfile));
        return () => {};
      },
      getAuthHeaders: async () => ({}),
    });
    return;
  }
  const endpoint = String(config.endpoint || "").replace(/\/+$/, "");
  const clientId = String(config.clientId || "");
  const resource = String(config.resource || "");
  const redirectUri = String(config.redirectUri || `${location.origin}/`);
  const tokenKey = "gomoku_logto_tokens";
  const flowKey = "gomoku_logto_flow";
  const listeners = new Set();
  let tokens = readJson(sessionStorage.getItem(tokenKey));
  let profile = profileFrom(tokens?.id_token);

  function readJson(value) {
    try {
      return JSON.parse(value || "null");
    } catch {
      return null;
    }
  }

  function jwtPayload(token) {
    try {
      const part = String(token || "").split(".")[1];
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(
        atob(part.replaceAll("-", "+").replaceAll("_", "/")),
        (char) => char.charCodeAt(0)
      )));
    } catch {
      return null;
    }
  }

  function profileFrom(idToken) {
    const claims = jwtPayload(idToken);
    if (!claims?.sub) return null;
    const nickname = claims.name || claims.username || claims.preferred_username
      || (typeof claims.email === "string" ? claims.email.split("@")[0] : "")
      || `玩家-${claims.sub.slice(0, 6)}`;
    return { sub: claims.sub, nickname, email: claims.email || "" };
  }

  function notify() {
    for (const listener of listeners) listener(profile);
  }

  function saveTokens(next) {
    tokens = next;
    profile = profileFrom(tokens?.id_token);
    if (tokens && profile) sessionStorage.setItem(tokenKey, JSON.stringify(tokens));
    else sessionStorage.removeItem(tokenKey);
    notify();
  }

  function randomValue(bytes = 32) {
    const data = crypto.getRandomValues(new Uint8Array(bytes));
    return btoa(String.fromCharCode(...data)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  }

  async function sha256(value) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  }

  function cleanReturnUrl() {
    const url = new URL(location.href);
    for (const key of ["code", "state", "error", "error_description"]) url.searchParams.delete(key);
    return url.href;
  }

  async function tokenRequest(parameters) {
    const response = await fetch(`${endpoint}/oidc/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, ...parameters }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error_description || "登录服务暂时不可用");
    return payload;
  }

  async function handleCallback() {
    const params = new URLSearchParams(location.search);
    if (!params.has("code") && !params.has("error")) return;
    const flow = readJson(sessionStorage.getItem(flowKey));
    sessionStorage.removeItem(flowKey);
    if (params.get("error")) throw new Error(params.get("error_description") || "登录未完成");
    if (!flow || params.get("state") !== flow.state) throw new Error("登录状态校验失败，请重试");

    const payload = await tokenRequest({
      grant_type: "authorization_code",
      code: params.get("code"),
      code_verifier: flow.verifier,
      redirect_uri: redirectUri,
    });
    const idClaims = jwtPayload(payload.id_token);
    const accessClaims = jwtPayload(payload.access_token);
    if (!idClaims?.sub || idClaims.sub !== accessClaims?.sub || idClaims.nonce !== flow.nonce) {
      throw new Error("登录令牌校验失败，请重试");
    }
    saveTokens(payload);
    location.replace(flow.returnUrl || `${location.origin}/`);
    await new Promise(() => {});
  }

  function expiresSoon(token, seconds = 60) {
    const exp = jwtPayload(token)?.exp;
    return !Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000) + seconds;
  }

  async function refreshTokens() {
    if (!tokens?.refresh_token) throw new Error("登录已过期");
    const payload = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      resource,
    });
    const next = {
      ...tokens,
      ...payload,
      refresh_token: payload.refresh_token || tokens.refresh_token,
      id_token: payload.id_token || tokens.id_token,
    };
    if (expiresSoon(next.id_token)) throw new Error("登录已过期");
    saveTokens(next);
  }

  async function login(options = {}) {
    if (!endpoint || !clientId || !resource) throw new Error("登录配置不完整");
    const verifier = randomValue(48);
    const state = randomValue();
    const nonce = randomValue();
    sessionStorage.setItem(flowKey, JSON.stringify({
      verifier,
      state,
      nonce,
      returnUrl: options.returnUrl || cleanReturnUrl(),
    }));
    const url = new URL(`${endpoint}/oidc/auth`);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid profile offline_access",
      resource,
      code_challenge: await sha256(verifier),
      code_challenge_method: "S256",
      state,
      nonce,
      ...(options.register ? { first_screen: "register" } : {}),
    });
    location.assign(url.href);
  }

  function clearRoomSessions() {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith("gomoku_session_")) localStorage.removeItem(key);
    }
  }

  function logout() {
    const idToken = tokens?.id_token || "";
    saveTokens(null);
    clearRoomSessions();
    const url = new URL(`${endpoint}/oidc/session/end`);
    url.search = new URLSearchParams({
      client_id: clientId,
      post_logout_redirect_uri: redirectUri,
      ...(idToken ? { id_token_hint: idToken } : {}),
    });
    location.assign(url.href);
  }

  const ready = handleCallback().catch((error) => {
    saveTokens(null);
    const url = new URL(location.href);
    for (const key of ["code", "state", "error", "error_description"]) url.searchParams.delete(key);
    history.replaceState(null, "", url);
    window.dispatchEvent(new CustomEvent("gomoku-auth-error", { detail: error.message }));
  });

  window.GomokuAuth = Object.freeze({
    ready,
    get isAuthenticated() { return Boolean(tokens?.access_token && tokens?.id_token && profile); },
    get profile() { return profile; },
    login,
    register: () => login({ register: true }),
    logout,
    subscribe(listener) {
      listeners.add(listener);
      queueMicrotask(() => listener(profile));
      return () => listeners.delete(listener);
    },
    async getAuthHeaders() {
      await ready;
      if (!tokens?.access_token || !tokens?.id_token || !profile) {
        const error = new Error("请先登录后再使用联机对战");
        error.code = "LOGIN_REQUIRED";
        throw error;
      }
      if (expiresSoon(tokens.access_token) || expiresSoon(tokens.id_token)) {
        try {
          await refreshTokens();
        } catch {
          saveTokens(null);
          const error = new Error("登录已过期，请重新登录");
          error.code = "LOGIN_REQUIRED";
          throw error;
        }
      }
      return {
        Authorization: `Bearer ${tokens.access_token}`,
        "X-Gomoku-Id-Token": tokens.id_token,
      };
    },
  });
})();
