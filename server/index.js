// 게임 서버: 정적 파일 + WebSocket. 위치·사격·라운드는 서버가 판정하고 클라이언트는 입력만 보낸다
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createMap, SPAWNS, W, D, H, B, BLOCK_HP, GHOST_REMOVABLE } from '../shared/map.js';
import { TICK, P, WEAPONS, SHOP, GHOST, newState, stepPlayer, stepGhost, stepWeapon, shotDirs, maskInput, damageAt } from '../shared/sim.js';
import { rayBlocks, rayBox, hitboxes } from '../shared/ray.js';
import { ZONE_START, ZONE_STAGES, ZONE_FINAL_DPS } from '../shared/zone.js';
import { CARDS, GIANT, CARD_BLOCK_HP, gravityMul, breakableByCard } from '../shared/cards.js';
import { CHARACTERS, DEFAULT_CHARACTER, charOf } from '../shared/characters.js';

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const MAX_PLAYERS = 5;
const SNAPSHOT_EVERY = 3; // 60틱 중 3틱마다 = 초당 20번
const HISTORY = 60; // 되감기용 위치 기록 (1초)
const MAX_REWIND = 40; // 쏜 사람 화면 기준으로 최대 0.67초까지 되감아 판정
const COLORS = ['#e8505b', '#3d8bfd', '#f2b632', '#2fbf71', '#a259ff'];
const SEC = 60;

// ---- 라운드 규칙 ----
const RULES = {
  winRounds: 5,
  startCountdown: 5 * SEC, // 대기실에서 2명 모이면
  buy: 15 * SEC,
  roundEnd: 6 * SEC, // 이 사이에 규칙 카드를 고른다
  matchEnd: 8 * SEC,
  lobbyRespawn: 3 * SEC,
  startMoney: 800,
  maxMoney: 9000,
  killReward: 200,
  roundPay: 1900, // 라운드마다 모두
  winBonus: 1000, // 라운드 승자 추가
};

// ---- 정적 파일 ----
const ROUTES = [
  ['/vendor/', 'node_modules/three/build/'],
  ['/addons/', 'node_modules/three/examples/jsm/'],
  ['/client/', 'client/'],
  ['/shared/', 'shared/'],
];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.glb': 'model/gltf-binary', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { p = ''; }
  if (p === '/') p = '/client/index.html';
  let file = null;
  for (const [prefix, dir] of ROUTES) {
    if (!p.startsWith(prefix)) continue;
    const base = path.join(ROOT, dir);
    const f = path.join(base, p.slice(prefix.length));
    if (f.startsWith(base)) file = f;
  }
  if (!file) { res.writeHead(404).end('not found'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(data);
  });
});

// ---- 방 ----
const rooms = new Map();
let nextId = 1;
let tick = 0;

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, except = null) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values())
    if (p !== except && p.ws.readyState === p.ws.OPEN) p.ws.send(data);
}

function roster(room) {
  broadcast(room, {
    t: 'roster',
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, color: p.color, char: p.char, kills: p.kills, deaths: p.deaths, wins: p.wins,
    })),
  });
}

// 살아 있는 다른 플레이어에게서 가장 먼 부활 지점
function farthestSpawn(room, self) {
  let best = SPAWNS[0], bestD = -1;
  for (const sp of SPAWNS) {
    let d = Infinity;
    for (const q of room.players.values())
      if (q !== self && q.alive) d = Math.min(d, Math.hypot(q.state.x - sp[0], q.state.z - sp[2]));
    if (d > bestD) { bestD = d; best = sp; }
  }
  return best;
}

// 캐릭터마다 체력이 다르고, 거인 카드면 거인만 200
const maxHp = (p) => (p.id === p.room.giant ? GIANT.hp : charOf(p.char).hp);
// 캐릭터 고유 무기 (기본 권총 자리)
const sigWeapon = (p) => charOf(p.char).weapon;

function spawn(p, at) {
  p.state = newState(at, p.weapon);
  p.hp = maxHp(p);
  p.alive = true;
  p.ghost = false;
  p.respawnAt = Infinity;
}

// ---- 블록 변화: 방마다 맵이 따로 있고, 바뀐 칸은 틱마다 모아서 보낸다 ----
function resetMap(room) {
  room.map = createMap();
  room.blockHp = new Map(); // "x,y,z" -> 남은 체력
  room.blockOwner = new Map(); // "x,y,z" -> 그 망령 블록을 놓은 플레이어 id
  room.changes = new Map(); // "x,y,z" -> 블록 (도중 입장자에게 보낼 원래 맵과의 차이)
  room.blkOut = [];
  broadcast(room, { t: 'mapReset' });
}

function setBlock(room, x, y, z, b) {
  room.map.set(x, y, z, b);
  room.changes.set(`${x},${y},${z}`, b);
  room.blkOut.push([x, y, z, b]);
}

function hitBlock(room, [x, y, z], dmg) {
  const b = room.map.get(x, y, z);
  const max = BLOCK_HP[b] ?? (room.card === 'blockbullet' && breakableByCard(x, y, z, b) ? CARD_BLOCK_HP : 0);
  if (!max) return;
  const key = `${x},${y},${z}`;
  const cur = room.blockHp.get(key) ?? max;
  if (b === B.GHOST) ghostCredit(room, key, Math.min(cur, dmg));
  const hp = cur - dmg;
  if (hp > 0) { room.blockHp.set(key, hp); return; }
  room.blockHp.delete(key);
  room.blockOwner.delete(key);
  setBlock(room, x, y, z, B.AIR);
}

// ---- 망령 ----
function becomeGhost(p) {
  p.ghost = true;
  Object.assign(p.state, { y: p.state.y + P.eye, vx: 0, vy: 0, vz: 0 });
  p.ghostReady = tick + 2 * SEC;
}

// 망령 블록이 총알을 막으면 놓은 망령에게 코인
function ghostCredit(room, key, absorbed) {
  const owner = room.players.get(room.blockOwner.get(key));
  if (!owner) return;
  const coins = Math.min(absorbed * GHOST.coinPerDmg, GHOST.coinCap - owner.ghostEarn);
  if (coins <= 0) return;
  owner.ghostEarn += coins;
  owner.money = Math.min(RULES.maxMoney, owner.money + coins);
  send(owner.ws, { t: 'ghostCoin', n: coins, total: owner.ghostEarn });
}

const NEIGHBORS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

function ghostBlock(p, msg) {
  const room = p.room;
  if (!p.ghost || room.phase !== 'R' || tick < p.ghostReady) return;
  const { x, y, z } = msg;
  if (![x, y, z].every(Number.isInteger)) return;
  const s = p.state;
  if (Math.hypot(x + 0.5 - s.x, y + 0.5 - s.y, z + 0.5 - s.z) > GHOST.reach + 1) return;
  const key = `${x},${y},${z}`;
  if (msg.place) {
    if (x < 1 || x > W - 2 || z < 1 || z > D - 2 || y < 1 || y > H - 2) return;
    if (room.map.get(x, y, z) !== B.AIR) return;
    if (!NEIGHBORS.some(([a, b, c]) => room.map.solid(x + a, y + b, z + c))) return;
    // 산 사람 몸과 겹치는 칸엔 못 놓음
    for (const q of room.players.values()) {
      if (!q.alive) continue;
      const t = q.state;
      if (t.x - P.hw < x + 1 && t.x + P.hw > x && t.z - P.hw < z + 1 && t.z + P.hw > z && t.y < y + 1 && t.y + P.h > y) return;
    }
    setBlock(room, x, y, z, B.GHOST);
    room.blockOwner.set(key, p.id);
  } else {
    if (!GHOST_REMOVABLE.has(room.map.get(x, y, z))) return;
    room.blockHp.delete(key);
    room.blockOwner.delete(key);
    setBlock(room, x, y, z, B.AIR);
  }
  p.ghostReady = tick + GHOST.cooldown;
  send(p.ws, { t: 'ghostCd', sec: GHOST.cooldown * TICK });
}

function vote(p) {
  const room = p.room;
  if (!p.ghost || room.phase !== 'R' || !room.zone?.voting) return;
  room.votes.set(p.id, [+p.state.x.toFixed(1), +p.state.z.toFixed(1)]);
}

function setPhase(room, phase, ticks) {
  room.phase = phase;
  room.timer = ticks;
  broadcast(room, { t: 'phase', ph: phase, rd: room.round });
}

// ---- 규칙 카드 ----
// 라운드가 끝나면 가장 먼저 죽은 사람에게 3장을 보여 준다
function offerCards(room, winner) {
  const ids = Object.keys(CARDS).filter((c) => c !== 'giant' || winner);
  const options = ids.sort(() => Math.random() - 0.5).slice(0, 3);
  let chooser = room.players.get(room.firstDead);
  if (!chooser) {
    const list = [...room.players.values()].filter((p) => p !== winner);
    chooser = list[Math.floor(Math.random() * list.length)];
  }
  room.pick = { chooser: chooser ? chooser.id : 0, options, picked: null, winner: winner ? winner.id : 0 };
  broadcast(room, { t: 'cards', chooser: room.pick.chooser, options });
}

function pickCard(p, i) {
  const pick = p.room.pick;
  if (!pick || p.room.phase !== 'E' || pick.chooser !== p.id || pick.picked || !pick.options[i]) return;
  pick.picked = pick.options[i];
  broadcast(p.room, { t: 'picked', card: pick.picked });
}

// ---- 경기 흐름 ----
function startMatch(room) {
  room.round = 0;
  room.pick = null;
  for (const p of room.players.values()) {
    p.wins = 0; p.kills = 0; p.deaths = 0;
    p.money = RULES.startMoney;
    p.weapon = sigWeapon(p);
  }
  roster(room);
  startRound(room);
}

function startRound(room) {
  room.round++;
  const pick = room.pick;
  room.card = pick ? pick.picked ?? pick.options[Math.floor(Math.random() * pick.options.length)] : null;
  room.giant = room.card === 'giant' ? pick.winner : 0;
  room.pick = null;
  room.firstDead = 0;
  const spots = [...SPAWNS].sort(() => Math.random() - 0.5);
  let i = 0;
  for (const p of room.players.values()) {
    if (p.lostWeapon) p.weapon = sigWeapon(p);
    p.lostWeapon = false;
    p.bought = null;
    p.ghostEarn = 0;
    spawn(p, spots[i++ % spots.length]);
  }
  resetMap(room);
  room.zones = [{ ...ZONE_START }];
  room.votes = new Map(); // 망령 id -> [x, z]
  room.liveTick = 0;
  room.zone = { ...room.zones[0], dps: 0, next: room.zones[0], shrinking: false, voting: false };
  setPhase(room, 'B', RULES.buy);
  if (room.card) broadcast(room, { t: 'card', card: room.card, giant: room.giant });
}

// 다음 원: 망령 투표가 있으면 투표 위치들의 평균 쪽으로, 없으면 이전 원 안쪽 아무 데나
function decideZone(room, i) {
  const prev = room.zones[i], st = ZONE_STAGES[i];
  const slack = prev.r - st.r, margin = st.r + 3;
  const votes = [...room.votes.values()];
  let x, z;
  if (votes.length) {
    let dx = votes.reduce((sum, v) => sum + v[0], 0) / votes.length - prev.x;
    let dz = votes.reduce((sum, v) => sum + v[1], 0) / votes.length - prev.z;
    const d = Math.hypot(dx, dz);
    if (d > slack) { dx *= slack / d; dz *= slack / d; }
    x = prev.x + dx; z = prev.z + dz;
  } else {
    const a = Math.random() * Math.PI * 2, d = Math.random() * slack;
    x = prev.x + Math.cos(a) * d; z = prev.z + Math.sin(a) * d;
  }
  x = Math.max(margin, Math.min(W - margin, x));
  z = Math.max(margin, Math.min(D - margin, z));
  room.zones.push({ x, z, r: st.r });
  room.votes.clear();
  broadcast(room, { t: 'zoneDecided', votes: votes.length });
}

function updateZone(room) {
  const t = room.liveTick;
  const lerp = (a, b, f) => a + (b - a) * f;
  let start = 0;
  for (let i = 0; i < ZONE_STAGES.length; i++) {
    const st = ZONE_STAGES[i], a = room.zones[i];
    const dps = i === 0 ? 0 : ZONE_STAGES[i - 1].dps;
    const voteEnd = start + st.vote, holdEnd = start + st.hold, shrinkEnd = holdEnd + st.shrink;
    if (t < voteEnd) {
      room.zone = { ...a, dps, next: a, shrinking: false, voting: true };
      return;
    }
    if (!room.zones[i + 1]) decideZone(room, i);
    const b = room.zones[i + 1];
    if (t < holdEnd) {
      room.zone = { ...a, dps, next: b, shrinking: false, voting: false };
      return;
    }
    if (t < shrinkEnd) {
      const f = (t - holdEnd) / st.shrink;
      room.zone = { x: lerp(a.x, b.x, f), z: lerp(a.z, b.z, f), r: lerp(a.r, b.r, f), dps: st.dps, next: b, shrinking: true, voting: false };
      return;
    }
    start = shrinkEnd;
  }
  const last = room.zones[room.zones.length - 1];
  room.zone = { ...last, dps: ZONE_FINAL_DPS, next: last, shrinking: false, voting: false };
}

function endRound(room) {
  const alive = [...room.players.values()].filter((p) => p.alive);
  const winner = alive.length === 1 ? alive[0] : null;
  for (const p of room.players.values())
    p.money = Math.min(RULES.maxMoney, p.money + RULES.roundPay + (p === winner ? RULES.winBonus : 0));
  if (winner) winner.wins++;
  broadcast(room, { t: 'roundEnd', winner: winner ? winner.id : 0, rd: room.round });
  roster(room);
  setPhase(room, 'E', RULES.roundEnd);
  if (!(winner && winner.wins >= RULES.winRounds)) offerCards(room, winner);
}

function backToLobby(room) {
  for (const p of room.players.values()) {
    p.weapon = sigWeapon(p);
    p.money = RULES.startMoney;
    p.wins = 0;
    if (!p.alive) spawn(p, farthestSpawn(room, p));
  }
  room.round = 0;
  room.zone = null;
  room.countdown = false;
  room.card = null;
  room.giant = 0;
  room.pick = null;
  resetMap(room);
  roster(room);
  setPhase(room, 'L', 0);
}

// 보통은 원 안이 안전, 거꾸로 자기장 카드면 (처음 반지름 - 지금 반지름) 원 바깥이 안전
function inSafeZone(room, s) {
  const z = room.zone, d = Math.hypot(s.x - z.x, s.z - z.z);
  return room.card === 'reverse' ? d >= ZONE_START.r - z.r : d <= z.r;
}

function updateRoom(room) {
  const count = room.players.size;
  if (room.phase !== 'L' && count < 2) return backToLobby(room);
  if (room.timer > 0) room.timer--;

  switch (room.phase) {
    case 'L':
      for (const p of room.players.values())
        if (!p.alive && tick >= p.respawnAt) spawn(p, farthestSpawn(room, p));
      if (count < 2) {
        if (room.countdown) { room.countdown = false; room.timer = 0; broadcast(room, { t: 'phase', ph: 'L', rd: 0 }); }
      } else if (!room.countdown) {
        room.countdown = true;
        room.timer = RULES.startCountdown;
        broadcast(room, { t: 'phase', ph: 'L', rd: 0, starting: true });
      } else if (room.timer === 0) {
        room.countdown = false;
        startMatch(room);
      }
      break;
    case 'B':
      if (room.timer === 0) setPhase(room, 'R', 0);
      break;
    case 'R': {
      room.liveTick++;
      updateZone(room);
      const z = room.zone;
      if (z.dps > 0 && room.liveTick % 30 === 0) {
        for (const p of room.players.values()) {
          if (!p.alive || inSafeZone(room, p.state)) continue;
          damage(room, null, p, Math.ceil(z.dps / 2), false);
        }
      }
      if ([...room.players.values()].filter((p) => p.alive).length <= 1) endRound(room);
      break;
    }
    case 'E':
      if (room.timer === 0) {
        const champ = [...room.players.values()].find((p) => p.wins >= RULES.winRounds);
        if (champ) {
          broadcast(room, { t: 'matchEnd', winner: champ.id });
          setPhase(room, 'O', RULES.matchEnd);
        } else startRound(room);
      }
      break;
    case 'O':
      if (room.timer === 0) startMatch(room);
      break;
  }
}

function join(ws, msg) {
  const name = String(msg.name || '').trim().slice(0, 12) || '플레이어';
  const char = Object.hasOwn(CHARACTERS, msg.c) ? msg.c : DEFAULT_CHARACTER;
  let code = String(msg.room || '').trim().toUpperCase();
  let room;
  if (code) {
    room = rooms.get(code);
    if (!room) return send(ws, { t: 'error', msg: `방 ${code}을(를) 찾을 수 없습니다.` });
  } else {
    code = makeCode();
    room = {
      code, players: new Map(), phase: 'L', timer: 0, round: 0, zone: null, countdown: false,
      card: null, giant: 0, pick: null, firstDead: 0,
    };
    resetMap(room);
    rooms.set(code, room);
  }
  if (room.players.size >= MAX_PLAYERS) return send(ws, { t: 'error', msg: '방이 가득 찼습니다.' });

  const used = new Set([...room.players.values()].map((p) => p.slot));
  const slot = [...Array(MAX_PLAYERS).keys()].find((i) => !used.has(i));
  const p = {
    id: nextId++, ws, name, slot, color: COLORS[slot], room, char,
    state: null, queue: [], lastSeq: 0, yaw: 0, pitch: 0,
    hp: CHARACTERS[char].hp, alive: true, respawnAt: Infinity, kills: 0, deaths: 0, wins: 0, hist: [],
    money: RULES.startMoney, weapon: CHARACTERS[char].weapon, lostWeapon: false, bought: null,
    ghost: false, ghostReady: 0, ghostEarn: 0,
  };
  spawn(p, farthestSpawn(room, p));
  // 라운드 도중에 들어오면 다음 라운드까지 망령
  if (room.phase === 'R' || room.phase === 'E') { p.alive = false; becomeGhost(p); }
  room.players.set(p.id, p);
  const changes = [...room.changes].map(([k, b]) => [...k.split(',').map(Number), b]);
  send(ws, { t: 'welcome', id: p.id, room: code, state: p.state, ph: room.phase, rd: room.round, changes, card: room.card, giant: room.giant });
  roster(room);
  return p;
}

// 대기실에서만 캐릭터를 바꿀 수 있다. 그 자리에서 새 캐릭터로 다시 태어난다
function changeChar(p, c) {
  const room = p.room;
  if (!Object.hasOwn(CHARACTERS, c) || c === p.char || room.phase !== 'L' || !p.alive) return;
  p.char = c;
  p.weapon = sigWeapon(p);
  const s = p.state;
  spawn(p, [s.x, s.y, s.z]);
  roster(room);
}

// 스킬을 쓴 틱. 이동형(대시·도약)은 sim이 이미 처리했고, 여기선 상태형 효과만
function useAbility(room, p, type) {
  const ab = charOf(p.char).ability;
  if (type === 'heal') p.hp = Math.min(maxHp(p), p.hp + ab.amount);
  broadcast(room, { t: 'ab', id: p.id, type });
}

function leave(p) {
  const room = p.room;
  room.players.delete(p.id);
  if (room.players.size === 0) rooms.delete(room.code);
  else roster(room);
}

function buy(p, idx) {
  const room = p.room, w = WEAPONS[idx], sig = sigWeapon(p);
  if (!w || !(SHOP.includes(idx) || idx === sig)) return; // 남의 고유 무기·권총은 못 삼
  if (!p.alive || (room.phase !== 'B' && room.phase !== 'L')) return;
  if (p.weapon === idx) return;
  if (room.phase === 'B') {
    // 이번 구매 시간에 산 걸 다른 걸로 바꾸면 환불
    const refund = p.bought !== null ? WEAPONS[p.bought].price : 0;
    if (p.money + refund < w.price) return;
    p.money += refund - w.price;
    p.bought = idx === sig ? null : idx;
  } // 대기실에선 연습용으로 공짜
  p.weapon = idx;
  Object.assign(p.state, { w: idx, ammo: w.mag, cd: 0, rl: 0, heat: 0 });
}

// rt 틱(소수 가능) 때 q가 있던 위치. 기록이 없으면 null
// 판정은 틱 도중에 일어나므로 hist 마지막 칸은 tick - 1 때의 위치
function positionAt(q, rt) {
  const h = q.hist;
  const find = (t) => h[h.length - 1 - (tick - 1 - t)];
  const a = find(Math.floor(rt)), b = find(Math.ceil(rt));
  if (!a || !b) return null;
  if (!a.alive || !b.alive) return null;
  const f = rt - Math.floor(rt);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
}

// attacker가 null이면 자기장 피해. 죽으면 true
function damage(room, attacker, target, amount, head) {
  target.hp -= amount;
  if (attacker) send(target.ws, { t: 'hurt', x: attacker.state.x, z: attacker.state.z });
  else send(target.ws, { t: 'hurt', zone: true });
  if (target.hp > 0) return false;
  target.hp = 0;
  target.alive = false;
  target.deaths++;
  target.lostWeapon = true;
  if (room.phase === 'L') target.respawnAt = tick + RULES.lobbyRespawn;
  else {
    becomeGhost(target);
    if (!room.firstDead) room.firstDead = target.id;
  }
  if (attacker) {
    attacker.kills++;
    if (room.phase !== 'L') attacker.money = Math.min(RULES.maxMoney, attacker.money + RULES.killReward);
  }
  broadcast(room, {
    t: 'kill', k: attacker ? attacker.id : 0, v: target.id, head,
    respawn: room.phase === 'L' ? RULES.lobbyRespawn * TICK : 0,
  });
  roster(room);
  return true;
}

const scaleOf = (room, p) => (p.id === room.giant ? GIANT.scale : 1);

function fire(room, p, inp, spread) {
  const s = p.state, w = WEAPONS[s.w];
  const o = [s.x, s.y + P.eye * scaleOf(room, p), s.z];
  const rt = Math.min(tick - 1, Math.max(tick - MAX_REWIND, inp.rt));
  const targets = [];
  for (const q of room.players.values()) {
    if (q === p || !q.alive) continue;
    const pos = positionAt(q, rt);
    if (pos) targets.push({ q, boxes: hitboxes(pos, scaleOf(room, q)) });
  }
  const ends = [], dealt = new Map(); // q -> { dmg, head }
  for (const d of shotDirs(s, inp.y, inp.p, spread, inp.s)) {
    const wall = rayBlocks(room.map, o, d, w.range);
    let best = wall ? wall.t : w.range, target = null, head = false;
    for (const { q, boxes } of targets)
      for (const hb of boxes) {
        const t = rayBox(o, d, hb.min, hb.max);
        if (t < best) { best = t; target = q; head = hb.head; }
      }
    ends.push([...o.map((v, i) => +(v + d[i] * best).toFixed(2)), target ? target.id : 0]);
    if (!target && wall && best === wall.t) hitBlock(room, wall.cell, damageAt(w, best, false));
    if (target && !(room.card === 'headonly' && !head)) {
      const r = dealt.get(target) ?? { dmg: 0, head: false };
      r.dmg += damageAt(w, best, head);
      r.head ||= head;
      dealt.set(target, r);
    }
  }
  broadcast(room, { t: 'fx', id: p.id, o, e: ends }, p);
  for (const [q, r] of dealt) {
    if (!q.alive) continue;
    const kill = damage(room, p, q, r.dmg, r.head);
    send(p.ws, { t: 'hit', id: q.id, head: r.head, kill, dmg: r.dmg });
  }
}

const wss = new WebSocketServer({ server, maxPayload: 1024 });
wss.on('connection', (ws) => {
  let me = null;
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === 'join' && !me) me = join(ws, msg) || null;
    else if (msg.t === 'ping') send(ws, { t: 'pong', c: msg.c });
    else if (msg.t === 'buy' && me) buy(me, msg.w | 0);
    else if (msg.t === 'gb' && me) ghostBlock(me, msg);
    else if (msg.t === 'vote' && me) vote(me);
    else if (msg.t === 'pick' && me) pickCard(me, msg.i | 0);
    else if (msg.t === 'char' && me) changeChar(me, msg.c);
    else if (msg.t === 'tp' && me && process.env.DEV) Object.assign(me.state, { x: +msg.x, y: +msg.y, z: +msg.z }); // 테스트용 순간이동
    else if (msg.t === 'i' && me) {
      const k = msg.k | 0, s = msg.s | 0;
      if (k < 0 || k > 511 || s <= me.lastSeq) return;
      if (![msg.y, msg.p, msg.rt].every(Number.isFinite)) return;
      me.queue.push({ s, k, y: msg.y, p: Math.max(-1.55, Math.min(1.55, msg.p)), rt: msg.rt });
      if (me.queue.length > 30) me.queue.shift();
    }
  });
  ws.on('close', () => { if (me) leave(me); });
});

// ---- 게임 루프 ----
setInterval(() => {
  tick++;
  for (const room of rooms.values()) {
    for (const p of room.players.values()) {
      // 한 틱에 최대 3개까지만 처리: 입력을 몰아 보내 빨리 움직이는 것 방지
      for (let n = 0; n < 3 && p.queue.length; n++) {
        const inp = p.queue.shift();
        p.lastSeq = inp.s;
        if (!p.alive) {
          if (p.ghost) {
            p.yaw = inp.y;
            p.pitch = inp.p;
            stepGhost(p.state, inp, W, D, H);
          }
          continue;
        }
        inp.k = maskInput(inp.k, room.phase);
        p.yaw = inp.y;
        p.pitch = inp.p;
        const used = stepPlayer(p.state, inp, room.map, gravityMul(room.card), charOf(p.char));
        if (used) useAbility(room, p, used);
        const spread = stepWeapon(p.state, inp.k);
        if (spread >= 0) fire(room, p, inp, spread);
      }
      if (p.state.y < -10) spawn(p, farthestSpawn(room, p));
    }
    updateRoom(room);
    if (room.blkOut.length) {
      broadcast(room, { t: 'blk', c: room.blkOut });
      room.blkOut = [];
    }
    for (const p of room.players.values()) {
      p.hist.push({ x: p.state.x, y: p.state.y, z: p.state.z, alive: p.alive });
      if (p.hist.length > HISTORY) p.hist.shift();
    }
    if (tick % SNAPSHOT_EVERY === 0) {
      const z = room.zone;
      broadcast(room, {
        t: 's',
        tick,
        ph: room.phase,
        tl: +(room.timer * TICK).toFixed(1),
        zt: room.phase === 'R' ? +(room.liveTick * TICK).toFixed(1) : 0,
        z: z ? [z.x, z.z, z.r, z.next.x, z.next.z, z.next.r, z.shrinking ? 1 : 0, z.voting ? 1 : 0].map((v) => +v.toFixed(2)) : null,
        vt: z?.voting ? [...room.votes.values()] : null,
        rc: room.card ? [room.card, room.giant] : null,
        ps: [...room.players.values()].map((p) => {
          const s = p.state;
          return [p.id, s.x, s.y, s.z, s.vx, s.vy, s.vz, s.g ? 1 : 0, p.yaw, p.pitch, p.lastSeq,
            p.hp, p.alive ? 1 : 0, s.ammo, s.cd, s.rl, s.heat, s.w, s.tr ? 1 : 0, p.money, p.ghost ? 1 : 0,
            s.ab, s.dt, s.ddx, s.ddz];
        }),
      });
    }
  }
}, TICK * 1000);

server.listen(PORT, () => console.log(`block-arena 서버: http://localhost:${PORT}`));
