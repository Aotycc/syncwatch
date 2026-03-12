// ============================================================
// SyncWatch - Cloudflare Worker + Durable Objects
// ============================================================

export class SyncRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // websocket -> { id, username, isHost }
    this.roomState = {
      videoUrl: '',
      currentTime: 0,
      isPlaying: false,
      hostId: null,
      lastUpdated: Date.now(),
    };
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/websocket') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }

      const [client, server] = Object.values(new WebSocketPair());
      await this.handleSession(server, request);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/state') {
      return Response.json(this.roomState);
    }

    return new Response('Not found', { status: 404 });
  }

  async handleSession(ws, request) {
    this.state.acceptWebSocket(ws);
    const sessionId = crypto.randomUUID();
    const url = new URL(request.url);
    const username = url.searchParams.get('username') || `Guest${Math.floor(Math.random() * 9000 + 1000)}`;

    const isFirstUser = this.sessions.size === 0;
    const session = { id: sessionId, username, isHost: isFirstUser };
    this.sessions.set(ws, session);

    if (isFirstUser) {
      this.roomState.hostId = sessionId;
    }

    // Send current state to new user
    this.sendTo(ws, {
      type: 'init',
      sessionId,
      isHost: session.isHost,
      roomState: this.roomState,
      users: this.getUserList(),
    });

    // Notify others
    this.broadcast({
      type: 'user_joined',
      username,
      users: this.getUserList(),
    }, ws);
  }

  webSocketMessage(ws, message) {
    const session = this.sessions.get(ws);
    if (!session) return;

    let data;
    try { data = JSON.parse(message); } catch { return; }

    switch (data.type) {
      case 'set_video': {
        this.roomState.videoUrl = data.url;
        this.roomState.currentTime = 0;
        this.roomState.isPlaying = false;
        this.broadcast({ type: 'video_changed', url: data.url });
        break;
      }
      case 'play': {
        this.roomState.isPlaying = true;
        this.roomState.currentTime = data.currentTime ?? this.roomState.currentTime;
        this.roomState.lastUpdated = Date.now();
        this.broadcast({ type: 'play', currentTime: this.roomState.currentTime, username: session.username }, ws);
        break;
      }
      case 'pause': {
        this.roomState.isPlaying = false;
        this.roomState.currentTime = data.currentTime ?? this.roomState.currentTime;
        this.broadcast({ type: 'pause', currentTime: this.roomState.currentTime, username: session.username }, ws);
        break;
      }
      case 'seek': {
        this.roomState.currentTime = data.currentTime;
        this.roomState.lastUpdated = Date.now();
        this.broadcast({ type: 'seek', currentTime: data.currentTime, username: session.username }, ws);
        break;
      }
      case 'sync_request': {
        // New user or desynced user requests current state
        this.sendTo(ws, {
          type: 'sync',
          roomState: this.roomState,
          serverTime: Date.now(),
        });
        break;
      }
      case 'chat': {
        this.broadcast({
          type: 'chat',
          username: session.username,
          message: data.message.slice(0, 300),
          time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        });
        break;
      }
    }
  }

  webSocketClose(ws) {
    const session = this.sessions.get(ws);
    if (!session) return;
    this.sessions.delete(ws);

    // Reassign host if needed
    if (session.isHost && this.sessions.size > 0) {
      const [nextWs, nextSession] = this.sessions.entries().next().value;
      nextSession.isHost = true;
      this.roomState.hostId = nextSession.id;
      this.sendTo(nextWs, { type: 'promoted_host' });
    }

    this.broadcast({
      type: 'user_left',
      username: session.username,
      users: this.getUserList(),
    });
  }

  webSocketError(ws) {
    this.webSocketClose(ws);
  }

  sendTo(ws, data) {
    try { ws.send(JSON.stringify(data)); } catch {}
  }

  broadcast(data, excludeWs = null) {
    const msg = JSON.stringify(data);
    for (const [ws] of this.sessions) {
      if (ws !== excludeWs) {
        try { ws.send(msg); } catch {}
      }
    }
  }

  getUserList() {
    return Array.from(this.sessions.values()).map(s => ({
      username: s.username,
      isHost: s.isHost,
    }));
  }
}

// ── Main Worker ───────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '*';

    const corsHeaders = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // API: Create or join room
    if (url.pathname.startsWith('/room/')) {
      const parts = url.pathname.split('/');
      const roomId = parts[2];
      const action = parts[3]; // 'websocket' or 'state'

      if (!roomId || !/^[a-zA-Z0-9-_]{4,32}$/.test(roomId)) {
        return new Response('Invalid room ID', { status: 400 });
      }

      const id = env.SYNC_ROOM.idFromName(roomId);
      const room = env.SYNC_ROOM.get(id);
      const newUrl = new URL(request.url);
      newUrl.pathname = `/${action || ''}`;

      return room.fetch(new Request(newUrl.toString(), request));
    }

    // Serve static frontend
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(getHTML(), {
        headers: { 'Content-Type': 'text/html;charset=UTF-8', ...corsHeaders },
      });
    }

    return new Response('Not found', { status: 404 });
  },
};

// ── Embedded Frontend HTML ─────────────────────────────────────
function getHTML() {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SyncWatch · 一起看</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;700;900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #080a0f;
    --surface: #0e1118;
    --border: #1e2436;
    --accent: #e8b84b;
    --accent2: #ff6b35;
    --text: #e8e4d9;
    --muted: #5a6070;
    --success: #4ade80;
    --danger: #f87171;
  }

  body {
    font-family: 'Space Mono', monospace;
    background: var(--bg);
    color: var(--text);
    min-height: 100dvh;
    overflow-x: hidden;
  }

  /* ── LOBBY ── */
  #lobby {
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    position: relative;
    overflow: hidden;
  }

  #lobby::before {
    content: '';
    position: absolute;
    inset: 0;
    background:
      radial-gradient(ellipse 80% 60% at 50% -10%, rgba(232,184,75,0.12) 0%, transparent 60%),
      radial-gradient(ellipse 50% 40% at 80% 80%, rgba(255,107,53,0.07) 0%, transparent 50%);
    pointer-events: none;
  }

  .film-grain {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 9999;
    opacity: 0.025;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  }

  .logo {
    font-family: 'Noto Serif SC', serif;
    font-size: clamp(2.5rem, 8vw, 5rem);
    font-weight: 900;
    letter-spacing: -0.02em;
    line-height: 1;
    margin-bottom: 0.5rem;
    background: linear-gradient(135deg, var(--accent) 0%, var(--accent2) 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .tagline {
    color: var(--muted);
    font-size: 0.75rem;
    letter-spacing: 0.25em;
    text-transform: uppercase;
    margin-bottom: 3rem;
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 2rem;
    width: 100%;
    max-width: 420px;
  }

  .card-title {
    font-size: 0.7rem;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 1.5rem;
  }

  .input-group {
    margin-bottom: 1rem;
  }

  label {
    display: block;
    font-size: 0.65rem;
    letter-spacing: 0.15em;
    color: var(--muted);
    text-transform: uppercase;
    margin-bottom: 0.4rem;
  }

  input[type=text] {
    width: 100%;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-family: 'Space Mono', monospace;
    font-size: 0.9rem;
    padding: 0.65rem 0.85rem;
    outline: none;
    transition: border-color 0.2s;
  }
  input[type=text]:focus { border-color: var(--accent); }
  input[type=text]::placeholder { color: var(--muted); }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-family: 'Space Mono', monospace;
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    padding: 0.7rem 1.2rem;
    transition: all 0.15s;
    width: 100%;
  }

  .btn-primary {
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    color: #000;
  }
  .btn-primary:hover { filter: brightness(1.1); transform: translateY(-1px); }
  .btn-ghost {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text);
  }
  .btn-ghost:hover { border-color: var(--accent); color: var(--accent); }

  .divider {
    display: flex; align-items: center; gap: 1rem;
    margin: 1.5rem 0;
    color: var(--muted); font-size: 0.65rem; letter-spacing: 0.1em;
  }
  .divider::before, .divider::after {
    content: ''; flex: 1; height: 1px; background: var(--border);
  }

  /* ── ROOM ── */
  #room { display: none; height: 100dvh; flex-direction: column; }

  .room-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.75rem 1.25rem;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .room-id-badge {
    display: flex; align-items: center; gap: 0.5rem;
    font-size: 0.7rem; letter-spacing: 0.1em;
    color: var(--muted);
  }

  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--success); animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1;} 50%{opacity:.4;} }

  .room-id-text {
    font-weight: 700; color: var(--accent); cursor: pointer;
    transition: opacity .2s;
  }
  .room-id-text:hover { opacity: .7; }

  .user-count {
    font-size: 0.7rem; color: var(--muted);
    display: flex; align-items: center; gap: 0.35rem;
  }

  .room-body {
    display: flex; flex: 1; overflow: hidden;
  }

  .video-area {
    flex: 1; display: flex; flex-direction: column;
    background: #000; position: relative;
    overflow: hidden;
  }

  .url-bar {
    display: flex; gap: 0.5rem;
    padding: 0.6rem 0.75rem;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }

  .url-bar input { flex: 1; font-size: 0.78rem; }

  .url-bar .btn { width: auto; padding: 0.5rem 1rem; font-size: 0.65rem; }

  .player-wrap {
    flex: 1; position: relative; background: #000;
    display: flex; align-items: center; justify-content: center;
  }

  #yt-player { position: absolute; inset: 0; width: 100%; height: 100%; border: none; }
  #html5-player { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }

  .player-placeholder {
    display: flex; flex-direction: column; align-items: center; gap: 1rem;
    color: var(--muted); text-align: center;
  }

  .play-icon { font-size: 3.5rem; opacity: 0.15; }

  .status-bar {
    padding: 0.45rem 0.75rem;
    background: var(--surface);
    border-top: 1px solid var(--border);
    display: flex; align-items: center; gap: 1rem;
    font-size: 0.65rem; color: var(--muted); letter-spacing: 0.05em;
  }

  .status-pill {
    display: inline-flex; align-items: center; gap: 0.3rem;
    padding: 0.2rem 0.5rem;
    border-radius: 99px;
    background: rgba(232,184,75,0.1);
    color: var(--accent); font-size: 0.6rem; letter-spacing: 0.1em;
  }

  /* ── SIDEBAR ── */
  .sidebar {
    width: 280px; flex-shrink: 0;
    background: var(--surface);
    border-left: 1px solid var(--border);
    display: flex; flex-direction: column;
    overflow: hidden;
  }

  @media (max-width: 700px) { .sidebar { display: none; } }

  .sidebar-tab {
    display: flex; border-bottom: 1px solid var(--border);
  }

  .tab-btn {
    flex: 1; padding: 0.7rem;
    background: transparent; border: none;
    color: var(--muted); cursor: pointer;
    font-family: 'Space Mono', monospace;
    font-size: 0.65rem; letter-spacing: 0.1em; text-transform: uppercase;
    border-bottom: 2px solid transparent;
    transition: all .2s;
  }
  .tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); }

  .tab-panel { display: none; flex: 1; flex-direction: column; overflow: hidden; }
  .tab-panel.active { display: flex; }

  /* Users panel */
  .users-list { flex: 1; padding: 0.75rem; overflow-y: auto; display: flex; flex-direction: column; gap: 0.4rem; }
  .user-item {
    display: flex; align-items: center; gap: 0.6rem;
    padding: 0.5rem 0.6rem;
    border-radius: 6px;
    background: rgba(255,255,255,0.03);
    font-size: 0.75rem;
  }
  .avatar {
    width: 26px; height: 26px; border-radius: 50%;
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    display: flex; align-items: center; justify-content: center;
    font-size: 0.65rem; font-weight: 700; color: #000; flex-shrink: 0;
  }
  .host-badge {
    margin-left: auto; font-size: 0.55rem; letter-spacing: 0.1em;
    color: var(--accent); border: 1px solid var(--accent);
    padding: 0.1rem 0.35rem; border-radius: 3px;
  }

  /* Chat panel */
  .chat-messages {
    flex: 1; padding: 0.75rem; overflow-y: auto;
    display: flex; flex-direction: column; gap: 0.5rem;
  }
  .msg { font-size: 0.72rem; line-height: 1.5; }
  .msg-meta { color: var(--muted); font-size: 0.6rem; margin-bottom: 0.1rem; }
  .msg-name { color: var(--accent); }
  .msg-system { color: var(--muted); font-style: italic; font-size: 0.65rem; }
  .chat-input-wrap {
    padding: 0.6rem;
    border-top: 1px solid var(--border);
    display: flex; gap: 0.4rem;
  }
  .chat-input-wrap input { flex: 1; font-size: 0.75rem; }
  .chat-input-wrap .btn { width: auto; padding: 0.5rem 0.75rem; font-size: 0.6rem; }

  /* Toast */
  .toast {
    position: fixed; bottom: 1.5rem; left: 50%; transform: translateX(-50%);
    background: var(--surface); border: 1px solid var(--accent);
    border-radius: 6px; padding: 0.5rem 1.2rem;
    font-size: 0.72rem; color: var(--accent); letter-spacing: 0.05em;
    z-index: 9998; opacity: 0; transition: opacity .3s;
    pointer-events: none;
  }
  .toast.show { opacity: 1; }

  scrollbar-width: thin;
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
</style>
</head>
<body>
<div class="film-grain"></div>

<!-- LOBBY -->
<div id="lobby">
  <div class="logo">一起看</div>
  <div class="tagline">SyncWatch · 同步观影</div>

  <div class="card">
    <div class="card-title">▶ 创建房间</div>
    <div class="input-group">
      <label>你的昵称</label>
      <input type="text" id="create-username" placeholder="给自己起个名字" maxlength="20">
    </div>
    <div class="input-group">
      <label>房间名（可选）</label>
      <input type="text" id="room-name-input" placeholder="留空则自动生成" maxlength="20">
    </div>
    <button class="btn btn-primary" onclick="createRoom()">创建并进入</button>

    <div class="divider">或加入已有房间</div>

    <div class="input-group">
      <label>房间代码</label>
      <input type="text" id="join-room-id" placeholder="输入6位房间代码" maxlength="20">
    </div>
    <div class="input-group">
      <label>昵称</label>
      <input type="text" id="join-username" placeholder="给自己起个名字" maxlength="20">
    </div>
    <button class="btn btn-ghost" onclick="joinRoom()">加入房间</button>
  </div>
</div>

<!-- ROOM -->
<div id="room" style="display:none;flex-direction:column;">
  <div class="room-header">
    <div class="room-id-badge">
      <div class="dot"></div>
      <span>房间</span>
      <span class="room-id-text" id="display-room-id" onclick="copyRoomId()"></span>
      <span style="font-size:0.6rem;opacity:.5" title="点击复制">📋</span>
    </div>
    <div class="user-count">
      <span>👥</span>
      <span id="user-count-num">1</span> 人在线
    </div>
    <button class="btn btn-ghost" style="width:auto;padding:.4rem .8rem;font-size:.65rem" onclick="leaveRoom()">离开</button>
  </div>

  <div class="room-body">
    <div class="video-area">
      <div class="url-bar">
        <input type="text" id="video-url-input" placeholder="粘贴视频链接（YouTube / MP4 / M3U8…）">
        <button class="btn btn-primary" onclick="loadVideo()">载入</button>
      </div>

      <div class="player-wrap" id="player-wrap">
        <div class="player-placeholder" id="placeholder">
          <div class="play-icon">▶</div>
          <div style="font-size:.8rem;">在上方粘贴视频链接开始观影</div>
          <div style="font-size:.65rem;color:var(--muted)">支持 YouTube · 直链 MP4 · 流媒体</div>
        </div>
        <iframe id="yt-player" allow="autoplay; fullscreen" style="display:none"></iframe>
        <video id="html5-player" controls style="display:none"></video>
      </div>

      <div class="status-bar">
        <div class="status-pill" id="sync-status">● SYNC</div>
        <span id="status-msg">等待载入视频</span>
      </div>
    </div>

    <div class="sidebar">
      <div class="sidebar-tab">
        <button class="tab-btn active" onclick="switchTab('chat')">💬 聊天</button>
        <button class="tab-btn" onclick="switchTab('users')">👥 成员</button>
      </div>

      <div class="tab-panel active" id="tab-chat">
        <div class="chat-messages" id="chat-messages"></div>
        <div class="chat-input-wrap">
          <input type="text" id="chat-input" placeholder="发送消息…" maxlength="200" onkeydown="if(event.key==='Enter')sendChat()">
          <button class="btn btn-primary" onclick="sendChat()">发</button>
        </div>
      </div>

      <div class="tab-panel" id="tab-users">
        <div class="users-list" id="users-list"></div>
      </div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
// ── State ────────────────────────────────────────────────────
let ws = null;
let roomId = '';
let username = '';
let isHost = false;
let ytPlayer = null;
let currentVideoType = null; // 'youtube' | 'html5'
let isSyncing = false; // suppress echo
let activeTab = 'chat';

// ── Lobby ─────────────────────────────────────────────────────
function createRoom() {
  username = document.getElementById('create-username').value.trim() || 'Guest' + Math.floor(Math.random()*9000+1000);
  const name = document.getElementById('room-name-input').value.trim();
  roomId = name || Math.random().toString(36).slice(2,8).toUpperCase();
  enterRoom();
}

function joinRoom() {
  roomId = document.getElementById('join-room-id').value.trim().toUpperCase();
  username = document.getElementById('join-username').value.trim() || 'Guest' + Math.floor(Math.random()*9000+1000);
  if (!roomId) { toast('请输入房间代码'); return; }
  enterRoom();
}

function enterRoom() {
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('room').style.display = 'flex';
  document.getElementById('display-room-id').textContent = roomId;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = \`\${proto}://\${location.host}/room/\${roomId}/websocket?username=\${encodeURIComponent(username)}\`;
  
  ws = new WebSocket(wsUrl);
  ws.onopen = () => setStatus('已连接');
  ws.onmessage = e => handleMessage(JSON.parse(e.data));
  ws.onclose = () => { setStatus('连接断开'); addSystemMsg('与服务器断开连接'); };
  ws.onerror = () => setStatus('连接错误');
}

function leaveRoom() {
  ws?.close();
  location.reload();
}

// ── WS Messages ───────────────────────────────────────────────
function handleMessage(data) {
  switch(data.type) {
    case 'init':
      isHost = data.isHost;
      updateUsers(data.users);
      if (data.roomState.videoUrl) {
        loadVideoUrl(data.roomState.videoUrl);
        syncFromState(data.roomState);
      }
      addSystemMsg(isHost ? '你是房主 👑' : '已加入房间');
      break;
    case 'user_joined':
      updateUsers(data.users);
      addSystemMsg(\`\${data.username} 加入了房间\`);
      break;
    case 'user_left':
      updateUsers(data.users);
      addSystemMsg(\`\${data.username} 离开了房间\`);
      break;
    case 'promoted_host':
      isHost = true;
      toast('你成为了新房主 👑');
      addSystemMsg('你成为了新房主');
      break;
    case 'video_changed':
      loadVideoUrl(data.url);
      addSystemMsg('视频已更新');
      break;
    case 'play':
      isSyncing = true;
      if (data.currentTime !== undefined) seekTo(data.currentTime);
      playVideo();
      setTimeout(() => isSyncing = false, 500);
      setStatus(\`\${data.username} 播放了视频\`);
      break;
    case 'pause':
      isSyncing = true;
      pauseVideo();
      if (data.currentTime !== undefined) seekTo(data.currentTime);
      setTimeout(() => isSyncing = false, 500);
      setStatus(\`\${data.username} 暂停了视频\`);
      break;
    case 'seek':
      isSyncing = true;
      seekTo(data.currentTime);
      setTimeout(() => isSyncing = false, 500);
      setStatus(\`\${data.username} 跳转到 \${fmtTime(data.currentTime)}\`);
      break;
    case 'sync':
      syncFromState(data.roomState);
      break;
    case 'chat':
      addChatMsg(data.username, data.message, data.time);
      break;
  }
}

function syncFromState(state) {
  if (!state.videoUrl) return;
  isSyncing = true;
  const lag = (Date.now() - (state.lastUpdated || Date.now())) / 1000;
  const target = state.currentTime + (state.isPlaying ? lag : 0);
  seekTo(target);
  if (state.isPlaying) playVideo(); else pauseVideo();
  setTimeout(() => isSyncing = false, 800);
}

// ── Video Control ─────────────────────────────────────────────
function getYTId(url) {
  const m = url.match(/(?:youtube\\.com\\/(?:watch\\?v=|embed\\/)|youtu\\.be\\/)([\\w-]{11})/);
  return m ? m[1] : null;
}

function loadVideo() {
  const url = document.getElementById('video-url-input').value.trim();
  if (!url) return;
  ws?.send(JSON.stringify({ type: 'set_video', url }));
  loadVideoUrl(url);
}

function loadVideoUrl(url) {
  document.getElementById('video-url-input').value = url;
  document.getElementById('placeholder').style.display = 'none';

  const ytId = getYTId(url);

  if (ytId) {
    currentVideoType = 'youtube';
    document.getElementById('html5-player').style.display = 'none';
    document.getElementById('yt-player').style.display = 'block';
    
    if (!ytPlayer) {
      initYTPlayer(ytId);
    } else {
      ytPlayer.loadVideoById(ytId);
    }
  } else {
    currentVideoType = 'html5';
    document.getElementById('yt-player').style.display = 'none';
    const vid = document.getElementById('html5-player');
    vid.style.display = 'block';
    vid.src = url;
    attachHtml5Events(vid);
  }
}

// YouTube IFrame API
function initYTPlayer(videoId) {
  if (!window.YT) {
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
    window.onYouTubeIframeAPIReady = () => createYTPlayer(videoId);
  } else {
    createYTPlayer(videoId);
  }
}

function createYTPlayer(videoId) {
  ytPlayer = new YT.Player('yt-player', {
    videoId,
    playerVars: { autoplay: 0, rel: 0, modestbranding: 1 },
    events: {
      onStateChange: e => {
        if (isSyncing) return;
        const t = ytPlayer.getCurrentTime();
        if (e.data === YT.PlayerState.PLAYING) {
          ws?.send(JSON.stringify({ type: 'play', currentTime: t }));
        } else if (e.data === YT.PlayerState.PAUSED) {
          ws?.send(JSON.stringify({ type: 'pause', currentTime: t }));
        }
      }
    }
  });
}

function attachHtml5Events(vid) {
  vid.onplay = () => { if (isSyncing) return; ws?.send(JSON.stringify({ type: 'play', currentTime: vid.currentTime })); };
  vid.onpause = () => { if (isSyncing) return; ws?.send(JSON.stringify({ type: 'pause', currentTime: vid.currentTime })); };
  vid.onseeked = () => { if (isSyncing) return; ws?.send(JSON.stringify({ type: 'seek', currentTime: vid.currentTime })); };
}

function playVideo() {
  if (currentVideoType === 'youtube' && ytPlayer?.playVideo) ytPlayer.playVideo();
  else if (currentVideoType === 'html5') document.getElementById('html5-player').play().catch(()=>{});
}

function pauseVideo() {
  if (currentVideoType === 'youtube' && ytPlayer?.pauseVideo) ytPlayer.pauseVideo();
  else if (currentVideoType === 'html5') document.getElementById('html5-player').pause();
}

function seekTo(t) {
  if (currentVideoType === 'youtube' && ytPlayer?.seekTo) ytPlayer.seekTo(t, true);
  else if (currentVideoType === 'html5') document.getElementById('html5-player').currentTime = t;
}

// ── Chat ──────────────────────────────────────────────────────
function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg || !ws) return;
  ws.send(JSON.stringify({ type: 'chat', message: msg }));
  input.value = '';
}

function addChatMsg(user, message, time) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'msg';
  const isMe = user === username;
  div.innerHTML = \`<div class="msg-meta"><span class="msg-name" style="\${isMe?'color:var(--accent2)':''}">\${escHtml(user)}</span>  \${time}</div>\${escHtml(message)}\`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  if (activeTab !== 'chat') {
    document.querySelector('.tab-btn').style.color = 'var(--accent2)';
  }
}

function addSystemMsg(msg) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'msg-system';
  div.textContent = '— ' + msg;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// ── UI Helpers ────────────────────────────────────────────────
function updateUsers(users) {
  document.getElementById('user-count-num').textContent = users.length;
  const list = document.getElementById('users-list');
  list.innerHTML = users.map(u => \`
    <div class="user-item">
      <div class="avatar">\${u.username[0].toUpperCase()}</div>
      <span style="font-size:.75rem">\${escHtml(u.username)}</span>
      \${u.isHost ? '<span class="host-badge">HOST</span>' : ''}
    </div>
  \`).join('');
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach((b,i) => b.classList.toggle('active', (i===0&&tab==='chat')||(i===1&&tab==='users')));
  document.getElementById('tab-chat').classList.toggle('active', tab==='chat');
  document.getElementById('tab-users').classList.toggle('active', tab==='users');
  if (tab==='chat') document.querySelector('.tab-btn').style.color='';
}

function setStatus(msg) {
  document.getElementById('status-msg').textContent = msg;
}

function copyRoomId() {
  navigator.clipboard.writeText(roomId).then(() => toast('房间代码已复制！'));
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

function fmtTime(s) {
  const m = Math.floor(s/60), sec = Math.floor(s%60);
  return \`\${m}:\${sec.toString().padStart(2,'0')}\`;
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Check URL params for direct room link
const params = new URLSearchParams(location.search);
if (params.get('room')) {
  document.getElementById('join-room-id').value = params.get('room');
}
</script>
</body>
</html>`;
}
