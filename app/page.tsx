"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  Terminal,
  Send,
  Coffee,
  Sparkles,
  Code2,
  LogOut,
  Users,
  Volume2,
  VolumeX,
  Wifi,
  RotateCcw,
  Footprints,
  Armchair,
} from "lucide-react";

const APP_ID = "mogakko-3d-walk-p2p-v3"; // 프로토콜이 바뀌었으므로 구버전 클라이언트와 분리
const SEAT_RADIUS = 3.35;
const ROOM_BOUNDARY = 7.8;
const TABLE_COLLISION_RADIUS = 2.65;
const MAX_PLAYERS = 6;

type PeerState = {
  peerId: string;
  nickname: string;
  avatar: string;
  color: string;
  seatIndex: number;
  x: number;
  z: number;
  rotY: number;
  isMoving: boolean;
  status: "coding" | "resting";
  task: string;
  joinedAt: number;
};

type MovePacket = {
  seatIndex: number;
  x: number;
  z: number;
  rotY: number;
  isMoving: boolean;
  jump: boolean;
};

type ChatPayload = {
  id: string;
  senderId: string;
  nickname: string;
  avatar: string;
  text: string;
  timestamp: string;
  isSystem?: boolean;
};

type GesturePayload = {
  id: string;
  peerId: string;
  emoji: string;
  label: string;
};

// ---------------------------------------------------------------------------
// Trystero 0.26 API 최소 타입 (makeAction → { send, onMessage }, onPeerJoin 속성)
// ---------------------------------------------------------------------------
type TrysteroAction<T> = {
  send: (data: T, options?: { target?: string | string[] | null }) => Promise<unknown>;
  onMessage: ((data: T, ctx: { peerId: string }) => void) | null;
};

type TrysteroRoom = {
  leave: () => unknown;
  makeAction: (id: string) => unknown;
  onPeerJoin: ((peerId: string) => void) | null;
  onPeerLeave: ((peerId: string) => void) | null;
};

type SendFn<T> = (data: T, target?: string) => void;

function createAction<T>(room: TrysteroRoom, id: string): [TrysteroAction<T>, SendFn<T>] {
  const action = room.makeAction(id) as TrysteroAction<T>;
  const send: SendFn<T> = (data, target) => {
    try {
      const p = action.send(data, target ? { target } : undefined);
      if (p && typeof (p as Promise<unknown>).catch === "function") {
        (p as Promise<unknown>).catch(() => {});
      }
    } catch {
      // 연결 종료 중 전송 실패는 무시
    }
  };
  return [action, send];
}

interface ChairStation3D {
  emptyRing: THREE.Mesh;
  laptopGroup: THREE.Group;
  mugGroup: THREE.Group;
  screenLight: THREE.PointLight;
  seatWorldX: number;
  seatWorldZ: number;
  lookTableRotY: number;
}

interface AvatarRig3D {
  root: THREE.Group;
  bodyGroup: THREE.Group;
  bodyMesh: THREE.Mesh;
  headGroup: THREE.Group;
  leftLeg: THREE.Mesh;
  rightLeg: THREE.Mesh;
  leftHand: THREE.Mesh;
  rightHand: THREE.Mesh;
  labelAnchor: THREE.Object3D;
  color: string;
  jumpVel: number;
  jumpY: number;
}

const AVATARS = ["🧑‍💻", "🦊", "🐱", "🦉", "🐼", "🐸", "🤖", "🎧"];
const CHARACTER_COLORS = [
  { name: "인디고", hex: "#6366f1" },
  { name: "에메랄드", hex: "#10b981" },
  { name: "앰버", hex: "#f59e0b" },
  { name: "로즈", hex: "#f43f5e" },
  { name: "스카이", hex: "#0ea5e9" },
  { name: "바이올렛", hex: "#a855f7" },
];

const GESTURES = [
  { emoji: "👋", label: "반가워요" },
  { emoji: "☕", label: "커피 타임" },
  { emoji: "🔥", label: "불꽃 코딩" },
  { emoji: "🎉", label: "버그 해결!" },
  { emoji: "🫠", label: "뇌 정지..." },
];

function getSeatTransform(seatIndex: number) {
  const angle = (seatIndex * 2 * Math.PI) / 6 - Math.PI / 2;
  const x = Math.cos(angle) * SEAT_RADIUS;
  const z = Math.sin(angle) * SEAT_RADIUS;
  const rotY = Math.atan2(-x, -z);
  return { x, z, rotY, angle };
}

function disposeObject(obj: THREE.Object3D) {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry?.dispose();
      const mat = mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    }
  });
}

const nowTime = () =>
  new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });

export default function Mogakko3DWalkableRoom() {
  const [myId, setMyId] = useState<string>("");

  const [nickname, setNickname] = useState<string>("");
  const [selectedAvatar, setSelectedAvatar] = useState<string>("🧑‍💻");
  const [selectedColor, setSelectedColor] = useState<string>("#6366f1");
  const [task, setTask] = useState<string>("사이드 프로젝트 기능 구현 중");
  const [joined, setJoined] = useState<boolean>(false);
  const [mySeat, setMySeat] = useState<number>(-1);
  const [nearSeat, setNearSeat] = useState<number | null>(null);
  const [myStatus, setMyStatus] = useState<"coding" | "resting">("coding");
  const [joinedAt, setJoinedAt] = useState<number>(0);

  const [roomId, setRoomId] = useState<string>("mogakko-3d");
  const [peers, setPeers] = useState<Record<string, PeerState>>({});
  const [messages, setMessages] = useState<ChatPayload[]>([]);
  const [inputText, setInputText] = useState<string>("");
  const [gestures, setGestures] = useState<GesturePayload[]>([]);
  const [soundOn, setSoundOn] = useState<boolean>(true);
  const [isConnecting, setIsConnecting] = useState<boolean>(false);

  const mountRef = useRef<HTMLDivElement | null>(null);
  const cameraResetRef = useRef<(() => void) | null>(null);
  const labelElsRef = useRef<Map<string, HTMLDivElement>>(new Map());

  const myPhysicsRef = useRef({
    x: 0,
    z: 5.2,
    rotY: Math.PI,
    seatIndex: -1,
    isMoving: false,
    triggerJump: false,
  });

  const keysPressedRef = useRef<Record<string, boolean>>({});
  const peersRef = useRef<Record<string, PeerState>>({});
  const myStateSnapshotRef = useRef<PeerState | null>(null);
  const gesturesRef = useRef<GesturePayload[]>([]);
  const pendingJumpsRef = useRef<Set<string>>(new Set());

  const roomRef = useRef<TrysteroRoom | null>(null);
  const sendProfileRef = useRef<SendFn<PeerState> | null>(null);
  const sendMoveRef = useRef<SendFn<MovePacket> | null>(null);
  const sendChatRef = useRef<SendFn<ChatPayload> | null>(null);
  const sendGestureRef = useRef<SendFn<GesturePayload> | null>(null);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);

  const soundOnRef = useRef(true);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Trystero의 selfId를 내 ID로 사용 (상대방이 보는 peerId와 동일)
  useEffect(() => {
    let alive = true;
    void import("trystero").then((m) => {
      if (alive) setMyId(m.selfId);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    soundOnRef.current = soundOn;
  }, [soundOn]);

  useEffect(() => {
    return () => {
      void audioCtxRef.current?.close().catch(() => {});
    };
  }, []);

  // 피어 상태를 ref와 state에 동시에 반영 (업데이터 내부 사이드이펙트 제거)
  const commitPeers = useCallback((next: Record<string, PeerState>) => {
    peersRef.current = next;
    setPeers(next);
  }, []);

  // 의존성 없는 안정적인 알림음 (소리 토글이 P2P 재연결을 유발하지 않음)
  const playChime = useCallback(() => {
    if (!soundOnRef.current || typeof window === "undefined") return;
    try {
      if (!audioCtxRef.current) {
        const Ctx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return;
        audioCtxRef.current = new Ctx();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") void ctx.resume().catch(() => {});
      const t = ctx.currentTime;
      const osc = new OscillatorNode(ctx, { type: "sine", frequency: 587.33 });
      const gain = new GainNode(ctx, { gain: 0.08 });
      osc.frequency.exponentialRampToValueAtTime(880, t + 0.15);
      gain.gain.setValueAtTime(0.08, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.8);
    } catch {
      // 자동재생 정책 등으로 차단 시 무시
    }
  }, []);

  const appendSystemMessage = useCallback((text: string) => {
    setMessages((prev) => [
      ...prev.slice(-99),
      {
        id: `sys_${Date.now()}_${Math.random()}`,
        senderId: "system",
        nickname: "모각코봇",
        avatar: "💻",
        text,
        timestamp: nowTime(),
        isSystem: true,
      },
    ]);
  }, []);

  const triggerFloatingGesture = useCallback(
    (payload: GesturePayload) => {
      setGestures((prev) => {
        const next = [...prev, payload];
        gesturesRef.current = next;
        return next;
      });
      if (payload.emoji === "👋") playChime();
      window.setTimeout(() => {
        setGestures((prev) => {
          const next = prev.filter((g) => g.id !== payload.id);
          gesturesRef.current = next;
          return next;
        });
      }, 2800);
    },
    [playChime]
  );

  const sitOnSeat = useCallback((seatIdx: number) => {
    const occupied = Object.values(peersRef.current).some((p) => p.seatIndex === seatIdx);
    if (occupied) return;
    const { x, z, rotY } = getSeatTransform(seatIdx);
    const phys = myPhysicsRef.current;
    phys.seatIndex = seatIdx;
    phys.x = x;
    phys.z = z;
    phys.rotY = rotY;
    phys.isMoving = false;
    setMySeat(seatIdx);
    setNearSeat(null);
  }, []);

  const standUpFromSeat = useCallback(() => {
    const phys = myPhysicsRef.current;
    if (phys.seatIndex === -1) return;
    const { angle } = getSeatTransform(phys.seatIndex);
    phys.x = Math.cos(angle) * (SEAT_RADIUS + 1.05);
    phys.z = Math.sin(angle) * (SEAT_RADIUS + 1.05);
    phys.rotY = angle + Math.PI / 2;
    phys.seatIndex = -1;
    setMySeat(-1);
  }, []);

  const handleLeaveRoom = useCallback(() => {
    const room = roomRef.current;
    if (room) {
      room.onPeerJoin = null;
      room.onPeerLeave = null;
      try {
        room.leave();
      } catch {
        /* noop */
      }
      roomRef.current = null;
    }
    sendProfileRef.current = null;
    sendMoveRef.current = null;
    sendChatRef.current = null;
    sendGestureRef.current = null;
    myPhysicsRef.current.seatIndex = -1;
    pendingJumpsRef.current.clear();
    setMySeat(-1);
    setNearSeat(null);
    setJoined(false);
    commitPeers({});
  }, [commitPeers]);

  // 내 프로필 변경 시 브로드캐스트
  useEffect(() => {
    if (!joined || !myId) return;
    const phys = myPhysicsRef.current;
    const snapshot: PeerState = {
      peerId: myId,
      nickname,
      avatar: selectedAvatar,
      color: selectedColor,
      seatIndex: mySeat,
      x: phys.x,
      z: phys.z,
      rotY: phys.rotY,
      isMoving: phys.isMoving,
      status: myStatus,
      task,
      joinedAt,
    };
    myStateSnapshotRef.current = snapshot;
    sendProfileRef.current?.(snapshot);
  }, [joined, myId, nickname, selectedAvatar, selectedColor, mySeat, myStatus, task, joinedAt]);

  // 정원 제한 및 좌석 충돌 시 늦게 온 사람이 양보
  useEffect(() => {
    if (!joined || !myId) return;
    const peerList = Object.values(peers);

    if (peerList.length >= MAX_PLAYERS) {
      const all = [
        ...peerList.map((p) => ({ t: p.joinedAt, id: p.peerId })),
        { t: joinedAt, id: myId },
      ].sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
      const allowed = new Set(all.slice(0, MAX_PLAYERS).map((e) => e.id));
      if (!allowed.has(myId)) {
        window.alert(
          `현재 이 모각코룸의 최대 인원(${MAX_PLAYERS}명)이 모두 찼습니다. 다른 룸 이름을 입력해 주세요!`
        );
        handleLeaveRoom();
        return;
      }
    }

    if (mySeat !== -1) {
      const conflict = peerList.find((p) => p.seatIndex === mySeat);
      if (conflict) {
        const shouldYield =
          joinedAt > conflict.joinedAt ||
          (joinedAt === conflict.joinedAt && myId > conflict.peerId);
        if (shouldYield) {
          const taken = new Set(peerList.map((p) => p.seatIndex));
          const free = [0, 1, 2, 3, 4, 5].find((s) => !taken.has(s));
          if (free !== undefined) {
            // 내 좌석을 먼저 비운 뒤 이동
            myPhysicsRef.current.seatIndex = -1;
            sitOnSeat(free);
          } else {
            standUpFromSeat();
          }
        }
      }
    }
  }, [peers, mySeat, joined, joinedAt, myId, handleLeaveRoom, sitOnSeat, standUpFromSeat]);

  // 키보드 입력
  useEffect(() => {
    if (!joined) return;

    const isTypingInInput = () => {
      const el = document.activeElement as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    };

    const MOVE_KEYS = new Set([
      "KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    ]);

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingInInput()) return;
      const code = e.code;

      if (MOVE_KEYS.has(code)) {
        e.preventDefault();
        keysPressedRef.current[code] = true;
        if (myPhysicsRef.current.seatIndex !== -1) standUpFromSeat();
      } else if (code === "Space") {
        e.preventDefault();
        if (e.repeat) return;
        if (myPhysicsRef.current.seatIndex !== -1) standUpFromSeat();
        myPhysicsRef.current.triggerJump = true;
      } else if (code === "KeyE") {
        if (e.repeat) return;
        if (myPhysicsRef.current.seatIndex !== -1) {
          standUpFromSeat();
          return;
        }
        let closestSeat: number | null = null;
        let minDist = 1.65;
        const occupied = new Set(Object.values(peersRef.current).map((p) => p.seatIndex));
        for (let i = 0; i < 6; i++) {
          if (occupied.has(i)) continue;
          const st = getSeatTransform(i);
          const d = Math.hypot(myPhysicsRef.current.x - st.x, myPhysicsRef.current.z - st.z);
          if (d < minDist) {
            minDist = d;
            closestSeat = i;
          }
        }
        if (closestSeat !== null) sitOnSeat(closestSeat);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      keysPressedRef.current[e.code] = false;
    };
    const onBlur = () => {
      keysPressedRef.current = {};
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      keysPressedRef.current = {};
    };
  }, [joined, sitOnSeat, standUpFromSeat]);

  // ==========================================================================
  // P2P 룸 연결 (Trystero 0.26)
  // ==========================================================================
  useEffect(() => {
    if (!joined || !myId) return;

    let active = true;
    let room: TrysteroRoom | null = null;
    const roomName = roomId.trim();
    setIsConnecting(true);

    const connect = async () => {
      try {
        const { joinRoom } = await import("trystero");
        if (!active) return;

        room = joinRoom({ appId: APP_ID }, roomName) as unknown as TrysteroRoom;
        roomRef.current = room;

        const [profileAction, sendProfile] = createAction<PeerState>(room, "profile");
        const [moveAction, sendMove] = createAction<MovePacket>(room, "move");
        const [chatAction, sendChat] = createAction<ChatPayload>(room, "chat");
        const [gestureAction, sendGesture] = createAction<GesturePayload>(room, "gesture");

        sendProfileRef.current = sendProfile;
        sendMoveRef.current = sendMove;
        sendChatRef.current = sendChat;
        sendGestureRef.current = sendGesture;

        profileAction.onMessage = (data, { peerId }) => {
          const prev = peersRef.current;
          if (!prev[peerId]) {
            appendSystemMessage(`${data.avatar} ${data.nickname}님이 모각코룸에 들어왔습니다.`);
          }
          commitPeers({ ...prev, [peerId]: { ...data, peerId } });
        };

        // 이동 패킷은 ref만 갱신 (좌석이 바뀔 때만 React 렌더)
        moveAction.onMessage = (pkt, { peerId }) => {
          const prev = peersRef.current;
          const existing = prev[peerId];
          if (!existing) return;
          const next = {
            ...prev,
            [peerId]: {
              ...existing,
              seatIndex: pkt.seatIndex,
              x: pkt.x,
              z: pkt.z,
              rotY: pkt.rotY,
              isMoving: pkt.isMoving,
            },
          };
          if (existing.seatIndex !== pkt.seatIndex) commitPeers(next);
          else peersRef.current = next;
          if (pkt.jump) pendingJumpsRef.current.add(peerId);
        };

        chatAction.onMessage = (data, { peerId }) => {
          setMessages((prev) => [
            ...prev.slice(-99),
            { ...data, senderId: peerId, text: String(data.text).slice(0, 500), isSystem: false },
          ]);
        };

        gestureAction.onMessage = (data, { peerId }) => {
          triggerFloatingGesture({ ...data, peerId });
        };

        room.onPeerJoin = (peerId) => {
          if (myStateSnapshotRef.current) {
            const phys = myPhysicsRef.current;
            sendProfile(
              {
                ...myStateSnapshotRef.current,
                seatIndex: phys.seatIndex,
                x: phys.x,
                z: phys.z,
                rotY: phys.rotY,
              },
              peerId
            );
          }
          playChime();
        };

        room.onPeerLeave = (peerId) => {
          const prev = peersRef.current;
          const leaving = prev[peerId];
          if (leaving) {
            appendSystemMessage(`${leaving.avatar} ${leaving.nickname}님이 퇴장했습니다.`);
            const next = { ...prev };
            delete next[peerId];
            commitPeers(next);
          }
          pendingJumpsRef.current.delete(peerId);
        };

        setIsConnecting(false);
        appendSystemMessage(
          `'${roomName}' 3D 모각코룸에 입장했습니다! WASD(방향키)로 걸어 다니고, 의자를 클릭하거나 [E] 키를 눌러 착석해 보세요.`
        );
      } catch (err) {
        console.error(err);
        if (active) {
          setIsConnecting(false);
          appendSystemMessage("P2P 연결에 실패했습니다. 잠시 후 다시 입장해 주세요.");
        }
      }
    };

    void connect();

    return () => {
      active = false;
      if (room) {
        room.onPeerJoin = null;
        room.onPeerLeave = null;
        try {
          room.leave();
        } catch {
          /* noop */
        }
      }
      if (roomRef.current === room) roomRef.current = null;
      sendProfileRef.current = null;
      sendMoveRef.current = null;
      sendChatRef.current = null;
      sendGestureRef.current = null;
    };
  }, [joined, roomId, myId, appendSystemMessage, playChime, triggerFloatingGesture, commitPeers]);

  // ==========================================================================
  // Three.js 월드 + 물리 + 렌더 루프
  // ==========================================================================
  useEffect(() => {
    if (!joined || !mountRef.current || !myId) return;

    const container = mountRef.current;
    let viewW = container.clientWidth || 1;
    let viewH = container.clientHeight || 1;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#090d16");
    scene.fog = new THREE.FogExp2("#090d16", 0.038);

    const camera = new THREE.PerspectiveCamera(46, viewW / viewH, 0.1, 100);
    camera.position.set(0, 7.2, 9.8);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setSize(viewW, viewH);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.target.set(0, 1.0, 0);
    controls.minDistance = 4.2;
    controls.maxDistance = 16.5;
    controls.maxPolarAngle = Math.PI / 2 - 0.05;

    cameraResetRef.current = () => {
      camera.position.set(0, 7.2, 9.8);
      controls.target.set(0, 1.0, 0);
      controls.update();
    };

    scene.add(new THREE.AmbientLight("#94a3b8", 0.7));

    const dirLight = new THREE.DirectionalLight("#e0e7ff", 1.15);
    dirLight.position.set(6, 13, 7);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.set(1024, 1024);
    dirLight.shadow.camera.left = -10;
    dirLight.shadow.camera.right = 10;
    dirLight.shadow.camera.top = 10;
    dirLight.shadow.camera.bottom = -10;
    scene.add(dirLight);

    // PointLight 그림자는 큐브맵 6회 렌더링이라 비용이 커서 끔
    const centerWarmLight = new THREE.PointLight("#fbbf24", 2.3, 11);
    centerWarmLight.position.set(0, 2.1, 0);
    scene.add(centerWarmLight);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(ROOM_BOUNDARY + 0.6, 64),
      new THREE.MeshStandardMaterial({ color: "#0f172a", roughness: 0.88 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    const outerRing = new THREE.Mesh(
      new THREE.RingGeometry(ROOM_BOUNDARY - 0.08, ROOM_BOUNDARY, 64),
      new THREE.MeshBasicMaterial({ color: "#334155", side: THREE.DoubleSide, transparent: true, opacity: 0.5 })
    );
    outerRing.rotation.x = -Math.PI / 2;
    outerRing.position.y = 0.015;
    scene.add(outerRing);

    const rug = new THREE.Mesh(
      new THREE.CylinderGeometry(4.75, 4.75, 0.03, 64),
      new THREE.MeshStandardMaterial({ color: "#1e1b4b", roughness: 0.85 })
    );
    rug.position.y = 0.015;
    rug.receiveShadow = true;
    scene.add(rug);

    const tableGroup = new THREE.Group();
    const tableTop = new THREE.Mesh(
      new THREE.CylinderGeometry(2.35, 2.25, 0.16, 48),
      new THREE.MeshStandardMaterial({ color: "#3b281e", roughness: 0.55, metalness: 0.1 })
    );
    tableTop.position.y = 1.05;
    tableTop.castShadow = true;
    tableTop.receiveShadow = true;
    tableGroup.add(tableTop);

    const tablePedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.75, 1.0, 32),
      new THREE.MeshStandardMaterial({ color: "#1e293b", roughness: 0.5, metalness: 0.4 })
    );
    tablePedestal.position.y = 0.5;
    tablePedestal.castShadow = true;
    tableGroup.add(tablePedestal);

    const crystalMesh = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.24, 0),
      new THREE.MeshStandardMaterial({ color: "#fbbf24", emissive: "#f59e0b", emissiveIntensity: 0.85, roughness: 0.2 })
    );
    crystalMesh.position.y = 1.52;
    tableGroup.add(crystalMesh);
    scene.add(tableGroup);

    const chairStations: ChairStation3D[] = [];
    const clickableChairs: THREE.Mesh[] = [];

    for (let i = 0; i < 6; i++) {
      const { x, z, rotY } = getSeatTransform(i);
      const stationGroup = new THREE.Group();
      stationGroup.position.set(x, 0, z);
      stationGroup.rotation.y = rotY;

      const cushionMat = new THREE.MeshStandardMaterial({ color: "#334155", roughness: 0.7 });
      const cushionMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.46, 0.13, 24), cushionMat);
      cushionMesh.position.y = 0.52;
      cushionMesh.castShadow = true;
      cushionMesh.receiveShadow = true;
      cushionMesh.userData = { seatIndex: i };
      stationGroup.add(cushionMesh);
      clickableChairs.push(cushionMesh);

      const leg = new THREE.Mesh(
        new THREE.CylinderGeometry(0.09, 0.26, 0.48, 16),
        new THREE.MeshStandardMaterial({ color: "#1e293b", metalness: 0.5 })
      );
      leg.position.y = 0.24;
      stationGroup.add(leg);

      const backRest = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.5, 0.1), cushionMat);
      backRest.position.set(0, 0.86, -0.42);
      backRest.castShadow = true;
      stationGroup.add(backRest);

      const emptyRing = new THREE.Mesh(
        new THREE.RingGeometry(0.56, 0.65, 32),
        new THREE.MeshBasicMaterial({ color: "#38bdf8", side: THREE.DoubleSide, transparent: true, opacity: 0.4 })
      );
      emptyRing.rotation.x = -Math.PI / 2;
      emptyRing.position.y = 0.03;
      stationGroup.add(emptyRing);

      const laptopGroup = new THREE.Group();
      laptopGroup.position.set(0, 1.14, 1.42);
      const laptopMetal = new THREE.MeshStandardMaterial({ color: "#94a3b8", metalness: 0.7, roughness: 0.3 });
      laptopGroup.add(new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.03, 0.4), laptopMetal));

      const lidPivot = new THREE.Group();
      lidPivot.position.set(0, 0.015, 0.2);
      lidPivot.rotation.x = -0.35;
      const lidMesh = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.38, 0.025), laptopMetal);
      lidMesh.position.set(0, 0.19, 0);
      lidPivot.add(lidMesh);
      const screenMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(0.54, 0.32),
        new THREE.MeshBasicMaterial({ color: "#38bdf8" })
      );
      screenMesh.position.set(0, 0.19, -0.015);
      screenMesh.rotation.y = Math.PI;
      lidPivot.add(screenMesh);
      laptopGroup.add(lidPivot);
      stationGroup.add(laptopGroup);

      // 조명 개수가 변하면 셰이더가 재컴파일되므로 항상 씬에 두고 intensity만 조절
      const screenLight = new THREE.PointLight("#38bdf8", 0, 2.2);
      screenLight.position.set(0, 1.39, 1.27);
      stationGroup.add(screenLight);

      const mugGroup = new THREE.Group();
      mugGroup.position.set(0, 1.22, 1.38);
      mugGroup.add(
        new THREE.Mesh(
          new THREE.CylinderGeometry(0.1, 0.085, 0.19, 16),
          new THREE.MeshStandardMaterial({ color: "#f8fafc", roughness: 0.3 })
        )
      );
      stationGroup.add(mugGroup);

      scene.add(stationGroup);
      chairStations.push({
        emptyRing,
        laptopGroup,
        mugGroup,
        screenLight,
        seatWorldX: x,
        seatWorldZ: z,
        lookTableRotY: rotY,
      });
    }

    const avatarRigs = new Map<string, AvatarRig3D>();

    const createAvatarRig = (colorHex: string): AvatarRig3D => {
      const root = new THREE.Group();
      const bodyGroup = new THREE.Group();
      root.add(bodyGroup);

      const skinMat = new THREE.MeshStandardMaterial({ color: "#fde68a", roughness: 0.55 });
      const pantsMat = new THREE.MeshStandardMaterial({ color: "#1e293b", roughness: 0.7 });
      const bodyMat = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.6 });

      const legGeo = new THREE.CylinderGeometry(0.095, 0.085, 0.46, 12);
      const leftLeg = new THREE.Mesh(legGeo, pantsMat);
      leftLeg.position.set(0.13, 0.23, 0);
      leftLeg.castShadow = true;
      const rightLeg = new THREE.Mesh(legGeo, pantsMat);
      rightLeg.position.set(-0.13, 0.23, 0);
      rightLeg.castShadow = true;
      bodyGroup.add(leftLeg, rightLeg);

      const bodyMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.33, 0.62, 20), bodyMat);
      bodyMesh.position.y = 0.72;
      bodyMesh.castShadow = true;
      bodyGroup.add(bodyMesh);

      const headGroup = new THREE.Group();
      headGroup.position.set(0, 1.28, 0);
      const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.29, 24, 24), skinMat);
      headMesh.castShadow = true;
      headGroup.add(headMesh);

      const eyeGeo = new THREE.SphereGeometry(0.04, 12, 12);
      const eyeMat = new THREE.MeshBasicMaterial({ color: "#0f172a" });
      const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
      leftEye.position.set(0.1, 0.04, 0.25);
      const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
      rightEye.position.set(-0.1, 0.04, 0.25);
      headGroup.add(leftEye, rightEye);

      const headsetMat = new THREE.MeshStandardMaterial({ color: "#0f172a", roughness: 0.3 });
      headGroup.add(new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.028, 12, 24, Math.PI), headsetMat));
      const earGeo = new THREE.CylinderGeometry(0.085, 0.085, 0.07, 16);
      const leftEar = new THREE.Mesh(earGeo, headsetMat);
      leftEar.rotation.z = Math.PI / 2;
      leftEar.position.set(0.3, 0, 0);
      const rightEar = new THREE.Mesh(earGeo, headsetMat);
      rightEar.rotation.z = Math.PI / 2;
      rightEar.position.set(-0.3, 0, 0);
      headGroup.add(leftEar, rightEar);
      bodyGroup.add(headGroup);

      const handGeo = new THREE.SphereGeometry(0.08, 14, 14);
      const leftHand = new THREE.Mesh(handGeo, skinMat);
      const rightHand = new THREE.Mesh(handGeo, skinMat);
      leftHand.position.set(0.34, 0.72, 0.1);
      rightHand.position.set(-0.34, 0.72, 0.1);
      bodyGroup.add(leftHand, rightHand);

      const labelAnchor = new THREE.Object3D();
      labelAnchor.position.set(0, 1.92, 0);
      bodyGroup.add(labelAnchor);

      scene.add(root);
      return {
        root, bodyGroup, bodyMesh, headGroup, leftLeg, rightLeg, leftHand, rightHand, labelAnchor,
        color: colorHex, jumpVel: 0, jumpY: 0,
      };
    };

    const removeRig = (id: string) => {
      const rig = avatarRigs.get(id);
      if (!rig) return;
      scene.remove(rig.root);
      disposeObject(rig.root);
      avatarRigs.delete(id);
    };

    // 의자 클릭 착석
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downPos = { x: 0, y: 0 };

    const updatePointer = (ev: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    };

    const onPointerMove = (ev: PointerEvent) => {
      updatePointer(ev);
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(clickableChairs, false);
      if (hits.length > 0) {
        const idx = hits[0].object.userData.seatIndex as number;
        const taken =
          myPhysicsRef.current.seatIndex === idx ||
          Object.values(peersRef.current).some((p) => p.seatIndex === idx);
        renderer.domElement.style.cursor = taken ? "grab" : "pointer";
      } else {
        renderer.domElement.style.cursor = "grab";
      }
    };

    const onPointerDown = (ev: PointerEvent) => {
      downPos = { x: ev.clientX, y: ev.clientY };
    };

    const onPointerUp = (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      if (Math.hypot(ev.clientX - downPos.x, ev.clientY - downPos.y) > 6) return;
      updatePointer(ev);
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(clickableChairs, false);
      if (hits.length > 0) {
        const idx = hits[0].object.userData.seatIndex as number;
        if (myPhysicsRef.current.seatIndex !== idx) {
          myPhysicsRef.current.seatIndex = -1;
          sitOnSeat(idx);
        }
      }
    };

    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);

    // 컨테이너 크기 변화(레이아웃 전환 포함) 감지
    const resizeObserver = new ResizeObserver(() => {
      viewW = container.clientWidth || 1;
      viewH = container.clientHeight || 1;
      camera.aspect = viewW / viewH;
      camera.updateProjectionMatrix();
      renderer.setSize(viewW, viewH);
    });
    resizeObserver.observe(container);

    const clock = new THREE.Clock();
    const camForward = new THREE.Vector3();
    const camRight = new THREE.Vector3();
    const projVec = new THREE.Vector3();
    const tmpTarget = new THREE.Vector3();
    let frameId = 0;
    let frameCounter = 0;
    let lastNetworkSend = 0;
    let lastMovingSent = false;

    const animate = () => {
      frameId = window.requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.05);
      const elapsed = clock.elapsedTime;
      const seatLerp = 1 - Math.exp(-14 * dt);
      const remoteLerp = 1 - Math.exp(-12 * dt);
      controls.update();

      crystalMesh.rotation.y = elapsed * 0.8;
      crystalMesh.position.y = 1.52 + Math.sin(elapsed * 2.2) * 0.05;

      // 1) 내 이동
      const phys = myPhysicsRef.current;
      const keys = keysPressedRef.current;
      let moveForward = 0;
      let moveSide = 0;
      if (keys.KeyW || keys.ArrowUp) moveForward += 1;
      if (keys.KeyS || keys.ArrowDown) moveForward -= 1;
      if (keys.KeyD || keys.ArrowRight) moveSide += 1;
      if (keys.KeyA || keys.ArrowLeft) moveSide -= 1;

      let jumpedNow = false;

      if (phys.seatIndex === -1 && (moveForward !== 0 || moveSide !== 0)) {
        camera.getWorldDirection(camForward);
        camForward.y = 0;
        camForward.normalize();
        camRight.set(-camForward.z, 0, camForward.x);

        const dirX = camForward.x * moveForward + camRight.x * moveSide;
        const dirZ = camForward.z * moveForward + camRight.z * moveSide;
        const len = Math.hypot(dirX, dirZ) || 1;
        const normX = dirX / len;
        const normZ = dirZ / len;

        const speed = 3.9;
        let nextX = phys.x + normX * speed * dt;
        let nextZ = phys.z + normZ * speed * dt;

        const distFromCenter = Math.hypot(nextX, nextZ);
        if (distFromCenter < TABLE_COLLISION_RADIUS) {
          const s = TABLE_COLLISION_RADIUS / (distFromCenter || 0.001);
          nextX *= s;
          nextZ *= s;
        }
        const distOuter = Math.hypot(nextX, nextZ);
        if (distOuter > ROOM_BOUNDARY) {
          const s = ROOM_BOUNDARY / distOuter;
          nextX *= s;
          nextZ *= s;
        }

        phys.x = nextX;
        phys.z = nextZ;
        phys.rotY = Math.atan2(normX, normZ);
        phys.isMoving = true;
      } else {
        phys.isMoving = false;
      }

      if (phys.triggerJump) {
        phys.triggerJump = false;
        const myRig = avatarRigs.get(myId);
        if (myRig && myRig.jumpY <= 0.01) {
          myRig.jumpVel = 5.2;
          jumpedNow = true;
        }
      }

      // 원격 점프 큐 소비
      if (pendingJumpsRef.current.size > 0) {
        pendingJumpsRef.current.forEach((id) => {
          const rig = avatarRigs.get(id);
          if (rig && rig.jumpY <= 0.01) rig.jumpVel = 5.2;
        });
        pendingJumpsRef.current.clear();
      }

      // 근처 빈 의자 감지
      if (frameCounter % 6 === 0) {
        if (phys.seatIndex !== -1) {
          setNearSeat(null);
        } else {
          const occupied = new Set(Object.values(peersRef.current).map((p) => p.seatIndex));
          let found: number | null = null;
          let minD = 1.65;
          for (let i = 0; i < 6; i++) {
            if (occupied.has(i)) continue;
            const st = chairStations[i];
            const d = Math.hypot(phys.x - st.seatWorldX, phys.z - st.seatWorldZ);
            if (d < minD) {
              minD = d;
              found = i;
            }
          }
          setNearSeat(found);
        }
      }

      // 이동 패킷 전송 (~15Hz)
      const nowMs = performance.now();
      const sendMove = sendMoveRef.current;
      if (
        sendMove &&
        (jumpedNow ||
          (phys.isMoving && nowMs - lastNetworkSend > 66) ||
          (!phys.isMoving && lastMovingSent))
      ) {
        lastNetworkSend = nowMs;
        lastMovingSent = phys.isMoving;
        sendMove({
          seatIndex: phys.seatIndex,
          x: Number(phys.x.toFixed(3)),
          z: Number(phys.z.toFixed(3)),
          rotY: Number(phys.rotY.toFixed(3)),
          isMoving: phys.isMoving,
          jump: jumpedNow,
        });
      }

      // 2) 전체 플레이어 목록
      const allPlayers: PeerState[] = [];
      if (myStateSnapshotRef.current) {
        allPlayers.push({
          ...myStateSnapshotRef.current,
          seatIndex: phys.seatIndex,
          x: phys.x,
          z: phys.z,
          rotY: phys.rotY,
          isMoving: phys.isMoving,
        });
      }
      Object.values(peersRef.current).forEach((p) => {
        if (p.peerId && p.peerId !== myId) allPlayers.push(p);
      });

      const activeIds = new Set(allPlayers.map((p) => p.peerId));
      Array.from(avatarRigs.keys()).forEach((id) => {
        if (!activeIds.has(id)) removeRig(id);
      });

      // 3) 좌석 스테이션 상태
      chairStations.forEach((st, idx) => {
        const sitter = allPlayers.find((p) => p.seatIndex === idx);
        if (sitter) {
          st.emptyRing.visible = false;
          if (sitter.status === "coding") {
            st.laptopGroup.visible = true;
            st.mugGroup.visible = false;
            st.screenLight.intensity = 0.85 + Math.sin(elapsed * 7 + idx) * 0.15;
          } else {
            st.laptopGroup.visible = false;
            st.mugGroup.visible = true;
            st.screenLight.intensity = 0;
          }
        } else {
          st.laptopGroup.visible = false;
          st.mugGroup.visible = false;
          st.screenLight.intensity = 0;
          st.emptyRing.visible = true;
          (st.emptyRing.material as THREE.MeshBasicMaterial).opacity =
            0.22 + (Math.sin(elapsed * 3 + idx) + 1) * 0.16;
        }
      });

      // 4) 캐릭터 애니메이션
      const activeGestures = gesturesRef.current;

      allPlayers.forEach((player, idx) => {
        let rig = avatarRigs.get(player.peerId);
        if (!rig) {
          rig = createAvatarRig(player.color || "#6366f1");
          rig.root.position.set(player.x, 0, player.z);
          rig.root.rotation.y = player.rotY;
          avatarRigs.set(player.peerId, rig);
        }

        const color = player.color || "#6366f1";
        if (rig.color !== color) {
          (rig.bodyMesh.material as THREE.MeshStandardMaterial).color.set(color);
          rig.color = color;
        }

        if (rig.jumpY > 0 || rig.jumpVel !== 0) {
          rig.jumpY += rig.jumpVel * dt;
          rig.jumpVel -= 15.5 * dt;
          if (rig.jumpY <= 0) {
            rig.jumpY = 0;
            rig.jumpVel = 0;
          }
        }

        const hasGesture = activeGestures.some((g) => g.peerId === player.peerId);
        const gestureBounce = hasGesture ? Math.abs(Math.sin(elapsed * 10)) * 0.22 : 0;

        if (player.seatIndex >= 0 && player.seatIndex < 6) {
          const st = chairStations[player.seatIndex];
          tmpTarget.set(st.seatWorldX, 0, st.seatWorldZ);
          rig.root.position.lerp(tmpTarget, seatLerp);
          rig.root.rotation.y = st.lookTableRotY;
          rig.bodyGroup.position.y = 0.26 + gestureBounce;

          rig.leftLeg.rotation.x = -Math.PI / 2.4;
          rig.rightLeg.rotation.x = -Math.PI / 2.4;
          rig.leftLeg.position.set(0.13, 0.34, 0.2);
          rig.rightLeg.position.set(-0.13, 0.34, 0.2);

          if (player.status === "coding") {
            rig.leftHand.position.set(0.16, 0.94 + Math.abs(Math.sin(elapsed * 15 + idx)) * 0.055, 1.12);
            rig.rightHand.position.set(-0.16, 0.94 + Math.abs(Math.cos(elapsed * 15 + idx)) * 0.055, 1.12);
            rig.headGroup.rotation.x = 0.14 + Math.sin(elapsed * 2.5 + idx) * 0.03;
          } else {
            rig.leftHand.position.set(0.24, 0.85, 0.45);
            rig.rightHand.position.set(-0.24, 0.85, 0.45);
            rig.headGroup.rotation.x = -0.04;
          }
        } else {
          if (player.peerId === myId) {
            rig.root.position.set(player.x, 0, player.z);
            rig.root.rotation.y = player.rotY;
          } else {
            tmpTarget.set(player.x, 0, player.z);
            rig.root.position.lerp(tmpTarget, remoteLerp);
            const diff = Math.atan2(
              Math.sin(player.rotY - rig.root.rotation.y),
              Math.cos(player.rotY - rig.root.rotation.y)
            );
            rig.root.rotation.y += diff * remoteLerp;
          }

          rig.leftLeg.position.set(0.13, 0.23, 0);
          rig.rightLeg.position.set(-0.13, 0.23, 0);
          rig.headGroup.rotation.x = 0;

          if (player.isMoving) {
            const walkCycle = elapsed * 12;
            const bob = Math.abs(Math.sin(walkCycle)) * 0.07;
            rig.bodyGroup.position.y = rig.jumpY + gestureBounce + bob;
            rig.leftLeg.rotation.x = Math.sin(walkCycle) * 0.65;
            rig.rightLeg.rotation.x = -Math.sin(walkCycle) * 0.65;
            rig.leftHand.position.set(0.35, 0.72, -Math.sin(walkCycle) * 0.22);
            rig.rightHand.position.set(-0.35, 0.72, Math.sin(walkCycle) * 0.22);
          } else {
            rig.bodyGroup.position.y = rig.jumpY + gestureBounce + Math.sin(elapsed * 2.5) * 0.02;
            rig.leftLeg.rotation.x = 0;
            rig.rightLeg.rotation.x = 0;
            rig.leftHand.position.set(0.35, 0.72, 0.06);
            rig.rightHand.position.set(-0.35, 0.72, 0.06);
          }
        }
      });

      renderer.render(scene, camera);

      // 이름표: React state 대신 DOM transform 직접 갱신
      labelElsRef.current.forEach((el, id) => {
        const rig = avatarRigs.get(id);
        if (!rig) {
          el.style.visibility = "hidden";
          return;
        }
        rig.labelAnchor.getWorldPosition(projVec);
        projVec.project(camera);
        if (projVec.z > 1 || projVec.z < -1) {
          el.style.visibility = "hidden";
          return;
        }
        const sx = (projVec.x * 0.5 + 0.5) * viewW;
        const sy = (-projVec.y * 0.5 + 0.5) * viewH;
        el.style.visibility = "visible";
        el.style.transform = `translate3d(${sx}px, ${sy}px, 0) translate(-50%, -100%)`;
      });

      frameCounter += 1;
    };

    animate();

    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      cameraResetRef.current = null;
      controls.dispose();
      disposeObject(scene);
      avatarRigs.clear();
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [joined, myId, sitOnSeat]);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleEnterRoom = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!nickname.trim() || !roomId.trim() || !myId) return;
    setJoinedAt(Date.now());
    myPhysicsRef.current = {
      x: (Math.random() - 0.5) * 2.2,
      z: 5.1,
      rotY: Math.PI,
      seatIndex: -1,
      isMoving: false,
      triggerJump: false,
    };
    setMySeat(-1);
    commitPeers({});
    setMessages([]);
    setJoined(true);
    playChime(); // 사용자 제스처 시점에 AudioContext 활성화
  };

  const handleSendGesture = (emoji: string, label: string) => {
    if (!myId) return;
    const payload: GesturePayload = { id: `${Date.now()}_${Math.random()}`, peerId: myId, emoji, label };
    triggerFloatingGesture(payload);
    sendGestureRef.current?.(payload);
  };

  const handleSendMessage = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const text = inputText.trim().slice(0, 500);
    if (!text || !myId) return;
    const msg: ChatPayload = {
      id: `${Date.now()}_${myId}_${Math.random().toString(36).slice(2, 6)}`,
      senderId: myId,
      nickname,
      avatar: selectedAvatar,
      text,
      timestamp: nowTime(),
    };
    setMessages((prev) => [...prev.slice(-99), msg]);
    sendChatRef.current?.(msg);
    setInputText("");
  };

  const visiblePlayers: PeerState[] = [];
  if (joined && myId) {
    visiblePlayers.push({
      peerId: myId,
      nickname,
      avatar: selectedAvatar,
      color: selectedColor,
      seatIndex: mySeat,
      x: 0,
      z: 0,
      rotY: 0,
      isMoving: false,
      status: myStatus,
      task,
      joinedAt,
    });
    Object.values(peers).forEach((p) => {
      if (p.peerId && p.peerId !== myId) visiblePlayers.push(p);
    });
  }

  // ==========================================================================
  // 1) 로비
  // ==========================================================================
  if (!joined) {
    return (
      <main className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4 selection:bg-indigo-600">
        <div className="max-w-md w-full bg-slate-900/90 border border-slate-800 rounded-3xl p-8 shadow-2xl backdrop-blur">
          <div className="text-center mb-7">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-950/80 border border-indigo-500/30 mb-4 text-indigo-400">
              <Terminal className="w-8 h-8" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-white">3D 온라인 모각코룸</h1>
            <p className="text-xs text-slate-400 mt-2 leading-relaxed">
              캐릭터를 직접 움직여 원형 테이블에 둘러앉아 코딩하는 P2P 가상 공간입니다.
              <br />
              최대 6명이 한 룸에서 함께 개발하고 소통할 수 있습니다!
            </p>
          </div>

          <form onSubmit={handleEnterRoom} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">모각코룸 코드 (방 이름)</label>
              <input
                type="text"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
                placeholder="같은 방 이름을 입력한 사람끼리 만납니다"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">닉네임</label>
              <input
                type="text"
                maxLength={12}
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
                placeholder="사용할 닉네임을 입력하세요"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">오늘의 코딩 목표 (한 줄 상태)</label>
              <input
                type="text"
                maxLength={28}
                value={task}
                onChange={(e) => setTask(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
                placeholder="예: 포트폴리오 UI 다듬기"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-400 mb-2">아이콘 & 3D 캐릭터 컬러</label>
              <div className="grid grid-cols-8 gap-1.5 mb-3">
                {AVATARS.map((av) => (
                  <button
                    type="button"
                    key={av}
                    onClick={() => setSelectedAvatar(av)}
                    className={`h-9 rounded-xl text-lg flex items-center justify-center transition ${
                      selectedAvatar === av
                        ? "bg-indigo-600/30 border-2 border-indigo-400 scale-105"
                        : "bg-slate-950 border border-slate-800 hover:bg-slate-800"
                    }`}
                  >
                    {av}
                  </button>
                ))}
              </div>
              <div className="flex items-center justify-between gap-2 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2">
                <span className="text-xs text-slate-400">후드 색상</span>
                <div className="flex items-center gap-2">
                  {CHARACTER_COLORS.map((c) => (
                    <button
                      type="button"
                      key={c.hex}
                      onClick={() => setSelectedColor(c.hex)}
                      style={{ backgroundColor: c.hex }}
                      className={`w-6 h-6 rounded-full transition ${
                        selectedColor === c.hex
                          ? "ring-2 ring-white ring-offset-2 ring-offset-slate-950 scale-110"
                          : "opacity-70 hover:opacity-100"
                      }`}
                      title={c.name}
                    />
                  ))}
                </div>
              </div>
            </div>

            <button
              type="submit"
              disabled={!myId}
              className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-semibold text-sm transition shadow-lg shadow-indigo-950/60"
            >
              {myId ? "3D 모각코룸 입장하기 💻" : "준비 중..."}
            </button>
          </form>
        </div>
      </main>
    );
  }

  // ==========================================================================
  // 2) 메인 화면
  // ==========================================================================
  return (
    <div className="h-screen w-screen bg-slate-950 text-slate-100 flex flex-col lg:flex-row overflow-hidden">
      <div className="relative flex-1 h-[62vh] lg:h-full overflow-hidden select-none">
        <div ref={mountRef} className="absolute inset-0 w-full h-full" />

        {/* 이름표: 위치는 렌더 루프에서 transform으로 직접 갱신 */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden z-10">
          {visiblePlayers.map((player) => {
            const isMe = player.peerId === myId;
            const playerGestures = gestures.filter((g) => g.peerId === player.peerId);
            const id = player.peerId;

            return (
              <div
                key={id}
                ref={(el) => {
                  if (!el) return;
                  labelElsRef.current.set(id, el);
                  return () => {
                    labelElsRef.current.delete(id);
                  };
                }}
                style={{ visibility: "hidden" }}
                className="absolute left-0 top-0 flex flex-col items-center will-change-transform"
              >
                {playerGestures.map((g) => (
                  <div
                    key={g.id}
                    className="mb-1.5 flex items-center gap-1 px-3 py-1 rounded-full bg-indigo-600/95 border border-indigo-300/60 shadow-xl animate-bounce whitespace-nowrap"
                  >
                    <span className="text-base">{g.emoji}</span>
                    <span className="text-xs font-semibold text-white">{g.label}</span>
                  </div>
                ))}

                <div
                  className={`px-2.5 py-1 rounded-xl backdrop-blur-md border shadow-lg flex flex-col items-center max-w-38.75 ${
                    isMe ? "bg-indigo-950/85 border-indigo-400/70" : "bg-slate-900/85 border-slate-700/70"
                  }`}
                >
                  <div className="flex items-center gap-1 text-xs font-semibold text-white whitespace-nowrap">
                    <span>{player.avatar}</span>
                    <span className="truncate max-w-22.5">{player.nickname}</span>
                    {isMe && <span className="text-[10px] text-indigo-300">(나)</span>}
                    {player.seatIndex !== -1 ? (
                      player.status === "coding" ? (
                        <Code2 className="w-3 h-3 text-emerald-400 shrink-0" />
                      ) : (
                        <Coffee className="w-3 h-3 text-amber-400 shrink-0" />
                      )
                    ) : (
                      <Footprints className="w-3 h-3 text-sky-400 shrink-0" />
                    )}
                  </div>
                  <p className="text-[10px] text-slate-300 truncate max-w-35 mt-0.5">
                    {player.seatIndex === -1 ? "라운지 산책 중" : player.task || "집중 코딩 중"}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        <header className="absolute top-4 left-4 right-4 z-20 flex items-center justify-between pointer-events-none">
          <div className="pointer-events-auto bg-slate-900/85 border border-slate-800 backdrop-blur-md rounded-2xl px-4 py-2.5 flex items-center gap-3 shadow-xl">
            <div className="w-9 h-9 rounded-xl bg-indigo-950 border border-indigo-500/40 flex items-center justify-center text-indigo-400">
              <Terminal className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-sm font-semibold text-white">모각코룸: {roomId}</h2>
                <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-200 flex items-center gap-1">
                  <Users className="w-3 h-3 text-indigo-400" /> {visiblePlayers.length} / {MAX_PLAYERS}
                </span>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-950/80 border border-emerald-700/50 text-emerald-300 flex items-center gap-1">
                  <Wifi className="w-3 h-3" /> {isConnecting ? "연결 중..." : "P2P Live"}
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-0.5 hidden sm:block">
                WASD/방향키: 이동 · Space: 점프 · 빈 의자 클릭 또는 [E]: 착석
              </p>
            </div>
          </div>

          <div className="pointer-events-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => cameraResetRef.current?.()}
              className="p-2.5 rounded-xl bg-slate-900/85 border border-slate-800 backdrop-blur-md text-slate-300 hover:text-indigo-300 transition shadow-lg"
              title="카메라 시점 초기화"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setSoundOn((v) => !v)}
              className="p-2.5 rounded-xl bg-slate-900/85 border border-slate-800 backdrop-blur-md text-slate-300 hover:text-indigo-300 transition shadow-lg"
              title="알림음 켜기/끄기"
            >
              {soundOn ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
            </button>
            <button
              type="button"
              onClick={handleLeaveRoom}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-900/85 border border-slate-800 backdrop-blur-md text-xs text-slate-300 hover:bg-red-950/60 hover:border-red-800/60 hover:text-red-200 transition shadow-lg"
            >
              <LogOut className="w-3.5 h-3.5" /> 나가기
            </button>
          </div>
        </header>

        {nearSeat !== null && mySeat === -1 && (
          <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-20 pointer-events-auto">
            <button
              type="button"
              onClick={() => sitOnSeat(nearSeat)}
              className="px-4 py-2 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-xl border border-indigo-300/50 flex items-center gap-2 animate-bounce"
            >
              <Armchair className="w-4 h-4" />
              [E] 키 또는 클릭하여 {nearSeat + 1}번 좌석에 앉기
            </button>
          </div>
        )}

        <div className="absolute bottom-4 left-4 right-4 z-20 flex justify-center pointer-events-none">
          <div className="pointer-events-auto max-w-3xl w-full bg-slate-900/85 border border-slate-800/90 backdrop-blur-md rounded-2xl p-2.5 flex flex-wrap items-center justify-between gap-2 shadow-2xl">
            <div className="flex items-center gap-1.5 flex-wrap">
              {GESTURES.map((g) => (
                <button
                  type="button"
                  key={g.label}
                  onClick={() => handleSendGesture(g.emoji, g.label)}
                  className="px-2.5 py-1.5 rounded-xl bg-slate-950/90 hover:bg-slate-800 border border-slate-800 text-xs flex items-center gap-1.5 transition active:scale-95"
                >
                  <span className="text-base">{g.emoji}</span>
                  <span className="hidden sm:inline text-slate-300">{g.label}</span>
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              {mySeat !== -1 ? (
                <>
                  <button
                    type="button"
                    onClick={() => setMyStatus((s) => (s === "coding" ? "resting" : "coding"))}
                    className={`px-3 py-1.5 rounded-xl text-xs font-medium flex items-center gap-1.5 transition ${
                      myStatus === "coding"
                        ? "bg-emerald-950/90 text-emerald-300 border border-emerald-700/60"
                        : "bg-amber-950/90 text-amber-300 border border-amber-700/60"
                    }`}
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    {myStatus === "coding" ? "집중 코딩 중" : "커피 휴식 중"}
                  </button>
                  <button
                    type="button"
                    onClick={standUpFromSeat}
                    className="px-3 py-1.5 rounded-xl text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 flex items-center gap-1.5 transition"
                  >
                    <Footprints className="w-3.5 h-3.5 text-sky-400" />
                    일어나기
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    const occupied = new Set(Object.values(peersRef.current).map((p) => p.seatIndex));
                    const empty = [0, 1, 2, 3, 4, 5].find((s) => !occupied.has(s));
                    if (empty !== undefined) sitOnSeat(empty);
                  }}
                  className="px-3.5 py-1.5 rounded-xl text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white flex items-center gap-1.5 transition"
                >
                  <Armchair className="w-3.5 h-3.5" />빈 자리에 바로 앉기
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <aside className="w-full lg:w-96 h-[38vh] lg:h-full bg-slate-900/95 border-t lg:border-t-0 lg:border-l border-slate-800 flex flex-col z-30">
        <div className="p-4 border-b border-slate-800 hidden lg:block">
          <h3 className="text-sm font-semibold text-white">라운지 채팅</h3>
          <p className="text-xs text-slate-400 mt-0.5">대화는 서버에 저장되지 않으며 퇴장 시 사라집니다</p>
        </div>

        <div className="px-4 py-2.5 bg-slate-950/70 border-b border-slate-800 flex items-center gap-2">
          <span className="text-[11px] text-indigo-400 shrink-0 font-medium">내 목표:</span>
          <input
            type="text"
            maxLength={28}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            className="w-full bg-transparent text-xs text-slate-200 focus:outline-none"
            placeholder="현재 진행 중인 작업 입력..."
          />
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.map((msg) => {
            if (msg.isSystem) {
              return (
                <div
                  key={msg.id}
                  className="text-[11px] text-indigo-200/90 bg-indigo-950/40 border border-indigo-800/40 rounded-xl p-2.5 leading-relaxed"
                >
                  {msg.text}
                </div>
              );
            }
            const isMine = msg.senderId === myId;
            return (
              <div key={msg.id} className={`flex flex-col ${isMine ? "items-end" : "items-start"}`}>
                <span className="text-[11px] text-slate-400 mb-1 flex items-center gap-1">
                  <span>{msg.avatar}</span> {msg.nickname} · {msg.timestamp}
                </span>
                <div
                  className={`max-w-[82%] px-3.5 py-2 rounded-2xl text-xs leading-relaxed break-words ${
                    isMine ? "bg-indigo-600 text-white rounded-tr-sm" : "bg-slate-800 text-slate-200 rounded-tl-sm"
                  }`}
                >
                  {msg.text}
                </div>
              </div>
            );
          })}
          <div ref={chatBottomRef} />
        </div>

        <form onSubmit={handleSendMessage} className="p-3 border-t border-slate-800 flex items-center gap-2">
          <input
            type="text"
            maxLength={500}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="팀원들에게 메시지 보내기..."
            className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
          />
          <button type="submit" className="p-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white transition">
            <Send className="w-4 h-4" />
          </button>
        </form>
      </aside>
    </div>
  );
}
