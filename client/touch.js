// 터치 조작: 왼쪽 = 누른 자리에 생기는 조이스틱, 오른쪽 = 드래그로 시점, 버튼들
// 사격 버튼은 누른 채로 끌면 시점도 같이 돌아간다

// 주 입력이 손가락인 기기(폰·태블릿). 터치스크린 노트북은 마우스 조작 그대로
// 주소 뒤에 ?touch 를 붙이면 PC에서도 터치 화면으로 볼 수 있다 (확인용)
export const isTouch = matchMedia('(pointer: coarse)').matches || new URLSearchParams(location.search).has('touch');

// main.js가 읽는 상태
export const touch = { move: [0, 0], fire: false, jump: false, reload: false, down: false, skill: false };

const $ = (id) => document.getElementById(id);
const HOLD = { 't-fire': 'fire', 't-jump': 'jump', 't-reload': 'reload', 't-down': 'down', 't-up': 'jump', 't-skill': 'skill' };
const STICK_R = 50;

let handlers = null;
const touches = new Map(); // identifier -> { kind: 'stick' | 'look' | 'hold', x, y, ox, oy, key }

export function initTouch(h) {
  handlers = h;
  document.body.classList.add('touch');
  const opts = { passive: false };
  addEventListener('touchstart', onStart, opts);
  addEventListener('touchmove', onMove, opts);
  addEventListener('touchend', onEnd, opts);
  addEventListener('touchcancel', onEnd, opts);
}

function onStart(e) {
  if (!handlers.active()) return; // 입장 화면에선 평소대로 (입력칸 쓰기)
  e.preventDefault();
  for (const t of e.changedTouches) {
    const el = document.elementFromPoint(t.clientX, t.clientY);
    // 상점·카드 목록은 눌러서 고른다
    const item = el?.closest('[data-shop], [data-card]');
    if (item) {
      if (item.dataset.shop) handlers.tap('buy', Number(item.dataset.shop));
      else handlers.tap('card', Number(item.dataset.card));
      continue;
    }
    const btn = el?.closest('.tbtn');
    if (btn) {
      btn.classList.add('on');
      const key = HOLD[btn.id];
      if (key) touch[key] = true;
      else handlers.tap(btn.dataset.act);
      // 사격 버튼은 시점 드래그도 겸한다
      touches.set(t.identifier, { kind: btn.id === 't-fire' ? 'firelook' : 'hold', x: t.clientX, y: t.clientY, key, btn });
      continue;
    }
    if (t.clientX < innerWidth * 0.4) {
      touches.set(t.identifier, { kind: 'stick', ox: t.clientX, oy: t.clientY });
      const base = $('stick');
      base.style.left = `${t.clientX}px`;
      base.style.top = `${t.clientY}px`;
      base.classList.remove('hidden');
      $('knob').style.transform = 'translate(-50%, -50%)';
    } else {
      touches.set(t.identifier, { kind: 'look', x: t.clientX, y: t.clientY });
    }
  }
}

function onMove(e) {
  if (!touches.size) return;
  e.preventDefault();
  for (const t of e.changedTouches) {
    const s = touches.get(t.identifier);
    if (!s) continue;
    if (s.kind === 'stick') {
      let dx = t.clientX - s.ox, dy = t.clientY - s.oy;
      const len = Math.hypot(dx, dy);
      if (len > STICK_R) { dx *= STICK_R / len; dy *= STICK_R / len; }
      touch.move = [dx / STICK_R, dy / STICK_R];
      $('knob').style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    } else if (s.kind === 'look' || s.kind === 'firelook') {
      handlers.look(t.clientX - s.x, t.clientY - s.y);
      s.x = t.clientX;
      s.y = t.clientY;
    }
  }
}

function onEnd(e) {
  for (const t of e.changedTouches) {
    const s = touches.get(t.identifier);
    if (!s) continue;
    touches.delete(t.identifier);
    if (s.kind === 'stick') {
      touch.move = [0, 0];
      $('stick').classList.add('hidden');
    }
    if (s.btn) s.btn.classList.remove('on');
    if (s.key) touch[s.key] = false;
  }
}

export function resetTouch() {
  touches.clear();
  touch.move = [0, 0];
  touch.fire = touch.jump = touch.reload = touch.down = touch.skill = false;
  $('stick')?.classList.add('hidden');
  for (const b of document.querySelectorAll('.tbtn.on')) b.classList.remove('on');
}
