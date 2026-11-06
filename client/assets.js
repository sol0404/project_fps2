// 캐릭터 GLB 불러오기 (project_fps에서 가져옴): 셋을 노드별로 나누고 크기·원점·방향을 맞춘다
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CHARACTERS } from '/shared/characters.js';
import { P } from '/shared/sim.js';

const CHARACTER_URL = '/client/models/chiikawa_and_friends.glb';
// 원본 키 약 0.6m → 치이카와가 판정 상자 키(1.85m)에 맞도록. 셋 모두 같은 배율이라 키 차이는 원작대로
const TARGET_HEIGHT = P.h - 0.05;

const loader = new GLTFLoader();
const characters = {}; // id -> { template, height }
const box = new THREE.Box3();
const v = new THREE.Vector3();

export async function loadAssets() {
  const gltf = await loader.loadAsync(CHARACTER_URL);
  gltf.scene.updateMatrixWorld(true);

  let scale = 0;
  for (const [id, def] of Object.entries(CHARACTERS)) {
    const node = gltf.scene.getObjectByName(def.model);
    if (!node) throw new Error(`캐릭터 모델에 '${def.model}' 노드가 없습니다`);

    // Sketchfab 루트의 축 변환(Z-up → Y-up)과 0.01 스케일을 노드에 구워 넣는다
    const model = node.clone(true);
    model.applyMatrix4(node.parent.matrixWorld);

    // 원점: 발바닥 중앙. 원본은 셋이 x축으로 나란히 서 있어서 각자 중심으로 옮긴다
    const pivot = new THREE.Group();
    pivot.add(model);
    box.setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.x -= center.x;
    model.position.z -= center.z;
    model.position.y -= box.min.y;
    // 배율은 치이카와(첫 캐릭터) 기준으로 한 번만 정한다
    if (!scale) scale = TARGET_HEIGHT / box.getSize(v).y;

    // 방향: 원본 얼굴은 +Z, 게임의 정면은 -Z
    pivot.rotation.y = Math.PI;
    pivot.scale.setScalar(scale);

    const template = new THREE.Group();
    template.add(pivot);
    box.setFromObject(template);
    characters[id] = { template, height: box.getSize(v).y };
  }
}

// 캐릭터 하나 복제. 망령(반투명)·피격 번쩍임을 위해 재질은 인스턴스마다 복제한다
// 재질은 KHR_materials_unlit → MeshBasicMaterial. 얼굴은 알파 마스크, 어두운 재질은 외곽선(뒤집힌 껍질)
export function createCharacterModel(id) {
  const { template, height } = characters[id];
  const object = template.clone(true);
  const materials = [];
  object.traverse((o) => {
    if (o.isMesh) {
      o.material = o.material.clone();
      materials.push(o.material);
    }
  });
  return { object, materials, height };
}

// 캐릭터 선택 카드용 정면 썸네일
export function renderThumbnails(size = 160) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(size, size);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  const result = {};
  for (const id of Object.keys(characters)) {
    const scene = new THREE.Scene();
    const { object, height } = createCharacterModel(id);
    scene.add(object);
    camera.position.set(0, height * 0.55, -height * 2.6); // 정면(-Z)에서 바라봄
    camera.lookAt(0, height * 0.45, 0);
    renderer.render(scene, camera);
    result[id] = renderer.domElement.toDataURL('image/png');
  }
  renderer.dispose();
  return result;
}
