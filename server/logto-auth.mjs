import { createPublicKey, verify } from "node:crypto";

const AUTH_REQUIRED = process.env.GOMOKU_AUTH_REQUIRED !== "false";
const ISSUER = String(process.env.GOMOKU_LOGTO_ISSUER || "https://auth.candymo.com/oidc").replace(/\/+$/, "");
const AUDIENCE = process.env.GOMOKU_LOGTO_AUDIENCE || "https://gomoku.candymo.com/api";
const CLIENT_ID = process.env.GOMOKU_LOGTO_CLIENT_ID || "pt1vgzollhjzsfml54uz9";
const JWKS_URI = process.env.GOMOKU_LOGTO_JWKS_URI || `${ISSUER}/jwks`;
const JWKS_CACHE_MS = 5 * 60_000;

let cachedJwks = null;
let cachedAt = 0;

function decodePart(value) {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Malformed JWT");
  }
}

function audienceIncludes(claim, expected) {
  return Array.isArray(claim) ? claim.includes(expected) : claim === expected;
}

function validateClaims(payload, audience, tokenKind) {
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== ISSUER) throw new Error("Unexpected issuer");
  if (!audienceIncludes(payload.aud, audience)) throw new Error("Unexpected audience");
  if (typeof payload.sub !== "string" || !payload.sub) throw new Error("Missing subject");
  if (!Number.isFinite(payload.exp) || payload.exp <= now) throw new Error("Expired token");
  if (Number.isFinite(payload.nbf) && payload.nbf > now + 30) throw new Error("Token is not active");
  if (Number.isFinite(payload.iat) && payload.iat > now + 60) throw new Error("Token issued in the future");
  if (tokenKind === "access" && payload.client_id !== CLIENT_ID && payload.azp !== CLIENT_ID) {
    throw new Error("Unexpected client");
  }
}

async function getJwks(forceRefresh = false) {
  if (!forceRefresh && cachedJwks && Date.now() - cachedAt < JWKS_CACHE_MS) return cachedJwks;
  const response = await fetch(JWKS_URI, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`JWKS endpoint returned ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload.keys)) throw new Error("Invalid JWKS response");
  cachedJwks = payload.keys;
  cachedAt = Date.now();
  return cachedJwks;
}

async function verifyJwt(token, audience, tokenKind) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");
  const header = decodePart(parts[0]);
  const payload = decodePart(parts[1]);
  if (header.alg !== "ES384" || typeof header.kid !== "string") throw new Error("Unsupported JWT");

  let keys = await getJwks();
  let jwk = keys.find((item) => item.kid === header.kid && item.kty === "EC" && item.crv === "P-384");
  if (!jwk) {
    keys = await getJwks(true);
    jwk = keys.find((item) => item.kid === header.kid && item.kty === "EC" && item.crv === "P-384");
  }
  if (!jwk) throw new Error("Unknown signing key");

  const valid = verify(
    "sha384",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" },
    Buffer.from(parts[2], "base64url")
  );
  if (!valid) throw new Error("Invalid signature");
  validateClaims(payload, audience, tokenKind);
  return payload;
}

function bearerToken(req) {
  const match = String(req.headers.authorization || "").match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] || "";
}

export async function authenticateLogtoRequest(req) {
  if (!AUTH_REQUIRED) return null;
  const accessToken = bearerToken(req);
  const idToken = String(req.headers["x-gomoku-id-token"] || "");
  if (!accessToken || !idToken) throw new Error("Missing authentication token");

  const [accessClaims, idClaims] = await Promise.all([
    verifyJwt(accessToken, AUDIENCE, "access"),
    verifyJwt(idToken, CLIENT_ID, "id"),
  ]);
  if (accessClaims.sub !== idClaims.sub) throw new Error("Token subjects do not match");

  const nickname = idClaims.name || idClaims.username || idClaims.preferred_username
    || (typeof idClaims.email === "string" ? idClaims.email.split("@")[0] : "")
    || `玩家-${idClaims.sub.slice(0, 6)}`;
  return { sub: idClaims.sub, nickname };
}

export const logtoAuthConfig = Object.freeze({
  required: AUTH_REQUIRED,
  issuer: ISSUER,
  audience: AUDIENCE,
  clientId: CLIENT_ID,
});
