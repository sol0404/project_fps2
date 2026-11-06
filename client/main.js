import * as THREE from 'three';
import { createMap, B, BLOCK_HP, GHOST_REMOVABLE, W, D, H } from '/shared/map.js';
import { TICK, P, KEY, WEAPONS, SHOP, GHOST, stepPlayer, stepGhost, stepWeapon, shotDirs, aimDir, maskInput } from '/shared/sim.js';
import { rayBlocks, rayBox, hitboxes } from '/shared/ray.js';
import { zoneStatus, ZONE_START } from '/shared/zone.js';
import { CARDS, GIANT, gravityMul } from '/shared/cards.js';
import { CHARACTERS, DEFAULT_CHARACTER, charOf } from '/shared/characters.js';
import { loadAssets, renderThumbnails } from './assets.js';
import { renderer, scene, camera, buildWorld, makeAvatar, removeAvatar, setAvatarWeapon, setAvatarGhost, setAvatarFlash, animateAvatar, setGhostPreview, setZone, setFog, BLOCK_COLORS } from './world.js';
import { setGunVisible, setGunModel, setScoped, muzzleWorld, gunFired, updateGun, tracer, burst, updateFx, initAudio, sfx } from './fx.js';
import { buildMinimap, drawMinimap } from './minimap.js';
import { isTouch, touch, initTouch, resetTouch } from './touch.js';

const $ = (id) => document.getElementById(id);
let map = createMap();
let mapDirty = true; // 블록이 바뀌면 다음 프레임에 화면·미니맵을 다시 만든다

// ---- 입력 ----
const keys = new Set();
let yaw = 0, pitch = 0, firing = false, aiming = false;
const SENS = 0.0022;
const FOV = 80, SCOPE_FOV = 28;
const TOUCH_SENS = 0.006;
// 터치 기기엔 마우스 잠금이 없으니, 게임에 들어와 있으면 늘 잠긴 것으로 본다
const locked = () => (isTouch ? joined : document.pointerLockElement === renderer.domElement);
function lockPointer() {
  if (!isTouch) return renderer.domElement.requestPointerLock()?.catch?.(() => {});
  // 폰: 전체 화면 + 가로 고정 (지원 안 하는 브라우저면 그냥 넘어감)
  document.documentElement.requestFullscreen?.()?.then(() => screen.orientation?.lock?.('landscape'))?.catch?.(() => {});
}

addEventListener('keydown', (e) => {
  if (!joined) return;
  if (e.code === 'Tab') { e.preventDefault(); $('board').classList.remove('hidden'); }
  if (!locked()) return;
  if (e.code === 'KeyB' && !e.repeat) toggleShop();
  if (e.code === 'KeyF' && !e.repeat && ghost) ghostVote();
  if (e.code === 'KeyC' && !e.repeat) nextChar();
  const n = e.code.match(/^Digit([1-5])$/);
  if (n && shopOpen) buy(shopList()[Number(n[1]) - 1]);
  if (n && cardPick && cardPick.chooser === myId && !cardPick.picked) pickCard(Number(n[1]) - 1);
  keys.add(e.code);
  if (e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (e.code === 'Tab' && phase !== 'O') $('board').classList.add('hidden');
});
addEventListener('blur', () => { keys.clear(); firing = aiming = false; });
addEventListener('mousemove', (e) => {
  if (!locked()) return;
  const sens = SENS * (camera.fov / FOV);
  yaw -= e.movementX * sens;
  pitch = Math.max(-1.55, Math.min(1.55, pitch - e.movementY * sens));
});
addEventListener('mousedown', (e) => {
  if (!locked()) return;
  if (ghost) {
    if (e.button === 0) ghostAction(true);
    if (e.button === 2) ghostAction(false);
    return;
  }
  if (e.button === 0) {
    if (alive) firing = true;
    else cycleSpectate();
  }
  if (e.button === 2) aiming = true;
});
addEventListener('mouseup', (e) => {
  if (e.button === 0) firing = false;
  if (e.button === 2) aiming = false;
});
addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('pointerlockchange', () => {
  if (!locked()) { keys.clear(); firing = aiming = false; }
  if (joined) $('resume').classList.toggle('hidden', locked());
});
$('resume').addEventListener('click', () => { initAudio(); lockPointer(); });

function keyBits() {
  let k = 0;
  if (isTouch) {
    const [mx, my] = touch.move;
    if (my < -0.35) k |= KEY.F;
    if (my > 0.35) k |= KEY.B;
    if (mx < -0.35) k |= KEY.L;
    if (mx > 0.35) k |= KEY.R;
    if (touch.jump) k |= KEY.J;
    if (touch.down) k |= KEY.DOWN;
    if (touch.reload) k |= KEY.RELOAD;
    if (touch.fire && alive) k |= KEY.FIRE;
    if (touch.skill) k |= KEY.SKILL;
  }
  if (keys.has('KeyW')) k |= KEY.F;
  if (keys.has('KeyS')) k |= KEY.B;
  if (keys.has('KeyA')) k |= KEY.L;
  if (keys.has('KeyD')) k |= KEY.R;
  if (keys.has('Space')) k |= KEY.J;
  if (keys.has('ShiftLeft') || keys.has('ShiftRight')) k |= KEY.DOWN;
  if (keys.has('KeyR')) k |= KEY.RELOAD;
  if (keys.has('KeyE')) k |= KEY.SKILL;
  if (firing) k |= KEY.FIRE;
  return k;
}

// ---- 상태 ----
let ws = null, joined = false, myId = 0;
let me = null, prev = null, seq = 0, pending = [];
// 내 캐릭터: 입장 전엔 고른 것, 입장 뒤엔 서버가 보내 준 명단 기준
let myChar = Object.hasOwn(CHARACTERS, storageGet('char')) ? storageGet('char') : DEFAULT_CHARACTER;
const myCh = () => charOf(myChar);
let alive = true, hp = myCh().hp, money = 0, killerId = 0, respawnAt = 0, spectateId = 0;
let ghost = false, ghostReadyAt = 0, ghostTarget = null, votes = null, voted = false;
let card = null, giantId = 0, cardPick = null; // 이번 라운드 규칙 카드, 거인 id, 고르는 중인 카드
const grav = () => gravityMul(card);
const scaleOf = (id) => (id && id === giantId ? GIANT.scale : 1);
let phase = 'L', round = 0, timeLeft = 0, zoneTime = 0, zone = null, starting = false;
const players = new Map(); // id -> { name, color, kills, deaths, wins }
const others = new Map(); // id -> avatar (내 것도 포함, 살아 있을 땐 숨김)
let snaps = []; // [{ t, tick, ps: Map }]
const INTERP_MS = 100;

$('name').value = storageGet('name');
$('join').addEventListener('click', connect);

// ---- 캐릭터 선택 (입장 화면) ----
let assetsReady = false;
loadAssets().then(() => {
  assetsReady = true;
  buildCharSelect(renderThumbnails());
  $('join').disabled = false;
  $('join').textContent = '입장';
}).catch((err) => {
  console.error(err);
  $('error').textContent = '캐릭터 모델을 불러오지 못했습니다. 새로고침해 주세요.';
});

function buildCharSelect(thumbs) {
  const list = $('char-list');
  list.innerHTML = '';
  for (const [id, c] of Object.entries(CHARACTERS)) {
    const card = document.createElement('div');
    card.className = 'char-card' + (id === myChar ? ' selected' : '');
    card.style.setProperty('--c', c.color);
    card.innerHTML = '<img alt=""><h3></h3><div class="role"></div><div class="stat"></div><div class="ab"></div>';
    card.querySelector('img').src = thumbs[id];
    card.querySelector('h3').textContent = c.name;
    card.querySelector('.role').textContent = c.role;
    card.querySelector('.stat').textContent = `체력 ${c.hp} · ${WEAPONS[c.weapon].name}`;
    card.querySelector('.ab').textContent = `[E] ${c.ability.name}: ${c.ability.desc}`;
    card.addEventListener('click', () => {
      myChar = id;
      storageSet('char', id);
      for (const el of list.children) el.classList.toggle('selected', el === card);
    });
    list.append(card);
  }
}

// 대기실에서 C: 다음 캐릭터로 (서버가 그 자리에서 다시 태워 준다)
function nextChar() {
  if (phase !== 'L') return centerMsg('캐릭터는 대기실에서만 바꿀 수 있습니다');
  if (!alive) return;
  const ids = Object.keys(CHARACTERS);
  const c = ids[(ids.indexOf(myChar) + 1) % ids.length];
  storageSet('char', c);
  ws.send(JSON.stringify({ t: 'char', c }));
  centerMsg(`${CHARACTERS[c].name}(으)로 변경`);
  sfx.buy();
}
for (const id of ['name', 'room']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });

function storageGet(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } }
function storageSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

function connect() {
  if (ws || !assetsReady) return;
  initAudio();
  if (isTouch) lockPointer(); // 전체 화면은 버튼을 누른 순간에만 허용된다
  $('error').textContent = '';
  const name = $('name').value.trim();
  storageSet('name', name);
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name, room: $('room').value.trim(), c: myChar }));
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    const wasJoined = joined;
    ws = null; joined = false;
    for (const a of others.values()) removeAvatar(a);
    others.clear();
    players.clear();
    snaps = [];
    zone = null;
    setZone(null);
    closeShop();
    resetTouch();
    for (const id of ['hud', 'resume', 'death', 'board', 'banner']) $(id).classList.add('hidden');
    $('lobby').classList.remove('hidden');
    if (wasJoined) $('error').textContent = '서버와 연결이 끊겼습니다.';
    else if (!$('error').textContent) $('error').textContent = '서버에 연결할 수 없습니다.';
  };
}

const nameOf = (id) => (id === 0 ? '자기장' : players.get(id)?.name ?? '?');
const colorOf = (id) => (id === 0 ? '#4a8cff' : players.get(id)?.color ?? '#fff');

function onMessage(msg) {
  switch (msg.t) {
    case 'error':
      $('error').textContent = msg.msg;
      ws.close();
      break;
    case 'welcome':
      joined = true;
      myId = msg.id;
      me = { ...msg.state };
      prev = { ...me };
      seq = 0; pending = [];
      alive = true; hp = myCh().hp;
      phase = msg.ph; round = msg.rd;
      setCard(msg.card, msg.giant);
      map = createMap();
      for (const [x, y, z, b] of msg.changes) map.set(x, y, z, b);
      mapDirty = true;
      setGunVisible(true);
      $('code').textContent = msg.room;
      $('lobby').classList.add('hidden');
      $('hud').classList.remove('hidden');
      if (!isTouch) $('resume').classList.remove('hidden');
      lockPointer();
      break;
    case 'roster': onRoster(msg.players); break;
    case 's': onSnapshot(msg); break;
    case 'fx': onFx(msg); break;
    case 'blk': onBlocks(msg.c); break;
    case 'ghostCd':
      ghostReadyAt = performance.now() + msg.sec * 1000;
      sfx.buy();
      break;
    case 'ghostCoin':
      centerMsg(`+${msg.n} 코인 · 내 블록이 총알을 막음 (${msg.total}/${GHOST.coinCap})`);
      sfx.hit(false);
      break;
    case 'cards':
      cardPick = { chooser: msg.chooser, options: msg.options, picked: null };
      renderCards();
      break;
    case 'picked':
      if (cardPick) { cardPick.picked = msg.card; renderCards(); }
      sfx.buy();
      break;
    case 'card':
      setCard(msg.card, msg.giant);
      banner(`규칙: ${CARDS[msg.card].name}`, CARDS[msg.card].desc + (msg.card === 'giant' ? ` (${nameOf(msg.giant)})` : ''), '#ffe27a', 3500);
      break;
    case 'zoneDecided':
      voted = false;
      if (msg.votes) centerMsg(`망령 ${msg.votes}표로 다음 자기장이 정해졌습니다`);
      break;
    case 'mapReset':
      map = createMap();
      mapDirty = true;
      break;
    case 'phase': onPhase(msg); break;
    case 'roundEnd':
      if (msg.winner) banner(`${nameOf(msg.winner)} 라운드 승리`, msg.winner === myId ? '+1000 보너스' : '', colorOf(msg.winner));
      else banner('무승부', '살아남은 사람이 없습니다');
      break;
    case 'matchEnd':
      banner(`${nameOf(msg.winner)} 우승!`, '잠시 후 새 경기가 시작됩니다', colorOf(msg.winner), 8000);
      $('board').classList.remove('hidden');
      sfx.round();
      break;
    case 'hit': {
      sfx.hit(msg.head);
      showHitmarker(msg.head, msg.kill);
      if (msg.kill) sfx.kill();
      const a = others.get(msg.id);
      if (a) {
        setAvatarFlash(a, 0.12);
        burst(a.root.position.clone().add(new THREE.Vector3(0, msg.head ? 1.4 : 0.5, 0)), colorOf(msg.id), 6);
      }
      break;
    }
    case 'hurt':
      sfx.hurt();
      flashVignette(msg.zone ? 'zone' : '');
      break;
    case 'kill': onKill(msg); break;
    case 'ab': onAbility(msg); break;
    case 'pong':
      $('ping').textContent = `${Math.round(performance.now() - msg.c)} ms`;
      break;
  }
}

function onPhase({ ph, rd, starting: st }) {
  phase = ph;
  round = rd;
  starting = !!st;
  if (ph !== 'E') { cardPick = null; renderCards(); }
  if (ph === 'B') {
    setCard(null, 0); // 카드가 있으면 바로 뒤에 오는 card 메시지로 다시 정해진다
    banner(`${rd}라운드`, isTouch ? '구매 시간 · 상점에서 눌러서 구매' : '구매 시간 · B 상점 · 숫자 1~5로 구매');
    sfx.round();
    if (alive) openShop();
    $('board').classList.add('hidden');
  } else if (ph === 'R') {
    banner('시작!', '자기장 밖에 있으면 체력이 줄어듭니다', '', 1500);
    closeShop();
  } else if (ph === 'L') {
    if (st) banner('곧 경기 시작', '5초 뒤 1라운드', '', 2000);
    $('board').classList.add('hidden');
  }
}

function onRoster(list) {
  const ids = new Set();
  players.clear();
  for (const p of list) {
    ids.add(p.id);
    players.set(p.id, p);
    if (p.id === myId) myChar = p.char;
    // 대기실에서 캐릭터를 바꾸면 모델도 새로
    const old = others.get(p.id);
    if (old && old.char !== p.char) { removeAvatar(old); others.delete(p.id); }
    if (!others.has(p.id)) others.set(p.id, makeAvatar(p.name, p.color, p.char));
  }
  for (const [id, a] of others) if (!ids.has(id)) { removeAvatar(a); others.delete(id); }

  $('players').innerHTML = '';
  for (const p of list) {
    const li = document.createElement('li');
    li.innerHTML = '<i></i><span></span><b></b>';
    li.querySelector('i').style.background = p.color;
    li.querySelector('span').textContent = `${p.name}${p.id === myId ? ' (나)' : ''} · ${charOf(p.char).name}`;
    li.querySelector('b').textContent = p.wins ? `${p.wins}승` : '';
    $('players').append(li);
  }
  const rows = [...list].sort((a, b) => b.wins - a.wins || b.kills - a.kills || a.deaths - b.deaths);
  $('board-rows').innerHTML = '';
  for (const p of rows) {
    const tr = document.createElement('tr');
    if (p.id === myId) tr.className = 'me';
    tr.innerHTML = '<td><i></i><span></span></td><td></td><td></td><td></td>';
    tr.querySelector('i').style.background = p.color;
    tr.querySelector('span').textContent = p.name;
    tr.children[1].textContent = p.wins;
    tr.children[2].textContent = p.kills;
    tr.children[3].textContent = p.deaths;
    $('board-rows').append(tr);
  }
}

function onSnapshot(msg) {
  phase = msg.ph;
  timeLeft = msg.tl;
  zoneTime = msg.zt;
  zone = msg.z;
  votes = msg.vt;
  if ((msg.rc?.[0] ?? null) !== card || (msg.rc?.[1] ?? 0) !== giantId) setCard(msg.rc?.[0] ?? null, msg.rc?.[1] ?? 0);
  const ps = new Map();
  for (const [id, x, y, z, vx, vy, vz, g, pyaw, ppitch, last, php, palive, ammo, cd, rl, heat, w, tr, pmoney, pghost, ab, dt, ddx, ddz] of msg.ps) {
    ps.set(id, { x, y, z, yaw: pyaw, pitch: ppitch, alive: !!palive, ghost: !!pghost, w });
    if (id !== myId) continue;
    hp = php;
    money = pmoney;
    pending = pending.filter((inp) => inp.s > last);
    const wasAlive = alive;
    alive = !!palive;
    if (alive) {
      // 서버 상태로 맞춘 뒤, 서버가 아직 처리 안 한 입력을 다시 적용 (예측 보정)
      me = { x, y, z, vx, vy, vz, g: !!g, w, ammo, cd, rl, heat, tr: !!tr, ab, dt, ddx, ddz };
      for (const inp of pending) { stepPlayer(me, inp, map, grav(), myCh()); stepWeapon(me, inp.k); }
      if (!wasAlive) { prev = { ...me }; onRespawn(); }
    } else if (pghost) {
      // 망령 위치도 서버 기준으로 맞추고 아직 처리 안 된 입력을 다시 적용
      if (!ghost) enterGhost();
      me = { ...me, x, y, z, vx, vy, vz };
      for (const inp of pending) stepGhost(me, inp, W, D, H);
    } else if (wasAlive) {
      onDeathLocal(); // 대기실에서 죽어 부활을 기다리는 경우
    }
  }
  snaps.push({ t: performance.now(), tick: msg.tick, ps });
  if (snaps.length > 30) snaps.shift();
}

function onRespawn() {
  setGunVisible(true);
  $('death').classList.add('hidden');
  killerId = spectateId = 0;
  if (ghost) {
    ghost = false;
    $('ghost').classList.add('hidden');
    setGhostPreview(null, null, false);
  }
  // 구매 시간 알림이 부활보다 먼저 오므로, 살아난 뒤에 상점을 연다
  if (phase === 'B') openShop();
}

function enterGhost() {
  ghost = true;
  voted = false;
  firing = aiming = false;
  setGunVisible(false);
  closeShop();
  $('death').classList.add('hidden');
  $('ghost').classList.remove('hidden');
  prev = { ...me };
  banner('망령이 되었습니다', '블록으로 산 사람을 막거나 도우세요 · 자기장 위치에 투표하세요', '#b48cff', 3000);
}

// 망령이 보고 있는 블록: 지울 칸(그 블록)과 놓을 칸(맞은 면 바로 앞)
function updateGhostTarget() {
  const hit = rayBlocks(map, [me.x, me.y, me.z], aimDir(yaw, pitch), GHOST.reach);
  if (!hit) { ghostTarget = null; return; }
  const c = hit.cell;
  const place = [c[0] + hit.n[0], c[1] + hit.n[1], c[2] + hit.n[2]];
  const placeOk = place[0] >= 1 && place[0] <= W - 2 && place[2] >= 1 && place[2] <= D - 2
    && place[1] >= 1 && place[1] <= H - 2 && !map.get(...place);
  ghostTarget = { place: placeOk ? place : null, remove: GHOST_REMOVABLE.has(map.get(...c)) ? c : null };
}

function ghostAction(place) {
  if (phase !== 'R') return centerMsg('블록은 전투 중에만 놓을 수 있습니다');
  if (performance.now() < ghostReadyAt) return sfx.empty();
  const cell = place ? ghostTarget?.place : ghostTarget?.remove;
  if (!cell) return sfx.empty();
  ws.send(JSON.stringify({ t: 'gb', place, x: cell[0], y: cell[1], z: cell[2] }));
}

function ghostVote() {
  if (phase !== 'R' || !zone?.[7]) return centerMsg('지금은 투표 시간이 아닙니다');
  ws.send(JSON.stringify({ t: 'vote' }));
  voted = true;
  sfx.buy();
}

function onDeathLocal() {
  firing = aiming = false;
  setGunVisible(false);
  closeShop();
  $('death').classList.remove('hidden');
  if (!killerId) $('death-by').textContent = '관전 중';
}

function onKill({ k, v, head, respawn }) {
  const li = document.createElement('li');
  li.innerHTML = '<span class="k"></span><span class="arrow"></span><span class="v"></span>';
  li.querySelector('.k').textContent = nameOf(k);
  li.querySelector('.k').style.color = colorOf(k);
  li.querySelector('.arrow').textContent = head ? ' ▸ 헤드샷 ▸ ' : ' ▸ ';
  li.querySelector('.v').textContent = nameOf(v);
  li.querySelector('.v').style.color = colorOf(v);
  if (k === myId || v === myId) li.className = 'mine';
  $('feed').prepend(li);
  setTimeout(() => li.remove(), 5000);
  while ($('feed').children.length > 5) $('feed').lastChild.remove();

  if (v === myId && !respawn) {
    // 라운드 중 죽음 → 망령. 서버가 눈높이로 띄워 주므로 미리 맞춰 둔다
    alive = false;
    me.y += P.eye;
    enterGhost();
    centerMsg(k ? `${nameOf(k)}에게 당했습니다` : '자기장에 당했습니다');
  } else if (v === myId) {
    alive = false;
    killerId = k;
    spectateId = k;
    respawnAt = respawn ? performance.now() + respawn * 1000 : 0;
    $('death-by').textContent = k ? `${nameOf(k)}에게 당했습니다` : '자기장에 당했습니다';
    onDeathLocal();
  } else if (k === myId) {
    centerMsg(`${nameOf(v)} 처치${head ? ' (헤드샷)' : ''}${phase === 'L' ? '' : ' +200'}`);
  }
}

// ---- 스킬 ----
// 내 스킬은 예측으로 먼저 소리를 내고(onLocalSkill), 다른 사람 스킬은 서버 알림(ab)으로 효과만
const SKILL_SFX = { heal: () => sfx.heal(), dash: () => sfx.dash(), leap: () => sfx.leap() };
function onLocalSkill(type) {
  SKILL_SFX[type]?.();
  if (type === 'heal') burst(camera.position.clone().addScaledVector(camera.getWorldDirection(new THREE.Vector3()), 0.8), '#7dff9a', 10, 0.06);
}

function onAbility({ id, type }) {
  if (id === myId) return;
  const a = others.get(id);
  if (!a || !a.root.visible) return;
  const at = a.root.position.clone().add(new THREE.Vector3(0, 0.8, 0));
  burst(at, type === 'heal' ? '#7dff9a' : charOf(players.get(id)?.char).color, 12, 0.1);
  if (camera.position.distanceTo(at) < 25) SKILL_SFX[type]?.();
}

// 죽었을 때 클릭하면 살아 있는 다른 사람으로 넘기기
function cycleSpectate() {
  const view = snaps[snaps.length - 1];
  if (!view) return;
  const ids = [...view.ps].filter(([id, p]) => id !== myId && p.alive).map(([id]) => id);
  if (!ids.length) return;
  spectateId = ids[(ids.indexOf(spectateId) + 1) % ids.length];
}

function onBlocks(changes) {
  for (const [x, y, z, b] of changes) {
    const old = map.get(x, y, z);
    map.set(x, y, z, b);
    if (b === B.AIR && old) {
      const at = new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5);
      burst(at, BLOCK_COLORS[old][0], 14, 0.18);
      if (camera.position.distanceTo(at) < 40) sfx.smash();
    }
  }
  mapDirty = true;
}

// ---- 규칙 카드 ----
function setCard(c, giant) {
  card = c || null;
  giantId = giant || 0;
  setFog(card === 'fog');
  $('card-tag').textContent = card ? `규칙: ${CARDS[card].name}` : '';
}

function pickCard(i) {
  ws.send(JSON.stringify({ t: 'pick', i }));
}

function renderCards() {
  const el = $('cards');
  el.classList.toggle('hidden', !cardPick);
  if (!cardPick) return;
  const mine = cardPick.chooser === myId;
  $('cards-title').textContent = cardPick.picked
    ? `${nameOf(cardPick.chooser)}: ${CARDS[cardPick.picked].name}`
    : mine ? `가장 먼저 죽은 당신이 다음 라운드 규칙을 고릅니다 (${isTouch ? '눌러서 고르기' : '1~3'})` : `${nameOf(cardPick.chooser)}이(가) 다음 라운드 규칙을 고르는 중`;
  $('cards-list').innerHTML = '';
  cardPick.options.forEach((id, i) => {
    const li = document.createElement('li');
    if (cardPick.picked) li.className = cardPick.picked === id ? 'picked' : 'dim';
    li.dataset.card = i;
    li.innerHTML = '<kbd></kbd><b></b><span></span>';
    li.querySelector('kbd').textContent = i + 1;
    li.querySelector('b').textContent = CARDS[id].name;
    li.querySelector('span').textContent = CARDS[id].desc;
    $('cards-list').append(li);
  });
}

// ---- 상점 ----
let shopOpen = false;
function openShop() {
  if (!(phase === 'B' || phase === 'L') || !alive) return;
  shopOpen = true;
  renderShop();
  $('shop').classList.remove('hidden');
}
function closeShop() {
  shopOpen = false;
  $('shop').classList.add('hidden');
}
function toggleShop() { if (shopOpen) closeShop(); else openShop(); }

// 상점 목록: 1번 = 내 캐릭터 고유 무기(무료), 2~5번 = 파는 무기
const shopList = () => [myCh().weapon, ...SHOP];

// 돈 확인은 서버가 한다 (이번 구매 시간에 산 것을 바꾸면 환불까지 계산)
function buy(idx) {
  if (!shopOpen || idx === undefined || me.w === idx) return;
  ws.send(JSON.stringify({ t: 'buy', w: idx }));
  sfx.buy();
}

function renderShop() {
  const free = phase === 'L';
  $('shop-money').textContent = free ? '대기실: 전부 무료(연습)' : `${money.toLocaleString()} 코인`;
  $('shop-list').innerHTML = '';
  shopList().forEach((i, n) => {
    const w = WEAPONS[i];
    const li = document.createElement('li');
    const owned = me && me.w === i;
    const can = free || w.price <= money;
    li.className = owned ? 'owned' : can ? '' : 'poor';
    li.dataset.shop = i;
    li.innerHTML = '<kbd></kbd><span class="nm"></span><span class="st"></span><span class="pr"></span>';
    li.querySelector('kbd').textContent = n + 1;
    li.querySelector('.nm').textContent = w.name;
    li.querySelector('.st').textContent = `${w.pellets > 1 ? `${w.dmg}×${w.pellets}` : w.dmg} 피해 · ${w.mag}발 · ${w.auto ? '연사' : '단발'}`;
    li.querySelector('.pr').textContent = owned ? '보유' : w.price ? w.price.toLocaleString() : '무료';
    $('shop-list').append(li);
  });
}

// ---- 화면 알림 ----
let bannerTimer = 0;
function banner(title, sub = '', color = '', ms = 2500) {
  $('banner-title').textContent = title;
  $('banner-title').style.color = color || '';
  $('banner-sub').textContent = sub;
  $('banner').classList.remove('hidden');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => $('banner').classList.add('hidden'), ms);
}

let centerTimer = 0;
function centerMsg(text) {
  $('center').textContent = text;
  $('center').classList.remove('hidden');
  clearTimeout(centerTimer);
  centerTimer = setTimeout(() => $('center').classList.add('hidden'), 1500);
}

let hitTimer = 0;
function showHitmarker(head, kill) {
  const el = $('hitmarker');
  el.className = kill ? 'kill' : head ? 'head' : '';
  clearTimeout(hitTimer);
  hitTimer = setTimeout(() => el.classList.add('hidden'), kill ? 300 : 150);
}

function flashVignette(kind) {
  const v = $('vignette');
  v.className = kind;
  v.style.transition = 'none';
  v.style.opacity = '1';
  requestAnimationFrame(() => {
    v.style.transition = 'opacity 0.5s';
    v.style.opacity = '0';
  });
}

setInterval(() => { if (joined) ws.send(JSON.stringify({ t: 'ping', c: performance.now() })); }, 2000);

// ---- 보간: 100ms 전 시점을 그린다. 그 시점의 서버 틱을 사격 판정에 함께 보낸다 ----
const lerp = (a, b, t) => a + (b - a) * t;
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function viewAt(now) {
  if (!snaps.length) return null;
  const t = now - INTERP_MS;
  let s0 = snaps[0], s1 = snaps[0];
  if (t >= snaps[snaps.length - 1].t) s0 = s1 = snaps[snaps.length - 1];
  else for (let i = 0; i < snaps.length - 1; i++)
    if (snaps[i + 1].t >= t) { s0 = snaps[i]; s1 = snaps[i + 1]; break; }
  const f = s1.t > s0.t ? Math.max(0, Math.min(1, (t - s0.t) / (s1.t - s0.t))) : 0;
  return { s0, s1, f, tick: lerp(s0.tick, s1.tick, f) };
}

function posAt(view, id) {
  const p0 = view.s0.ps.get(id), p1 = view.s1.ps.get(id) ?? p0;
  if (!p0) return null;
  // 부활처럼 순간이동한 경우엔 보간하지 않음
  const f = Math.hypot(p1.x - p0.x, p1.z - p0.z) > 3 ? 1 : view.f;
  return {
    x: lerp(p0.x, p1.x, f), y: lerp(p0.y, p1.y, f), z: lerp(p0.z, p1.z, f),
    yaw: lerpAngle(p0.yaw, p1.yaw, f), pitch: lerp(p0.pitch, p1.pitch, f), alive: p1.alive, ghost: p1.ghost, w: p1.w,
  };
}

function updateOthers(view, dt, hideId) {
  for (const [id, a] of others) {
    const p = view && posAt(view, id);
    if (!p) { a.root.visible = false; continue; }
    a.root.visible = id !== hideId && !(id === myId && (alive || ghost));
    setAvatarGhost(a, p.ghost);
    const speed = Math.hypot(p.x - a.root.position.x, p.z - a.root.position.z) / Math.max(dt, 1e-3);
    // 망령의 y는 눈높이라 발 위치로 내리고 둥둥 떠 있게
    a.root.position.set(p.x, p.ghost ? p.y - P.eye + Math.sin(performance.now() / 400 + id) * 0.1 : p.y, p.z);
    a.root.rotation.y = p.yaw;
    a.root.scale.setScalar(scaleOf(id));
    setAvatarWeapon(a, p.w);
    const amt = p.alive && !p.ghost ? Math.min(1, speed / P.speed) : 0;
    if (p.ghost) a.fall = 0;
    animateAvatar(a, dt, amt);
    if (!p.ghost) a.fall += ((p.alive ? 0 : 1) - a.fall) * Math.min(1, dt * 8);
    a.body.rotation.x = -a.fall * Math.PI / 2;
    a.tag.visible = p.alive;
    if (a.flash > 0) setAvatarFlash(a, Math.max(0, a.flash - dt));
  }
}

// ---- 사격 표시 ----
function localShot(inp, spread) {
  const o = [me.x, me.y + P.eye * scaleOf(myId), me.z];
  const w = WEAPONS[me.w];
  const from = muzzleWorld();
  for (const d of shotDirs(me, inp.y, inp.p, spread, inp.s)) {
    const wall = rayBlocks(map, o, d, w.range);
    let best = wall ? wall.t : w.range, hitPlayer = false;
    for (const [id, a] of others) {
      if (id === myId || !a.root.visible || a.fall > 0.5 || a.ghost) continue;
      for (const hb of hitboxes(a.root.position, scaleOf(id))) {
        const t = rayBox(o, d, hb.min, hb.max);
        if (t < best) { best = t; hitPlayer = true; }
      }
    }
    const end = new THREE.Vector3(o[0] + d[0] * best, o[1] + d[1] * best, o[2] + d[2] * best);
    tracer(scoped() ? new THREE.Vector3(o[0], o[1] - 0.15, o[2]) : from, end);
    if (wall && !hitPlayer) {
      const b = map.get(...wall.cell);
      burst(end, BLOCK_COLORS[b]?.[0] ?? '#888', w.pellets > 1 ? 1 : 4, 0.06);
      if (BLOCK_HP[b] && w.pellets === 1) sfx.crack();
    }
  }
  gunFired();
  sfx.shot(me.w);
}

function onFx({ id, o, e }) {
  const from = new THREE.Vector3(o[0], o[1] - 0.25, o[2]);
  for (const [x, y, z, hit] of e) {
    const to = new THREE.Vector3(x, y, z);
    tracer(from, to);
    if (hit && hit !== myId) burst(to, colorOf(hit), 4);
    else if (!hit) burst(to, '#999', e.length > 1 ? 1 : 3, 0.05);
  }
  const w = snaps[snaps.length - 1]?.ps.get(id)?.w ?? 2;
  sfx.far(me ? Math.hypot(o[0] - me.x, o[2] - me.z) : 30, w);
}

const scoped = () => aiming && alive && me.w === 4 && me.rl === 0;

// ---- HUD ----
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function updateHud(now) {
  const w = WEAPONS[me.w];
  $('hp-num').textContent = alive ? hp : 0;
  const maxHp = myId === giantId ? GIANT.hp : myCh().hp;
  $('hp-bar').style.width = `${Math.min(1, (alive ? hp : 0) / maxHp) * 100}%`;
  $('hp-bar').className = hp <= 30 ? 'low' : '';
  $('ammo-num').textContent = me.ammo;
  $('ammo-max').textContent = `/ ${w.mag}`;
  $('weapon-name').textContent = w.name;
  $('money').textContent = phase === 'L' ? '' : `${money.toLocaleString()} 코인`;
  $('reload').classList.toggle('hidden', !(alive && me.rl > 0));
  if (!alive) {
    $('death-timer').textContent = respawnAt
      ? `${Math.max(0, Math.ceil((respawnAt - now) / 1000))}초 후 부활`
      : '다음 라운드까지 관전 · 클릭해서 다른 사람 보기';
  }
  if (shopOpen) renderShop();
  $('hp').classList.toggle('hidden', ghost);
  const ab = myCh().ability, cdLeft = alive ? (me.ab ?? 0) * TICK : 0;
  $('skill').classList.toggle('hidden', !alive);
  $('skill').classList.toggle('ready', cdLeft <= 0);
  $('skill-name').textContent = ab.name;
  $('skill-cd').textContent = cdLeft > 0 ? `${cdLeft.toFixed(1)}초` : '준비됨';
  $('ammo').classList.toggle('hidden', ghost);
  if (ghost) {
    const left = Math.max(0, (ghostReadyAt - now) / 1000);
    $('ghost-cd').textContent = phase !== 'R' ? '다음 라운드에 부활' : left > 0 ? `블록 ${left.toFixed(1)}초` : '블록 준비됨';
    $('ghost-cd').className = left > 0 || phase !== 'R' ? '' : 'ready';
    const voting = phase === 'R' && zone?.[7];
    const key = isTouch ? '투표 버튼' : 'F';
    $('ghost-vote').textContent = voting ? (voted ? `투표함 · 다시 ${key}로 위치 바꾸기` : `${key}: 지금 위치로 다음 자기장 투표`) : '';
  }

  let top = '', sub = '';
  if (phase === 'L') {
    top = '대기실';
    sub = starting && timeLeft > 0 ? `${Math.ceil(timeLeft)}초 후 경기 시작` : players.size < 2 ? '2명 이상 모이면 시작 · 지금은 연습' : '';
  } else if (phase === 'B') {
    top = `${round}라운드 · 구매 ${Math.ceil(timeLeft)}`;
    sub = 'B 상점';
  } else if (phase === 'R') {
    const zs = zoneStatus(zoneTime);
    top = `${round}라운드`;
    sub = zs.closed ? '자기장이 모두 닫혔습니다'
      : zs.voting ? `망령이 다음 자기장 위치 투표 중 ${fmt(zs.left)}`
      : zs.shrinking ? `자기장 줄어드는 중 ${fmt(zs.left)}` : `다음 자기장 ${fmt(zs.left)}`;
  } else if (phase === 'E') top = `${round}라운드 끝`;
  else if (phase === 'O') top = '경기 끝';
  $('round-top').textContent = top;
  $('round-sub').textContent = sub;

  // 자기장 밖이면 화면 테두리를 파랗게
  const d = zone ? Math.hypot(me.x - zone[0], me.z - zone[1]) : 0;
  const outside = alive && zone && phase === 'R' && (card === 'reverse' ? d < ZONE_START.r - zone[2] : d > zone[2]);
  $('outside').classList.toggle('hidden', !outside);
}

// ---- 터치 ----
if (isTouch) {
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25)); // 폰 성능
  renderer.setSize(innerWidth, innerHeight);
  $('ghost-keys').textContent = '놓기 · 지우기 버튼 · 위/아래 버튼으로 높이';
  $('shop-foot').textContent = '눌러서 구매 · 상점 버튼으로 닫기 · 살아남으면 다음 라운드에도 유지';
  initTouch({
    active: () => joined,
    look(dx, dy) {
      const sens = TOUCH_SENS * (camera.fov / FOV);
      yaw -= dx * sens;
      pitch = Math.max(-1.55, Math.min(1.55, pitch - dy * sens));
    },
    tap(act, i) {
      if (act === 'shop') toggleShop();
      else if (act === 'board') $('board').classList.toggle('hidden');
      else if (act === 'place') ghostAction(true);
      else if (act === 'remove') ghostAction(false);
      else if (act === 'vote') ghostVote();
      else if (act === 'aim') aiming = !aiming;
      else if (act === 'buy') buy(i);
      else if (act === 'card' && cardPick?.chooser === myId && !cardPick.picked) pickCard(i);
    },
  });
}

function updateTouchUi() {
  const show = (id, v) => $(id).classList.toggle('hidden', !v);
  const voting = phase === 'R' && zone?.[7];
  for (const id of ['t-fire', 't-jump', 't-reload', 't-skill']) show(id, alive);
  $('t-skill').textContent = myCh().ability.name;
  $('t-skill').classList.toggle('cool', (me.ab ?? 0) > 0);
  show('t-aim', alive && me.w === 4);
  show('t-shop', alive && (phase === 'B' || phase === 'L'));
  for (const id of ['t-place', 't-remove', 't-up', 't-down']) show(id, ghost);
  show('t-vote', ghost && voting);
  $('t-aim').classList.toggle('on', aiming);
}

// ---- 메인 루프: 60틱 고정 시뮬레이션 + 화면은 보간 ----
let acc = 0, last = performance.now();
function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (joined) {
    const view = viewAt(now);
    acc += dt;
    while (acc >= TICK) {
      acc -= TICK;
      const k = alive ? maskInput(keyBits(), phase) : ghost ? keyBits() & ~(KEY.FIRE | KEY.RELOAD) : 0;
      const inp = { s: ++seq, k, y: yaw, p: pitch, rt: view ? Math.round(view.tick * 100) / 100 : 0 };
      if (alive) {
        prev = { ...me };
        const wasCool = me.ab > 0;
        const used = stepPlayer(me, inp, map, grav(), myCh());
        if (used) onLocalSkill(used);
        else if (wasCool && me.ab === 0) sfx.skillReady();
        const spread = stepWeapon(me, inp.k);
        if (spread >= 0) localShot(inp, spread);
      } else if (ghost) {
        prev = { ...me };
        stepGhost(me, inp, W, D, H);
      }
      pending.push(inp);
      if (pending.length > 120) pending.shift();
      ws.send(JSON.stringify({ t: 'i', ...inp }));
    }

    // 죽었으면 관전: 나를 쏜 사람 → 없으면 살아 있는 아무나
    let spectating = 0;
    if (ghost) {
      const a = acc / TICK;
      camera.position.set(lerp(prev.x, me.x, a), lerp(prev.y, me.y, a), lerp(prev.z, me.z, a));
      camera.rotation.set(pitch, yaw, 0);
      updateGhostTarget();
      const ready = performance.now() >= ghostReadyAt && phase === 'R';
      setGhostPreview(ghostTarget?.place, ghostTarget?.remove, ready);
    } else if (alive) {
      const a = acc / TICK;
      camera.position.set(lerp(prev.x, me.x, a), lerp(prev.y, me.y, a) + P.eye * scaleOf(myId), lerp(prev.z, me.z, a));
      camera.rotation.set(pitch, yaw, 0);
    } else if (view) {
      let t = spectateId && posAt(view, spectateId);
      if (!t || !t.alive) {
        cycleSpectate();
        t = spectateId && posAt(view, spectateId);
      }
      if (t && t.alive) {
        spectating = spectateId;
        camera.position.set(t.x, t.y + P.eye * scaleOf(spectateId), t.z);
        camera.rotation.set(t.pitch, t.yaw, 0);
        $('death-watch').textContent = `${nameOf(spectateId)} 시점`;
      } else $('death-watch').textContent = '';
    }
    const zoom = scoped();
    const fov = lerp(camera.fov, zoom ? SCOPE_FOV : FOV, Math.min(1, dt * 20));
    if (Math.abs(fov - camera.fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
    setScoped(zoom);
    $('scope').classList.toggle('hidden', !zoom);
    $('crosshair').classList.toggle('hidden', zoom);

    setGunModel(me.w);
    setZone(zone, card === 'reverse', ZONE_START.r);
    updateOthers(view, dt, spectating);
    updateGun(dt, me.rl > 0 ? 1 - me.rl / WEAPONS[me.w].reload : -1, alive && me.g && Math.hypot(me.vx, me.vz) > 0.5);
    updateHud(now);
    if (isTouch) updateTouchUi();
    drawMinimap(zone, alive || ghost ? { x: me.x, z: me.z, yaw, ghost } : null, votes, card === 'reverse', ZONE_START.r);
  }
  if (mapDirty) {
    mapDirty = false;
    buildWorld(map);
    buildMinimap(map);
  }
  updateFx(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
