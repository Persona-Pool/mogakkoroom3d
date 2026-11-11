import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initRoom, startGame, action, tickGame, snapshot, transferHost } from '../lib/freeze-game.mjs';
function room(count = 3) {
  const r = new Map(Array.from({ length: count }, (_, i) => [String(i), { peer: { seatIndex: i } }]));
  initRoom(r);
  return r;
}
test('host transfer validates permissions and membership, and preserves the running game', () => {
  const r = room();
  assert.equal(transferHost(r, '1', '2'), false);
  assert.equal(transferHost(r, '0', 'missing'), false);
  assert.equal(transferHost(r, '0', '0'), false);
  assert.equal(r.hostId, '0');
  startGame(r, 1000);
  const before = structuredClone(r.game);
  assert.equal(transferHost(r, '0', '1'), true);
  assert.equal(snapshot(r).hostId, '1');
  assert.deepEqual(r.game, before);
  assert.equal(transferHost(r, '0', '2'), false);
  assert.equal(transferHost(r, '1', '2'), true);
});
test('minimum players, random role, duration, reset and duplicate start', () => {
  assert.equal(startGame(room(1), 1000), false);
  const r = room();
  assert.equal(r.hostId, '0');
  assert.equal(startGame(r, 1000), true);
  assert.ok(r.has(r.game.taggerId));
  assert.equal(r.game.endsAt, 61000);
  assert.ok([...r.values()].every(c => c.peer.seatIndex === null));
  const id = r.game.roundId;
  assert.equal(startGame(r, 2000), false);
  assert.equal(r.game.roundId, id);
  assert.equal(snapshot(r, 3000).serverNow, 3000);
});
test('freeze rejects tagger, rescue requires an active nearby teammate, protects rescued player', () => {
  const r = room(); startGame(r, 1000);
  const [a, b] = Object.keys(r.game.players).filter(id => id !== r.game.taggerId);
  assert.equal(action(r, r.game.taggerId, 'freeze', 2000), false);
  assert.equal(action(r, a, 'freeze', 2000), true);
  assert.equal(action(r, a, 'rescue', 2000), false);
  assert.equal(action(r, b, 'rescue', 2000), false);
  Object.assign(r.game.players[b], { x: r.game.players[a].x, z: r.game.players[a].z });
  assert.equal(action(r, b, 'rescue', 2000), true);
  assert.equal(r.game.players[a].state, 'active');
  assert.equal(r.game.players[a].protectedUntil, 3500);
});
test('touch capture, all frozen loss, timeout and tagger disconnect', () => {
  const r = room(2); startGame(r, 1000);
  const runnerId = Object.keys(r.game.players).find(id => id !== r.game.taggerId);
  const runner = r.game.players[runnerId];
  Object.assign(runner, { x: r.game.players[r.game.taggerId].x, z: r.game.players[r.game.taggerId].z });
  tickGame(r, 2000); assert.equal(runner.state, 'active');
  tickGame(r, 3000); assert.equal(runner.state, 'out'); assert.match(r.game.result, /술래 승리/);
  startGame(r, 4000);
  const id = Object.keys(r.game.players).find(id => id !== r.game.taggerId);
  action(r, id, 'freeze', 5000); tickGame(r, 5000); assert.match(r.game.result, /술래 승리/);
  startGame(r, 6000); tickGame(r, 66000); assert.match(r.game.result, /도망자 승리/);
  startGame(r, 70000); r.delete(r.game.taggerId); tickGame(r, 71000); assert.match(r.game.result, /취소/);
});
