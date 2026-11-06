// 장면, 블록 맵, 플레이어 아바타
import * as THREE from 'three';
import { W, D, H, B } from '/shared/map.js';
import { createCharacterModel } from './assets.js';

export const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);

export const scene = new THREE.Scene();
scene.background = new THREE.Color('#8fc9f0');
scene.fog = new THREE.Fog('#8fc9f0', 30, 75);
scene.add(new THREE.HemisphereLight('#ffffff', '#6b7a5a', 1.6));
const sun = new THREE.DirectionalLight('#ffffff', 1.4);
sun.position.set(30, 50, 15);
scene.add(sun);

export const camera = new THREE.PerspectiveCamera(80, innerWidth / innerHeight, 0.05, 200);
camera.rotation.order = 'YXZ';
camera.position.set(W / 2, 12, D + 6);
camera.lookAt(W / 2, 0, D / 2);
scene.add(camera); // 총 모델을 카메라에 붙이기 위해

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// ---- 맵 그리기: 겉으로 드러난 블록만 InstancedMesh 하나로 ----
function blockTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 16, 16);
  g.strokeStyle = 'rgba(0,0,0,0.18)';
  g.strokeRect(0.5, 0.5, 15, 15);
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export const BLOCK_COLORS = {
  [B.FLOOR]: ['#6cbf5a', '#63b352'],
  [B.WALL]: ['#8a909b', '#828893'],
  [B.STONE]: ['#c9bfa8', '#beb49c'],
  [B.CRATE]: ['#c98a3e', '#bd8037'],
  [B.COVER]: ['#5b7fbf', '#5377b5'],
  [B.GHOST]: ['#b48cff', '#a77ef5'],
};

// 블록이 바뀔 때마다 통째로 다시 만든다 (맵이 작아서 몇 ms면 됨)
const blockMat = new THREE.MeshLambertMaterial({ map: blockTexture() });
const blockGeo = new THREE.BoxGeometry(1, 1, 1);
let worldMesh = null;

export function buildWorld(map) {
  if (worldMesh) { scene.remove(worldMesh); worldMesh.dispose(); }
  const list = [];
  for (let y = 0; y < H; y++)
    for (let z = 0; z < D; z++)
      for (let x = 0; x < W; x++) {
        const b = map.get(x, y, z);
        if (!b) continue;
        const exposed = !map.solid(x + 1, y, z) || !map.solid(x - 1, y, z) || !map.solid(x, y + 1, z)
          || (y > 0 && !map.solid(x, y - 1, z)) || !map.solid(x, y, z + 1) || !map.solid(x, y, z - 1);
        if (exposed) list.push([x, y, z, b]);
      }
  const mesh = new THREE.InstancedMesh(blockGeo, blockMat, list.length);
  const m = new THREE.Matrix4(), col = new THREE.Color();
  list.forEach(([x, y, z, b], i) => {
    m.setPosition(x + 0.5, y + 0.5, z + 0.5);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, col.set(BLOCK_COLORS[b][(x + y + z) & 1]));
  });
  scene.add(mesh);
  worldMesh = mesh;
}

// ---- 아바타 ----
function part(w, h, d, color, x, y, z) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }));
  mesh.position.set(x, y, z);
  return mesh;
}

function nameTag(text) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 34px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(0,0,0,0.6)';
  g.strokeText(text, 128, 32);
  g.fillStyle = '#fff';
  g.fillText(text, 128, 32);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  sprite.scale.set(1.6, 0.4, 1);
  sprite.position.y = 2.2;
  return sprite;
}

// 캐릭터 모델 아바타 (project_fps 모델). 걸을 땐 통통 튀고, 죽으면 발을 축으로 눕는다
// root(위치·방향) > body(쓰러짐) > hop(걷기 바운스) > 모델
export function makeAvatar(name, color, char) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  const hop = new THREE.Group();
  const { object, materials, height } = createCharacterModel(char);
  hop.add(object);
  // 오른손 쪽에 든 총. 길이는 무기에 따라 setAvatarWeapon에서
  const gun = part(0.1, 0.12, 0.55, '#2b2b30', 0.42, 0.75, -0.25);
  hop.add(gun);
  body.add(hop);
  const tag = nameTag(name);
  tag.position.y = Math.max(2.2, height + 0.3);
  tag.material.color.set(color);
  root.add(body, tag);
  scene.add(root);
  const mats = [...materials, gun.material];
  const baseColors = mats.map((m) => m.color.clone());
  return { root, body, hop, gun, tag, mats, baseColors, char, phase: 0, bounce: 0, fall: 0, flash: 0, w: -1, ghost: false };
}

// 맞으면 잠깐 하얗게 (모델 재질이 조명을 안 받는 MeshBasic이라 emissive 대신 색을 섞는다)
const WHITE = new THREE.Color('#ffffff'), GHOST_TINT = new THREE.Color('#d6c2ff');
function applyTint(a) {
  a.mats.forEach((m, i) => {
    m.color.copy(a.baseColors[i]);
    if (a.ghost) m.color.lerp(GHOST_TINT, 0.6);
    if (a.flash > 0) m.color.lerp(WHITE, 0.6);
  });
}

export function setAvatarFlash(a, flash) {
  const was = a.flash > 0;
  a.flash = flash;
  if (was !== flash > 0) applyTint(a);
}

// 걷기: 통통 튀고 살짝 찌그러짐 (speed = 0~1)
export function animateAvatar(a, dt, amt) {
  a.bounce += (amt - a.bounce) * Math.min(1, dt * 10);
  a.phase += dt * 14 * amt;
  const squash = Math.cos(a.phase * 2) * 0.06 * a.bounce;
  a.hop.position.y = Math.abs(Math.sin(a.phase)) * 0.18 * a.bounce;
  a.hop.scale.set(1 + squash, 1 - squash, 1 + squash);
  a.hop.rotation.z = Math.sin(a.phase) * 0.08 * a.bounce;
}

// 망령: 반투명하게, 총은 숨김
export function setAvatarGhost(a, ghost) {
  if (a.ghost === ghost) return;
  a.ghost = ghost;
  a.gun.visible = !ghost;
  for (const m of a.mats) {
    m.transparent = ghost;
    m.opacity = ghost ? 0.3 : 1;
    m.depthWrite = !ghost;
    m.needsUpdate = true;
  }
  applyTint(a);
  a.tag.material.opacity = ghost ? 0.5 : 1;
}

// 망령이 블록을 놓을 칸(보라 반투명)과 지울 칸(빨간 테두리) 미리보기
const placeBox = new THREE.Mesh(
  new THREE.BoxGeometry(1.01, 1.01, 1.01),
  new THREE.MeshBasicMaterial({ color: '#b48cff', transparent: true, opacity: 0.35, depthWrite: false }),
);
const removeBox = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.03, 1.03, 1.03)),
  new THREE.LineBasicMaterial({ color: '#ff4a4a' }),
);
placeBox.visible = removeBox.visible = false;
scene.add(placeBox, removeBox);

export function setGhostPreview(place, remove, ready) {
  placeBox.visible = !!place;
  if (place) placeBox.position.set(place[0] + 0.5, place[1] + 0.5, place[2] + 0.5);
  placeBox.material.opacity = ready ? 0.4 : 0.12;
  removeBox.visible = !!remove;
  if (remove) removeBox.position.set(remove[0] + 0.5, remove[1] + 0.5, remove[2] + 0.5);
  removeBox.material.color.set(ready ? '#ff4a4a' : '#884444');
}

const AVATAR_GUN_LEN = [0.5, 0.8, 1, 0.9, 1.35, 0.85, 0.95, 0.7];
export function setAvatarWeapon(a, w) {
  if (a.w === w) return;
  a.w = w;
  const len = AVATAR_GUN_LEN[w] ?? 1;
  a.gun.scale.z = len;
  a.gun.position.z = 0.05 - 0.275 * len;
}

// ---- 자기장 벽: 안쪽에서도 보이게 양면, 반투명 ----
const zoneMesh = new THREE.Mesh(
  new THREE.CylinderGeometry(1, 1, 1, 72, 1, true),
  new THREE.MeshBasicMaterial({ color: '#4a8cff', transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false, fog: false }),
);
zoneMesh.visible = false;
scene.add(zoneMesh);

// z = [x, z, r, ...] 또는 null. reverse면 (startR - r) 반지름의 빨간 원(그 안이 위험)
export function setZone(z, reverse = false, startR = 30) {
  const r = z ? (reverse ? startR - z[2] : z[2]) : 0;
  zoneMesh.visible = !!z && r > 0.05;
  if (!zoneMesh.visible) return;
  zoneMesh.material.color.set(reverse ? '#ff4a4a' : '#4a8cff');
  zoneMesh.position.set(z[0], 40, z[1]);
  zoneMesh.scale.set(r, 80, r); // 위 끝이 하늘에 보이지 않게 높게
}

// 안개 카드
export function setFog(dense) {
  scene.fog.near = dense ? 3 : 30;
  scene.fog.far = dense ? 16 : 75;
  scene.fog.color.set(dense ? '#c9d3dc' : '#8fc9f0');
  scene.background.set(dense ? '#c9d3dc' : '#8fc9f0');
}

export function removeAvatar(a) {
  scene.remove(a.root);
  // 모델의 형상·텍스처는 다른 아바타와 함께 쓰므로 복제한 재질만 버린다
  for (const m of a.mats) m.dispose();
  a.gun.geometry.dispose();
  a.tag.material.map.dispose();
  a.tag.material.dispose();
}
