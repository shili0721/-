if (!window.THREE) throw new Error('本地 three.min.js 加载失败：请确认 vendor/three.min.js 存在。');

/* =========================================================
 * 体素关卡编辑器
 * - 平面模式：在固定高度层上画单层体素
 * - 堆叠模式：直接在已有体素面上堆叠/挖取
 * - 物件：多个体素物件可独立位移/旋转/分层，组合成完整物体
 * - 螺丝：自动布点 + 手动增删改色
 * - 数据：localStorage 自动存 + 导出/导入 JSON
 * ========================================================= */

const COLORS = [
  { name:'red',    hex:0xff5d5d, css:'#ff5d5d' },
  { name:'green',  hex:0x4dd07a, css:'#4dd07a' },
  { name:'purple', hex:0xb06dff, css:'#b06dff' },
  { name:'blue',   hex:0x4d8cff, css:'#4d8cff' },
  { name:'gray',   hex:0xa0a7b8, css:'#a0a7b8' },
  { name:'brown',  hex:0x9b6b43, css:'#9b6b43' },
  { name:'white',  hex:0xf3f5fa, css:'#f3f5fa' },
  { name:'yellow', hex:0xffd166, css:'#ffd166' },
];
const colorByName = n => COLORS.find(c => c.name === n) || COLORS[0];

const VOXEL = 1;            // 体素边长
const STORAGE_KEY = 'screw_editor_level_v1';
const CUSTOM_LEVEL_KEY = 'screw_custom_level';   // 与游戏共享：试玩用

/* ---------------- 场景搭建 ---------------- */
const app = document.getElementById('app');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14172a);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth/window.innerHeight, 0.1, 500);
const orbit = { target:new THREE.Vector3(0,1,0), radius:24, theta:0.6, phi:Math.PI*0.36, minPhi:0.05, maxPhi:Math.PI-0.05 };
function updateCamera(){
  const r = orbit.radius, sp = Math.sin(orbit.phi), cp = Math.cos(orbit.phi);
  camera.position.set(orbit.target.x + r*sp*Math.sin(orbit.theta), orbit.target.y + r*cp, orbit.target.z + r*sp*Math.cos(orbit.theta));
  camera.lookAt(orbit.target);
}
updateCamera();

const renderer = new THREE.WebGLRenderer({ antialias:true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// 色彩空间 + 色调映射：新版 three(r152+) 需显式设置，否则颜色发白过曝
if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
app.appendChild(renderer.domElement);

scene.add(new THREE.AmbientLight(0xffffff, 0.45));
const hemi = new THREE.HemisphereLight(0xf1f8ff, 0x40476a, 0.35); scene.add(hemi);
const dir = new THREE.DirectionalLight(0xffffff, 0.9);
dir.position.set(10, 22, 12); dir.castShadow = true; dir.shadow.mapSize.set(2048,2048);
dir.shadow.camera.near=1; dir.shadow.camera.far=80; dir.shadow.camera.left=-30; dir.shadow.camera.right=30; dir.shadow.camera.top=30; dir.shadow.camera.bottom=-30;
// 消除阴影自遮挡造成的“麻点/粗糙纹理”噪点（shadow acne），体素棱边尤其明显
dir.shadow.bias = -0.0015; dir.shadow.normalBias = 0.02;
scene.add(dir);

// 光影随镜头水平旋转（仅左右/方位角，不跟随俯仰）：保持光源与地面的
// 水平距离、高度不变，只让光源绕 Y 轴与镜头 orbit.theta 同步转动。
const DIR_LIGHT_RADIUS_XZ = Math.hypot(10, 12);
const DIR_LIGHT_HEIGHT = 22;
const DIR_LIGHT_THETA_OFFSET = Math.atan2(10, 12) - orbit.theta;
function updateLightAzimuth(){
  const t = orbit.theta + DIR_LIGHT_THETA_OFFSET;
  dir.position.set(
    orbit.target.x + DIR_LIGHT_RADIUS_XZ * Math.sin(t),
    DIR_LIGHT_HEIGHT,
    orbit.target.z + DIR_LIGHT_RADIUS_XZ * Math.cos(t)
  );
}
updateLightAzimuth();

/* ---------------- 地面网格 & 绘制平面 ---------------- */
const GRID = 24;
const gridHelper = new THREE.GridHelper(GRID, GRID, 0x44507a, 0x2a3050);
gridHelper.position.y = 0;
scene.add(gridHelper);

// 地面（拾取用平面模式，不再承接投影，避免地上出现体素阴影）
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(GRID, GRID),
  new THREE.MeshStandardMaterial({ color:0x1a1e36, roughness:1, metalness:0, transparent:true, opacity:0.55 })
);
ground.rotation.x = -Math.PI/2; ground.receiveShadow = false; ground.name = 'ground';
scene.add(ground);

// 平面模式：当前绘制高度层的高亮指示
const planeIndicator = new THREE.Mesh(
  new THREE.PlaneGeometry(GRID, GRID),
  new THREE.MeshBasicMaterial({ color:0x4f78ff, transparent:true, opacity:0.06, side:THREE.DoubleSide, depthWrite:false })
);
planeIndicator.rotation.x = -Math.PI/2;
planeIndicator.visible = false;
scene.add(planeIndicator);

// 悬停体素预览框
const hoverBox = new THREE.Mesh(
  new THREE.BoxGeometry(VOXEL, VOXEL, VOXEL),
  new THREE.MeshBasicMaterial({ color:0xffffff, transparent:true, opacity:0.22, depthWrite:false })
);
hoverBox.visible = false;
scene.add(hoverBox);
const hoverEdges = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(VOXEL, VOXEL, VOXEL)),
  new THREE.LineBasicMaterial({ color:0xffffff })
);
hoverBox.add(hoverEdges);

/* ---------------- 人形模特（半透明参考 + 头部禁放区） ----------------
 * 体素围绕模特搭建；头部为禁止放置体素的区域。
 */
let mannequin = null;
if (window.createMannequin) {
  mannequin = window.createMannequin({ color:0xc7cee2, opacity:0.5 });
  mannequin.position.set(0, 0, 0);
  scene.add(mannequin);
}
function headBlocks(worldPoint){
  if (!mannequin || !mannequin.userData.getHeadWorldSphere) return false;
  const sph = mannequin.userData.getHeadWorldSphere();
  return worldPoint.distanceTo(sph.center) < sph.radius;
}
function cellBlockedByHead(obj, x, y, z){
  const ref = renderRefs.get(obj.id);
  if (!ref) return false;
  const local = new THREE.Vector3(x*VOXEL+VOXEL/2, y*VOXEL+VOXEL/2, z*VOXEL+VOXEL/2);
  return headBlocks(ref.group.localToWorld(local));
}

/* =========================================================
 * 数据模型
 * level = { name, objects:[ object ] }
 * object = {
 *   id, name, colorName, layer,
 *   pos:{x,y,z}, rotY,            // 物件整体变换
 *   voxels: { "x,y,z": colorName },  // 体素相对物件局部坐标
 *   screws: [ {key, face, color} ]   // key=体素坐标, face=面方向, color=颜色名
 * }
 * ========================================================= */

let level = { name:'我的关卡', objects:[] };
let activeObjId = null;
let nextId = 1;

const editor = {
  tool: 'add',       // add | erase | screw | screw-erase
  mode: 'stack',     // plane | stack
  planeY: 0,         // 平面模式当前层（整数，体素中心高度=planeY+0.5）
  voxelColor: 'yellow',
  screwColor: 'red',
  screwColorCount: 3,   // 随机配色：颜色种类数
};

function shuffleArr(arr){
  for (let i = arr.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

/* Three 对象引用：objId -> { group, voxelMeshes:Map(key->mesh), screwMeshes:Map(skey->mesh) } */
const renderRefs = new Map();

const FACES = [
  { dir:[ 1,0,0], normal:new THREE.Vector3( 1,0,0) },
  { dir:[-1,0,0], normal:new THREE.Vector3(-1,0,0) },
  { dir:[0, 1,0], normal:new THREE.Vector3(0, 1,0) },
  { dir:[0,-1,0], normal:new THREE.Vector3(0,-1,0) },
  { dir:[0,0, 1], normal:new THREE.Vector3(0,0, 1) },
  { dir:[0,0,-1], normal:new THREE.Vector3(0,0,-1) },
];
const keyOf = (x,y,z) => `${x},${y},${z}`;
const parseKey = k => k.split(',').map(Number);

/* ---------------- 物件 CRUD ---------------- */
function getActiveObj(){ return level.objects.find(o => o.id === activeObjId) || null; }

function createObject(opts = {}){
  const id = nextId++;
  const obj = {
    id,
    name: opts.name || `物件 ${id}`,
    colorName: opts.colorName || editor.voxelColor,
    layer: opts.layer ?? 0,
    pos: opts.pos || { x:0, y:0, z:0 },
    rotY: opts.rotY ?? 0,
    voxels: opts.voxels || {},
    screws: opts.screws || [],
  };
  level.objects.push(obj);
  buildObjectGroup(obj);
  activeObjId = id;
  refreshObjList();
  refreshRightPanel();
  return obj;
}

function deleteObject(id){
  const idx = level.objects.findIndex(o => o.id === id);
  if (idx < 0) return;
  const ref = renderRefs.get(id);
  if (ref) { scene.remove(ref.group); renderRefs.delete(id); }
  level.objects.splice(idx, 1);
  if (activeObjId === id) activeObjId = level.objects.length ? level.objects[0].id : null;
  refreshObjList(); refreshRightPanel(); rebuildAll(); autoSave();
}

/* ---------------- 几何构建 ---------------- */
function voxelMaterial(colorName){
  const c = colorByName(colorName);
  return new THREE.MeshStandardMaterial({ color:c.hex, roughness:0.78, metalness:0.04, flatShading:true });
}

function makeScrewMesh(colorHex){
  const g = new THREE.Group();
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.1,0.1,0.05,24), new THREE.MeshStandardMaterial({ color:colorHex, roughness:0.3, metalness:0.1 }));
  head.castShadow = true; head.position.y = 0.025; g.add(head);
  const peg = new THREE.Mesh(new THREE.CylinderGeometry(0.035,0.03,0.055,12), new THREE.MeshStandardMaterial({ color:0xcbd1d9, metalness:0.7, roughness:0.35 })); peg.position.y=-0.0275; g.add(peg);
  const slotMat = new THREE.MeshStandardMaterial({ color:0x2b2f3a, roughness:0.6 });
  const s1 = new THREE.Mesh(new THREE.BoxGeometry(0.1,0.011,0.025), slotMat); s1.position.y=0.055;
  const s2 = new THREE.Mesh(new THREE.BoxGeometry(0.025,0.011,0.1), slotMat); s2.position.y=0.055;
  g.add(s1); g.add(s2);
  return g;
}

// 把物件局部坐标 -> 世界变换应用到 group
function applyObjTransform(obj){
  const ref = renderRefs.get(obj.id);
  if (!ref) return;
  ref.group.position.set(obj.pos.x, obj.pos.y, obj.pos.z);
  ref.group.rotation.y = THREE.MathUtils.degToRad(obj.rotY);
}

function buildObjectGroup(obj){
  // 清掉旧的
  const old = renderRefs.get(obj.id);
  if (old) scene.remove(old.group);

  const group = new THREE.Group();
  group.userData = { type:'objGroup', objId: obj.id };
  const voxelMeshes = new Map();
  const screwMeshes = new Map();

  // 体素
  const geo = new THREE.BoxGeometry(VOXEL, VOXEL, VOXEL);
  for (const key in obj.voxels) {
    const [x,y,z] = parseKey(key);
    const mesh = new THREE.Mesh(geo, voxelMaterial(obj.voxels[key]));
    mesh.position.set(x*VOXEL+VOXEL/2, y*VOXEL+VOXEL/2, z*VOXEL+VOXEL/2);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData = { type:'voxel', objId: obj.id, key };
    group.add(mesh);
    voxelMeshes.set(key, mesh);
  }

  scene.add(group);
  renderRefs.set(obj.id, { group, voxelMeshes, screwMeshes });
  applyObjTransform(obj);

  // 螺丝
  obj.screws.forEach(s => addScrewMesh(obj, s));
}

function rebuildAll(){
  for (const obj of level.objects) buildObjectGroup(obj);
  refreshStats();
}

/* ---------------- 体素增删 ---------------- */
function addVoxel(obj, x, y, z, colorName){
  const key = keyOf(x,y,z);
  if (obj.voxels[key]) return false;
  obj.voxels[key] = colorName;
  const ref = renderRefs.get(obj.id);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(VOXEL,VOXEL,VOXEL), voxelMaterial(colorName));
  mesh.position.set(x*VOXEL+VOXEL/2, y*VOXEL+VOXEL/2, z*VOXEL+VOXEL/2);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.userData = { type:'voxel', objId: obj.id, key };
  ref.group.add(mesh);
  ref.voxelMeshes.set(key, mesh);
  return true;
}

function removeVoxel(obj, key){
  if (!obj.voxels[key]) return false;
  delete obj.voxels[key];
  const ref = renderRefs.get(obj.id);
  const mesh = ref.voxelMeshes.get(key);
  if (mesh) { ref.group.remove(mesh); ref.voxelMeshes.delete(key); }
  // 删除挂在该体素上的螺丝
  for (let i = obj.screws.length - 1; i >= 0; i--) {
    if (obj.screws[i].key === key) {
      const skey = screwKey(obj.screws[i]);
      const sm = ref.screwMeshes.get(skey);
      if (sm) { ref.group.remove(sm); ref.screwMeshes.delete(skey); }
      obj.screws.splice(i, 1);
    }
  }
  return true;
}

/* ---------------- 螺丝增删改 ---------------- */
const screwKey = s => `${s.key}|${s.face.join(',')}`;

function faceCenterLocal(key, face){
  const [x,y,z] = parseKey(key);
  const cx = x*VOXEL+VOXEL/2, cy = y*VOXEL+VOXEL/2, cz = z*VOXEL+VOXEL/2;
  return new THREE.Vector3(
    cx + face[0]*VOXEL/2,
    cy + face[1]*VOXEL/2,
    cz + face[2]*VOXEL/2
  );
}

function addScrewMesh(obj, s){
  const ref = renderRefs.get(obj.id);
  const skey = screwKey(s);
  if (ref.screwMeshes.has(skey)) return;
  const c = colorByName(s.color);
  const mesh = makeScrewMesh(c.hex);
  mesh.scale.setScalar(0.95);
  const n = new THREE.Vector3(...s.face).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0), n);
  mesh.quaternion.copy(q);
  const center = faceCenterLocal(s.key, s.face);
  mesh.position.copy(center).add(n.clone().multiplyScalar(0.012));
  mesh.userData = { type:'screw', objId: obj.id, skey };
  ref.group.add(mesh);
  ref.screwMeshes.set(skey, mesh);
}

function addScrew(obj, key, face, colorName){
  const s = { key, face, color: colorName };
  const skey = screwKey(s);
  const exist = obj.screws.find(x => screwKey(x) === skey);
  if (exist) { // 改色
    exist.color = colorName;
    const ref = renderRefs.get(obj.id);
    const old = ref.screwMeshes.get(skey);
    if (old) { ref.group.remove(old); ref.screwMeshes.delete(skey); }
    addScrewMesh(obj, exist);
    return;
  }
  obj.screws.push(s);
  addScrewMesh(obj, s);
}

function removeScrew(obj, skey){
  const idx = obj.screws.findIndex(x => screwKey(x) === skey);
  if (idx < 0) return;
  obj.screws.splice(idx, 1);
  const ref = renderRefs.get(obj.id);
  const sm = ref.screwMeshes.get(skey);
  if (sm) { ref.group.remove(sm); ref.screwMeshes.delete(skey); }
}

// 判断某体素的某个面是否暴露在外（相邻无体素）
function isFaceExposed(obj, x, y, z, face){
  return !obj.voxels[keyOf(x+face[0], y+face[1], z+face[2])];
}

function autoGenScrews(obj){
  // 在每个"暴露面"上布点；为避免过密，仅在朝上/朝外的主要面布
  obj.screws = [];
  const ref = renderRefs.get(obj.id);
  // 清除旧螺丝 mesh
  ref.screwMeshes.forEach(m => ref.group.remove(m));
  ref.screwMeshes.clear();

  const placed = new Set();
  for (const key in obj.voxels) {
    const [x,y,z] = parseKey(key);
    // 优先选取顶面，其次四侧面；底面跳过（一般贴地）
    const order = [[0,1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]];
    for (const face of order) {
      if (face[1] === -1) continue;
      if (!isFaceExposed(obj, x, y, z, face)) continue;
      // 稀疏化：用坐标哈希，约 1/2 概率布点，保证至少有一定数量
      const h = (x*73856093 ^ y*19349663 ^ z*83492791 ^ (face[0]+2)*11+(face[2]+2)*7) >>> 0;
      if ((h % 10) < 5) {
        const s = { key, face, color: editor.screwColor };
        const sk = screwKey(s);
        if (!placed.has(sk)) { placed.add(sk); obj.screws.push(s); addScrewMesh(obj, s); }
        break; // 每个体素最多 1 颗自动螺丝
      }
    }
  }
  // 若一颗都没布到，则保底在每个最顶层体素顶面布
  if (obj.screws.length === 0) {
    for (const key in obj.voxels) {
      const [x,y,z] = parseKey(key);
      if (isFaceExposed(obj, x, y, z, [0,1,0])) {
        const s = { key, face:[0,1,0], color: editor.screwColor };
        obj.screws.push(s); addScrewMesh(obj, s);
      }
    }
  }
  refreshStats(); autoSave();
}

/* =========================================================
 * 交互：射线拾取
 * ========================================================= */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function setPointer(clientX, clientY){
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((clientX-rect.left)/rect.width)*2 - 1;
  pointer.y = -((clientY-rect.top)/rect.height)*2 + 1;
  raycaster.setFromCamera(pointer, camera);
}

function allVoxelMeshes(){
  const arr = [];
  renderRefs.forEach(ref => ref.voxelMeshes.forEach(m => arr.push(m)));
  return arr;
}
function allScrewMeshes(){
  const arr = [];
  renderRefs.forEach(ref => ref.screwMeshes.forEach(m => arr.push(m)));
  return arr;
}

// 把世界点转换为活动物件的局部体素坐标
function worldToLocalVoxel(obj, worldPoint){
  const ref = renderRefs.get(obj.id);
  const local = ref.group.worldToLocal(worldPoint.clone());
  return new THREE.Vector3(
    Math.floor(local.x / VOXEL),
    Math.floor(local.y / VOXEL),
    Math.floor(local.z / VOXEL)
  );
}

// 计算"添加体素"目标坐标
function computeAddTarget(){
  const obj = getActiveObj();
  if (!obj) return null;

  // 先看是否命中已有体素：在命中面外侧添加
  setPointerFromLast();
  const voxHits = raycaster.intersectObjects(allVoxelMeshes(), false);
  const myVoxHit = voxHits.find(h => h.object.userData.objId === obj.id);

  if (editor.mode === 'stack' && myVoxHit) {
    const [x,y,z] = parseKey(myVoxHit.object.userData.key);
    // 用法线决定堆叠方向（法线在物件局部空间）
    const ref = renderRefs.get(obj.id);
    const nLocal = myVoxHit.face.normal.clone();
    // face.normal 是 mesh 局部法线（box 未旋转，等于物件局部），直接用
    return { x: x+Math.round(nLocal.x), y: y+Math.round(nLocal.y), z: z+Math.round(nLocal.z) };
  }

  // 平面模式或未命中体素：投射到当前绘制平面 y=planeY
  if (myVoxHit && editor.mode === 'plane') {
    // 平面模式命中体素 -> 仍在同层旁边添加（取命中点投影）
  }
  // 与水平面 y = planeY 相交（物件局部）。简化：用世界水平面 + 物件无 X/Z 倾斜假设
  const ref = renderRefs.get(obj.id);
  const planeWorldY = obj.pos.y + (editor.mode === 'plane' ? editor.planeY*VOXEL : 0);
  const planeObj = new THREE.Plane(new THREE.Vector3(0,1,0), -planeWorldY);
  const hitPt = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(planeObj, hitPt)) return null;
  const lv = worldToLocalVoxel(obj, hitPt);
  const targetY = editor.mode === 'plane' ? editor.planeY : 0;
  return { x: lv.x, y: targetY, z: lv.z };
}

let lastClientX = 0, lastClientY = 0;
function setPointerFromLast(){ setPointer(lastClientX, lastClientY); }

/* ---------------- 悬停预览 ---------------- */
function updateHover(){
  const obj = getActiveObj();
  hoverBox.visible = false;
  if (!obj) return;
  setPointerFromLast();

  if (editor.tool === 'add') {
    const t = computeAddTarget();
    if (t) {
      if (cellBlockedByHead(obj, t.x, t.y, t.z)) { hoverBox.visible = false; return; }
      const ref = renderRefs.get(obj.id);
      const localCenter = new THREE.Vector3(t.x*VOXEL+VOXEL/2, t.y*VOXEL+VOXEL/2, t.z*VOXEL+VOXEL/2);
      const wp = ref.group.localToWorld(localCenter.clone());
      hoverBox.position.copy(wp);
      hoverBox.quaternion.copy(ref.group.quaternion);
      hoverBox.material.color.set(colorByName(editor.voxelColor).hex);
      hoverBox.visible = true;
    }
  } else if (editor.tool === 'erase') {
    const voxHits = raycaster.intersectObjects(allVoxelMeshes(), false);
    const myHit = voxHits.find(h => h.object.userData.objId === obj.id);
    if (myHit) {
      hoverBox.position.copy(myHit.object.getWorldPosition(new THREE.Vector3()));
      hoverBox.quaternion.copy(myHit.object.parent.quaternion);
      hoverBox.material.color.set(0xff5d5d);
      hoverBox.visible = true;
    }
  }
}

/* ---------------- 点击处理 ---------------- */
function handleClick(){
  const obj = getActiveObj();
  if (!obj) { toast('请先新建/选择一个物件'); return; }
  setPointerFromLast();

  if (editor.tool === 'add') {
    const t = computeAddTarget();
    if (t) {
      if (cellBlockedByHead(obj, t.x, t.y, t.z)) { toast('人头区域不能放置体素'); return; }
      addVoxel(obj, t.x, t.y, t.z, editor.voxelColor); refreshStats(); autoSave();
    }
    return;
  }

  if (editor.tool === 'erase') {
    const voxHits = raycaster.intersectObjects(allVoxelMeshes(), false);
    const myHit = voxHits.find(h => h.object.userData.objId === obj.id);
    if (myHit) { removeVoxel(obj, myHit.object.userData.key); refreshStats(); autoSave(); }
    return;
  }

  if (editor.tool === 'screw') {
    // 先看是否点到已有螺丝 -> 改色
    const screwHits = raycaster.intersectObjects(allScrewMeshes(), true);
    if (screwHits.length) {
      const root = findRoot(screwHits[0].object, 'screw');
      if (root && root.userData.objId === obj.id) {
        const skey = root.userData.skey;
        const s = obj.screws.find(x => screwKey(x) === skey);
        if (s) { addScrew(obj, s.key, s.face, editor.screwColor); refreshStats(); autoSave(); }
        return;
      }
    }
    // 否则点体素面 -> 加螺丝
    const voxHits = raycaster.intersectObjects(allVoxelMeshes(), false);
    const myHit = voxHits.find(h => h.object.userData.objId === obj.id);
    if (myHit) {
      const key = myHit.object.userData.key;
      const n = myHit.face.normal;
      const face = [Math.round(n.x), Math.round(n.y), Math.round(n.z)];
      addScrew(obj, key, face, editor.screwColor); refreshStats(); autoSave();
    }
    return;
  }

  if (editor.tool === 'screw-erase') {
    const screwHits = raycaster.intersectObjects(allScrewMeshes(), true);
    if (screwHits.length) {
      const root = findRoot(screwHits[0].object, 'screw');
      if (root && root.userData.objId === obj.id) {
        removeScrew(obj, root.userData.skey); refreshStats(); autoSave();
      }
    }
    return;
  }
}

function findRoot(o, type){ while(o){ if (o.userData && o.userData.type === type) return o; o = o.parent; } return null; }

/* =========================================================
 * 鼠标/触摸事件：左键=工具操作，右键/拖动=旋转视角，滚轮=缩放
 * ========================================================= */
const drag = { active:false, moved:false, btn:0, lx:0, ly:0, sx:0, sy:0 };
const THRESH = 5;

renderer.domElement.addEventListener('pointermove', e => {
  lastClientX = e.clientX; lastClientY = e.clientY;
  if (!drag.active) updateHover();
});

renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());

renderer.domElement.addEventListener('pointerdown', e => {
  drag.active = true; drag.moved = false; drag.btn = e.button;
  drag.sx = drag.lx = e.clientX; drag.sy = drag.ly = e.clientY;
});
window.addEventListener('pointermove', e => {
  if (!drag.active) return;
  const dx = e.clientX - drag.lx, dy = e.clientY - drag.ly;
  if (!drag.moved && Math.hypot(e.clientX-drag.sx, e.clientY-drag.sy) > THRESH) drag.moved = true;
  // 右键拖动 或 左键拖动空白处 -> 旋转视角
  if (drag.moved && (drag.btn === 2 || drag.btn === 1 || (drag.btn===0 && drag.orbiting))) {
    orbit.theta -= dx*0.008; orbit.phi -= dy*0.008;
    orbit.phi = Math.max(orbit.minPhi, Math.min(orbit.maxPhi, orbit.phi));
    updateCamera();
    updateLightAzimuth(); // 光影仅随镜头左右(水平)旋转联动，不随上下俯仰变化
  }
  drag.lx = e.clientX; drag.ly = e.clientY;
});
// 区分：左键按下时若没命中任何体素/螺丝，则视为视角旋转
renderer.domElement.addEventListener('pointerdown', e => {
  if (e.button === 0) {
    setPointer(e.clientX, e.clientY);
    const hitVox = raycaster.intersectObjects(allVoxelMeshes(), false).some(h => true);
    const hitScrew = raycaster.intersectObjects(allScrewMeshes(), true).some(h => true);
    const willAdd = editor.tool === 'add'; // 添加工具即使点空白也要落点
    drag.orbiting = !(hitVox || hitScrew || willAdd);
  } else {
    drag.orbiting = true;
  }
});
window.addEventListener('pointerup', e => {
  if (!drag.active) return;
  drag.active = false;
  if (!drag.moved && e.button === 0 && !drag.orbiting) {
    lastClientX = e.clientX; lastClientY = e.clientY;
    handleClick();
  }
  updateHover();
});

renderer.domElement.addEventListener('wheel', e => {
  e.preventDefault();
  orbit.radius += e.deltaY * 0.02;
  orbit.radius = Math.max(8, Math.min(60, orbit.radius));
  updateCamera();
}, { passive:false });

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* =========================================================
 * UI 绑定
 * ========================================================= */
const $ = id => document.getElementById(id);

// 工具切换
document.querySelectorAll('[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => {
    editor.tool = btn.dataset.tool;
    document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b === btn));
    updateHover();
  });
});
// 模式切换
document.querySelectorAll('[data-mode]').forEach(btn => {
  btn.addEventListener('click', () => {
    editor.mode = btn.dataset.mode;
    document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('active', b === btn));
    planeIndicator.visible = editor.mode === 'plane';
    syncPlaneIndicator();
    toast(editor.mode === 'plane' ? '平面模式：在当前层绘制（Y 滑块调整层高）' : '堆叠模式：在体素面上堆叠');
  });
});

function syncPlaneIndicator(){
  const obj = getActiveObj();
  const baseY = obj ? obj.pos.y : 0;
  planeIndicator.position.y = baseY + editor.planeY*VOXEL + 0.001;
}

// 调色板
function buildPalette(containerId, pick, current){
  const c = $(containerId); c.innerHTML = '';
  COLORS.forEach(col => {
    const s = document.createElement('div');
    s.className = 'swatch' + (col.name === current() ? ' active' : '');
    s.style.background = col.css;
    s.title = col.name;
    s.addEventListener('click', () => { pick(col.name); buildPalette(containerId, pick, current); });
    c.appendChild(s);
  });
}
buildPalette('voxel-palette', n => editor.voxelColor = n, () => editor.voxelColor);
buildPalette('screw-palette', n => editor.screwColor = n, () => editor.screwColor);

// 物件列表
function refreshObjList(){
  const list = $('obj-list'); list.innerHTML = '';
  level.objects.forEach(obj => {
    const item = document.createElement('div');
    item.className = 'obj-item' + (obj.id === activeObjId ? ' active' : '');
    const sw = document.createElement('div'); sw.className = 'obj-swatch'; sw.style.background = colorByName(obj.colorName).css;
    const name = document.createElement('div'); name.className='obj-name'; name.textContent = obj.name; name.title = '双击重命名';
    name.addEventListener('dblclick', e => {
      e.stopPropagation();
      const nv = prompt('重命名物件', obj.name);
      if (nv != null && nv.trim()) { obj.name = nv.trim(); refreshObjList(); refreshRightPanel(); autoSave(); }
    });
    const cnt = document.createElement('div'); cnt.className='obj-count'; cnt.textContent = `L${obj.layer}`;
    const del = document.createElement('div'); del.className='obj-del'; del.textContent='✕';
    del.addEventListener('click', e => { e.stopPropagation(); if (confirm(`删除「${obj.name}」？`)) deleteObject(obj.id); });
    item.append(sw, name, cnt, del);
    item.addEventListener('click', () => { activeObjId = obj.id; refreshObjList(); refreshRightPanel(); syncPlaneIndicator(); });
    list.appendChild(item);
  });
  refreshStats();
}

// 右侧属性面板同步
function refreshRightPanel(){
  const obj = getActiveObj();
  const nameInput = $('obj-name-input');
  if (!obj) { nameInput.value=''; return; }
  nameInput.value = obj.name;
  $('pos-x').value = obj.pos.x; $('v-px').textContent = obj.pos.x;
  $('pos-y').value = obj.pos.y; $('v-py').textContent = obj.pos.y;
  $('pos-z').value = obj.pos.z; $('v-pz').textContent = obj.pos.z;
  $('rot-y').value = obj.rotY; $('v-ry').textContent = obj.rotY;
  $('layer').value = obj.layer; $('v-layer').textContent = obj.layer;
}

// ---- 关卡改名 ----
function refreshLevelName(){ const el = $('level-name-input'); if (el) el.value = level.name || ''; }
if ($('level-name-input')) $('level-name-input').addEventListener('input', e => {
  level.name = e.target.value.trim() || '未命名关卡';
  autoSave();
});

$('obj-name-input').addEventListener('input', e => { const o = getActiveObj(); if (o){ o.name = e.target.value; refreshObjList(); autoSave(); } });
['x','y','z'].forEach(ax => {
  $('pos-'+ax).addEventListener('input', e => {
    const o = getActiveObj(); if (!o) return;
    o.pos[ax] = parseFloat(e.target.value);
    $('v-p'+ax).textContent = o.pos[ax];
    applyObjTransform(o); syncPlaneIndicator(); autoSave();
  });
});
$('rot-y').addEventListener('input', e => {
  const o = getActiveObj(); if (!o) return;
  o.rotY = parseInt(e.target.value); $('v-ry').textContent = o.rotY;
  applyObjTransform(o); autoSave();
});
$('layer').addEventListener('input', e => {
  const o = getActiveObj(); if (!o) return;
  o.layer = parseInt(e.target.value); $('v-layer').textContent = o.layer;
  refreshObjList(); autoSave();
});

$('btn-add-obj').addEventListener('click', () => { createObject(); autoSave(); });
$('btn-auto-screw').addEventListener('click', () => { const o = getActiveObj(); if (o){ autoGenScrews(o); toast(`已自动布点 ${o.screws.length} 颗螺丝`); } });
$('btn-clear-screw').addEventListener('click', () => {
  const o = getActiveObj(); if (!o) return;
  o.screws = []; const ref = renderRefs.get(o.id); ref.screwMeshes.forEach(m=>ref.group.remove(m)); ref.screwMeshes.clear();
  refreshStats(); autoSave(); toast('已清空螺丝');
});

/* ---------------- 随机螺丝颜色（全局 · 仅重新配色，不改位置） ----------------
 * 较为平均分配：每种颜色数量尽量相等，且为 3 的倍数（便于游戏 3 个一组消除）。
 */
function rebuildObjScrews(obj){
  const ref = renderRefs.get(obj.id);
  if (!ref) return;
  ref.screwMeshes.forEach(m => ref.group.remove(m));
  ref.screwMeshes.clear();
  obj.screws.forEach(s => addScrewMesh(obj, s));
}
function randomizeScrewColorsAll(colorCount){
  colorCount = Math.max(1, Math.min(colorCount|0, COLORS.length));
  const all = [];
  level.objects.forEach(o => (o.screws || []).forEach(s => all.push(s)));
  const total = all.length;
  if (total === 0){ toast('请先放置螺丝再随机配色'); return; }

  const triples = Math.floor(total / 3);
  let cc = colorCount;
  if (triples === 0) cc = 1;
  else if (cc > triples) cc = triples;

  const perColorGroups = new Array(cc).fill(0);
  for (let g = 0; g < triples; g++) perColorGroups[g % cc]++;
  const bag = [];
  for (let ci = 0; ci < cc; ci++)
    for (let k = 0; k < perColorGroups[ci] * 3; k++) bag.push(COLORS[ci].name);
  const remainder = total - triples * 3;
  for (let k = 0; k < remainder; k++) bag.push(COLORS[0].name);

  shuffleArr(bag);
  all.forEach((s, i) => { s.color = bag[i]; });
  level.objects.forEach(o => rebuildObjScrews(o));
  refreshStats(); autoSave();

  if (remainder) toast(`已随机配色 ${cc} 色 · 共 ${total} 颗（非 3 的倍数，建议调整螺丝数）`);
  else toast(`已随机配色 ${cc} 色 · 共 ${total} 颗`);
}
if ($('btn-rand-screw-color')) $('btn-rand-screw-color').addEventListener('click', () => { randomizeScrewColorsAll(editor.screwColorCount); });
if ($('screw-colorcount')) $('screw-colorcount').addEventListener('input', e => {
  const v = parseInt(e.target.value); editor.screwColorCount = v; $('v-screw-colorcount').textContent = v;
});

function refreshStats(){
  let vox = 0, screw = 0;
  level.objects.forEach(o => { vox += Object.keys(o.voxels).length; screw += o.screws.length; });
  $('stat-vox').textContent = vox;
  $('stat-screw').textContent = screw;
  $('stat-obj').textContent = level.objects.length;
}

/* =========================================================
 * 保存 / 加载 / 导出 / 导入
 * ========================================================= */
function serialize(){
  return JSON.stringify({ name: level.name, nextId, objects: level.objects });
}
function autoSave(){
  try { localStorage.setItem(STORAGE_KEY, serialize()); } catch(e){}
}
function loadFromStorage(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    applyLevelData(data);
    return true;
  } catch(e){ return false; }
}
function applyLevelData(data){
  // 清空现有
  renderRefs.forEach(ref => scene.remove(ref.group));
  renderRefs.clear();
  level = { name: data.name || '我的关卡', objects: data.objects || [] };
  nextId = data.nextId || (level.objects.reduce((m,o)=>Math.max(m,o.id),0)+1);
  activeObjId = level.objects.length ? level.objects[0].id : null;
  level.objects.forEach(buildObjectGroup);
  refreshObjList(); refreshRightPanel(); refreshStats(); syncPlaneIndicator(); refreshLevelName();
}

$('btn-save').addEventListener('click', () => { autoSave(); toast('已保存到本地'); });

// 导出/导入模态
const modalMask = $('modal-mask');
let modalMode = 'export';
$('btn-export').addEventListener('click', () => {
  modalMode = 'export';
  $('modal-title').textContent = '导出关卡（复制下面 JSON 分享）';
  $('modal-text').value = JSON.stringify({ name: level.name, objects: level.objects }, null, 2);
  $('modal-text').readOnly = true;
  $('modal-ok').textContent = '复制到剪贴板';
  modalMask.style.display = 'flex';
});
$('btn-import').addEventListener('click', () => {
  modalMode = 'import';
  $('modal-title').textContent = '导入关卡（粘贴 JSON 后点导入）';
  $('modal-text').value = '';
  $('modal-text').readOnly = false;
  $('modal-ok').textContent = '导入';
  modalMask.style.display = 'flex';
});
$('modal-cancel').addEventListener('click', () => modalMask.style.display = 'none');
$('modal-ok').addEventListener('click', async () => {
  if (modalMode === 'export') {
    try { await navigator.clipboard.writeText($('modal-text').value); toast('已复制到剪贴板'); }
    catch(e){ $('modal-text').select(); document.execCommand('copy'); toast('已复制'); }
  } else {
    try {
      const data = JSON.parse($('modal-text').value);
      applyLevelData(data); autoSave(); modalMask.style.display='none'; toast('导入成功');
    } catch(e){ toast('JSON 格式错误'); }
  }
});

/* ---------------- 试玩：写入共享 key 并跳转 ---------------- */
$('btn-test').addEventListener('click', () => {
  if (!level.objects.length) { toast('请先创建物件'); return; }
  const totalScrews = level.objects.reduce((s,o)=>s+o.screws.length, 0);
  if (totalScrews === 0) { toast('请先布置螺丝'); return; }
  if (totalScrews % 3 !== 0) { toast(`螺丝总数需为 3 的倍数（当前 ${totalScrews}）`); return; }
  try {
    localStorage.setItem(CUSTOM_LEVEL_KEY, JSON.stringify({ name: level.name, objects: level.objects }));
    location.href = 'index.html?custom=1';
  } catch(e){ toast('保存失败'); }
});

/* =========================================================
 * ✨ AI / 程序化体素生成
 * - 输入：文字描述（+可选图片取色）+ 物件数量
 * - 在「人头模型附近」围绕分布生成体素物件
 * - 优先使用用户填写的 LLM 端点；否则用内置形状生成器
 * ========================================================= */

// 内置色板名 -> 便于把任意 hex 归一到最接近的可用颜色
function nearestColorName(hex){
  const r = (hex>>16)&255, g=(hex>>8)&255, b=hex&255;
  let best = COLORS[0].name, bd = Infinity;
  for (const c of COLORS){
    const cr=(c.hex>>16)&255, cg=(c.hex>>8)&255, cb=c.hex&255;
    const d=(r-cr)**2+(g-cg)**2+(b-cb)**2;
    if (d<bd){ bd=d; best=c.name; }
  }
  return best;
}

// 关键词 -> 颜色名
function colorFromText(text){
  const map = [
    [/红|red|爱心|心|苹果|草莓|玫瑰/, 'red'],
    [/绿|green|树|草|叶|仙人掌|青蛙/, 'green'],
    [/紫|purple|葡萄/, 'purple'],
    [/蓝|blue|海|水|冰/, 'blue'],
    [/灰|gray|grey|石|铁|机器/, 'gray'],
    [/棕|褐|brown|木|熊|巧克力|面包|汉堡/, 'brown'],
    [/白|white|云|雪|骨/, 'white'],
    [/黄|yellow|金|星|太阳|玉米|香蕉|月/, 'yellow'],
  ];
  for (const [re, name] of map) if (re.test(text)) return name;
  return null;
}

// ---- 形状生成：返回 voxels 对象 { "x,y,z": colorName } ----
// 以 (0,0,0) 为底部中心附近的局部坐标系
function genShapeVoxels(text, colorName){
  const t = text || '';
  const set = {};
  const put = (x,y,z,c)=>{ set[keyOf(x,y,z)] = c || colorName; };

  // 爱心
  if (/爱心|心形|heart|❤|心/.test(t)){
    const pattern = [
      '011011',
      '111111',
      '111111',
      '011110',
      '001100',
    ];
    pattern.forEach((row,ri)=>{ const y = pattern.length-1-ri; for (let x=0;x<row.length;x++) if (row[x]==='1') put(x-2, y, 0); });
    return set;
  }
  // 五角星
  if (/星|star|✦|✩/.test(t)){
    const pattern = [
      '0010100',
      '0111110',
      '1111111',
      '0111110',
      '0110110',
      '1100011',
    ];
    pattern.forEach((row,ri)=>{ const y=pattern.length-1-ri; for(let x=0;x<row.length;x++) if(row[x]==='1') put(x-3,y,0); });
    return set;
  }
  // 树
  if (/树|tree|圣诞/.test(t)){
    // 树干
    put(0,0,0,'brown'); put(0,1,0,'brown');
    // 树冠（三层金字塔）
    const crown='green';
    for (let y=2;y<=5;y++){ const r=5-y; for(let x=-r;x<=r;x++) for(let z=-r;z<=r;z++) if(Math.abs(x)+Math.abs(z)<=r) put(x,y,z,crown); }
    return set;
  }
  // 球 / 太阳 / 苹果
  if (/球|圆|sphere|太阳|苹果|月|气球/.test(t)){
    const R=3;
    for(let x=-R;x<=R;x++)for(let y=-R;y<=R;y++)for(let z=-R;z<=R;z++)
      if(x*x+y*y+z*z<=R*R+1) put(x,y+R,z);
    return set;
  }
  // 金字塔
  if (/金字塔|pyramid|三角/.test(t)){
    for(let y=0;y<=4;y++){ const r=4-y; for(let x=-r;x<=r;x++)for(let z=-r;z<=r;z++) put(x,y,z); }
    return set;
  }
  // 房子
  if (/房|屋|house|城堡/.test(t)){
    for(let x=-2;x<=2;x++)for(let y=0;y<=3;y++)for(let z=-2;z<=2;z++)
      if(Math.abs(x)===2||Math.abs(z)===2||y===0) put(x,y,z, colorName==='white'?'gray':colorName);
    // 屋顶
    for(let y=4;y<=6;y++){ const r=6-y; for(let x=-r;x<=r;x++)for(let z=-2;z<=2;z++) put(x,y,z,'red'); }
    return set;
  }
  // 单个字母（A-Z）：用 5x5 点阵简化
  const letterMatch = t.toUpperCase().match(/字母\s*([A-Z])|^\s*([A-Z])\s*$|letter\s*([A-Z])/);
  const letter = letterMatch ? (letterMatch[1]||letterMatch[2]||letterMatch[3]) : null;
  if (letter){
    const FONT = {
      A:['01110','10001','11111','10001','10001'],
      B:['11110','10001','11110','10001','11110'],
      C:['01111','10000','10000','10000','01111'],
      H:['10001','10001','11111','10001','10001'],
      I:['11111','00100','00100','00100','11111'],
      L:['10000','10000','10000','10000','11111'],
      O:['01110','10001','10001','10001','01110'],
      T:['11111','00100','00100','00100','00100'],
      X:['10001','01010','00100','01010','10001'],
      Y:['10001','01010','00100','00100','00100'],
      Z:['11111','00010','00100','01000','11111'],
    };
    const rows = FONT[letter] || FONT.A;
    rows.forEach((row,ri)=>{ const y=rows.length-1-ri; for(let x=0;x<row.length;x++) if(row[x]==='1') put(x-2,y,0); });
    return set;
  }

  // 默认：一个 3x3x3 立方块
  for(let x=0;x<3;x++)for(let y=0;y<3;y++)for(let z=0;z<3;z++) put(x-1,y,z-1);
  return set;
}

// ---- 从图片提取主色调（平均色 -> 最近色板名）----
let aiImageColorName = null;
function extractImageColor(img){
  try {
    const cv = document.createElement('canvas');
    const w = cv.width = 32, h = cv.height = 32;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0,0,w,h).data;
    let r=0,g=0,b=0,n=0;
    for(let i=0;i<data.length;i+=4){ if(data[i+3]<40) continue; r+=data[i]; g+=data[i+1]; b+=data[i+2]; n++; }
    if(!n) return null;
    const hex = ((Math.round(r/n)<<16)|(Math.round(g/n)<<8)|Math.round(b/n));
    return nearestColorName(hex);
  } catch(e){ return null; }
}

// ---- 计算人头世界位置（用于在其附近生成）----
function getHeadAnchorWorld(){
  if (mannequin && mannequin.userData.getHeadWorldSphere){
    const s = mannequin.userData.getHeadWorldSphere();
    return { center: s.center.clone(), radius: s.radius };
  }
  return { center: new THREE.Vector3(0, 6, 0), radius: 2 };
}

// ---- 把一组 voxels 包围盒底部中心移到原点，便于摆放 ----
function recenterVoxels(voxels){
  const keys = Object.keys(voxels);
  if (!keys.length) return { voxels, size:new THREE.Vector3(), height:0 };
  let minx=Infinity,miny=Infinity,minz=Infinity,maxx=-Infinity,maxy=-Infinity,maxz=-Infinity;
  keys.forEach(k=>{ const [x,y,z]=parseKey(k); minx=Math.min(minx,x);miny=Math.min(miny,y);minz=Math.min(minz,z);maxx=Math.max(maxx,x);maxy=Math.max(maxy,y);maxz=Math.max(maxz,z); });
  const cx=Math.round((minx+maxx)/2), cz=Math.round((minz+maxz)/2);
  const out={};
  keys.forEach(k=>{ const [x,y,z]=parseKey(k); out[keyOf(x-cx, y-miny, z-cz)] = voxels[k]; });
  return { voxels: out, sizeX:maxx-minx+1, sizeY:maxy-miny+1, sizeZ:maxz-minz+1 };
}

// ---- 在人头附近放置 count 个物件 ----
function placeGeneratedObjects(makeVoxels, count, baseColorName){
  const anchor = getHeadAnchorWorld();
  // 在人头水平四周环形分布；单个则放正前方略低
  const created = [];
  for (let i=0;i<count;i++){
    const raw = makeVoxels(i);
    const { voxels } = recenterVoxels(raw);
    if (!Object.keys(voxels).length) continue;

    // 环形角度
    const ang = count===1 ? Math.PI*0.0 : (i/count)*Math.PI*2;
    const ring = anchor.radius + 3.5;     // 距离人头中心
    const wx = anchor.center.x + Math.sin(ang)*ring;
    const wz = anchor.center.z + Math.cos(ang)*ring;
    // 体素底部对齐到人头中心略下方
    const wy = anchor.center.y - anchor.radius;

    const obj = createObject({
      name: count===1 ? 'AI 物件' : `AI 物件 ${i+1}`,
      colorName: baseColorName,
      layer: 0,
      voxels,
      pos: { x: Math.round(wx*2)/2, y: Math.round(wy*2)/2, z: Math.round(wz*2)/2 },
      rotY: count===1 ? 0 : Math.round((ang*180/Math.PI)/15)*15,
    });
    autoGenScrews(obj);   // 自动布点螺丝，便于直接试玩
    created.push(obj);
  }
  refreshObjList(); refreshRightPanel(); refreshStats(); rebuildAll(); autoSave();
  return created;
}

// ---- 调用用户自定义 LLM 端点（约定返回体素 JSON）----
async function callLLMEndpoint(endpoint, desc, count, imageDataUrl){
  const prompt = `你是体素建模助手。根据描述生成 ${count} 个体素物件，仅返回 JSON，格式：
{"objects":[{"name":"名称","voxels":{"x,y,z":"颜色名"}}]}
颜色名只能是：${COLORS.map(c=>c.name).join(',')}。
坐标为整数，物体置于 y>=0、底部从 0 开始、整体不超过 8x8x8。描述：${desc}`;
  const body = { prompt, description: desc, count, image: imageDataUrl || null, colors: COLORS.map(c=>c.name) };
  const res = await fetch(endpoint, {
    method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('接口返回 '+res.status);
  const json = await res.json();
  // 兼容：直接 {objects:[...]} 或 {choices:[{message:{content:"...json..."}}]}
  let data = json;
  if (json.choices && json.choices[0] && json.choices[0].message){
    const txt = json.choices[0].message.content;
    const m = txt.match(/\{[\s\S]*\}/);
    data = JSON.parse(m ? m[0] : txt);
  }
  if (!data.objects || !data.objects.length) throw new Error('接口未返回 objects');
  return data.objects;
}

/* ---------------- AI 模态 UI 绑定 ---------------- */
(function setupAI(){
  const mask = $('ai-mask');
  if (!mask) return;
  const descEl = $('ai-desc');
  const countEl = $('ai-count');
  const countVal = $('ai-count-val');
  const imgDrop = $('ai-img-drop');
  const imgInput = $('ai-img-input');
  const imgPreview = $('ai-img-preview');
  const endpointEl = $('ai-endpoint');
  let imageDataUrl = null;

  // 快捷描述
  const chips = ['一颗红色爱心','一个黄色五角星','一棵绿色小树','一个蓝色球','字母 A','一座小房子','一个金字塔'];
  const chipBox = $('ai-chips');
  chips.forEach(c=>{ const el=document.createElement('div'); el.className='ai-chip'; el.textContent=c; el.addEventListener('click',()=>{ descEl.value=c; }); chipBox.appendChild(el); });

  // 记住端点
  try { const saved = localStorage.getItem('ai_endpoint'); if (saved) endpointEl.value = saved; } catch(e){}

  countEl.addEventListener('input', ()=> countVal.textContent = countEl.value);
  imgDrop.addEventListener('click', ()=> imgInput.click());
  imgInput.addEventListener('change', e=>{
    const f = e.target.files[0]; if(!f) return;
    const reader = new FileReader();
    reader.onload = ev => {
      imageDataUrl = ev.target.result;
      imgPreview.src = imageDataUrl; imgPreview.style.display='block';
      const img = new Image();
      img.onload = ()=>{ aiImageColorName = extractImageColor(img); imgDrop.textContent = '已选择图片 · 主色：' + (aiImageColorName||'未知'); };
      img.src = imageDataUrl;
    };
    reader.readAsDataURL(f);
  });
  ['dragover','dragenter'].forEach(ev=> imgDrop.addEventListener(ev, e=>{ e.preventDefault(); imgDrop.style.borderColor='#4f78ff'; }));
  ['dragleave','drop'].forEach(ev=> imgDrop.addEventListener(ev, e=>{ e.preventDefault(); imgDrop.style.borderColor=''; }));
  imgDrop.addEventListener('drop', e=>{ const f=e.dataTransfer.files[0]; if(f){ imgInput.files=e.dataTransfer.files; imgInput.dispatchEvent(new Event('change')); } });

  function open(){ mask.style.display='flex'; descEl.focus(); }
  function close(){ mask.style.display='none'; }
  $('btn-ai').addEventListener('click', open);
  $('ai-cancel').addEventListener('click', close);
  mask.addEventListener('click', e=>{ if(e.target===mask) close(); });

  $('ai-generate').addEventListener('click', async ()=>{
    const desc = (descEl.value||'').trim();
    const count = parseInt(countEl.value)||1;
    const endpoint = (endpointEl.value||'').trim();
    if (!desc && !imageDataUrl){ toast('请填写描述或上传图片'); return; }

    // 颜色优先级：文字关键词 > 图片主色 > 默认黄
    const baseColor = colorFromText(desc) || aiImageColorName || 'yellow';

    const btn = $('ai-generate'); btn.disabled = true; btn.textContent = '生成中…';
    try {
      if (endpoint){
        try { localStorage.setItem('ai_endpoint', endpoint); } catch(e){}
        toast('正在调用 AI 接口…');
        const objs = await callLLMEndpoint(endpoint, desc, count, imageDataUrl);
        placeGeneratedObjects(i => {
          const o = objs[i % objs.length];
          // 归一颜色到色板
          const vox = {};
          for (const k in o.voxels){ const cn = colorByName(o.voxels[k]).name; vox[k] = cn; }
          return vox;
        }, count, baseColor);
        toast(`AI 生成完成 · ${count} 个物件`);
      } else {
        // 内置程序化生成
        placeGeneratedObjects(()=> genShapeVoxels(desc, baseColor), count, baseColor);
        toast(`已生成 ${count} 个物件（内置生成器）`);
      }
      close();
    } catch(err){
      toast('生成失败：' + (err.message||err));
    } finally {
      btn.disabled = false; btn.textContent = '生成';
    }
  });
})();

/* ---------------- toast ---------------- */
let toastTimer = null;
function toast(msg){ const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(()=>t.classList.remove('show'), 1400); }

/* =========================================================
 * 初始化
 * ========================================================= */
function seedDefault(){
  // 默认空物件：围绕人形模特搭建（头部为禁放区）
  createObject({ name:'物件 1', colorName: editor.voxelColor, layer:0 });
  refreshStats(); autoSave();
}

if (!loadFromStorage()) seedDefault();
refreshObjList(); refreshRightPanel(); syncPlaneIndicator(); refreshLevelName();

function animate(){
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}
animate();
