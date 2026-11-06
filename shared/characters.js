// 캐릭터: 서버(판정)와 클라이언트(예측·화면)가 함께 쓴다 (project_fps에서 가져옴)
// model: client/models/chiikawa_and_friends.glb 안의 노드 이름
// weapon: sim.js WEAPONS의 번호. 고유 무기는 기본 권총 자리를 대신한다 (무료, 죽어도 다시 받음)
// 단위: speed m/s, cooldown 틱(1/60초)
export const CHARACTERS = {
  chiikawa: {
    name: '치이카와', role: '밸런스', model: 'Chiikawa', color: '#ff9fb8',
    hp: 120, speed: 6, weapon: 5,
    ability: { type: 'heal', name: '용기 충전', cooldown: 12 * 60, amount: 50, desc: '체력 50 즉시 회복' },
  },
  hachiware: {
    name: '하치와레', role: '돌격', model: 'Hachiware', color: '#6fb4ff',
    hp: 100, speed: 6.5, weapon: 6,
    ability: { type: 'dash', name: '대시', cooldown: 6 * 60, ticks: 12, speed: 30, desc: '이동 방향으로 순간 돌진' },
  },
  usagi: {
    name: '우사기', role: '기동', model: 'Usagi', color: '#ffcf5c',
    hp: 90, speed: 7.2, weapon: 7,
    // power 11 → 약 2.5칸: 가운데 단상(2칸)·상자 더미엔 오르지만 "못 넘는" 키 큰 벽(3칸)은 못 넘음
    ability: { type: 'leap', name: '우라!', cooldown: 7 * 60, power: 11, desc: '높이 뛰어올라 단상·상자 위로' },
  },
};

export const DEFAULT_CHARACTER = 'chiikawa';
export const charOf = (id) => CHARACTERS[id] ?? CHARACTERS[DEFAULT_CHARACTER];
