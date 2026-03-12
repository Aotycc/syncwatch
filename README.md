# 🎬 SyncWatch · 一起看

> 基于 Cloudflare Workers + Durable Objects 的实时视频同步观影平台

## ✨ 功能特性

- **实时同步** — 播放、暂停、跳转瞬间同步给所有观众
- **YouTube 支持** — 直接粘贴 YouTube 链接
- **直链视频** — 支持 MP4、WebM 等 HTML5 视频格式
- **聊天室** — 实时聊天，一起讨论剧情
- **房间系统** — 创建房间并分享代码给好友
- **房主机制** — 第一个进入的人为房主，房主离开后自动转移

---

## 🚀 部署到 Cloudflare

### 1. 安装依赖

\`\`\`bash
npm install
\`\`\`

### 2. 登录 Cloudflare

\`\`\`bash
npx wrangler login
\`\`\`

### 3. 一键部署

\`\`\`bash
npm run deploy
\`\`\`

部署完成后会输出类似：
\`\`\`
https://syncwatch.YOUR-SUBDOMAIN.workers.dev
\`\`\`

### 4. 本地开发调试

\`\`\`bash
npm run dev
\`\`\`

访问 `http://localhost:8787`

---

## 🏗️ 架构说明

\`\`\`
Browser A ──WebSocket──┐
Browser B ──WebSocket──┼── Durable Object (SyncRoom) ── 房间状态
Browser C ──WebSocket──┘
\`\`\`

- **Cloudflare Workers** — 处理 HTTP/WebSocket 请求，提供前端 HTML
- **Durable Objects** — 每个房间一个实例，管理 WebSocket 连接，广播同步事件
- **前端** — 嵌入在 Worker 中，无需额外静态托管

### 同步事件类型

| 事件 | 说明 |
|------|------|
| `play` | 播放，携带当前时间 |
| `pause` | 暂停，携带当前时间 |
| `seek` | 跳转到指定时间 |
| `set_video` | 更换视频 URL |
| `chat` | 聊天消息 |
| `sync_request` | 请求当前房间状态 |

---

## 📋 使用方法

1. 打开网站，输入昵称，点击 **创建并进入**
2. 复制页面顶部的 **房间代码**，发给朋友
3. 朋友在首页输入房间代码和昵称，点击 **加入房间**
4. 在视频框上方粘贴视频链接，点击 **载入**
5. 开始同步观影！

---

## 💡 注意事项

- YouTube 视频需要浏览器允许自动播放
- 直链视频需要服务器支持 CORS，或使用支持跨域的 CDN
- Durable Objects 需要 Cloudflare Workers Paid Plan（$5/月）

---

## 📄 License

MIT
