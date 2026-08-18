import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";

const repository = new URL("..", import.meta.url).pathname;
const host = "127.0.0.1";
const audience = "https://gomoku.test/api";
const clientId = "gomoku-test-spa";
const keyId = "gomoku-test-key";
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
const publicJwk = publicKey.export({ format: "jwk" });

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, host, resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function jwt(payload, signingKey = privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: "ES384", typ: "JWT", kid: keyId })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign("sha384", Buffer.from(`${header}.${body}`), {
    key: signingKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${body}.${signature}`;
}

function tokenPair(issuer, sub, name = "测试玩家", overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const common = { iss: issuer, sub, iat: now, exp: now + 300 };
  return {
    accessToken: jwt({ ...common, aud: audience, client_id: clientId, ...overrides.access }),
    idToken: jwt({ ...common, aud: clientId, name, ...overrides.id }),
  };
}

function authHeaders(pair) {
  return {
    Authorization: `Bearer ${pair.accessToken}`,
    "X-Gomoku-Id-Token": pair.idToken,
    "Content-Type": "application/json",
  };
}

async function waitForHealth(url, child) {
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(300) });
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    if (child.exitCode !== null) throw new Error(`Room server exited: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Room server did not start: ${output}`);
}

const jwksPort = await freePort();
const roomPort = await freePort();
const issuer = `http://${host}:${jwksPort}/oidc`;
const jwksServer = createHttpServer((req, res) => {
  if (req.url !== "/oidc/jwks") return res.writeHead(404).end();
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ keys: [{ ...publicJwk, kid: keyId, alg: "ES384", use: "sig" }] }));
});
await new Promise((resolve) => jwksServer.listen(jwksPort, host, resolve));

const roomServer = spawn(process.execPath, ["server/room-server.mjs"], {
  cwd: repository,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    GOMOKU_HOST: host,
    GOMOKU_PORT: String(roomPort),
    GOMOKU_ALLOWED_ORIGIN: "*",
    GOMOKU_AUTH_REQUIRED: "true",
    GOMOKU_LOGTO_ISSUER: issuer,
    GOMOKU_LOGTO_AUDIENCE: audience,
    GOMOKU_LOGTO_CLIENT_ID: clientId,
    GOMOKU_LOGTO_JWKS_URI: `${issuer}/jwks`,
  },
});
const api = `http://${host}:${roomPort}/api/gomoku`;

try {
  await waitForHealth(api, roomServer);

  const preflight = await fetch(`${api}/rooms/public`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://gomoku.test",
      "Access-Control-Request-Headers": "authorization,x-gomoku-id-token",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(await preflight.text(), "", "CORS preflight has no HTTP/2-invalid body");

  const missing = await fetch(`${api}/rooms/public`);
  assert.equal(missing.status, 401, "room list requires login");

  const wrongAudience = tokenPair(issuer, "account-a", "甲", { access: { aud: "wrong" } });
  const rejectedAudience = await fetch(`${api}/rooms/public`, { headers: authHeaders(wrongAudience) });
  assert.equal(rejectedAudience.status, 401, "wrong access-token audience is rejected");

  const { privateKey: otherPrivateKey } = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
  const badSignature = tokenPair(issuer, "account-a");
  badSignature.accessToken = jwt({
    iss: issuer,
    sub: "account-a",
    aud: audience,
    client_id: clientId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
  }, otherPrivateKey);
  const rejectedSignature = await fetch(`${api}/rooms/public`, { headers: authHeaders(badSignature) });
  assert.equal(rejectedSignature.status, 401, "invalid signature is rejected");

  const accountA = tokenPair(issuer, "account-a", "账号甲");
  const createdResponse = await fetch(`${api}/rooms`, {
    method: "POST",
    headers: authHeaders(accountA),
    body: JSON.stringify({ nickname: "伪造昵称", visibility: "private", password: "secret" }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.room.players[0].nickname, "账号甲", "nickname comes from verified ID token");

  const accountB = tokenPair(issuer, "account-b", "账号乙");
  const saturatedResponses = [];
  for (let requestIndex = 0; requestIndex < 121; requestIndex += 1) {
    saturatedResponses.push(await fetch(`${api}/rooms/${created.room.code}`, {
      headers: authHeaders(accountA),
    }));
  }
  assert.ok(saturatedResponses.some((response) => response.status === 429), "account A reaches its own view limit");
  const independentAccount = await fetch(`${api}/rooms/${created.room.code}`, {
    headers: authHeaders(accountB),
  });
  assert.equal(independentAccount.status, 200, "account B is not rate-limited by account A behind the same proxy");

  const mismatchedCredential = await fetch(`${api}/rooms/${created.room.code}/ready`, {
    method: "POST",
    headers: authHeaders(accountB),
    body: JSON.stringify({ playerId: created.playerId, token: created.token, ready: true }),
  });
  assert.equal(mismatchedCredential.status, 401, "room credentials are bound to Logto subject");

  const spectatorWithoutPassword = await fetch(`${api}/rooms/${created.room.code}/join`, {
    method: "POST",
    headers: authHeaders(accountB),
    body: JSON.stringify({ asSpectator: true }),
  });
  assert.equal(spectatorWithoutPassword.status, 403, "spectators cannot bypass room password");

  const spectatorWithPassword = await fetch(`${api}/rooms/${created.room.code}/join`, {
    method: "POST",
    headers: authHeaders(accountB),
    body: JSON.stringify({ asSpectator: true, password: "secret" }),
  });
  assert.equal(spectatorWithPassword.status, 201);
  const spectator = await spectatorWithPassword.json();
  assert.equal(spectator.room.spectators[0].nickname, "账号乙");

  console.log("Gomoku Logto authentication passed: JWT validation, account binding, and spectator password checks");
} finally {
  roomServer.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => roomServer.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
  await new Promise((resolve) => jwksServer.close(resolve));
}
