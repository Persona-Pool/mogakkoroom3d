"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { LogOut, RefreshCw, Send, Users, Volume2, VolumeX } from "lucide-react";

/* =========================================================
 * 상수 (server.mjs와 값 맞춤)
 * ======================================================= */
const SEAT_COUNT = 6;
const SEAT_RADIUS = 3.35;
const TABLE_RADIUS = 2.4;
const ROOM_BOUNDARY = 7.8;
const TABLE_COLLISION_RADIUS = 2.65;
const MAX_PLAYERS = 6;
const DEFAULT_WS_PORT = 3001;
const MOVE_SEND_INTERVAL = 66; // 약 15Hz
const SIT_DISTANCE = 1.65;
const WALK_SPEED = 3.9;
const JUMP_VEL = 5.2;
const GRAVITY = 14;
const MAX_MESSAGES = 99;
const MAX_CHAT_LEN = 500;
const GESTURE_MS = 2500;
const SELF_KEY = "__me__";

const AVATARS = ["🐱", "🐶", "🦊", "🐼", "🐻", "🐰", "🐸", "🐧"];
const COLORS = ["#6366f1", "#ec4899", "#f59e0b", "#10b981", "#0ea5e9", "#ef4444"];
const GESTURES = ["👋", "☕", "🔥", "🎉", "🫠"];

/* =========================================================
 * 타입
 * ======================================================= */
type Status = "coding" | "resting";
type ConnState = "connecting" | "open" | "closed";

type PeerState = {
  id: string;
  name: string;
  goal: string;
  avatar: string;
  color: string;
  status: Status;
  seatIndex: number | null;
  joinedAt: number;
};

type GamePlayer = { state: "active" | "frozen" | "out"; x: number; y: number; z: number; stamina: number; protectedUntil: number };
type GameState = { hostId: string; roundId: string; phase: "idle" | "playing" | "ended"; taggerId: string | null; endsAt: number; serverNow: number; result: string; players: Record<string, GamePlayer> };
const EMPTY_GAME: GameState = { hostId: "", roundId: "", phase: "idle", taggerId: null, endsAt: 0, serverNow: 0, result: "", players: {} };
function gameBadge(g: GameState, id: string) {
  if (g.phase !== "playing") return "";
  if (!g.players[id]) return "👀 관전";
  if (id === g.taggerId) return "🔴 술래";
  return g.players[id].state === "frozen" ? "🧊 얼음" : g.players[id].state === "out" ? "👀 탈락" : "🏃 도망자";
}

type MovePacket = { sprinting?: boolean; x: number; y: number; z: number; ry: number; moving: boolean };
type JoinProfile = Omit<PeerState, "id" | "joinedAt">;
type HostInfo = { ips: string[]; port: number; wsPort: number };

type ClientMsg =
  | { t: "host-transfer"; targetId: string }
  | { t: "game-start" | "game-random" | "freeze" | "rescue" }
  | { t: "join"; room: string; profile: JoinProfile }
  | { t: "seat"; seatIndex: number | null }
  | { t: "status"; status: Status }
  | ({ t: "move" } & MovePacket)
  | { t: "chat"; text: string }
  | { t: "gesture"; emoji: string };

type ServerMsg =
  | ({ t: "game" } & GameState)
  | { t: "position"; x: number; y: number; z: number }
  | { t: "welcome"; id: string; you: PeerState; peers: PeerState[] }
  | { t: "full"; max: number }
  | { t: "peer-join"; peer: PeerState }
  | { t: "peer-leave"; id: string }
  | { t: "peer-update"; peer: PeerState }
  | { t: "seat-denied"; seatIndex: number }
  | ({ t: "move"; id: string } & MovePacket)
  | { t: "chat"; id: string; text: string }
  | { t: "gesture"; id: string; emoji: string };

type ChatMessage = {
  id: string;
  kind: "chat" | "system";
  text: string;
  name?: string;
  avatar?: string;
  color?: string;
  mine?: boolean;
};

type LocalPlayer = { x: number; y: number; z: number; ry: number; vy: number; moving: boolean };

type AvatarRig = {
  group: THREE.Group;
  legL: THREE.Mesh;
  legR: THREE.Mesh;
  armL: THREE.Mesh;
  armR: THREE.Mesh;
  label: HTMLDivElement;
  labelSig: string;
  walkPhase: number;
  initialized: boolean;
  cur: { x: number; y: number; z: number; ry: number };
};

/* =========================================================
 * 유틸
 * ======================================================= */
function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function round2(v: number) {
  return Math.round(v * 100) / 100;
}

function wrapAngle(a: number) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function lerpAngle(a: number, b: number, t: number) {
  return a + wrapAngle(b - a) * t;
}

function getSeatTransform(i: number) {
  const a = (i / SEAT_COUNT) * Math.PI * 2;
  return { x: Math.sin(a) * SEAT_RADIUS, z: Math.cos(a) * SEAT_RADIUS, ry: a + Math.PI };
}

function isTypingTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

function disposeObject(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else if (mat) mat.dispose();
  });
}

function createLabel(layer: HTMLDivElement) {
  const el = document.createElement("div");
  el.className =
    "absolute left-0 top-0 flex flex-col items-center whitespace-nowrap pointer-events-none select-none will-change-transform";
  const gesture = document.createElement("div");
  gesture.className = "mb-1 text-3xl leading-none";
  const name = document.createElement("div");
  name.className = "rounded-full bg-black/60 px-2 py-0.5 text-xs font-semibold text-white";
  const goal = document.createElement("div");
  goal.className = "mt-0.5 max-w-[160px] truncate rounded bg-white/85 px-1.5 text-[10px] text-slate-800";
  el.append(gesture, name, goal);
  layer.appendChild(el);
  return el;
}

function createRig(color: string, layer: HTMLDivElement): AvatarRig {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
  const skin = new THREE.MeshStandardMaterial({ color: "#ffe0bd", roughness: 0.8 });
  const dark = new THREE.MeshStandardMaterial({ color: "#1f2937", roughness: 0.7 });

  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.7, 20), mat);
  body.position.y = 0.85;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 24, 16), skin);
  head.position.y = 1.5;

  const eyeGeo = new THREE.SphereGeometry(0.04, 8, 8);
  const eyeL = new THREE.Mesh(eyeGeo, dark);
  eyeL.position.set(-0.1, 1.55, 0.27);
  const eyeR = new THREE.Mesh(eyeGeo, dark);
  eyeR.position.set(0.1, 1.55, 0.27);

  const legGeo = new THREE.BoxGeometry(0.16, 0.5, 0.16);
  legGeo.translate(0, -0.25, 0);
  const legL = new THREE.Mesh(legGeo, dark);
  legL.position.set(-0.13, 0.5, 0);
  const legR = new THREE.Mesh(legGeo, dark);
  legR.position.set(0.13, 0.5, 0);

  // 어깨를 회전축으로 두어 팔 전체가 자연스럽게 흔들리게 한다.
  const armGeo = new THREE.CapsuleGeometry(0.09, 0.32, 4, 8);
  armGeo.translate(0, -0.23, 0);
  const armL = new THREE.Mesh(armGeo, mat);
  armL.position.set(-0.4, 1.12, 0);
  const armR = new THREE.Mesh(armGeo, mat);
  armR.position.set(0.4, 1.12, 0);
  for (const arm of [armL, armR]) {
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 8), skin);
    hand.position.y = -0.48;
    hand.castShadow = true;
    arm.add(hand);
  }

  [body, head, legL, legR, armL, armR].forEach((m) => (m.castShadow = true));
  group.add(body, head, eyeL, eyeR, legL, legR, armL, armR);
  const ice = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.85, 0.95), new THREE.MeshStandardMaterial({ color: "#67e8f9", transparent: true, opacity: 0.45, roughness: 0.15 }));
  ice.name = "ice";
  ice.position.y = 0.9;
  ice.visible = false;
  const taggerRing = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.07, 8, 24), new THREE.MeshBasicMaterial({ color: "#fb4444" }));
  taggerRing.name = "tagger";
  taggerRing.rotation.x = Math.PI / 2;
  taggerRing.position.y = 0.08;
  taggerRing.visible = false;
  group.add(ice, taggerRing);

  return {
    group,
    legL,
    legR,
    armL,
    armR,
    label: createLabel(layer),
    labelSig: "",
    walkPhase: 0,
    initialized: false,
    cur: { x: 0, y: 0, z: 0, ry: 0 },
  };
}

function updateLabel(rig: AvatarRig, p: PeerState, gesture: string, isMe: boolean, badge = "") {
  const sig = `${gesture}|${p.avatar}|${p.name}|${p.status}|${p.goal}|${isMe}|${badge}`;
  if (sig === rig.labelSig) return;
  rig.labelSig = sig;
  rig.group.getObjectByName("ice")!.visible = badge.includes("얼음");
  rig.group.getObjectByName("tagger")!.visible = badge.includes("술래");
  const [g, n, goal] = Array.from(rig.label.children) as HTMLDivElement[];
  g.textContent = gesture;
  g.style.visibility = gesture ? "visible" : "hidden";
  n.textContent = `${badge ? badge + " · " : ""}${p.avatar} ${p.name}${isMe ? " (나)" : ""} · ${p.status === "coding" ? "💻" : "☕"}`;
  goal.textContent = p.goal;
  goal.style.display = p.goal ? "block" : "none";
}

/* =========================================================
 * 컴포넌트
 * ======================================================= */
export default function Page() {
  // ── 로비 입력 ──
  const [roomInput, setRoomInput] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [goalInput, setGoalInput] = useState("");
  const [avatar, setAvatar] = useState(AVATARS[0]);
  const [color, setColor] = useState(COLORS[0]);

  // ── 앱 상태 ──
  const [phase, setPhase] = useState<"lobby" | "room">("lobby");
  const [hostInfo, setHostInfo] = useState<HostInfo | null>(null);
  const [hostError, setHostError] = useState<string | null>(null);
  const [isHttps, setIsHttps] = useState(false);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [activeRoom, setActiveRoom] = useState("");
  const [peers, setPeers] = useState<Record<string, PeerState>>({});
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [status, setStatus] = useState<Status>("coding");
  const [seatIndex, setSeatIndex] = useState<number | null>(null);
  const [soundOn, setSoundOn] = useState(true);
  const [reconnectKey, setReconnectKey] = useState(0);
  const [myProfile, setMyProfile] = useState<PeerState>({ id: "", name: "", goal: "", avatar: AVATARS[0], color: COLORS[0], status: "coding", seatIndex: null, joinedAt: 0 });
  const [game, setGame] = useState<GameState>(EMPTY_GAME);
  const [stamina, setStamina] = useState(100);
  const gameRef = useRef<GameState>(EMPTY_GAME);
  const staminaRef = useRef(100);

  // ── refs ──
  const mountRef = useRef<HTMLDivElement | null>(null);
  const labelLayerRef = useRef<HTMLDivElement | null>(null);
  const chatBoxRef = useRef<HTMLDivElement | null>(null);
  const chatInputRef = useRef<HTMLInputElement | null>(null);

  const peersRef = useRef<Record<string, PeerState>>({});
  const myProfileRef = useRef<PeerState>({
    id: "",
    name: "",
    goal: "",
    avatar: AVATARS[0],
    color: COLORS[0],
    status: "coding",
    seatIndex: null,
    joinedAt: 0,
  });
  const sendRef = useRef<((msg: ClientMsg) => void) | null>(null);
  const remoteMovesRef = useRef<Record<string, MovePacket>>({});
  const gestureRef = useRef<Record<string, { emoji: string; until: number }>>({});
  const seatRef = useRef<number | null>(null);
  const statusRef = useRef<Status>("coding");
  const localRef = useRef<LocalPlayer>({ x: 0, y: 0, z: 6.2, ry: Math.PI, vy: 0, moving: false });
  const keysRef = useRef<Set<string>>(new Set());
  const jumpQueuedRef = useRef(false);
  const soundOnRef = useRef(true);
  const audioRef = useRef<AudioContext | null>(null);

  const wsPort = hostInfo?.wsPort ?? DEFAULT_WS_PORT;

  /* ── 공용 콜백 (ref/setter만 사용 → 항상 같은 함수) ── */
  const commitPeers = useCallback((next: Record<string, PeerState>) => {
    peersRef.current = next;
    setPeers(next);
  }, []);

  const pushMessage = useCallback((msg: Omit<ChatMessage, "id">) => {
    setMessages((prev) => [...prev, { ...msg, id: makeId() }].slice(-MAX_MESSAGES));
  }, []);

  const addSystemMessage = useCallback(
    (text: string) => pushMessage({ kind: "system", text }),
    [pushMessage]
  );

  const playChime = useCallback(() => {
    if (!soundOnRef.current) return;
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!audioRef.current) audioRef.current = new Ctx();
      const ctx = audioRef.current;
      if (ctx.state === "suspended") void ctx.resume();
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(587.33, t);
      osc.frequency.setValueAtTime(880, t + 0.09);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    } catch {
      /* 오디오 실패는 무시 */
    }
  }, []);

  const placeAtSeat = useCallback((idx: number) => {
    const t = getSeatTransform(idx);
    Object.assign(localRef.current, { x: t.x, z: t.z, ry: t.ry, y: 0, vy: 0 });
    seatRef.current = idx;
    setSeatIndex(idx);
  }, []);

  const standUp = useCallback(() => {
    const idx = seatRef.current;
    if (idx === null) return;
    const a = (idx / SEAT_COUNT) * Math.PI * 2;
    const r = SEAT_RADIUS + 0.9;
    Object.assign(localRef.current, { x: Math.sin(a) * r, z: Math.cos(a) * r, y: 0, vy: 0 });
    seatRef.current = null;
    setSeatIndex(null);
  }, []);

  const trySit = useCallback(
    (idx: number) => {
      if (gameRef.current.phase === "playing") return;
      const taken = Object.values(peersRef.current).some((p) => p.seatIndex === idx);
      if (taken) {
        addSystemMessage("이미 다른 동료가 앉아 있는 자리예요.");
        return;
      }
      placeAtSeat(idx); // 서버가 거절하면 seat-denied로 다시 일어남
    },
    [addSystemMessage, placeAtSeat]
  );

  const leaveRoom = useCallback(
    (reason?: string) => {
      if (reason) alert(reason);
      commitPeers({});
      remoteMovesRef.current = {};
      gestureRef.current = {};
      keysRef.current.clear();
      seatRef.current = null;
      setSeatIndex(null);
      setMessages([]);
      gameRef.current = EMPTY_GAME;
      setGame(EMPTY_GAME);
      setPhase("lobby");
    },
    [commitPeers]
  );

  const handleReconnect = useCallback(() => {
    addSystemMessage("🔄 서버에 다시 연결하는 중...");
    setReconnectKey((k) => k + 1);
  }, [addSystemMessage]);

  /* ── 1) 호스트 IP 정보 가져오기 ── */
  useEffect(() => {
    queueMicrotask(() => setIsHttps(window.location.protocol === "https:"));
    let alive = true;
    fetch("/__host-info", { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<HostInfo>;
      })
      .then((info) => {
        if (alive) setHostInfo(info);
      })
      .catch(() => {
        if (alive) {
          setHostError("호스트 서버 정보를 불러오지 못했어요. server.mjs(npm run dev / npm start)로 실행했는지 확인해 주세요.");
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  /* ── 2) 내 좌석/상태가 바뀌면 서버에 알림 ── */
  useEffect(() => {
    myProfileRef.current = { ...myProfileRef.current, seatIndex };
    sendRef.current?.({ t: "seat", seatIndex });
  }, [seatIndex]);

  useEffect(() => {
    myProfileRef.current = { ...myProfileRef.current, status };
    sendRef.current?.({ t: "status", status });
  }, [status]);

  /* ── 3) 채팅 자동 스크롤 ── */
  useEffect(() => {
    const box = chatBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [messages]);

  /* ── 4) 언마운트 시 오디오 정리 ── */
  useEffect(() => {
    return () => {
      void audioRef.current?.close().catch(() => {});
    };
  }, []);

  /* ── 5) WebSocket 연결 (끊기면 자동 재연결) ── */
  useEffect(() => {
    if (phase !== "room" || !activeRoom) return;

    let cancelled = false;
    let kicked = false;
    let everConnected = false;
    let retry = 0;
    let sock: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (cancelled) return;
      setConn("connecting");

      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${window.location.hostname}:${wsPort}`);
      sock = ws;

      const send = (msg: ClientMsg) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      };

      ws.onopen = () => {
        const me = myProfileRef.current;
        send({
          t: "join",
          room: activeRoom,
          profile: {
            name: me.name,
            goal: me.goal,
            avatar: me.avatar,
            color: me.color,
            status: statusRef.current,
            seatIndex: seatRef.current,
          },
        });
      };

      ws.onmessage = (ev) => {
        if (cancelled) return;
        let msg: ServerMsg;
        try {
          msg = JSON.parse(String(ev.data)) as ServerMsg;
        } catch {
          return;
        }

        switch (msg.t) {
          case "game": {
            const previous = gameRef.current;
            if (previous.hostId && previous.hostId !== msg.hostId) {
              const hostName = msg.hostId === myProfileRef.current.id ? myProfileRef.current.name : peersRef.current[msg.hostId]?.name ?? "동료";
              addSystemMessage(`👑 ${hostName}님이 방장이 되었어요.`);
            }
            const player = msg.players[myProfileRef.current.id];
            if (msg.phase === "playing" && msg.roundId !== previous.roundId) {
              seatRef.current = null;
              setSeatIndex(null);
              keysRef.current.clear();
              jumpQueuedRef.current = false;
              if (player) Object.assign(localRef.current, { x: player.x, y: 0, z: player.z, vy: 0 });
              staminaRef.current = 100;
              addSystemMessage("🧊 얼음땡 시작! Shift 달리기 · F 얼음 · G 땡");
            }
            if (msg.phase === "playing") {
              for (const [id, p] of Object.entries(msg.players)) {
                remoteMovesRef.current[id] = { sprinting: remoteMovesRef.current[id]?.sprinting, x: p.x, y: p.y, z: p.z, ry: remoteMovesRef.current[id]?.ry ?? 0, moving: p.state === "active" && (remoteMovesRef.current[id]?.moving ?? false) };
              }
              if (player) staminaRef.current = player.stamina;
            }
            if (msg.phase === "ended" && previous.phase === "playing") addSystemMessage(msg.result);
            gameRef.current = msg;
            setGame(msg);
            break;
          }
          case "position":
            Object.assign(localRef.current, { x: msg.x, y: msg.y, z: msg.z, vy: 0 });
            break;
          case "welcome": {
            myProfileRef.current = { ...myProfileRef.current, id: msg.id, joinedAt: msg.you.joinedAt };
            setMyProfile(myProfileRef.current);
            const map: Record<string, PeerState> = {};
            for (const p of msg.peers) map[p.id] = p;
            commitPeers(map);
            remoteMovesRef.current = {};

            if (msg.you.seatIndex !== seatRef.current) {
              if (msg.you.seatIndex === null) {
                standUp();
                addSystemMessage("앉아 있던 자리를 다른 동료가 쓰고 있어서 일어났어요.");
              } else {
                placeAtSeat(msg.you.seatIndex);
              }
            }

            sendRef.current = send;
            retry = 0;
            setConn("open");
            addSystemMessage(
              everConnected
                ? "서버에 다시 연결되었습니다."
                : `서버에 연결되었습니다. 현재 ${msg.peers.length + 1}명이 있어요.`
            );
            everConnected = true;
            break;
          }

          case "full":
            kicked = true;
            leaveRoom(`현재 이 모각코룸의 최대 인원(${msg.max}명)이 모두 찼습니다. 다른 룸 이름을 입력해 주세요!`);
            break;

          case "peer-join":
            commitPeers({ ...peersRef.current, [msg.peer.id]: msg.peer });
            addSystemMessage(`${msg.peer.avatar} ${msg.peer.name}님이 모각코룸에 들어왔습니다.`);
            playChime();
            break;

          case "peer-leave": {
            const leaving = peersRef.current[msg.id];
            delete remoteMovesRef.current[msg.id];
            delete gestureRef.current[msg.id];
            if (!leaving) break;
            const next = { ...peersRef.current };
            delete next[msg.id];
            commitPeers(next);
            addSystemMessage(`${leaving.avatar} ${leaving.name}님이 모각코룸에서 나갔습니다.`);
            break;
          }

          case "peer-update":
            if (msg.peer.id === myProfileRef.current.id) {
              myProfileRef.current = msg.peer;
              setMyProfile(msg.peer);
              seatRef.current = msg.peer.seatIndex;
              setSeatIndex(msg.peer.seatIndex);
              break;
            }
            if (!peersRef.current[msg.peer.id]) break;
            commitPeers({ ...peersRef.current, [msg.peer.id]: msg.peer });
            break;

          case "seat-denied":
            if (seatRef.current === msg.seatIndex) {
              standUp();
              addSystemMessage("간발의 차로 다른 동료가 먼저 앉았어요.");
            }
            break;

          case "move":
            remoteMovesRef.current[msg.id] = {
              sprinting: msg.sprinting,
              x: msg.x,
              y: msg.y,
              z: msg.z,
              ry: msg.ry,
              moving: msg.moving,
            };
            break;

          case "chat": {
            const p = peersRef.current[msg.id];
            pushMessage({
              kind: "chat",
              text: msg.text,
              name: p?.name ?? "동료",
              avatar: p?.avatar ?? "👤",
              color: p?.color ?? "#94a3b8",
            });
            playChime();
            break;
          }

          case "gesture":
            gestureRef.current[msg.id] = { emoji: msg.emoji, until: Date.now() + GESTURE_MS };
            break;
        }
      };

      ws.onclose = () => {
        if (sock === ws) sock = null;
        sendRef.current = null;
        if (cancelled || kicked) return;

        setConn("closed");
        gameRef.current = EMPTY_GAME;
        setGame(EMPTY_GAME);
        commitPeers({});
        remoteMovesRef.current = {};

        if (retry === 0) {
          addSystemMessage(
            everConnected
              ? "서버와 연결이 끊겼습니다. 다시 연결하는 중..."
              : "서버에 연결할 수 없어요. 호스트 PC에서 server.mjs가 켜져 있는지, 방화벽에서 3001 포트가 허용됐는지 확인해 주세요."
          );
        }
        const delay = Math.min(1000 * 2 ** retry, 10000);
        retry += 1;
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      sendRef.current = null;
      if (sock) {
        sock.onclose = null;
        sock.close();
        sock = null;
      }
    };
  }, [
    phase,
    activeRoom,
    wsPort,
    reconnectKey,
    addSystemMessage,
    commitPeers,
    leaveRoom,
    placeAtSeat,
    playChime,
    pushMessage,
    standUp,
  ]);

  /* ── 6) 3D 월드 ── */
  useEffect(() => {
    if (phase !== "room") return;
    const mount = mountRef.current;
    const labelLayer = labelLayerRef.current;
    if (!mount || !labelLayer) return;

    let width = Math.max(1, mount.clientWidth);
    let height = Math.max(1, mount.clientHeight);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#1e1b2e");
    scene.fog = new THREE.Fog("#1e1b2e", 16, 32);

    const me0 = localRef.current;
    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 100);
    camera.position.set(me0.x, 6, me0.z + 7);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = 3;
    controls.maxDistance = 18;
    controls.maxPolarAngle = Math.PI * 0.47;
    controls.target.set(me0.x, 1, me0.z);
    controls.update();

    // 조명
    scene.add(new THREE.HemisphereLight("#ffffff", "#3b3355", 0.9));
    const sun = new THREE.DirectionalLight("#ffffff", 1.4);
    sun.position.set(6, 12, 5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 1, far: 30 });
    scene.add(sun);

    // 바닥/벽
    const size = ROOM_BOUNDARY * 2 + 2;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({ color: "#3a3450", roughness: 0.9 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    const grid = new THREE.GridHelper(size, 18, "#5b5280", "#4a4366");
    grid.position.y = 0.01;
    scene.add(grid);

    const wallMat = new THREE.MeshStandardMaterial({ color: "#2b2640" });
    const walls: Array<[number, number, number]> = [
      [0, -size / 2, 0],
      [0, size / 2, 0],
      [-size / 2, 0, Math.PI / 2],
      [size / 2, 0, Math.PI / 2],
    ];
    for (const [x, z, ry] of walls) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(size, 1.2, 0.2), wallMat);
      wall.position.set(x, 0.6, z);
      wall.rotation.y = ry;
      wall.receiveShadow = true;
      scene.add(wall);
    }

    // 테이블
    const table = new THREE.Mesh(
      new THREE.CylinderGeometry(TABLE_RADIUS, TABLE_RADIUS, 0.12, 48),
      new THREE.MeshStandardMaterial({ color: "#8b5e3c", roughness: 0.7 })
    );
    table.position.y = 0.78;
    table.castShadow = true;
    table.receiveShadow = true;
    scene.add(table);
    const tableLeg = new THREE.Mesh(
      new THREE.CylinderGeometry(0.25, 0.4, 0.78, 16),
      new THREE.MeshStandardMaterial({ color: "#5a3d28" })
    );
    tableLeg.position.y = 0.39;
    scene.add(tableLeg);

    // 의자 + 노트북 스테이션
    type Station = {
      ring: THREE.Mesh;
      ringMat: THREE.MeshBasicMaterial;
      light: THREE.PointLight;
      screenMat: THREE.MeshStandardMaterial;
    };
    const stations: Station[] = [];
    const clickables: THREE.Object3D[] = [];
    const chairMat = new THREE.MeshStandardMaterial({ color: "#475569", roughness: 0.6 });
    const laptopMat = new THREE.MeshStandardMaterial({ color: "#cbd5e1", metalness: 0.3, roughness: 0.4 });
    const mugMat = new THREE.MeshStandardMaterial({ color: "#f8fafc" });

    for (let i = 0; i < SEAT_COUNT; i++) {
      const t = getSeatTransform(i);
      const a = (i / SEAT_COUNT) * Math.PI * 2;

      const chair = new THREE.Group();
      chair.position.set(t.x, 0, t.z);
      chair.rotation.y = t.ry;
      const seat = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.1, 0.8), chairMat);
      seat.position.y = 0.45;
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.1), chairMat);
      back.position.set(0, 0.85, -0.4);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.45, 8), chairMat);
      post.position.y = 0.22;
      [seat, back].forEach((m) => {
        m.castShadow = true;
        m.userData.seatIndex = i;
        clickables.push(m);
      });
      chair.add(seat, back, post);
      scene.add(chair);

      const ringMat = new THREE.MeshBasicMaterial({
        color: "#a5f3fc",
        transparent: true,
        opacity: 0.6,
        side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.62, 32), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(t.x, 0.02, t.z);
      scene.add(ring);

      const lr = TABLE_RADIUS - 0.45;
      const laptop = new THREE.Group();
      laptop.position.set(Math.sin(a) * lr, 0.85, Math.cos(a) * lr);
      laptop.rotation.y = t.ry;
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.03, 0.4), laptopMat);
      const screenMat = new THREE.MeshStandardMaterial({
        color: "#111827",
        emissive: new THREE.Color("#60a5fa"),
        emissiveIntensity: 0,
      });
      const screen = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.4, 0.03), screenMat);
      screen.position.set(0, 0.2, 0.2);
      screen.rotation.x = 0.2;
      const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.06, 0.14, 12), mugMat);
      mug.position.set(0.45, 0.07, 0);
      base.castShadow = true;
      laptop.add(base, screen, mug);
      scene.add(laptop);

      // 셰이더 재컴파일 방지: 라이트는 항상 씬에 두고 intensity만 조절
      const light = new THREE.PointLight("#93c5fd", 0, 2.5);
      light.position.set(Math.sin(a) * (lr + 0.3), 1.2, Math.cos(a) * (lr + 0.3));
      scene.add(light);

      stations.push({ ring, ringMat, light, screenMat });
    }

    // 아바타
    const rigs = new Map<string, AvatarRig>();
    const localRig = createRig(myProfileRef.current.color, labelLayer);
    scene.add(localRig.group);
    rigs.set(SELF_KEY, localRig);

    const removeRig = (id: string) => {
      const rig = rigs.get(id);
      if (!rig) return;
      scene.remove(rig.group);
      disposeObject(rig.group);
      rig.label.remove();
      rigs.delete(id);
    };

    const applyPose = (rig: AvatarRig, moving: boolean, seated: boolean, bounce: number, dt: number, sprinting = false, frozen = false, coding = false) => {
      rig.group.position.set(rig.cur.x, rig.cur.y + bounce, rig.cur.z);
      rig.group.rotation.y = rig.cur.ry;
      let armSwing = 0;
      if (seated) {
        rig.legL.rotation.x = -Math.PI / 2;
        rig.legR.rotation.x = -Math.PI / 2;
        if (coding && !frozen) {
          rig.walkPhase += dt * 12;
          armSwing = Math.sin(rig.walkPhase) * 0.13;
        }
      } else if (moving && rig.cur.y < 0.01) {
        rig.walkPhase += dt * (sprinting ? 15 : 10);
        const s = Math.sin(rig.walkPhase) * 0.6;
        rig.legL.rotation.x = s;
        rig.legR.rotation.x = -s;
        armSwing = Math.sin(rig.walkPhase) * (sprinting ? 0.95 : 0.55);
      } else {
        rig.legL.rotation.x *= 0.8;
        rig.legR.rotation.x *= 0.8;
      }
      const blend = frozen ? 1 : 1 - Math.exp(-18 * dt);
      const restAngle = seated ? (coding ? -1.15 : -0.65) : 0;
      rig.armL.rotation.x += (restAngle - armSwing - rig.armL.rotation.x) * blend;
      rig.armR.rotation.x += (restAngle + armSwing - rig.armR.rotation.x) * blend;
      rig.armL.rotation.z = -0.1;
      rig.armR.rotation.z = 0.1;
    };

    // 입력
    const interact = () => {
      if (seatRef.current !== null) {
        standUp();
        return;
      }
      const me = localRef.current;
      const taken = new Set(Object.values(peersRef.current).map((p) => p.seatIndex));
      let best = -1;
      let bestDist = SIT_DISTANCE;
      for (let i = 0; i < SEAT_COUNT; i++) {
        if (taken.has(i)) continue;
        const t = getSeatTransform(i);
        const d = Math.hypot(t.x - me.x, t.z - me.z);
        if (d <= bestDist) {
          best = i;
          bestDist = d;
        }
      }
      if (best >= 0) trySit(best);
    };

    const MOVE_KEYS = ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || isTypingTarget(e.target)) return;
      if (e.code === "Enter" || e.code === "NumpadEnter") {
        e.preventDefault();
        if (!e.repeat) {
          keysRef.current.clear();
          jumpQueuedRef.current = false;
          chatInputRef.current?.focus();
        }
        return;
      }
      if ((e.code === "KeyF" || e.code === "KeyG") && !e.repeat) {
        sendRef.current?.({ t: e.code === "KeyF" ? "freeze" : "rescue" });
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        if (!e.repeat) jumpQueuedRef.current = true;
        return;
      }
      if (e.code === "KeyE") {
        if (!e.repeat) interact();
        return;
      }
      if (MOVE_KEYS.includes(e.code) || e.code === "ShiftLeft" || e.code === "ShiftRight") {
        e.preventDefault();
        keysRef.current.add(e.code);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => keysRef.current.delete(e.code);
    const onBlur = () => keysRef.current.clear();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    // 의자 클릭 (드래그 6px 이하일 때만)
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let down: { x: number; y: number } | null = null;
    const onPointerDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 6) return;
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObjects(clickables, false)[0];
      if (!hit) return;
      const idx = hit.object.userData.seatIndex as number;
      if (seatRef.current !== idx) trySit(idx);
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);

    // 리사이즈
    const ro = new ResizeObserver(() => {
      width = Math.max(1, mount.clientWidth);
      height = Math.max(1, mount.clientHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    });
    ro.observe(mount);

    // 렌더 루프
    const fwd = new THREE.Vector3();
    const followDelta = new THREE.Vector3();
    const proj = new THREE.Vector3();
    let raf = 0;
    let last = performance.now();
    let lastSend = 0;
    let lastHeartbeat = 0;
    let lastSentKey = "";

    const placeLabel = (rig: AvatarRig) => {
      proj.set(rig.group.position.x, rig.group.position.y + 2.05, rig.group.position.z).project(camera);
      if (proj.z > 1) {
        rig.label.style.display = "none";
        return;
      }
      rig.label.style.display = "";
      const sx = (proj.x * 0.5 + 0.5) * width;
      const sy = (-proj.y * 0.5 + 0.5) * height;
      rig.label.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -100%)`;
    };

    const animate = (now: number) => {
      raf = requestAnimationFrame(animate);
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const wall = Date.now();
      const me = localRef.current;
      const smooth = 1 - Math.exp(-12 * dt);

      // ─ 로컬 이동 ─
      const k = keysRef.current;
      let ix = 0;
      let iz = 0;
      if (k.has("KeyW") || k.has("ArrowUp")) iz += 1;
      if (k.has("KeyS") || k.has("ArrowDown")) iz -= 1;
      if (k.has("KeyD") || k.has("ArrowRight")) ix += 1;
      if (k.has("KeyA") || k.has("ArrowLeft")) ix -= 1;
      const currentGame = gameRef.current;
      const gp = currentGame.players[myProfileRef.current.id];
      const blocked = currentGame.phase === "playing" && (!gp || gp.state !== "active");
      if (blocked) {
        ix = 0; iz = 0;
        jumpQueuedRef.current = false;
        if (gp) Object.assign(me, { x: gp.x, z: gp.z, y: 0, vy: 0 });
      }
      const moving = ix !== 0 || iz !== 0;
      const sprinting = moving && (k.has("ShiftLeft") || k.has("ShiftRight")) && staminaRef.current > 1;
      staminaRef.current = clamp(staminaRef.current + (sprinting ? -20 : 14) * dt, 0, 100);
      setStamina(prev => Math.abs(prev - staminaRef.current) >= 1 ? Math.round(staminaRef.current) : prev);
      const speed = sprinting ? WALK_SPEED * 1.6 : WALK_SPEED;

      if (moving && seatRef.current !== null) standUp();

      if (moving) {
        camera.getWorldDirection(fwd);
        fwd.y = 0;
        fwd.normalize();
        const rx = -fwd.z;
        const rz = fwd.x;
        let dx = fwd.x * iz + rx * ix;
        let dz = fwd.z * iz + rz * ix;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len;
        dz /= len;
        let nx = me.x + dx * speed * dt;
        let nz = me.z + dz * speed * dt;
        const r = Math.hypot(nx, nz);
        if (r < TABLE_COLLISION_RADIUS) {
          if (r < 0.001) {
            nz = TABLE_COLLISION_RADIUS;
          } else {
            nx *= TABLE_COLLISION_RADIUS / r;
            nz *= TABLE_COLLISION_RADIUS / r;
          }
        }
        me.x = clamp(nx, -ROOM_BOUNDARY, ROOM_BOUNDARY);
        me.z = clamp(nz, -ROOM_BOUNDARY, ROOM_BOUNDARY);
        me.ry = wrapAngle(lerpAngle(me.ry, Math.atan2(dx, dz), 1 - Math.exp(-14 * dt)));
      }

      if (jumpQueuedRef.current) {
        jumpQueuedRef.current = false;
        if (!blocked && me.y <= 0.0001 && seatRef.current === null) me.vy = JUMP_VEL;
      }
      if (me.y > 0 || me.vy > 0) {
        me.vy -= GRAVITY * dt;
        me.y = Math.max(0, me.y + me.vy * dt);
        if (me.y === 0) me.vy = 0;
      }
      me.moving = moving;

      // ─ 로컬 아바타 ─
      const myProfile: PeerState = {
        ...myProfileRef.current,
        status: statusRef.current,
        seatIndex: seatRef.current,
      };
      const myGesture = gestureRef.current[SELF_KEY];
      const myGestureOn = !!myGesture && myGesture.until > wall;
      localRig.cur = { x: me.x, y: me.y, z: me.z, ry: me.ry };
      applyPose(
        localRig,
        moving,
        seatRef.current !== null,
        myGestureOn ? Math.abs(Math.sin(now * 0.012)) * 0.25 : 0,
        dt,
        sprinting,
        blocked,
        myProfile.status === "coding"
      );
      updateLabel(localRig, myProfile, myGestureOn ? myGesture.emoji : "", true, gameBadge(currentGame, myProfile.id));
      placeLabel(localRig);

      // ─ 원격 아바타 생성/삭제 ─
      const peerMap = peersRef.current;
      for (const id of Object.keys(peerMap)) {
        if (!rigs.has(id)) {
          const rig = createRig(peerMap[id].color, labelLayer);
          scene.add(rig.group);
          rigs.set(id, rig);
        }
      }
      for (const id of Array.from(rigs.keys())) {
        if (id !== SELF_KEY && !peerMap[id]) removeRig(id);
      }

      // ─ 원격 아바타 보간 ─
      for (const [id, rig] of rigs) {
        if (id === SELF_KEY) continue;
        const p = peerMap[id];
        const pm = remoteMovesRef.current[id];
        let tx: number, ty: number, tz: number, tr: number;
        let mv = false;
        const seated = p.seatIndex !== null;
        if (seated) {
          const t = getSeatTransform(p.seatIndex as number);
          tx = t.x;
          ty = 0;
          tz = t.z;
          tr = t.ry;
        } else if (pm) {
          tx = pm.x;
          ty = pm.y;
          tz = pm.z;
          tr = pm.ry;
          mv = pm.moving;
        } else {
          rig.group.visible = false;
          rig.label.style.display = "none";
          continue;
        }
        rig.group.visible = true;
        if (!rig.initialized) {
          rig.cur = { x: tx, y: ty, z: tz, ry: tr };
          rig.initialized = true;
        } else {
          rig.cur.x += (tx - rig.cur.x) * smooth;
          rig.cur.y += (ty - rig.cur.y) * smooth;
          rig.cur.z += (tz - rig.cur.z) * smooth;
          rig.cur.ry = lerpAngle(rig.cur.ry, tr, smooth);
        }
        const g = gestureRef.current[id];
        const gOn = !!g && g.until > wall;
        applyPose(rig, mv, seated, gOn ? Math.abs(Math.sin(now * 0.012)) * 0.25 : 0, dt, pm?.sprinting, currentGame.phase === "playing" && currentGame.players[id]?.state !== "active", p.status === "coding");
        updateLabel(rig, p, gOn ? g.emoji : "", false, gameBadge(currentGame, id));
        placeLabel(rig);
      }

      // ─ 좌석/노트북 표시 ─
      const occupant: (PeerState | null)[] = Array(SEAT_COUNT).fill(null);
      for (const p of Object.values(peerMap)) if (p.seatIndex !== null) occupant[p.seatIndex] = p;
      if (seatRef.current !== null) occupant[seatRef.current] = myProfile;
      const pulse = 0.35 + 0.25 * Math.sin(now * 0.004);
      stations.forEach((s, i) => {
        const o = occupant[i];
        s.ring.visible = !o;
        s.ringMat.opacity = pulse;
        const target = o && o.status === "coding" ? 1.6 : 0;
        s.light.intensity += (target - s.light.intensity) * smooth;
        s.screenMat.emissiveIntensity = s.light.intensity * 0.6;
      });

      // ─ 카메라 따라가기 ─
      followDelta
        .set(me.x, 1 + me.y * 0.5, me.z)
        .sub(controls.target)
        .multiplyScalar(1 - Math.exp(-10 * dt));
      camera.position.add(followDelta);
      controls.target.add(followDelta);
      controls.update();

      // ─ 이동 전송 (~15Hz, 변화 없으면 1초 하트비트) ─
      if (now - lastSend > MOVE_SEND_INTERVAL) {
        lastSend = now;
        const pkt: MovePacket = {
          x: round2(me.x),
          y: round2(me.y),
          z: round2(me.z),
          ry: round2(wrapAngle(me.ry)),
          moving,
          sprinting,
        };
        const key = `${pkt.x},${pkt.y},${pkt.z},${pkt.ry},${moving},${sprinting}`;
        if (key !== lastSentKey || now - lastHeartbeat > (currentGame.phase === "playing" ? MOVE_SEND_INTERVAL : 1000)) {
          sendRef.current?.({ t: "move", ...pkt });
          lastSentKey = key;
          lastHeartbeat = now;
        }
      }

      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      controls.dispose();
      for (const id of Array.from(rigs.keys())) removeRig(id);
      disposeObject(scene);
      renderer.dispose();
      renderer.domElement.remove();
      labelLayer.innerHTML = "";
    };
  }, [phase, standUp, trySit]);

  /* ── 핸들러 ── */
  const handleEnter = () => {
    const roomName = roomInput.trim().slice(0, 40) || "모각코";
    myProfileRef.current = {
      id: "",
      name: nameInput.trim().slice(0, 12) || "익명",
      goal: goalInput.trim().slice(0, 28),
      avatar,
      color,
      status: "coding",
      seatIndex: null,
      joinedAt: 0,
    };
    setMyProfile(myProfileRef.current);
    statusRef.current = "coding";
    setStatus("coding");
    seatRef.current = null;
    setSeatIndex(null);
    localRef.current = { x: 0, y: 0, z: 6.2, ry: Math.PI, vy: 0, moving: false };
    commitPeers({});
    remoteMovesRef.current = {};
    gestureRef.current = {};
    gameRef.current = EMPTY_GAME;
    setGame(EMPTY_GAME);
    staminaRef.current = 100;
    setStamina(100);
    setActiveRoom(roomName);
    setMessages([
      {
        id: makeId(),
        kind: "system",
        text: `'${roomName}' 방에 입장했습니다. 의자를 클릭하거나 가까이 가서 E를 눌러 앉아보세요.`,
      },
    ]);
    setPhase("room");
  };

  const handleSendChat = () => {
    const text = chatInput.trim().slice(0, MAX_CHAT_LEN);
    if (!text) return;
    if (!sendRef.current) {
      addSystemMessage("서버와 연결되어 있지 않아 메시지를 보내지 못했어요.");
      return;
    }
    sendRef.current({ t: "chat", text });
    const me = myProfileRef.current;
    pushMessage({ kind: "chat", text, name: me.name, avatar: me.avatar, color: me.color, mine: true });
    setChatInput("");
  };

  const handleGesture = useCallback((emoji: string) => {
    gestureRef.current[SELF_KEY] = { emoji, until: Date.now() + GESTURE_MS };
    sendRef.current?.({ t: "gesture", emoji });
  }, []);

  const toggleStatus = () => {
    const next: Status = statusRef.current === "coding" ? "resting" : "coding";
    statusRef.current = next;
    setStatus(next);
  };

  const toggleSound = () => {
    const next = !soundOnRef.current;
    soundOnRef.current = next;
    setSoundOn(next);
  };

  const peerList = Object.values(peers);
  const peerCount = peerList.length;

  /* =========================================================
   * 렌더: 로비
   * ======================================================= */
  if (phase === "lobby") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 p-4 text-white">
        <div className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-900/80 p-6 shadow-2xl">
          <h1 className="text-2xl font-bold">모각코룸 3D</h1>
          <p className="mt-1 text-sm text-slate-400">같은 사내망에서 호스트 주소로 접속한 동료와 함께해요.</p>

          {/* 호스트 접속 주소 */}
          <div className="mt-5 rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-3 text-sm">
            <p className="text-xs text-indigo-300">동료에게 알려줄 접속 주소</p>
            {hostInfo ? (
              hostInfo.ips.length > 0 ? (
                hostInfo.ips.map((ip) => (
                  <p key={ip} className="mt-1 select-all font-mono text-base font-semibold">
                    http://{ip}:{hostInfo.port}
                  </p>
                ))
              ) : (
                <p className="mt-1 text-amber-300">LAN IP를 찾지 못했어요. 네트워크 연결을 확인해 주세요.</p>
              )
            ) : hostError ? (
              <p className="mt-1 text-red-400">{hostError}</p>
            ) : (
              <p className="mt-1 text-slate-400">확인 중...</p>
            )}
            <p className="mt-2 text-[11px] text-slate-400">
              같은 Wi-Fi/사내망이어야 하고, 호스트 PC에서 서버가 켜져 있어야 해요.
            </p>
            {isHttps && (
              <p className="mt-2 text-[11px] text-red-400">
                https 배포 페이지에서는 사용할 수 없어요. 위의 http 주소로 접속해 주세요.
              </p>
            )}
          </div>

          <div className="mt-5 space-y-4">
            <label className="block">
              <span className="text-xs text-slate-400">방 이름</span>
              <input
                className="mt-1 w-full rounded-lg bg-slate-800 px-3 py-2 outline-none ring-indigo-500 focus:ring-2"
                placeholder="예: frontend-team"
                maxLength={40}
                value={roomInput}
                onChange={(e) => setRoomInput(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-400">닉네임 (12자)</span>
              <input
                className="mt-1 w-full rounded-lg bg-slate-800 px-3 py-2 outline-none ring-indigo-500 focus:ring-2"
                maxLength={12}
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-400">오늘의 목표 (28자)</span>
              <input
                className="mt-1 w-full rounded-lg bg-slate-800 px-3 py-2 outline-none ring-indigo-500 focus:ring-2"
                maxLength={28}
                value={goalInput}
                onChange={(e) => setGoalInput(e.target.value)}
              />
            </label>

            <div>
              <span className="text-xs text-slate-400">아바타</span>
              <div className="mt-1 grid grid-cols-8 gap-1">
                {AVATARS.map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => setAvatar(a)}
                    className={`rounded-lg py-1 text-2xl ${avatar === a ? "bg-indigo-600" : "bg-slate-800 hover:bg-slate-700"}`}
                  >
                    {a}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className="text-xs text-slate-400">컬러</span>
              <div className="mt-1 flex gap-2">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    className={`h-8 w-8 rounded-full ${color === c ? "ring-2 ring-white ring-offset-2 ring-offset-slate-900" : ""}`}
                    style={{ backgroundColor: c }}
                    aria-label={c}
                  />
                ))}
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={handleEnter}
            disabled={!hostInfo && !hostError}
            className="mt-6 w-full rounded-xl bg-indigo-600 py-3 font-semibold hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-700"
          >
            {hostInfo || hostError ? "입장하기" : "서버 확인 중..."}
          </button>
        </div>
      </main>
    );
  }

  /* =========================================================
   * 렌더: 룸
   * ======================================================= */
  return (
    <main className="flex h-screen w-full overflow-hidden bg-slate-950 text-white">
      {/* 3D 영역 */}
      <section className="relative flex-1">
        <div
          ref={mountRef}
          tabIndex={-1}
          role="region"
          aria-label="3D 방 · WASD 이동 · Enter 채팅"
          onPointerDown={() => mountRef.current?.focus({ preventScroll: true })}
          className="absolute inset-0 outline-none"
        />
        <div ref={labelLayerRef} className="pointer-events-none absolute inset-0 overflow-hidden" />

        {/* HUD 상단 */}
        <div className="absolute left-3 top-3 flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-black/60 px-3 py-1 text-sm font-semibold"># {activeRoom}</span>
          {conn === "open" ? (
            <span className="flex items-center gap-1 rounded-full bg-emerald-600/80 px-3 py-1 text-xs font-semibold">
              <Users size={14} /> {peerCount > 0 ? `연결됨 · ${peerCount + 1}명` : "연결됨 · 혼자 있어요"}
            </span>
          ) : conn === "connecting" ? (
            <span className="rounded-full bg-amber-500/80 px-3 py-1 text-xs font-semibold text-black">서버 연결 중...</span>
          ) : (
            <span className="rounded-full bg-red-600/80 px-3 py-1 text-xs font-semibold">연결 끊김 · 재연결 중</span>
          )}
          <button
            type="button"
            onClick={handleReconnect}
            className="flex items-center gap-1 rounded-full bg-black/60 px-3 py-1 text-xs hover:bg-black/80"
            title="서버 재연결"
          >
            <RefreshCw size={14} /> 재연결
          </button>
          <button
            type="button"
            onClick={toggleSound}
            className="rounded-full bg-black/60 p-1.5 hover:bg-black/80"
            title="알림음"
          >
            {soundOn ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </button>
          <button
            type="button"
            onClick={() => leaveRoom()}
            className="flex items-center gap-1 rounded-full bg-red-600/80 px-3 py-1 text-xs hover:bg-red-600"
          >
            <LogOut size={14} /> 나가기
          </button>
        </div>

        {/* 얼음땡 HUD */}
        <div className="absolute right-3 top-16 w-60 rounded-2xl border border-cyan-300/20 bg-slate-950/90 p-4 shadow-xl">
          <p className="font-bold text-cyan-200">🧊 얼음땡 <span className="float-right tabular-nums">{game.phase === "playing" ? `${Math.max(0, Math.ceil((game.endsAt - game.serverNow) / 1000))}초` : "60초"}</span></p>
          {game.phase === "playing" ? <>
            <p className="mt-2 text-sm">{gameBadge(game, myProfile.id)}</p>
            <p className="mt-1 text-xs text-slate-300">술래: {game.taggerId === myProfile.id ? myProfile.name : peers[game.taggerId ?? ""]?.name ?? "동료"}</p>
            <p className="mt-1 text-xs text-slate-300">생존 {Object.entries(game.players).filter(([id, p]) => id !== game.taggerId && p.state !== "out").length}명 · 얼음 {Object.values(game.players).filter(p => p.state === "frozen").length}명</p>
            <div className="mt-3 flex gap-2">
              <button type="button" disabled={conn !== "open" || game.taggerId === myProfile.id || game.players[myProfile.id]?.state !== "active"} onClick={() => sendRef.current?.({ t: "freeze" })} className="flex-1 rounded-lg bg-cyan-800 p-2 text-xs disabled:opacity-40">🧊 얼음 F</button>
              <button type="button" disabled={conn !== "open" || game.taggerId === myProfile.id || game.players[myProfile.id]?.state !== "active"} onClick={() => sendRef.current?.({ t: "rescue" })} className="flex-1 rounded-lg bg-indigo-700 p-2 text-xs disabled:opacity-40">✨ 땡 G</button>
            </div>
          </> : <>
            {game.result && <p role="status" className="mt-2 text-sm text-amber-200">{game.result}</p>}
            {game.taggerId && <p className="mt-2 text-xs text-red-300">추첨된 술래: {game.taggerId === myProfile.id ? myProfile.name : peers[game.taggerId]?.name ?? "동료"}</p>}
            {game.hostId === myProfile.id && conn === "open" ? <div className="mt-3 flex flex-col gap-2">
              <button type="button" disabled={peerCount < 1} onClick={() => sendRef.current?.({ t: "game-start" })} className="rounded-lg bg-cyan-600 py-2 text-sm font-bold disabled:opacity-40">얼음땡 시작 · 자동 추첨</button>
              <button type="button" disabled={peerCount < 1} onClick={() => sendRef.current?.({ t: "game-random" })} className="rounded-lg bg-white/10 py-2 text-xs disabled:opacity-40">🎲 술래 랜덤 배정</button>
            </div> : <p className="mt-3 text-xs text-slate-300">방장이 게임을 시작할 수 있어요.</p>}
            {peerCount < 1 && <p className="mt-2 text-xs text-slate-400">2명 이상 모이면 시작해요.</p>}
          </>}
          <p className="mt-3 text-[11px] text-slate-400">F 얼음 · 가까운 동료에게 G 땡<br />얼음은 무적 · 전원 얼음/탈락 시 술래 승리</p>
        </div>

        {/* HUD 하단 */}
        <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2">
          <div className="w-48 rounded-xl bg-black/70 px-3 py-2">
            <div className="mb-1 flex justify-between text-[11px] text-cyan-100"><span>⚡ 스태미너</span><span>{stamina}%</span></div>
            <div role="progressbar" aria-label="스태미너" aria-valuenow={stamina} aria-valuemin={0} aria-valuemax={100} className="h-2 overflow-hidden rounded-full bg-white/15"><div className="h-full rounded-full bg-cyan-400" style={{ width: `${stamina}%` }} /></div>
          </div>
          <div className="flex gap-1 rounded-full bg-black/60 p-1">
            {GESTURES.map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => handleGesture(g)}
                className="rounded-full px-2 py-1 text-xl hover:bg-white/20"
              >
                {g}
              </button>
            ))}
            <button
              type="button"
              onClick={toggleStatus}
              className="ml-1 rounded-full bg-white/10 px-3 text-xs font-semibold hover:bg-white/20"
            >
              {status === "coding" ? "💻 코딩 중" : "☕ 휴식 중"}
            </button>
          </div>
          <p className="rounded bg-black/50 px-2 py-1 text-[11px] text-slate-300">
            WASD/방향키 이동 · Shift 달리기 · F 얼음 / G 땡 · Space 점프 · E 앉기/일어나기 · Enter 채팅/빈 입력에서 복귀 · 의자 클릭 착석 · 드래그로 시점 회전
            {seatIndex !== null && ` · ${seatIndex + 1}번 자리`}
          </p>
        </div>
      </section>

      {/* 사이드: 참여자 + 채팅 */}
      <aside className="flex w-80 flex-col border-l border-white/10 bg-slate-900">
        <div className="border-b border-white/10 p-3">
          <p className="mb-2 text-xs text-slate-400">
            참여자 {peerCount + 1}/{MAX_PLAYERS}
          </p>
          <ul className="space-y-1 text-sm">
            <li className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: myProfile.color }} />
              {myProfile.avatar} {myProfile.name} (나) {game.hostId === myProfile.id ? "👑" : ""} {gameBadge(game, myProfile.id)}
              <span className="ml-auto text-xs">{status === "coding" ? "💻" : "☕"}</span>
            </li>
            {peerList.map((p) => (
              <li key={p.id} className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
                {p.avatar} {p.name} {game.hostId === p.id ? "👑" : ""} {gameBadge(game, p.id)}
                {game.hostId === myProfile.id && conn === "open" && (
                  <button
                    type="button"
                    onClick={() => sendRef.current?.({ t: "host-transfer", targetId: p.id })}
                    className="shrink-0 rounded-md bg-amber-400/10 px-2 py-1 text-[11px] text-amber-200 hover:bg-amber-400/20"
                    aria-label={`${p.name}님에게 방장 넘기기`}
                  >
                    👑 넘기기
                  </button>
                )}
                <span className="ml-auto text-xs">{p.status === "coding" ? "💻" : "☕"}</span>
              </li>
            ))}
          </ul>
        </div>

        <div ref={chatBoxRef} className="flex-1 space-y-2 overflow-y-auto p-3 text-sm">
          {messages.map((m) =>
            m.kind === "system" ? (
              <p key={m.id} className="text-center text-xs text-slate-400">
                {m.text}
              </p>
            ) : (
              <div key={m.id} className={`flex flex-col ${m.mine ? "items-end" : "items-start"}`}>
                <span className="text-[11px]" style={{ color: m.color }}>
                  {m.avatar} {m.name}
                </span>
                <span
                  className={`max-w-[85%] whitespace-pre-wrap break-words rounded-xl px-3 py-1.5 ${
                    m.mine ? "bg-indigo-600" : "bg-slate-800"
                  }`}
                >
                  {m.text}
                </span>
              </div>
            )
          )}
        </div>

        <div className="flex gap-2 border-t border-white/10 p-3">
          <input
            ref={chatInputRef}
            className="flex-1 rounded-lg bg-slate-800 px-3 py-2 text-sm outline-none ring-indigo-500 focus:ring-2"
            placeholder="Enter 전송 · 빈 입력 Enter로 이동"
            maxLength={MAX_CHAT_LEN}
            value={chatInput}
            onFocus={() => {
              keysRef.current.clear();
              jumpQueuedRef.current = false;
            }}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              // 한글 IME 조합 중 Enter 중복 전송 방지
              if (e.key === "Enter" && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
                e.preventDefault();
                e.stopPropagation();
                if (e.repeat) return;
                if (chatInput.trim()) {
                  handleSendChat();
                } else {
                  setChatInput("");
                  keysRef.current.clear();
                  jumpQueuedRef.current = false;
                  mountRef.current?.focus({ preventScroll: true });
                }
              }
            }}
          />
          <button
            type="button"
            onClick={handleSendChat}
            className="rounded-lg bg-indigo-600 px-3 hover:bg-indigo-500"
            aria-label="전송"
          >
            <Send size={16} />
          </button>
        </div>
      </aside>
    </main>
  );
}
