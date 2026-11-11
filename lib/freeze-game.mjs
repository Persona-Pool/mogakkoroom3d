import { randomInt, randomUUID } from 'node:crypto';

export const RULES = { duration: 60_000, walk: 3.9, sprint: 6.24, drain: 20, regen: 14, touch: 0.85, rescue: 1.5 };
export function initRoom(room) {
  room.hostId = room.keys().next().value;
  room.game = { roundId: '', phase: 'idle', taggerId: null, endsAt: 0, result: '', players: {} };
}
export function snapshot(room, now = Date.now()) {
  return { t: 'game', hostId: room.hostId, serverNow: now, ...room.game };
}
export function transferHost(room, requesterId, targetId) {
  if (room.hostId !== requesterId || targetId === requesterId || !room.has(targetId)) return false;
  room.hostId = targetId;
  return true;
}
export function finish(room, result) {
  room.game.phase = 'ended';
  room.game.result = result;
}
export function startGame(room, now = Date.now()) {
  if (room.size < 2 || room.game.phase === 'playing') return false;
  const ids = [...room.keys()];
  room.game = { roundId: randomUUID(), phase: 'playing', taggerId: ids[randomInt(ids.length)], endsAt: now + RULES.duration, result: '', players: {} };
  ids.forEach((id, i) => {
    const angle = i / ids.length * Math.PI * 2;
    room.game.players[id] = { state: 'active', x: Math.sin(angle) * 5.5, y: 0, z: Math.cos(angle) * 5.5, stamina: 100, protectedUntil: now + 2000 };
    const member = room.get(id);
    member.peer.seatIndex = null;
    member.lastMoveAt = now;
  });
  return true;
}
export function action(room, id, type, now = Date.now()) {
  const g = room.game;
  const p = g.players[id];
  if (g.phase !== 'playing' || now >= g.endsAt || id === g.taggerId || p?.state !== 'active') return false;
  if (type === 'freeze') {
    p.state = 'frozen';
    p.y = 0;
    return true;
  }
  if (type === 'rescue') {
    const target = Object.entries(g.players).find(([other, q]) => other !== id && q.state === 'frozen' && Math.hypot(p.x - q.x, p.z - q.z) <= RULES.rescue);
    if (!target) return false;
    target[1].state = 'active';
    target[1].protectedUntil = now + 1500;
    return true;
  }
  return false;
}
export function tickGame(room, now = Date.now()) {
  const g = room.game;
  if (g.phase !== 'playing') return;
  const tagger = g.players[g.taggerId];
  if (!room.has(g.taggerId) || Object.keys(g.players).length < 2) return finish(room, '참여자가 부족해 게임이 취소됐어요.');
  const runners = Object.entries(g.players).filter(([id]) => id !== g.taggerId).map(([, p]) => p);
  // 마감 시각 이후에는 새 잡기 판정을 하지 않는다.
  if (now >= g.endsAt) return finish(room, '도망자 승리! 1분을 버텼어요 🎉');
  for (const p of runners) {
    if (p.state === 'active' && now >= p.protectedUntil && Math.hypot(tagger.x - p.x, tagger.z - p.z) <= RULES.touch) { p.state = 'out'; p.y = 0; }
  }
  if (runners.every(p => p.state !== 'active')) finish(room, '술래 승리! 움직이는 도망자가 없어요 🔴');
}
