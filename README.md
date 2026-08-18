# Gomoku

可独立开发、部署或嵌入其他网站的五子棋。人机对战可匿名使用；联机、观战和房间列表需要通过 Logto 登录。支持剪刀石头布决定先手、WebRTC DataChannel 直连与服务器通道回退。

## 本地运行

要求 Node.js 22 或更高版本，无第三方运行时依赖。

```bash
npm run dev
```

打开 `http://127.0.0.1:4173`。开发命令会同时启动静态站点和房间服务，并将 `/api/gomoku` 转发到本地房间服务。

也可以分别启动：

```bash
npm run rooms
python3 -m http.server 4173 --bind 127.0.0.1 --directory web
```

## 配置

浏览器运行时配置位于 `web/runtime-config.js`：

- `apiBase`：房间 API 地址，默认使用同源 `/api/gomoku`
- `logto.endpoint`：Logto 公共地址
- `logto.clientId`：Logto SPA Client ID（公开元数据，不是密钥）
- `logto.resource`：房间 API Resource indicator
- `logto.redirectUri`：登录回调地址，必须登记在 Logto SPA 应用中
- `iceServers`：WebRTC STUN/TURN 配置
- `parentOrigin`：允许向嵌入页面发送生命周期事件的父页面来源；留空时不发送

房间服务读取：

- `GOMOKU_HOST`，默认 `127.0.0.1`
- `GOMOKU_PORT`，默认 `8798`
- `GOMOKU_ALLOWED_ORIGIN`，逗号分隔的跨域来源白名单
- `GOMOKU_AUTH_REQUIRED`，默认 `true`；仅自动化测试可设为 `false`
- `GOMOKU_LOGTO_ISSUER`、`GOMOKU_LOGTO_AUDIENCE`、`GOMOKU_LOGTO_CLIENT_ID`
- `GOMOKU_LOGTO_JWKS_URI`，可选；默认由 Issuer 推导
- `GOMOKU_VIEW_RATE_LIMIT`，单个登录账号每分钟读取房间快照的上限，默认 `120`

URL 参数 `api` 仅可在同源页面或 localhost 开发环境覆盖 `apiBase`。

前端采用 Authorization Code + PKCE，不需要也不允许配置 Client Secret。登录令牌保存在当前标签页的 `sessionStorage`；仓库中只能提交上述公开元数据，不应提交管理令牌、用户令牌、数据库转储、`.env` 或任何 Secret。

## 嵌入接口

游戏不会依赖 CandyMo 门户。宿主可在 `host-bridge.js` 之前注入 `window.GOMOKU_HOST_ADAPTER`，实现可选的 `start()`、`end(score)` 和 `event(name, detail)` 方法。

配置 `parentOrigin` 后，iframe 父页面还会收到以下消息：

```js
{
  source: "gomoku",
  type: "view" | "start" | "end",
  detail: { game: "gomoku", ...data }
}
```

## 构建与检查

```bash
npm run build
npm run check
npm run check:browser
```

构建产物位于 `dist/`。生产环境应由静态服务器托管该目录，并将同源 `/api/gomoku` 反向代理到 `server/room-server.mjs`。

房间目前保存在进程内存中，服务重启后会清空；需要多实例或房间恢复时应改用共享存储。
