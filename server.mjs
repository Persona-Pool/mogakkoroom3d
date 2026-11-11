// server.mjs : Next 페이지(3000) + WebSocket 방 서버(3001)
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { randomUUID } from "node:crypto";
import next from "next";
import { RULES, initRoom, snapshot, startGame, action, tickGame, transferHost } from "./lib/freeze-game.mjs";
import { WebSocketServer } from "ws";

const dev = process.argv.includes("--dev");
const PORT = Number(process.env.PORT) || 3000;
const WS_PORT = Number(process.env.WS_PORT) || 3001;

// page.tsx와 반드시 같은 값
const MAX_PLAYERS = 6;
const SEAT_COUNT = 6;
const AVATARS = ["🐱", "🐶", "🦊", "🐼", "🐻", "🐰", "🐸", "🐧"];
const COLORS = ["#6366f1", "#ec4899", "#f59e0b", "#10b981", "#0ea5e9", "#ef4444"];
const GESTURES = ["👋", "☕", "🔥", "🎉", "🫠"];

/* ── 유틸 ── */
function getLanIps() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list ?? []) {
      const v4 = n.family === "IPv4" || n.family === 4;
      if (v4 && !n.internal && !n.address.startsWith("169.254.")) out.push(n.address);
    }
  }
  return out;
}
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v, min, max) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : 0;
const validSeat = (s) => Number.isInteger(s) && s >= 0 && s < SEAT_COUNT;
const cleanProfile = (p = {}) => ({
  name: str(p.name, 12) || "익명",
  goal: str(p.goal, 28),
  avatar: AVATARS.includes(p.avatar) ? p.avatar : AVATARS[0],
  color: COLORS.includes(p.color) ? p.color : COLORS[0],
  status: p.status === "resting" ? "resting" : "coding",
});

/* ── 방 상태: roomName -> Map<id, { id, room, peer, ws }> ── */
const rooms = new Map();
function sendRoom(members, msg) {
  const data = JSON.stringify(msg);
  for (const c of members.values()) if (c.ws.readyState === 1) c.ws.send(data);
}
setInterval(() => {
  for (const members of rooms.values()) {
    if (members.game.phase === "playing") {
      tickGame(members);
      sendRoom(members, snapshot(members));
    }
  }
}, 100);

const wss = new WebSocketServer({ port: WS_PORT, host: "0.0.0.0", maxPayload: 16 * 1024 });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  let me = null;

  const send = (msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg) => {
    const members = rooms.get(me.room);
    if (!members) return;
    const data = JSON.stringify(msg);
    for (const c of members.values()) {
      if (c.id !== me.id && c.ws.readyState === c.ws.OPEN) c.ws.send(data);
    }
  };

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    // ── 입장 ──
    if (!me) {
      if (msg.t !== "join") return;
      const room = str(msg.room, 40) || "모각코";
      const members = rooms.get(room) ?? new Map();
      if (members.size >= MAX_PLAYERS) {
        send({ t: "full", max: MAX_PLAYERS });
        ws.close(4001, "full");
        return;
      }
      const id = randomUUID();
      let seatIndex = validSeat(msg.profile?.seatIndex) ? msg.profile.seatIndex : null;
      if (seatIndex !== null && [...members.values()].some((c) => c.peer.seatIndex === seatIndex)) {
        seatIndex = null;
      }
      const peer = { id, ...cleanProfile(msg.profile), seatIndex, joinedAt: Date.now() };
      me = { id, room, peer, ws };
      members.set(id, me);
      if (!members.game) initRoom(members);
      rooms.set(room, members);

      send({
        t: "welcome",
        id,
        you: peer,
        peers: [...members.values()].filter((c) => c.id !== id).map((c) => c.peer),
      });
      broadcast({ t: "peer-join", peer });
      sendRoom(members, snapshot(members));
      console.log(`[room:${room}] + ${peer.name} (${members.size}/${MAX_PLAYERS})`);
      return;
    }

    // ── 입장 후 메시지 ──
    const members = rooms.get(me.room);
    const wasPlaying = members.game.phase === "playing";
    tickGame(members);
    if (wasPlaying && members.game.phase === "ended") sendRoom(members, snapshot(members));
    const game = members.game;
    switch (msg.t) {
      case "host-transfer":
        if (transferHost(members, me.id, msg.targetId)) sendRoom(members, snapshot(members));
        return;
      case "game-start":
        if (members.hostId === me.id && startGame(members)) {
          for (const c of members.values()) sendRoom(members, { t: "peer-update", peer: c.peer });
          sendRoom(members, snapshot(members));
        }
        return;
      case "game-random":
        if (members.hostId === me.id && game.phase !== "playing" && members.size >= 2) {
          const ids = [...members.keys()];
          game.taggerId = ids[Math.floor(Math.random() * ids.length)];
          sendRoom(members, snapshot(members));
        }
        return;
      case "freeze":
      case "rescue":
        if (action(members, me.id, msg.t)) {
          tickGame(members);
          sendRoom(members, snapshot(members));
        }
        return;
      case "seat": {
        if (game.phase === "playing" && msg.seatIndex !== null) return;
        const s = msg.seatIndex === null ? null : validSeat(msg.seatIndex) ? msg.seatIndex : undefined;
        if (s === undefined) return;
        if (s !== null) {
          const taken = [...rooms.get(me.room).values()].some(
            (c) => c.id !== me.id && c.peer.seatIndex === s
          );
          if (taken) {
            send({ t: "seat-denied", seatIndex: s });
            return;
          }
        }
        if (me.peer.seatIndex === s) return;
        me.peer.seatIndex = s;
        broadcast({ t: "peer-update", peer: me.peer });
        return;
      }
      case "status": {
        const st = msg.status === "resting" ? "resting" : "coding";
        if (me.peer.status === st) return;
        me.peer.status = st;
        broadcast({ t: "peer-update", peer: me.peer });
        return;
      }
      case "move": {
        if (![msg.x, msg.y, msg.z, msg.ry].every(v => typeof v === "number" && Number.isFinite(v))) return;
        let x = num(msg.x, -7.8, 7.8), z = num(msg.z, -7.8, 7.8), y = num(msg.y, 0, 3);
        const p = game.players[me.id];
        if (game.phase === "playing") {
          if (!p) return; // 관전자는 게임 중 이동 불가
          const now = Date.now();
          const dt = Math.min(Math.max((now - (me.lastMoveAt ?? now)) / 1000, 0), 0.25);
          me.lastMoveAt = now;
          if (p.state !== "active") { x = p.x; z = p.z; y = 0; }
          else {
            const sprint = !!msg.sprinting && p.stamina >= RULES.drain * dt;
            const limit = (sprint ? RULES.sprint : RULES.walk) * dt + 0.04;
            const distance = Math.hypot(x - p.x, z - p.z);
            if (distance > limit) { x = p.x + (x - p.x) * limit / distance; z = p.z + (z - p.z) * limit / distance; }
            p.stamina = Math.max(0, Math.min(100, p.stamina + (sprint && distance > 0.01 ? -RULES.drain : RULES.regen) * dt));
          }
          Object.assign(p, { x, y, z });
          if (Math.hypot(msg.x - x, msg.z - z) > 0.15 || p.state !== "active") send({ t: "position", x, y, z });
          tickGame(members);
          if (game.phase === "ended") sendRoom(members, snapshot(members));
        }
        broadcast({ t: "move", id: me.id, x, y, z, ry: num(msg.ry, -7, 7), moving: !!msg.moving && (!p || p.state === "active"), sprinting: !!msg.sprinting });
        return;
      }
      case "chat": {
        const text = str(msg.text, 500);
        if (text) broadcast({ t: "chat", id: me.id, text });
        return;
      }
      case "gesture":
        if (GESTURES.includes(msg.emoji)) broadcast({ t: "gesture", id: me.id, emoji: msg.emoji });
        return;
    }
  });

  ws.on("close", () => {
    if (!me) return;
    const members = rooms.get(me.room);
    if (!members) return;
    members.delete(me.id);
    if (members.size === 0) rooms.delete(me.room);
    else {
      broadcast({ t: "peer-leave", id: me.id });
      if (members.hostId === me.id) members.hostId = members.keys().next().value;
      delete members.game.players[me.id];
      tickGame(members);
      sendRoom(members, snapshot(members));
    }
    console.log(`[room:${me.room}] - ${me.peer.name} (${members.size}/${MAX_PLAYERS})`);
  });
});

// 응답 없는 연결 정리 (노트북 덮음, 와이파이 끊김 등)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

/* ── Next 페이지 서버 ── */
const app = next({ dev, hostname: "0.0.0.0", port: PORT });
const handle = app.getRequestHandler();
await app.prepare();

createServer((req, res) => {
  if (req.url === "/__host-info") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ips: getLanIps(), port: PORT, wsPort: WS_PORT }));
    return;
  }
  handle(req, res);
}).listen(PORT, "0.0.0.0", () => {
  console.log(`\n모각코룸 3D ${dev ? "(dev)" : ""} 실행 중`);
  console.log(`  내 PC:  http://localhost:${PORT}`);
  for (const ip of getLanIps()) console.log(`  동료:   http://${ip}:${PORT}`);
  console.log(`  WebSocket 포트: ${WS_PORT}\n`);
});
