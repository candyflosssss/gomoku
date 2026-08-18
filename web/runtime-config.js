window.GOMOKU_CONFIG = Object.freeze({
  apiBase: "/api/gomoku",
  logto: {
    endpoint: "https://auth.candymo.com",
    clientId: "pt1vgzollhjzsfml54uz9",
    resource: "https://gomoku.candymo.com/api",
    redirectUri: `${window.location.origin}/`
  },
  iceServers: [
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.l.google.com:19302" }
  ],
  parentOrigin: ""
});
