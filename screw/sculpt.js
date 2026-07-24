if (!window.THREE) throw new Error('本地 three.min.js 加载失败：请确认 vendor/three.min.js 存在。');

/* =========================================================
 * 小体素雕塑编辑器（Sculpt）
 * - 可调体素尺寸：真正的"小体素"，体素世界尺寸可缩放（精细雕塑）
 * - 片状笔刷：一次铺一整片体素（方/圆，可调半径），像雕塑一样成片堆叠
 * - 贴面雕刻模式：在体素外露面上按面的切平面成片堆叠/削除
 * - 平面层模式：在固定高度层成片绘制
 * - 体素颜色：任意自选（hex，颜色拾取器 + 最近使用）
 * - 螺丝：固定 8 色（游戏需求匹配），按"相连体素的整片表面"智能布点，
 *        每个连续表面区域放一颗、位于区域中心、尺寸随区域大小自适应
 * - 数据与游戏关卡格式兼容（voxels 值可为 hex 或 8 色名；新增 voxelSize；
 *        螺丝以局部坐标 pos+normal 存储，兼容旧的 key+face 形式）
 * ========================================================= */

// 螺丝固定 8 色（必须与 index.html / editor.js 的 COLORS 对齐）
const SCREW_COLORS = [
  { name:'red',    hex:0xff5d5d, css:'#ff5d5d' },
  { name:'green',  hex:0x4dd07a, css:'#4dd07a' },
  { name:'purple', hex:0xb06dff, css:'#b06dff' },
  { name:'blue',   hex:0x4d8cff, css:'#4d8cff' },
  { name:'gray',   hex:0xa0a7b8, css:'#a0a7b8' },
  { name:'brown',  hex:0x9b6b43, css:'#9b6b43' },
  { name:'white',  hex:0xf3f5fa, css:'#f3f5fa' },
  { name:'yellow', hex:0xffd166, css:'#ffd166' },
];
const screwByName = n => SCREW_COLORS.find(c => c.name === n) || SCREW_COLORS[0];

const STORAGE_KEY = 'screw_sculpt_level_v1';
const CUSTOM_LEVEL_KEY = 'screw_custom_level';   // 与游戏共享：试玩用（兼容旧入口）
const CUSTOM_LEVELS_KEY = 'screw_custom_levels_v1'; // 我的自定义关卡库（可管理多关）
const DEFAULT_VOXEL_SIZE = 0.5;
const SCREW_DIAMETER = 0.25;   // 螺丝固定为 0.25（世界直径恒为 0.25，不随 voxelSize 变化）

/* ---------------- 颜色工具：体素用任意 hex ---------------- */
function hexStrToInt(s){ return parseInt(s.replace('#',''), 16) || 0; }
function normHex(s){
  s = (s || '').trim();
  if (s[0] !== '#') s = '#' + s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) s = '#' + s[1]+s[1]+s[2]+s[2]+s[3]+s[3];
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : null;
}
// 体素 value 可能是 hex 字符串，也可能是旧的颜色名 -> 统一转 hex int
function voxelValueToHexInt(v){
  const hex = decodeVoxel(v).hex;
  if (typeof hex === 'string' && hex[0] === '#') return hexStrToInt(hex);
  const c = SCREW_COLORS.find(x => x.name === hex);
  return c ? c.hex : 0xcccccc;
}

/* ---------------- 体素形状编解码（向后兼容旧的纯 hex 字符串） ----------------
 * value 编码：
 *   "#rrggbb"                  -> 立方体 cube
 *   "#rrggbb|shape|dir"        -> 形状(half/tri) + 朝向 dir(0..5：+x,-x,+y,-y,+z,-z)
 *   "#rrggbb|shape|dir|faces"  -> 追加 6 面颜色覆盖
 *   "...|mult"                 -> 追加体素尺寸倍数（相对常规体素边长的倍数，支持小数，如
 *                                  0.25/0.5/1.5/2/3；该体素以自身逻辑坐标为锚点（最小角），
 *                                  实际占用 mult×mult×mult 个「常规体素」大小的空间。
 *                                  同一物件内可与其它尺寸的体素自由混合摆放，实现同物件内
 *                                  不同大小体素共存）
 *   "...|mult|alpha"           -> 追加透明度（0=完全透明 ~ 1=完全不透明）
 *   旧颜色名("red"等)也兼容，按 cube 处理
 * dir 表示「形状的法线/朝向」：half=平切面的法线方向；tri=斜面朝向
 */
const SHAPE_CUBE = 'cube', SHAPE_HALF = 'half', SHAPE_TRI = 'tri';
const SHAPE_SPHERE = 'sphere', SHAPE_HALFSPHERE = 'halfsphere', SHAPE_TORUS = 'torus';
// 参数化形状（带自定义参数，参数以世界绝对单位设置，几何居中于体素格、可超出格子）：
//   cylinder      圆柱体：  params = [半径, 高度]
//   halfcylinder  半圆柱：  params = [半径, 高度]
//   cone          圆台/圆锥：params = [上半径, 下半径, 高度]（上半径=0 即圆锥）
//   pyramid       棱锥：    params = [棱数, 底半径, 高度, 顶部偏移度数]
//   torusp        圆环：    params = [内直径, 外直径, 高度]
const SHAPE_CYLINDER = 'cylinder', SHAPE_HALFCYLINDER = 'halfcylinder', SHAPE_CONE = 'cone', SHAPE_PYRAMID = 'pyramid', SHAPE_TORUSP = 'torusp';
// 各参数化形状的默认参数（世界单位）
const SHAPE_PARAM_DEFAULTS = {
  cylinder:     [0.5, 1.0],
  halfcylinder: [0.5, 1.0],
  cone:         [0.2, 0.5, 1.0],
  pyramid:      [4, 0.5, 1.0, 0],
  torusp:       [0.4, 1.0, 0.4],
};
const PARAM_SHAPES = { cylinder:1, halfcylinder:1, cone:1, pyramid:1, torusp:1 };
function isParamShape(shape){ return !!PARAM_SHAPES[shape]; }
// faces：可选的 6 面颜色覆盖（BoxGeometry 面序：+X,-X,+Y,-Y,+Z,-Z）。
//   编码为第 4 段：六个用逗号分隔的 rrggbb（无 #），无覆盖处用 '-'。
// mult：可选的体素尺寸倍数（第 5 段，数字，可为小数，如 0.25/0.5/1.5/2/3）。
//   未指定时默认为 1（常规单位体素）。
// alpha：可选的透明度（第 6 段，数字，0~1，默认 1=完全不透明）。
// params：可选的第 7 段，参数化形状的参数（逗号分隔的数字，世界单位）。存在时前面各段用占位补齐。
function encodeVoxel(hex, shape, dir, faces, mult, alpha, params){
  const hasFaces = Array.isArray(faces) && faces.some(f => f);
  const hasMult = mult > 0 && Math.abs(mult - 1) > 1e-6;
  const hasAlpha = typeof alpha === 'number' && alpha >= 0 && alpha < 1 - 1e-6;
  const hasParams = Array.isArray(params) && params.length > 0;
  if ((!shape || shape === SHAPE_CUBE) && !hasFaces && !hasMult && !hasAlpha && !hasParams) return hex;
  let s = `${hex}|${shape || SHAPE_CUBE}|${dir|0}`;
  // 有 params 时，faces/mult/alpha 即使为默认也要占位输出，保证 params 落在第 7 段
  if (hasFaces || hasMult || hasAlpha || hasParams) s += '|' + (hasFaces ? faces.map(f => f ? String(f).replace('#','') : '-').join(',') : '-');
  if (hasMult || hasAlpha || hasParams) s += `|${mult || 1}`;
  if (hasAlpha || hasParams) s += `|${(hasAlpha ? alpha : 1)}`;
  if (hasParams) s += `|${params.map(n => +(+n).toFixed(4)).join(',')}`;
  return s;
}
function decodeVoxel(v){
  if (typeof v !== 'string') return { hex:'#cccccc', shape:SHAPE_CUBE, dir:2, faces:null, mult:1, alpha:1, params:null };
  if (v.indexOf('|') < 0) return { hex:v, shape:SHAPE_CUBE, dir:2, faces:null, mult:1, alpha:1, params:null };
  const parts = v.split('|');
  const hex = parts[0], shape = parts[1] || SHAPE_CUBE, dir = parseInt(parts[2]) || 0;
  let faces = null;
  if (parts[3] && parts[3] !== '-') {
    faces = parts[3].split(',').map(x => (x && x !== '-') ? '#' + x : null);
    while (faces.length < 6) faces.push(null);
  }
  const mult = parts[4] ? (parseFloat(parts[4]) || 1) : 1;
  const alpha = parts[5] ? (parseFloat(parts[5])) : 1;
  let params = null;
  if (parts[6]) { params = parts[6].split(',').map(x => parseFloat(x)).filter(n => !isNaN(n)); if (!params.length) params = null; }
  return { hex, shape, dir, faces, mult, alpha: (typeof alpha === 'number' && !isNaN(alpha)) ? Math.max(0, Math.min(1, alpha)) : 1, params };
}

/* ---------------- 场景 ---------------- */
const app = document.getElementById('app');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x11131f);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth/window.innerHeight, 0.05, 500);
const orbit = { target:new THREE.Vector3(0,1,0), radius:14, theta:0.6, phi:Math.PI*0.36, minPhi:0.05, maxPhi:Math.PI-0.05 };
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
// 色彩空间 + 色调映射：
// 体素编辑器需要「所见即所得」——用户选的 hex 就应显示成那个颜色。ACES 电影级色调映射
// 会压缩高光、抬升中间调，导致颜色发灰、发白、偏离所选值（观感就是"曝光偏大"）。
// 这里改为不做色调映射（线性直出 + sRGB 编码），并把三组光照总量配平到「正对光的面≈1」，
// 既保留体素立体明暗，又不过曝、颜色更准。
if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.toneMappingExposure = 1.0;
app.appendChild(renderer.domElement);

scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const hemi = new THREE.HemisphereLight(0xf1f8ff, 0x40476a, 0.2); scene.add(hemi);
const dir = new THREE.DirectionalLight(0xffffff, 0.5);
dir.position.set(10, 22, 12); dir.castShadow = true; dir.shadow.mapSize.set(2048,2048);
dir.shadow.camera.near=1; dir.shadow.camera.far=80; dir.shadow.camera.left=-30; dir.shadow.camera.right=30; dir.shadow.camera.top=30; dir.shadow.camera.bottom=-30;
// 消除阴影自遮挡产生的"麻点/粗糙颗粒"噪点（shadow acne）：
// 没有 bias 时，物体表面（尤其是体素棱边、斜面）会在阴影贴图分辨率限制下
// 出现大量细碎自阴影斑点，肉眼看起来就像"边缘长了一层粗糙的纹理"。
dir.shadow.bias = -0.0015;
dir.shadow.normalBias = 0.02;
scene.add(dir);

/* 光影随镜头水平旋转（仅左右/方位角，不跟随俯仰）：
   保持光源与地面的水平距离、高度不变，只让光源绕 Y 轴与镜头 orbit.theta
   同步转动，并保留初始时相对镜头的夹角，这样光照方向始终"跟着镜头转"，
   但镜头上下看时光影角度不会跟着变化。 */
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

/* ---------------- 地面网格 ---------------- */
const GRID = 50;
const gridHelper = new THREE.GridHelper(GRID, GRID, 0x4a4080, 0x2a2a50);
scene.add(gridHelper);
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(GRID, GRID),
  new THREE.MeshStandardMaterial({ color:0x171a30, roughness:1, metalness:0, transparent:true, opacity:0.55 })
);
// 地面不接收投影：地上不需要出现体素的阴影
ground.rotation.x = -Math.PI/2; ground.receiveShadow = false; ground.name = 'ground';
scene.add(ground);

const planeIndicator = new THREE.Mesh(
  new THREE.PlaneGeometry(GRID, GRID),
  new THREE.MeshBasicMaterial({ color:0x7a4fff, transparent:true, opacity:0.06, side:THREE.DoubleSide, depthWrite:false })
);
planeIndicator.rotation.x = -Math.PI/2;
planeIndicator.visible = false;
scene.add(planeIndicator);

// 片状笔刷预览组（每帧按当前体素尺寸重建盒子）
const hoverGroup = new THREE.Group();
scene.add(hoverGroup);
function clearHover(){ while(hoverGroup.children.length) { const c = hoverGroup.children.pop(); c.traverse(o=>{ o.geometry?.dispose?.(); }); } }

/* ---------------- 人形模特（半透明参考 + 头部禁放区） ----------------
 * 雕塑围绕模特创作；头部为禁止放置体素的区域。
 */
let mannequin = null;
// 人形模特的变换（随关卡保存到 level.mannequin）
const mannequinXform = { x:0, y:0, z:0, rotY:0, scale:1, visible:false };
if (window.createMannequin) {
  mannequin = window.createMannequin({ color:0xc7cee2, opacity:0.5 });
  mannequin.position.set(0, 0, 0);
  mannequin.visible = false;   // 默认隐藏，避免创建后首帧闪现；需用户手动开启
  scene.add(mannequin);
}
// 把 mannequinXform 应用到模特网格
function applyMannequinXform(){
  if (!mannequin) return;
  const t = mannequinXform;
  mannequin.position.set(t.x || 0, t.y || 0, t.z || 0);
  mannequin.rotation.y = THREE.MathUtils.degToRad(t.rotY || 0);
  const s = t.scale > 0 ? t.scale : 1;
  mannequin.scale.set(s, s, s);
  mannequin.visible = t.visible !== false;
  if (mannequin.updateMatrixWorld) mannequin.updateMatrixWorld(true);
}
function headBlocks(worldPoint){
  if (!mannequin || !mannequin.userData.getHeadWorldSphere) return false;
  const sph = mannequin.userData.getHeadWorldSphere();
  return worldPoint.distanceTo(sph.center) < sph.radius;
}
function cellBlockedByHead(obj, cx, cy, cz){
  // 已放开人物模型附近的建模限制：头部/人体不再作为禁放区，允许在模特附近自由雕刻。
  // 保留本函数与 headBlocks 供其它逻辑调用，但放置判定恒不阻挡。
  return false;
}

/* =========================================================
 * 数据模型（与游戏关卡兼容）
 * object = {
 *   id, name, colorName(代表色 hex), layer, pos, rotY,
 *   voxelSize,                         // 每个体素的世界边长（可调"小体素"）
 *   voxels:{ "x,y,z": hex },           // 逻辑坐标始终为整数网格
 *   screws:[ { pos:[lx,ly,lz], normal:[nx,ny,nz], color, scale } ]  // 局部坐标，贴在表面任意位置
 * }
 * ========================================================= */
let level = { name:'我的雕塑关卡', objects:[] };
let activeObjId = null;
let nextId = 1;

const editor = {
  tool: 'add',          // add | erase | paint | screw | screw-erase
  mode: 'surface',      // plane | surface
  planeY: 0,
  voxelColor: '#ffd166',// 任意 hex
  voxelAlpha: 1.0,      // 体素透明度：0=完全透明 ~ 1=完全不透明
  screwColor: 'red',    // 8 色名
  brush: 0,             // 片状半径（默认 0 = 单格）
  shape: 'square',      // 笔刷片形状：square | round
  brushOrient: 'auto',  // 笔刷片朝向：auto=跟随点击面 | horizontal=水平横片(XZ) | vertical=竖直竖片(面向镜头)
  voxelShape: 'cube',   // 体素形状：cube|half|tri|sphere|halfsphere|torus|cylinder|halfcylinder|cone|pyramid|torusp
  // 参数化形状的当前参数（按形状名索引，缺省用 SHAPE_PARAM_DEFAULTS）
  shapeParams: {
    cylinder:     [0.5, 1.0],
    halfcylinder: [0.5, 1.0],
    cone:         [0.2, 0.5, 1.0],
    pyramid:      [4, 0.5, 1.0, 0],
    torusp:       [0.4, 1.0, 0.4],
  },
  voxelMult: 1,         // 体素大小倍数：0.25/0.5/1/1.5/2/3（≠1 时占用对应比例的空间，
                         // 可与同物件内其它大小的体素自由混合摆放）
  recent: ['#ffd166','#ff5d5d','#4dd07a','#4d8cff'],
  screwCount: 18,       // 全局自动布点：螺丝总数（3 的倍数）
  screwColorCount: 3,   // 全局自动布点：颜色种类数
  paintFace: false,     // 上色工具：true=只给点击的单个面上色；false=整块上色（默认整块）
};

const renderRefs = new Map(); // objId -> { group, voxelMeshes:Map, pickMeshes:Set, screwMeshes:Map }
let _largeSceneMode = false;
function updateRendererPerformanceMode(){
  let total = 0;
  level.objects.forEach(o => { total += Number.isFinite(o._voxelCount) ? o._voxelCount : Object.keys(o.voxels || {}).length; });
  const large = total >= 10000;
  if (large === _largeSceneMode) return;
  _largeSceneMode = large;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, large ? 1.25 : 2));
  renderer.shadowMap.enabled = !large;
}

// 支持的最小尺寸粒度：0.25（即所有可选体素尺寸 0.25/0.5/1/1.5/2/3 均为其整数倍）。

// 坐标/尺寸统一吸附到该粒度，避免浮点误差导致占用表 key 不一致。
const VOXEL_STEP = 0.25;
function snap4(v){ return Math.round(v / VOXEL_STEP) * VOXEL_STEP; }

const keyOf = (x,y,z) => `${snap4(x)},${snap4(y)},${snap4(z)}`;
const parseKey = k => k.split(',').map(Number);

// 取某物件的体素尺寸（带默认）
function vsizeOf(obj){ return obj && obj.voxelSize > 0 ? obj.voxelSize : DEFAULT_VOXEL_SIZE; }

// 遍历一个「锚点在原点、尺寸为 mult（可为小数，单位=常规体素边长）」的体素所占用的
// 每个 0.25 粒度子格的偏移量 (dx,dy,dz)，用于占用表增删/校验。
function forEachSubOffset(mult, cb){
  const m = mult > 0 ? mult : 1;
  const n = Math.max(1, Math.round(m / VOXEL_STEP));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
    cb(i * VOXEL_STEP, j * VOXEL_STEP, k * VOXEL_STEP);
  }
}

/* ---------------- 逻辑格占用表（支持同物件内混合不同大小的体素） ----------------
 * 常规体素占用 1×1×1 个「常规体素」大小的空间；更大/更小的体素以自身坐标为锚点
 * （最小角），占用 mult×mult×mult 个「常规体素」大小的空间（mult 可为 0.25/0.5/1.5 等小数）。
 * obj._occ：{ "x,y,z"（被占用的每个 0.25 粒度子格） -> 锚点体素的 key }，用于 O(1) 判断
 * 任意位置是否已被占用，以及一次性定位到占用它的体素（无论该体素多大/多小）。
 * 每次增删体素时增量维护；载入/重建物件时整体重扫一次。
 */
function rebuildOccupancy(obj, forceDetailed){
  const occ = {};
  let compact = !forceDetailed;
  if (compact) {
    for (const key in obj.voxels) {
      const dec = decodeVoxel(obj.voxels[key]);
      const [x,y,z] = parseKey(key);
      if (Math.abs((dec.mult || 1) - 1) > 1e-6 || x !== Math.floor(x) || y !== Math.floor(y) || z !== Math.floor(z)) { compact = false; break; }
    }
  }
  for (const key in obj.voxels) {
    if (compact) { occ[key] = key; continue; }
    const [x, y, z] = parseKey(key);
    const mult = decodeVoxel(obj.voxels[key]).mult || 1;
    forEachSubOffset(mult, (dx,dy,dz) => { occ[keyOf(x+dx, y+dy, z+dz)] = key; });
  }
  obj._occ = occ;
  obj._occCompact = compact;
}
function ensureDetailedOccupancy(obj){
  if (obj && obj._occCompact) rebuildOccupancy(obj, true);
}
function occupiedOwner(obj, x, y, z){
  if (!obj || !obj._occ) return null;
  const direct = obj._occ[keyOf(x,y,z)];
  if (direct) return direct;
  if (!obj._occCompact) return null;
  return obj._occ[keyOf(Math.floor(x + 1e-8), Math.floor(y + 1e-8), Math.floor(z + 1e-8))] || null;
}
function markOccupied(obj, x, y, z, mult, ownerKey){
  if (!obj._occ) obj._occ = {};
  if (obj._occCompact && Math.abs(mult - 1) < 1e-6 && x === Math.floor(x) && y === Math.floor(y) && z === Math.floor(z)) {
    obj._occ[ownerKey] = ownerKey;
    return;
  }
  ensureDetailedOccupancy(obj);
  forEachSubOffset(mult, (dx,dy,dz) => { obj._occ[keyOf(x+dx, y+dy, z+dz)] = ownerKey; });
}
function unmarkOccupied(obj, x, y, z, mult){
  if (!obj._occ) return;
  if (obj._occCompact) { delete obj._occ[keyOf(x,y,z)]; return; }
  forEachSubOffset(mult, (dx,dy,dz) => { delete obj._occ[keyOf(x+dx, y+dy, z+dz)]; });
}
// 常规整数体素使用紧凑占用表：5 万体素只存 5 万项，而不是按 0.25 子格膨胀到 320 万项。
function cellOccupied(obj, x, y, z){
  return !!occupiedOwner(obj, x, y, z);
}

// 凭空落点（空格直填 / 地面兜底）时限制在 50×50×n 的水平网格区域内（以物件原点为中心）。
// 该限制仅用于"没有可贴合的既有表面"的情况，避免点到十分远处凭空生成体素；
// 而"贴着既有体素面延续"不受此限制（走命中分支），因此可以自然向外延展。
const PLACE_XZ_HALF = 25;   // 50×50 → 每侧 25 格（Y 方向不限，即高度 n 不限）
// 把一个凭空落点的 XZ 锚点夹回 50×50 范围内（Y 不变）
function clampAnchorToFreeRange(a, mult){
  const m = mult > 0 ? mult : 1;
  const lo = -PLACE_XZ_HALF, hi = PLACE_XZ_HALF - m;
  return {
    x: Math.max(lo, Math.min(hi, a.x)),
    y: a.y,
    z: Math.max(lo, Math.min(hi, a.z)),
  };
}

// 判断能否在 (x,y,z) 处放置一个 mult³ 大小的体素：所有子格必须都未被占用、且不落入人头禁放区
function canPlaceBlock(obj, x, y, z, mult){
  if (obj && obj._occCompact && Math.abs((mult || 1) - 1) < 1e-6 && x === Math.floor(x) && y === Math.floor(y) && z === Math.floor(z)) {
    return !cellOccupied(obj, x, y, z) && !cellBlockedByHead(obj, x, y, z);
  }
  let ok = true;
  forEachSubOffset(mult, (dx,dy,dz) => {

    if (!ok) return;
    if (cellOccupied(obj, x+dx, y+dy, z+dz) || cellBlockedByHead(obj, x+dx, y+dy, z+dz)) ok = false;
  });
  return ok;
}

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
    rotX: opts.rotX ?? 0,
    rotY: opts.rotY ?? 0,
    rotZ: opts.rotZ ?? 0,
    scale: opts.scale ? { x:opts.scale.x??1, y:opts.scale.y??1, z:opts.scale.z??1 } : { x:1, y:1, z:1 },
    voxelSize: opts.voxelSize ?? DEFAULT_VOXEL_SIZE,
    voxels: opts.voxels || {},
    screws: opts.screws || [],
  };
  level.objects.push(obj);
  buildObjectGroup(obj);
  activeObjId = id;
  refreshObjList(); refreshRightPanel();
  return obj;
}

function deleteObject(id){
  const idx = level.objects.findIndex(o => o.id === id);
  if (idx < 0) return;
  const gid = level.objects[idx].groupId;
  const ref = renderRefs.get(id);
  if (ref) { scene.remove(ref.group); renderRefs.delete(id); }
  level.objects.splice(idx, 1);
  // 若被删物件所在组只剩一个成员，自动解散该组
  if (gid){
    const rest = level.objects.filter(o => o.groupId === gid);
    if (rest.length === 1) rest[0].groupId = null;
  }
  if (activeObjId === id) activeObjId = level.objects.length ? level.objects[0].id : null;
  updateRendererPerformanceMode();
  refreshObjList(); refreshRightPanel(); autoSave();

}

// 复制物件：深拷贝体素/螺丝/变换，位置与原物件完全一致（原位重叠），成为新的选中物件
function duplicateObject(id){
  const src = level.objects.find(o => o.id === id);
  if (!src) return null;
  const sc = scaleOf(src);
  const clone = createObject({
    name: (src.name || '物件') + ' 副本',
    colorName: src.colorName,
    layer: src.layer,
    pos: { x: src.pos.x || 0, y: src.pos.y || 0, z: src.pos.z || 0 },
    rotX: src.rotX || 0,
    rotY: src.rotY || 0,
    rotZ: src.rotZ || 0,
    scale: { x: sc.x, y: sc.y, z: sc.z },
    voxelSize: vsizeOf(src),
    voxels: JSON.parse(JSON.stringify(src.voxels || {})),
    screws: JSON.parse(JSON.stringify(src.screws || [])),
  });
  autoSave();
  toast(`已复制「${src.name}」`);
  return clone;
}

// 取物件的世界变换矩阵（若已有渲染 group 则直接用，保证与画面完全一致；
// 否则临时按 pos/三轴旋转/scale/几何中心轴心现算一份，逻辑与 applyObjTransform 保持一致）
function objWorldMatrix(obj){
  const ref = renderRefs.get(obj.id);
  if (ref && ref.group){ ref.group.updateMatrixWorld(true); return ref.group.matrixWorld.clone(); }
  const sc = scaleOf(obj);
  const quat = objQuat(obj);
  const m = new THREE.Matrix4();
  m.compose(
    objPivotPosition(obj, sc, quat),
    quat,
    new THREE.Vector3(sc.x, sc.y, sc.z)
  );
  return m;
}

// 把「源物件的某个逻辑格坐标(sx,sy,sz)（可带 mult 得到体素中心）」换算到「目标物件的逻辑格坐标」。
// 走世界坐标中转：源局部中心 → 世界 → 目标局部 → 目标逻辑格锚点。
function srcCellToDstKey(srcObj, dstObj, srcMat, dstInv, sx, sy, sz, mult){
  const localC = voxelCenterLocal(srcObj, sx, sy, sz, mult);   // 源局部（体素中心）
  const world = localC.clone().applyMatrix4(srcMat);           // → 世界
  const dstLocal = world.applyMatrix4(dstInv);                 // → 目标局部
  const ds = vsizeOf(dstObj);
  // 目标局部中心 = (x + m/2) * ds  ⇒  锚点 x = round(center/ds - m/2)
  const dm = mult > 0 ? mult : 1;
  const gx = Math.round(dstLocal.x / ds - dm/2);
  const gy = Math.round(dstLocal.y / ds - dm/2);
  const gz = Math.round(dstLocal.z / ds - dm/2);
  return keyOf(gx, gy, gz);
}

/* ---------------- 物件绑定（整组共命运掉落） ----------------
 * 绑定不改变任何物件的体素/位置/大小，只给同组物件打上相同的 groupId。
 * 游戏中：同一组里所有物件身上的螺丝全部被取光后，整组一起掉落
 * （任一物件还剩螺丝，则整组都不掉）。支持多个物件绑成一组。
 */
let nextGroupId = 1;
function ensureGroupIdCounter(){
  // 让 nextGroupId 大于现有所有 groupId，避免 id 冲突
  let mx = 0;
  level.objects.forEach(o => { if (o.groupId > mx) mx = o.groupId; });
  if (nextGroupId <= mx) nextGroupId = mx + 1;
}

// 把 srcId 绑定到 aId 所在的组（若两者都无组则新建一个组；若一方已有组则并入该组；
// 若两方各有不同组，则把 src 那组的全部成员并入 a 的组）。
function bindObjects(aId, srcId){
  if (aId === srcId) return;
  const a = level.objects.find(o => o.id === aId);
  const src = level.objects.find(o => o.id === srcId);
  if (!a || !src){ toast('要绑定的物件不存在'); return; }
  ensureGroupIdCounter();

  let gid = a.groupId || src.groupId;
  if (!gid) gid = nextGroupId++;

  // 若 src 已属于另一个组，把那一整组都迁移过来（保持整组一致）
  const srcOldGid = src.groupId;
  if (srcOldGid && srcOldGid !== gid){
    level.objects.forEach(o => { if (o.groupId === srcOldGid) o.groupId = gid; });
  }
  a.groupId = gid;
  src.groupId = gid;

  const members = level.objects.filter(o => o.groupId === gid);
  refreshObjList(); refreshStats(); autoSave();
  toast(`已绑定为一组（共 ${members.length} 个物件，螺丝全被取走后一起掉落）`);
}

// 解除某物件的绑定：把它从组里移除；若该组只剩 1 个成员，则该组自动解散
function unbindObject(id){
  const obj = level.objects.find(o => o.id === id);
  if (!obj || !obj.groupId){ toast('该物件未绑定'); return; }
  const gid = obj.groupId;
  obj.groupId = null;
  const rest = level.objects.filter(o => o.groupId === gid);
  if (rest.length === 1) rest[0].groupId = null;   // 组里只剩一个，自动解散
  refreshObjList(); refreshStats(); autoSave();
  toast(`已解除「${obj.name}」的绑定`);
}

// 取某物件所在组的全部成员（含自身）；未绑定则返回空数组
function groupMembersOf(id){
  const obj = level.objects.find(o => o.id === id);
  if (!obj || !obj.groupId) return [];
  return level.objects.filter(o => o.groupId === obj.groupId);
}

// 清理只剩 1 个成员的组（组里只剩一个物件时自动解散，视为未绑定）
function cleanupTinyGroups(){
  const cnt = {};
  level.objects.forEach(o => { if (o.groupId) cnt[o.groupId] = (cnt[o.groupId] || 0) + 1; });
  level.objects.forEach(o => { if (o.groupId && cnt[o.groupId] < 2) o.groupId = null; });
}

// 把给定 ids 的所有物件绑成同一组（至少 2 个）。若勾选项里已有物件属于某组，
// 复用其一作为组号，其余勾选物件并入该组；因成员被移走而只剩 1 个的旧组自动解散。
function bindObjectsMulti(ids){
  const objs = ids.map(id => level.objects.find(o => o.id === id)).filter(Boolean);
  if (objs.length < 2){ toast('至少选择两个物件才能绑定'); return false; }
  ensureGroupIdCounter();
  let gid = 0;
  for (const o of objs){ if (o.groupId){ gid = o.groupId; break; } }
  if (!gid) gid = nextGroupId++;
  objs.forEach(o => { o.groupId = gid; });
  cleanupTinyGroups();
  const total = level.objects.filter(o => o.groupId === gid).length;
  refreshObjList(); refreshStats(); autoSave();
  toast(`已绑定为一组（共 ${total} 个物件，螺丝全被取走后一起掉落）`);
  return true;
}

// 解散所选物件涉及到的所有组：把这些组的全部成员（含未勾选的）都解除绑定。
function unbindGroupsByIds(ids){
  const gids = new Set();
  ids.forEach(id => { const o = level.objects.find(x => x.id === id); if (o && o.groupId) gids.add(o.groupId); });
  if (!gids.size){ toast('所选物件没有已绑定的组'); return false; }
  level.objects.forEach(o => { if (gids.has(o.groupId)) o.groupId = null; });
  refreshObjList(); refreshStats(); autoSave();
  toast('已解除绑定');
  return true;
}

// 是否禁止对该物件缩放：物件在一个绑定组里、且该组未覆盖全部物件时禁止；
// 当组包含场景中「全部物件」时允许（此时缩放会整组随动）。未绑定物件不受限。
function scaleBlockedFor(o){
  if (!o || !o.groupId) return false;
  const total = level.objects.length;
  const members = level.objects.filter(x => x.groupId === o.groupId).length;
  return members < total;
}

// 界面正中浮现一条提示，dur 毫秒后淡出（默认 500）；pointer-events:none 保证不影响其它操作。
function centerFlash(msg, dur = 500){
  let el = document.getElementById('center-flash');
  if (!el){
    el = document.createElement('div');
    el.id = 'center-flash';
    el.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:200;' +
      'padding:14px 26px;border-radius:12px;background:rgba(20,24,40,.92);color:#fff;font-size:15px;' +
      'font-weight:600;box-shadow:0 10px 34px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.14);' +
      'pointer-events:none;opacity:0;transition:opacity .12s;';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, dur);
}

// 显示/隐藏某个物件（仅影响画面显示，不删除数据；隐藏状态随关卡保存）
function applyObjVisibility(obj){
  const ref = renderRefs.get(obj.id);
  if (ref && ref.group) ref.group.visible = !obj.hidden;
}
function toggleObjHidden(id){
  const obj = level.objects.find(o => o.id === id);
  if (!obj) return;
  obj.hidden = !obj.hidden;
  applyObjVisibility(obj);
  refreshObjList(); refreshStats(); autoSave();
  toast(obj.hidden ? `已隐藏「${obj.name}」` : `已显示「${obj.name}」`);
}

// 一键清空场景内全部物件（需确认，不可撤销）
async function deleteAllObjects(){
  if (!level.objects.length){ toast('当前没有物件'); return; }
  if (!(await confirmDialog(`确定删除全部 ${level.objects.length} 个物件？此操作不可撤销。`, { okText:'全部删除' }))) return;
  renderRefs.forEach(ref => scene.remove(ref.group));
  renderRefs.clear();
  level.objects = [];
  activeObjId = null;
  updateRendererPerformanceMode();
  refreshObjList(); refreshRightPanel(); refreshStats(); autoSave();

  toast('已清空全部物件');
}

/* ---------------- 几何 ---------------- */
const _voxelMaterialCache = new Map();
const _voxelInstanceMaterialCache = new Map();
function voxelInstanceMaterial(alpha, doubleSide){
  const a = typeof alpha === 'number' && !isNaN(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
  const key = `${a.toFixed(4)}|${doubleSide?1:0}`;
  let mat = _voxelInstanceMaterialCache.get(key);
  if (mat) return mat;
  mat = new THREE.MeshStandardMaterial({
    color:0xffffff, roughness:0.78, metalness:0.04, flatShading:true, vertexColors:true,
    transparent:a < 1 - 1e-6, opacity:a, depthWrite:a >= 0.95,
    side:doubleSide ? THREE.DoubleSide : THREE.FrontSide,
  });
  _voxelInstanceMaterialCache.set(key, mat);
  return mat;
}
// Three r128 会将顶点色与 instanceColor 相乘；几何没有顶点色属性时乘积为黑。
// 为缓存几何补一份白色顶点色，让 instanceColor 单独决定每个体素的原始颜色。
function ensureWhiteVertexColors(geo){
  if (!geo || geo.getAttribute('color')) return geo;
  const pos = geo.getAttribute('position');
  if (!pos) return geo;
  const colors = new Float32Array(pos.count * 3);
  colors.fill(1);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

function voxelStdMat(hexInt, alpha, doubleSide){

  const a = typeof alpha === 'number' && !isNaN(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
  const cacheKey = `${hexInt}|${a.toFixed(4)}|${doubleSide?1:0}`;
  let mat = _voxelMaterialCache.get(cacheKey);
  if (mat) return mat;
  mat = new THREE.MeshStandardMaterial({
    color: hexInt, roughness:0.78, metalness:0.04, flatShading:true,
    transparent: a < 1 - 1e-6, opacity: a,
    depthWrite: a >= 0.95,
    side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
  });
  _voxelMaterialCache.set(cacheKey, mat);
  return mat;
}
// 相同颜色/透明度的体素共享材质，避免数万份重复 WebGL 材质对象。
function voxelMaterial(value){
  const dec = decodeVoxel(value);
  const base = voxelValueToHexInt(value);
  if (dec.faces && dec.shape === SHAPE_CUBE) {
    return dec.faces.map(f => voxelStdMat(f ? hexStrToInt(f) : base, dec.alpha));
  }
  return voxelStdMat(base, dec.alpha, dec.shape !== SHAPE_CUBE);
}


// dir 编号 -> 法线向量
const DIR_VECS = [
  new THREE.Vector3(1,0,0),  new THREE.Vector3(-1,0,0),
  new THREE.Vector3(0,1,0),  new THREE.Vector3(0,-1,0),
  new THREE.Vector3(0,0,1),  new THREE.Vector3(0,0,-1),
];
// 把 [fx,fy,fz] 面法线转成 dir 编号
function faceToDir(face){
  if (face[0]>0) return 0; if (face[0]<0) return 1;
  if (face[1]>0) return 2; if (face[1]<0) return 3;
  if (face[2]>0) return 4; return 5;
}

// 三角体素：直角三棱柱。基准朝向 dir=+Y 时，顶面(+Y)与左竖面(-X)为完整
// 正方形贴合面（与相邻方块无缝拼接），斜面（斜切角）朝 +X/-Y，沿 Z 拉伸占满
// 1 体素（占满整个体素包围盒，不留空隙）。
// 纯手工 BufferGeometry（不依赖 ExtrudeGeometry/Shape，避免个别 three 构建下报错），
// 每个面的顶点绕序均已逐一用右手法则核算，确保外法线方向正确、不会出现
// "正面被裁剪成空洞"的破面问题。
function makeTriGeometry(size){
  const s = size / 2;
  const A0=[-s, s, s], B0=[s, s, s], C0=[-s,-s, s];   // 前截面 z=+s
  const A1=[-s, s,-s], B1=[s, s,-s], C1=[-s,-s,-s];   // 后截面 z=-s
  const tris = [
    A0,C0,B0,              // 前面 +Z
    A1,B1,C1,              // 后面 -Z
    A0,B0,B1, A0,B1,A1,    // 顶面 +Y（完整正方形）
    A0,A1,C1, A0,C1,C0,    // 左竖面 -X（完整正方形）
    B0,C0,C1, B0,C1,B1,    // 斜面
  ];
  return trisToGeometry(tris);
}

// 半圆体素：四分之一圆弧倒角楔形。基准朝向 dir=+Y 时，顶面(+Y)与左竖面(-X)
// 同样是完整正方形贴合面（与三角体素、方块无缝拼接，占满整个体素包围盒），
// 仅把三角体素的斜面替换成一段圆滑的四分之一圆弧曲面，圆心在顶面与左竖面
// 相交的棱线上——即"方块斜切成三角，再把斜切面磨圆"的效果。
// 同样纯手工构建 BufferGeometry，每一段扇面/侧面的绕序都单独核算过，
// 保证前后端面、圆弧侧面、顶面、侧面五组面法线全部朝外、严丝合缝、无破面。
function makeHalfGeometry(size){
  const s = size / 2;
  const R = size;               // 圆弧半径 = 整个体素边长
  const N = 10;                  // 弧线分段数，越大越圆滑
  const cx = -s, cy = s;         // 圆心：顶面(+Y)与左竖面(-X)相交的棱线
  const A0 = [cx, cy, s], A1 = [cx, cy, -s];

  const arcF = [], arcB = [];
  for (let i = 0; i <= N; i++){
    const t = -Math.PI/2 * (i / N);   // 0 -> -90°，从「顶面终点」扫到「左竖面终点」
    const x = cx + R * Math.cos(t);
    const y = cy + R * Math.sin(t);
    arcF.push([x, y, s]);
    arcB.push([x, y, -s]);
  }
  const B0 = arcF[0], B1 = arcB[0];     // 弧线起点（同三角体素的顶点 B）
  const C0 = arcF[N], C1 = arcB[N];     // 弧线终点（同三角体素的顶点 C）

  const tris = [
    A0,B0,B1, A0,B1,A1,    // 顶面 +Y（完整正方形）
    A0,A1,C1, A0,C1,C0,    // 左竖面 -X（完整正方形）
  ];
  for (let i = 0; i < N; i++) tris.push(A0, arcF[i+1], arcF[i]);   // 前端面 +Z（扇形三角化）
  for (let i = 0; i < N; i++) tris.push(A1, arcB[i], arcB[i+1]);   // 后端面 -Z
  for (let i = 0; i < N; i++){                                    // 圆弧侧面（沿 Z 拉伸）
    tris.push(arcF[i], arcF[i+1], arcB[i+1]);
    tris.push(arcF[i], arcB[i+1], arcB[i]);
  }
  return trisToGeometry(tris);
}

// 把三角形顶点数组（每 3 个 [x,y,z] 为一个三角面）转成非索引 BufferGeometry，
// 并用 computeVertexNormals() 得到每面平坦法线（配合 flatShading 材质）。
function trisToGeometry(tris){
  const pos = new Float32Array(tris.length * 3);
  for (let i = 0; i < tris.length; i++){ pos[i*3]=tris[i][0]; pos[i*3+1]=tris[i][1]; pos[i*3+2]=tris[i][2]; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// 合并两个 BufferGeometry 的 position（都为非索引三角）为一个（不依赖 BufferGeometryUtils）。
function mergeGeos(a, b){
  const pa = a.attributes.position, pb = b.attributes.position;
  const arr = new Float32Array(pa.count*3 + pb.count*3);
  arr.set(pa.array.subarray(0, pa.count*3), 0);
  arr.set(pb.array.subarray(0, pb.count*3), pa.count*3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  g.computeVertexNormals();
  return g;
}
function toNonIndexed(geo){ return (geo.index && geo.toNonIndexed) ? geo.toNonIndexed() : geo; }

// 球体素：内切于体素盒的完整球（半径 = size/2），居中于体素中心。球对称，dir 不影响外观。
function makeSphereGeometry(size){
  const g = new THREE.SphereGeometry(size/2, 20, 14);
  return toNonIndexed(g);
}
// 半球体素：上半球（圆顶朝 +Y，平切面朝 -Y 贴合底面），半径 = size/2，
// 平切面位于体素盒底、球心在盒底中心，圆顶正好触及体素盒顶。底面补一个圆盘封口。
function makeHalfSphereGeometry(size){
  const r = size/2;
  // 约定：贴合面(平切面)朝 +Y（放置时会被旋转贴到被点击的面上），圆顶朝 -Y。
  const dome = toNonIndexed(new THREE.SphereGeometry(r, 20, 8, 0, Math.PI*2, Math.PI/2, Math.PI/2)); // 下半球(圆顶朝 -Y)
  const disk = toNonIndexed(new THREE.CircleGeometry(r, 20));  // 平切面圆盘
  disk.rotateX(-Math.PI/2);  // 转到 XZ 平面、法线朝 +Y（作为贴合面）
  const g = mergeGeos(dome, disk);
  g.translate(0, r, 0);      // 平切面落到体素盒顶(+r)，圆顶到达盒底(-r)
  return g;
}
// 圆环体素：躺平的圆环（环平面为水平 XZ 面，中轴 = +Y），外径贴合体素盒（大半径 = size/2 - 管半径）。
function makeTorusGeometry(size){
  const tube = size * 0.16;                 // 管半径
  const ring = size/2 - tube;               // 大半径（使外缘贴近体素盒边）
  const g = toNonIndexed(new THREE.TorusGeometry(Math.max(0.01, ring), Math.max(0.01, tube), 12, 24));
  g.rotateX(Math.PI/2);   // 默认环在 XY 平面(中轴 +Z)，转成中轴 +Y（水平躺平）
  return g;
}

/* ---------------- 参数化形状几何（世界绝对单位；主轴/高度方向为基准 +Y，居中于原点） ----------------
 * 这些函数返回以原点为中心的几何，makeVoxelGeometry 之后会按 dir 把 +Y 旋转到目标面法线，
 * 放置时几何中心对齐体素格中心，因此"生成位置适配体素位置"。参数缺省时用 SHAPE_PARAM_DEFAULTS。*/
function getParams(shape, params){
  const def = SHAPE_PARAM_DEFAULTS[shape] || [];
  const out = def.slice();
  if (Array.isArray(params)) for (let i=0; i<def.length; i++) if (isFinite(params[i])) out[i] = params[i];
  return out;
}
// 圆柱体：[半径, 高度]，主轴 +Y
function makeCylinderGeometry(params){
  const [r, h] = getParams(SHAPE_CYLINDER, params);
  return toNonIndexed(new THREE.CylinderGeometry(Math.max(0.01,r), Math.max(0.01,r), Math.max(0.01,h), 28));
}
// 半圆柱：[半径, 高度]。
// CylinderGeometry 顶点公式 x=sin(θ)*r, z=cos(θ)*r。
// 取 theta∈[-π/2, +π/2] 才是 z≥0 的半边（直径切面在 z=0 的 XY 平面，跨度 x∈[-r,r]、y∈[-h/2,h/2]）。
// CylinderGeometry 已封两个端面（y=±h/2 处的半圆盘）；再补一个矩形盖住直径切面。
function makeHalfCylinderGeometry(params){
  let [r, h] = getParams(SHAPE_HALFCYLINDER, params);
  r = Math.max(0.01, r); h = Math.max(0.01, h);
  const half = toNonIndexed(new THREE.CylinderGeometry(r, r, h, 24, 1, false, -Math.PI/2, Math.PI)); // 侧面 + 两端半圆盘
  const cap = toNonIndexed(new THREE.PlaneGeometry(2*r, h)); // z=0 的直径切面：宽 2r × 高 h
  cap.rotateY(Math.PI); // 法线改为 -Z，与 z≥0 半实体的外法线一致
  const g = mergeGeos(half, cap);
  return g;
}
// 圆台/圆锥：[上半径, 下半径, 高度]，上半径=0 即圆锥。
// 约定：下半径(大)那一面为贴合面，朝基准 +Y（放置时贴到被点击面）；上半径(小/尖)朝 -Y。
function makeConeGeometry(params){
  let [rt, rb, h] = getParams(SHAPE_CONE, params);
  rt = Math.max(0, rt); rb = Math.max(0.01, rb); h = Math.max(0.01, h);
  // CylinderGeometry(radiusTop=+Y, radiusBottom=-Y)：把"下半径"放到 +Y 端作为贴合面
  return toNonIndexed(new THREE.CylinderGeometry(rb, rt, h, 28));
}
// 棱锥：[棱数 n, 底半径 r, 高度 h, 顶部偏移度数 deg]
// 约定：底面为贴合面，在 +Y（放置时贴到被点击面）；尖顶朝 -Y（可按 deg 绕中心偏移）。
function makePyramidGeometry(params){
  let [n, r, h, deg] = getParams(SHAPE_PYRAMID, params);
  n = Math.max(3, Math.round(n)); r = Math.max(0.01, r); h = Math.max(0.01, h);
  const ang = THREE.MathUtils.degToRad(deg || 0);
  const half = h/2;
  // 底面顶点（y=+half，贴合面），顶点 apex（y=-half，按 deg 沿 +X 偏移）
  const base = [];
  for (let i=0; i<n; i++){ const a = (i/n)*Math.PI*2 - Math.PI/2; base.push([Math.cos(a)*r, half, Math.sin(a)*r]); }
  const off = Math.tan(Math.min(Math.max(ang, -1.4), 1.4)) * h;   // 顶点水平偏移距离（deg 控制倾斜量）
  const apexP = [off, -half, 0];  // 尖顶：朝 -Y，沿 +X 偏移
  const tris = [];
  // 侧面（绕序使外法线朝外）
  for (let i=0; i<n; i++){ const b0 = base[i], b1 = base[(i+1)%n]; tris.push(b1, b0, apexP); }
  // 底面（扇形三角化，法线朝 +Y）
  const c = [0, half, 0];
  for (let i=0; i<n; i++){ const b0 = base[i], b1 = base[(i+1)%n]; tris.push(c, b0, b1); }
  return trisToGeometry(tris);
}
// 圆环（空心圆柱/圆环柱）：[内直径, 外直径, 高度]，主轴 +Y。外壁+内壁+上下环形盖。
function makeTorusPrismGeometry(params){
  let [innerD, outerD, h] = getParams(SHAPE_TORUSP, params);
  let ri = Math.max(0, innerD/2), ro = Math.max(ri+0.01, outerD/2); h = Math.max(0.01, h);
  const half = h/2, N = 28;
  const tris = [];
  for (let i=0; i<N; i++){
    const a0 = (i/N)*Math.PI*2, a1 = ((i+1)/N)*Math.PI*2;
    const co0=Math.cos(a0), si0=Math.sin(a0), co1=Math.cos(a1), si1=Math.sin(a1);
    const oT0=[co0*ro, half, si0*ro], oT1=[co1*ro, half, si1*ro], oB0=[co0*ro,-half,si0*ro], oB1=[co1*ro,-half,si1*ro];
    const iT0=[co0*ri, half, si0*ri], iT1=[co1*ri, half, si1*ri], iB0=[co0*ri,-half,si0*ri], iB1=[co1*ri,-half,si1*ri];
    // 外壁（法线朝外）
    tris.push(oB0, oB1, oT1); tris.push(oB0, oT1, oT0);
    // 内壁（法线朝内）
    tris.push(iB1, iB0, iT0); tris.push(iB1, iT0, iT1);
    // 顶环（法线 +Y）
    tris.push(iT0, oT0, oT1); tris.push(iT0, oT1, iT1);
    // 底环（法线 -Y）
    tris.push(iB0, oB1, oB0); tris.push(iB0, iB1, oB1);
  }
  return trisToGeometry(tris);
}

// 按形状 + dir 生成已对齐到「体素中心为原点」的几何
function makeVoxelGeometry(shape, dir, size, params){
  let g;
  if (shape === SHAPE_HALF) g = makeHalfGeometry(size);
  else if (shape === SHAPE_TRI) g = makeTriGeometry(size);
  else if (shape === SHAPE_SPHERE) g = makeSphereGeometry(size);
  else if (shape === SHAPE_HALFSPHERE) g = makeHalfSphereGeometry(size);
  else if (shape === SHAPE_TORUS) g = makeTorusGeometry(size);
  else if (shape === SHAPE_CYLINDER) g = makeCylinderGeometry(params);
  else if (shape === SHAPE_HALFCYLINDER) g = makeHalfCylinderGeometry(params);
  else if (shape === SHAPE_CONE) g = makeConeGeometry(params);
  else if (shape === SHAPE_PYRAMID) g = makePyramidGeometry(params);
  else if (shape === SHAPE_TORUSP) g = makeTorusPrismGeometry(params);
  else return new THREE.BoxGeometry(size, size, size);
  // 基准朝向为 +y（dir=2）。把当前 +y 旋转到目标 dir 方向。
  // 注意：旧版 three 的 BufferGeometry 没有 applyQuaternion 方法（会抛
  // "g.applyQuaternion is not a function" 导致三角/半圆无法放置），
  // 这里统一用 applyMatrix4(旋转矩阵)，所有版本都兼容。
  const from = new THREE.Vector3(0,1,0);
  const to = DIR_VECS[dir] || from;
  if (!from.equals(to)) {
    const q = new THREE.Quaternion().setFromUnitVectors(from, to);
    const m = new THREE.Matrix4().makeRotationFromQuaternion(q);
    if (typeof g.applyMatrix4 === 'function') g.applyMatrix4(m);
    else if (typeof g.applyMatrix === 'function') g.applyMatrix(m);
  }
  return g;
}

// 体素几何按形状/方向/尺寸/参数复用；大模型不再为每个体素重复创建 GPU Buffer。
const _voxelGeometryCache = new Map();
function voxelGeometryKey(value, size){
  const { shape, dir, params } = decodeVoxel(value);
  return `${shape}|${dir}|${(+size).toFixed(6)}|${params ? params.join(',') : ''}`;
}
function geometryForVoxel(value, size){
  const cacheKey = voxelGeometryKey(value, size);
  let geo = _voxelGeometryCache.get(cacheKey);
  if (geo) return geo;
  const { shape, dir, params } = decodeVoxel(value);
  geo = makeVoxelGeometry(shape, dir, size, params);
  _voxelGeometryCache.set(cacheKey, geo);
  return geo;
}


// 螺丝模型按指定直径（世界单位）构建，使其能匹配体素尺寸/区域大小。
// 性能优化：同一关卡里所有螺丝直径相同，几何完全一致，故按直径缓存并「复用同一份几何」；
// peg/十字槽为固定色，其材质也全局共享。这样即使布上百颗螺丝，也不会重复创建几何/材质，
// 大幅降低内存占用与创建开销（缓解螺丝多时的卡顿）。头部材质因每颗颜色不同仍单独创建。
const _screwGeoCache = { dia: -1, head: null, peg: null, slot1: null, slot2: null };
const _screwPegMat = new THREE.MeshStandardMaterial({ color:0xcbd1d9, metalness:0.7, roughness:0.35 });
const _screwSlotMat = new THREE.MeshStandardMaterial({ color:0x2b2f3a, roughness:0.6 });
function _ensureScrewGeo(diameter){
  if (_screwGeoCache.dia === diameter && _screwGeoCache.head) return _screwGeoCache;
  // 直径变了（改了螺丝大小）：释放旧几何再重建，避免泄漏
  ['head','peg','slot1','slot2'].forEach(k => { if (_screwGeoCache[k]) _screwGeoCache[k].dispose(); });
  const R = diameter / 2;
  _screwGeoCache.dia = diameter;
  _screwGeoCache.head  = new THREE.CylinderGeometry(R, R, R*0.5, 16);   // 分段 24->16
  _screwGeoCache.peg   = new THREE.CylinderGeometry(R*0.35, R*0.3, R*0.55, 10);
  _screwGeoCache.slot1 = new THREE.BoxGeometry(R*2*0.6, R*0.12, R*2*0.16);
  _screwGeoCache.slot2 = new THREE.BoxGeometry(R*2*0.16, R*0.12, R*2*0.6);
  return _screwGeoCache;
}
function makeScrewMesh(colorHex, diameter){
  const g = new THREE.Group();
  const R = diameter / 2;
  const geo = _ensureScrewGeo(diameter);
  const head = new THREE.Mesh(geo.head, new THREE.MeshStandardMaterial({ color:colorHex, roughness:0.3, metalness:0.1 }));
  head.castShadow = true; head.position.y = R*0.25; g.add(head);
  const peg = new THREE.Mesh(geo.peg, _screwPegMat); peg.position.y=-R*0.27; g.add(peg);
  const s1 = new THREE.Mesh(geo.slot1, _screwSlotMat); s1.position.y=R*0.5;
  const s2 = new THREE.Mesh(geo.slot2, _screwSlotMat); s2.position.y=R*0.5;
  g.add(s1); g.add(s2);
  return g;
}

// 物件体素包围盒的几何中心（局部坐标，未缩放）；不同大小的体素按其实际占用范围计入包围盒
function objLocalCenter(obj){
  const keys = Object.keys(obj.voxels);
  if (!keys.length) return new THREE.Vector3(0,0,0);
  let minx=Infinity,miny=Infinity,minz=Infinity,maxx=-Infinity,maxy=-Infinity,maxz=-Infinity;
  for (const k of keys){
    const [x,y,z]=parseKey(k);
    const mult = decodeVoxel(obj.voxels[k]).mult || 1;
    const x2=x+mult, y2=y+mult, z2=z+mult;
    if(x<minx)minx=x; if(y<miny)miny=y; if(z<minz)minz=z;
    if(x2>maxx)maxx=x2; if(y2>maxy)maxy=y2; if(z2>maxz)maxz=z2;
  }
  const s = vsizeOf(obj);
  return new THREE.Vector3(((minx+maxx)/2)*s, ((miny+maxy)/2)*s, ((minz+maxz)/2)*s);
}

// 物件缩放（带默认，兼容旧数据）
function scaleOf(obj){ const sc = obj && obj.scale; return { x: sc&&sc.x>0?sc.x:1, y: sc&&sc.y>0?sc.y:1, z: sc&&sc.z>0?sc.z:1 }; }

// 物件三轴旋转（度→欧拉，兼容仅有 rotY 的旧数据；顺序 XYZ）
function objEuler(obj){
  return new THREE.Euler(
    THREE.MathUtils.degToRad(obj.rotX || 0),
    THREE.MathUtils.degToRad(obj.rotY || 0),
    THREE.MathUtils.degToRad(obj.rotZ || 0),
    'XYZ'
  );
}
function objQuat(obj){ return new THREE.Quaternion().setFromEuler(objEuler(obj)); }

// 计算「以物件几何中心为轴心」时，group 原点需要的位置补偿。
// 目标：世界点 = pos + c + R·(S∘(local - c))，即绕几何中心 c 先缩放后旋转。
// 而 group 实际输出 = position + R·(S∘local)，
// 故 position = pos + c - R·(S∘c)。这样旋转与缩放的中心都固定在物件中心。
function objPivotPosition(obj, sc, quat){
  const c = objLocalCenter(obj);
  const scaledC = new THREE.Vector3(c.x*sc.x, c.y*sc.y, c.z*sc.z).applyQuaternion(quat);
  return new THREE.Vector3(
    obj.pos.x + c.x - scaledC.x,
    obj.pos.y + c.y - scaledC.y,
    obj.pos.z + c.z - scaledC.z
  );
}

function applyObjTransform(obj){
  const ref = renderRefs.get(obj.id);
  if (!ref) return;
  const sc = scaleOf(obj);
  const quat = objQuat(obj);
  ref.group.scale.set(sc.x, sc.y, sc.z);
  ref.group.quaternion.copy(quat);
  // 螺丝尺寸恒定：螺丝是 group 的子物体，group 的整体缩放（sc，各轴可不同）会
  // 连带把螺丝也拉伸/缩小。这里给每颗螺丝反向抵消掉父级缩放，使其在世界空间中
  // 的实际大小始终保持 SCREW_DIAMETER，不随物件的「整体缩放」滑块变化
  // （位置仍跟随物件缩放移动，只是尺寸/形状不变）。
  ref.screwMeshes.forEach(m => m.scale.copy(screwCounterScale(m.quaternion, sc)));
  // 缩放与旋转均围绕几何中心：补偿 group 位置，使物件中心在世界中保持不动
  ref.group.position.copy(objPivotPosition(obj, sc, quat));
}

// 物件几何中心的世界坐标（= pos + 局部几何中心；旋转/缩放都绕此点，故它就是世界中心）
function objWorldCenter(obj){
  const c = objLocalCenter(obj);
  return new THREE.Vector3(obj.pos.x + c.x, obj.pos.y + c.y, obj.pos.z + c.z);
}

// 记录一个物件变换前的快照（世界中心 / 朝向 / 缩放），用于计算变换增量
function snapshotObjXform(obj){
  const s = scaleOf(obj);
  return { center: objWorldCenter(obj), quat: objQuat(obj), scale: { x:s.x, y:s.y, z:s.z } };
}

// 让 active 所在组的其它成员，跟随 active 的这一次变换（平移 / 旋转 / 缩放）一起刚性联动，
// 保持整组的相对位置、相对朝向与相对大小不变。snap 为 active 变换【前】的快照。
// 以 active 变换前的世界中心为轴心：active 原地按面板值变换，其余成员绕该轴心随动。
function applyGroupCoTransform(active, snap){
  if (!active || !active.groupId || !snap) return;
  const members = level.objects.filter(o => o.groupId === active.groupId && o.id !== active.id);
  if (!members.length) return;

  const pivot = snap.center;                                   // 轴心 = active 变换前的世界中心
  const deltaTrans = objWorldCenter(active).clone().sub(pivot); // 平移增量
  const deltaQuat = objQuat(active).multiply(snap.quat.clone().invert()); // 旋转增量
  const nsc = scaleOf(active);
  const sr = { x: nsc.x/snap.scale.x, y: nsc.y/snap.scale.y, z: nsc.z/snap.scale.z }; // 缩放比

  const _e = new THREE.Euler();
  members.forEach(m => {
    // 1) 新世界中心：把（成员中心 - 轴心）先按缩放比缩放、再旋转，最后整体平移
    const off = objWorldCenter(m).sub(pivot);
    off.set(off.x * sr.x, off.y * sr.y, off.z * sr.z);
    off.applyQuaternion(deltaQuat);
    const mc = pivot.clone().add(off).add(deltaTrans);
    // 2) 新朝向：在成员原朝向上叠加旋转增量
    const mq = deltaQuat.clone().multiply(objQuat(m));
    _e.setFromQuaternion(mq, 'XYZ');
    m.rotX = THREE.MathUtils.radToDeg(_e.x);
    m.rotY = THREE.MathUtils.radToDeg(_e.y);
    m.rotZ = THREE.MathUtils.radToDeg(_e.z);
    // 3) 新缩放：乘以缩放比（三轴锁定等比缩放时精确；非等比且成员已旋转时为近似）
    const ms = scaleOf(m);
    m.scale = { x: ms.x * sr.x, y: ms.y * sr.y, z: ms.z * sr.z };
    // 4) 由目标世界中心反推 pos（局部几何中心不变）
    const c = objLocalCenter(m);
    m.pos = { x: mc.x - c.x, y: mc.y - c.y, z: mc.z - c.z };
    applyObjTransform(m);
  });
}

// 计算螺丝为抵消父级（各轴可不同的）整体缩放所需的自身局部缩放系数（base 为
// 抵消前的基准尺寸倍数，默认 1）。
// 螺丝总是贴在体素的某个轴对齐面上，其法线必为 ±X/±Y/±Z 之一，因此
// setFromUnitVectors(up, normal) 得到的旋转必是「轴置换」旋转——局部 x/y/z 轴
// 旋转后必分别落在某个世界坐标轴上（可能带符号翻转，但不会产生斜切）。
// 所以只需按每个局部轴旋转后落在哪个世界轴，用该轴上父级的缩放值做倒数，
// 即可精确抵消（无论父级三轴缩放是否不同）。
function screwCounterScale(quat, groupScale, base){
  base = base || 1;
  const gs = [groupScale.x || 1, groupScale.y || 1, groupScale.z || 1];
  const localAxes = [new THREE.Vector3(1,0,0), new THREE.Vector3(0,1,0), new THREE.Vector3(0,0,1)];
  const out = [1,1,1];
  localAxes.forEach((a, i) => {
    const w = a.clone().applyQuaternion(quat);
    let axis = 0, best = Math.abs(w.x);
    if (Math.abs(w.y) > best) { axis = 1; best = Math.abs(w.y); }
    if (Math.abs(w.z) > best) { axis = 2; best = Math.abs(w.z); }
    const s = gs[axis];
    out[i] = base / (Math.abs(s) > 1e-6 ? s : 1);
  });
  return new THREE.Vector3(out[0], out[1], out[2]);
}

// 体素中心（局部坐标），按体素尺寸缩放；mult 为该体素占用的空间倍数（可为小数，如 0.25/0.5/1.5/2/3）
function voxelCenterLocal(obj, x, y, z, mult){
  const s = vsizeOf(obj);
  const m = mult > 0 ? mult : 1;
  return new THREE.Vector3((x+m/2)*s, (y+m/2)*s, (z+m/2)*s);
}

const VOXEL_INSTANCE_THRESHOLD = 256;

const _queuedInstanceRebuilds = new Set();
function queueInstancedRebuild(obj){
  if (!obj || _queuedInstanceRebuilds.has(obj.id)) return;
  _queuedInstanceRebuilds.add(obj.id);
  requestAnimationFrame(() => {
    _queuedInstanceRebuilds.delete(obj.id);
    if (level.objects.includes(obj)) buildObjectGroup(obj);
  });
}

// 小物件保留逐体素 Mesh 以获得最低编辑延迟；大物件由 buildVoxelBatches 批量实例化。
function buildVoxelMesh(obj, key){
  const ref = renderRefs.get(obj.id);
  const val = obj.voxels[key];
  if (!ref || !val) return null;
  const [x,y,z] = parseKey(key);
  const dec = decodeVoxel(val);
  const mult = dec.mult || 1;
  const s = vsizeOf(obj);
  const mesh = new THREE.Mesh(geometryForVoxel(val, s * mult), voxelMaterial(val));
  mesh.position.copy(voxelCenterLocal(obj, x, y, z, mult));
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.userData = { type:'voxel', objId: obj.id, key };
  mesh.updateMatrix();
  mesh.matrixAutoUpdate = false;
  ref.group.add(mesh);
  ref.voxelMeshes.set(key, mesh);
  ref.pickMeshes.add(mesh);
  return mesh;
}

function buildVoxelBatches(obj, keys){
  const ref = renderRefs.get(obj.id);
  const s = vsizeOf(obj);
  const batches = new Map();
  keys.forEach(key => {
    const val = obj.voxels[key];
    const dec = decodeVoxel(val);
    const mult = dec.mult || 1;
    const instanceColored = !dec.faces;
    const sig = instanceColored
      ? `${voxelGeometryKey(val, s * mult)}|ic|${(dec.alpha || 1).toFixed(4)}`
      : `${voxelGeometryKey(val, s * mult)}|faces|${val}`;
    let batch = batches.get(sig);
    if (!batch) { batch = { val, mult, dec, instanceColored, keys:[] }; batches.set(sig, batch); }
    batch.keys.push(key);
  });
  const mat4 = new THREE.Matrix4();
  batches.forEach(batch => {
    const material = batch.instanceColored
      ? voxelInstanceMaterial(batch.dec.alpha, batch.dec.shape !== SHAPE_CUBE)
      : voxelMaterial(batch.val);
    const geometry = geometryForVoxel(batch.val, s * batch.mult);
    if (batch.instanceColored) ensureWhiteVertexColors(geometry);
    const mesh = new THREE.InstancedMesh(geometry, material, batch.keys.length);

    const keyToInstance = new Map();
    mesh.userData = { type:'voxelBatch', objId:obj.id, instanceKeys:batch.keys, keyToInstance, instanceColored:batch.instanceColored };
    batch.keys.forEach((key, i) => {
      const [x,y,z] = parseKey(key);
      const p = voxelCenterLocal(obj, x, y, z, batch.mult);
      mat4.makeTranslation(p.x, p.y, p.z);
      mesh.setMatrixAt(i, mat4);
      if (batch.instanceColored) mesh.setColorAt(i, new THREE.Color(voxelValueToHexInt(obj.voxels[key])));
      keyToInstance.set(key, i);
      ref.voxelMeshes.set(key, mesh);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    if (typeof mesh.computeBoundingSphere === 'function') mesh.computeBoundingSphere();
    if (typeof mesh.computeBoundingBox === 'function') mesh.computeBoundingBox();
    ref.group.add(mesh);
    ref.pickMeshes.add(mesh);
  });
}


function buildObjectGroup(obj){
  const old = renderRefs.get(obj.id);
  if (old) scene.remove(old.group);

  const group = new THREE.Group();
  group.userData = { type:'objGroup', objId: obj.id };
  scene.add(group);
  renderRefs.set(obj.id, { group, voxelMeshes:new Map(), pickMeshes:new Set(), screwMeshes:new Map() });

  rebuildOccupancy(obj);
  const keys = Object.keys(obj.voxels);
  obj._voxelCount = keys.length;
  if (keys.length >= VOXEL_INSTANCE_THRESHOLD && typeof THREE.InstancedMesh === 'function') buildVoxelBatches(obj, keys);

  else keys.forEach(key => buildVoxelMesh(obj, key));

  applyObjTransform(obj);
  obj.screws.forEach((sObj, i) => addScrewMesh(obj, sObj, i));
  applyObjVisibility(obj);
  updateRendererPerformanceMode();
}


// 体素尺寸改变后，仅重建该物件（体素+螺丝）
function rebuildObject(obj){ buildObjectGroup(obj); }


/* ---------------- 体素增删改 ----------------
 * mult：体素尺寸倍数（默认 1，可为 0.25/0.5/1.5/2/3 等小数）。放置前会校验其占用的
 * mult³ 大小的空间是否全部空闲（不要求与全局整数网格对齐，可紧贴任意已有体素摆放，
 * 精度为 0.25），从而支持同一物件内混合摆放不同大小的体素。
 */
function addVoxel(obj, x, y, z, value, mult){
  mult = mult > 0 ? mult : 1;
  if (!canPlaceBlock(obj, x, y, z, mult)) return false;
  const dec = decodeVoxel(value);
  const key = keyOf(x,y,z);
  obj.voxels[key] = encodeVoxel(dec.hex, dec.shape, dec.dir, dec.faces, mult, dec.alpha, dec.params);
  markOccupied(obj, x, y, z, mult, key);
  obj._voxelCount = (Number.isFinite(obj._voxelCount) ? obj._voxelCount : Object.keys(obj.voxels).length - 1) + 1;
  buildVoxelMesh(obj, key);

  return true;
}

function paintVoxel(obj, key, hexStr){
  if (!obj.voxels[key]) return false;
  // 整块上色：保留形状/朝向/大体素倍数/参数化形状参数，清除所有单面覆盖，应用当前透明度
  const old = decodeVoxel(obj.voxels[key]);
  obj.voxels[key] = encodeVoxel(hexStr, old.shape, old.dir, null, old.mult, editor.voxelAlpha, old.params);
  const ref = renderRefs.get(obj.id);
  const mesh = ref.voxelMeshes.get(key);
  if (mesh) {
    if (mesh.isInstancedMesh) {
      const ud = mesh.userData || {};
      const idx = ud.keyToInstance && ud.keyToInstance.get(key);
      if (ud.instanceColored && idx != null && !old.faces && Math.abs((old.alpha || 1) - editor.voxelAlpha) <= 1e-6) {
        mesh.setColorAt(idx, new THREE.Color(voxelValueToHexInt(obj.voxels[key])));
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      } else queueInstancedRebuild(obj);
    } else if (Math.abs((old.alpha || 1) - editor.voxelAlpha) > 1e-6) {

      ref.group.remove(mesh); ref.voxelMeshes.delete(key); ref.pickMeshes.delete(mesh);
      buildVoxelMesh(obj, key);
    } else {
      mesh.material = voxelMaterial(obj.voxels[key]);
    }
  }

  return true;
}

// 只给某个面上色（仅 cube 支持；faceIdx 为 BoxGeometry 面序 0..5）
function paintVoxelFace(obj, key, faceIdx, hexStr){
  if (!obj.voxels[key]) return false;
  const old = decodeVoxel(obj.voxels[key]);
  if (old.shape !== SHAPE_CUBE) return paintVoxel(obj, key, hexStr); // 非方块退化为整块
  const faces = old.faces ? old.faces.slice() : new Array(6).fill(null);
  faces[faceIdx] = normHex(hexStr) || hexStr;
  obj.voxels[key] = encodeVoxel(old.hex, old.shape, old.dir, faces, old.mult, old.alpha, old.params);
  const ref = renderRefs.get(obj.id);
  const mesh = ref.voxelMeshes.get(key);
  if (mesh) {
    if (mesh.isInstancedMesh) queueInstancedRebuild(obj);
    else mesh.material = voxelMaterial(obj.voxels[key]);
  }
  return true;
}

// key 可以是任意被占用逻辑格的坐标（不必是大体素的锚点），会自动定位并整体删除该体素

function removeVoxel(obj, key){
  const [x,y,z] = parseKey(key);
  const ownerKey = occupiedOwner(obj, x, y, z);

  if (!ownerKey || !obj.voxels[ownerKey]) return false;
  const [ax,ay,az] = parseKey(ownerKey);
  const mult = decodeVoxel(obj.voxels[ownerKey]).mult || 1;
  delete obj.voxels[ownerKey];
  obj._voxelCount = Math.max(0, (Number.isFinite(obj._voxelCount) ? obj._voxelCount : Object.keys(obj.voxels).length + 1) - 1);
  unmarkOccupied(obj, ax, ay, az, mult);

  const ref = renderRefs.get(obj.id);
  const mesh = ref && ref.voxelMeshes.get(ownerKey);
  if (mesh) {
    if (mesh.isInstancedMesh) queueInstancedRebuild(obj);
    else { ref.group.remove(mesh); ref.voxelMeshes.delete(ownerKey); ref.pickMeshes.delete(mesh); }
  }
  return true;
}


/* =========================================================
 * 螺丝（局部坐标 pos + 法线 normal 存储）
 * - 智能布点：把相连体素的外露面按朝向 + 连通聚类，
 *   每个连续表面区域放一颗螺丝，位于区域几何中心，尺寸随区域大小自适应。
 * ========================================================= */
const screwIdKey = i => `screw#${i}`;

function clearScrewMeshes(obj){
  const ref = renderRefs.get(obj.id);
  if (!ref) return;
  ref.screwMeshes.forEach(m => ref.group.remove(m));
  ref.screwMeshes.clear();
}

function rebuildScrewMeshes(obj){
  clearScrewMeshes(obj);
  obj.screws.forEach((s, i) => addScrewMesh(obj, s, i));
}

// 螺丝大小自动跟随体素大小：世界直径 = 0.5 × 体素大小（全场统一，取主物件的体素大小）。
// 渲染处直径 = SCREW_DIAMETER(0.25) × screwSizeMul()，因此倍数取 0.5×体素/0.25 = 2×体素，
// 使默认体素 0.5 时倍数为 1、直径 0.25（与旧默认一致）；体素越大，螺丝越大。
function baseVoxelSize(){
  const o = (level && level.objects && level.objects.length) ? level.objects[0] : null;
  const vs = o ? vsizeOf(o) : DEFAULT_VOXEL_SIZE;
  return (vs > 0) ? vs : DEFAULT_VOXEL_SIZE;
}
function screwSizeMul(){ return 2 * baseVoxelSize(); }

function addScrewMesh(obj, s, index){
  const ref = renderRefs.get(obj.id);
  const skey = screwIdKey(index);
  const c = screwByName(s.color);
  // 世界直径 = 基准直径 × 全体统一倍数（不随 voxelSize / 物件缩放变化）
  const dia = SCREW_DIAMETER * screwSizeMul();
  const mesh = makeScrewMesh(c.hex, dia);
  const n = new THREE.Vector3(...s.normal).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0), n);
  mesh.quaternion.copy(q);
  const lift = dia * 0.05;   // 更贴近表面：螺丝底座几乎紧贴体素面
  mesh.position.set(s.pos[0], s.pos[1], s.pos[2]).add(n.clone().multiplyScalar(lift));
  // 螺丝是 group 的子物体，用反向缩放抵消物件当前的「整体缩放」（各轴可不同），
  // 使螺丝世界尺寸始终恒定，不随物件缩放变化。
  mesh.scale.copy(screwCounterScale(q, scaleOf(obj)));
  mesh.userData = { type:'screw', objId: obj.id, screwIndex: index };
  ref.group.add(mesh);
  ref.screwMeshes.set(skey, mesh);
}

function isFaceExposed(obj, x, y, z, face){
  return !cellOccupied(obj, x+face[0], y+face[1], z+face[2]);
}

// 收集物件所有外露面：{x,y,z, face:[fx,fy,fz]}（按"常规体素"粒度采样：大体素展开其
// 占用的每个常规体素粒度分别判断；小于 1 的体素按 1 个采样点处理，保证螺丝自动布点
// 在大/小体素混合表面上依然按统一粒度聚类）
function collectExposedFaces(obj){
  const FACES = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  const s = vsizeOf(obj);
  const faces = [];
  for (const key in obj.voxels) {
    const [ax,ay,az] = parseKey(key);
    const mult = decodeVoxel(obj.voxels[key]).mult || 1;
    const n = Math.max(1, Math.ceil(mult - 1e-9));
    // 小体素（mult<1）实际只占 mult*s 大小，不能按整数格(1×s)定位螺丝面，否则会
    // 悬空或穿进相邻体素（尤其颜色相似度高、体素被大量合并成不同尺寸混排时）。
    // 这里对 <1 的体素直接用其真实几何算面中心；>=1 的按整数格展开（格边界即真实表面）。
    const small = mult < 1;
    for (let dx=0; dx<n; dx++) for (let dy=0; dy<n; dy++) for (let dz=0; dz<n; dz++){
      const x=ax+dx, y=ay+dy, z=az+dz;
      for (const f of FACES){
        if (!isFaceExposed(obj, x, y, z, f)) continue;
        // 该面在局部坐标下的准确中心点：小体素按真实尺寸(mult)，其余按 1 格
        let fc;
        if (small){
          fc = [ (ax+mult/2)*s + f[0]*mult*s/2,
                 (ay+mult/2)*s + f[1]*mult*s/2,
                 (az+mult/2)*s + f[2]*mult*s/2 ];
        } else {
          fc = [ (x+0.5)*s + f[0]*s/2,
                 (y+0.5)*s + f[1]*s/2,
                 (z+0.5)*s + f[2]*s/2 ];
        }
        faces.push({ x, y, z, face:f, fc });
      }
    }
  }
  return faces;
}

// 把外露面按"朝向 + 在切平面上是否相邻"聚类成连通区域
function clusterExposedFaces(obj){
  const faces = collectExposedFaces(obj);
  // 按朝向分组
  const byDir = new Map();
  faces.forEach(fc => {
    const dkey = fc.face.join(',');
    if (!byDir.has(dkey)) byDir.set(dkey, []);
    byDir.get(dkey).push(fc);
  });

  const clusters = [];
  byDir.forEach((list) => {
    const setKey = fc => `${fc.x},${fc.y},${fc.z}`;
    const map = new Map();
    list.forEach(fc => map.set(setKey(fc), fc));
    const visited = new Set();
    // 同朝向的面，相邻体素的同向面视为连通（沿切平面 4 邻接）
    const face = list[0].face;
    let tangent;
    if (face[0] !== 0) tangent = [[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
    else if (face[1] !== 0) tangent = [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]];
    else tangent = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0]];

    list.forEach(start => {
      const sk = setKey(start);
      if (visited.has(sk)) return;
      const queue = [start];
      visited.add(sk);
      const region = [];
      while (queue.length) {
        const cur = queue.pop();
        region.push(cur);
        for (const t of tangent) {
          const nk = `${cur.x+t[0]},${cur.y+t[1]},${cur.z+t[2]}`;
          if (map.has(nk) && !visited.has(nk)) { visited.add(nk); queue.push(map.get(nk)); }
        }
      }
      clusters.push({ face, cells: region });
    });
  });
  return clusters;
}

// 区域 -> 一颗螺丝的局部坐标、法线、尺寸
function screwFromCluster(obj, cluster){
  const s = vsizeOf(obj);
  const face = cluster.face;
  // 区域几何中心（取所有面精确中心的平均；面中心已按体素真实尺寸算好，紧贴表面不穿模）
  const center = new THREE.Vector3();
  cluster.cells.forEach(c => {
    const p = c.fc || [ (c.x+0.5)*s+face[0]*s/2, (c.y+0.5)*s+face[1]*s/2, (c.z+0.5)*s+face[2]*s/2 ];
    center.add(new THREE.Vector3(p[0], p[1], p[2]));
  });
  center.multiplyScalar(1 / cluster.cells.length);
  // 螺丝直径：随区域大小自适应（最少覆盖一个体素的 ~0.45，越大越粗但有上限）
  const span = Math.sqrt(cluster.cells.length);
  let diaRatio = 0.42 + (span - 1) * 0.12;   // 相对体素尺寸的比例
  diaRatio = Math.max(0.42, Math.min(diaRatio, 1.6));
  return { pos:[center.x, center.y, center.z], normal:[face[0],face[1],face[2]], color: editor.screwColor, scale: diaRatio };
}

function autoGenScrews(obj){
  obj.screws = [];
  clearScrewMeshes(obj);
  const clusters = clusterExposedFaces(obj);
  // 优先朝上/朝外的区域，按面积从大到小，避免太多碎屑螺丝
  clusters.sort((a,b)=> b.cells.length - a.cells.length);
  // 过滤掉朝下(-Y)区域（贴地面，不放螺丝），保留其余
  const useful = clusters.filter(c => !(c.face[1] === -1));
  useful.forEach(cl => obj.screws.push(screwFromCluster(obj, cl)));
  if (obj.screws.length === 0 && clusters.length) {
    obj.screws.push(screwFromCluster(obj, clusters[0]));
  }
  rebuildScrewMeshes(obj);
  invalidateSolution();
  refreshStats(); autoSave();
}

/* ---------------- 全局自动布点（按场景所有物件 + 体素数量分配） ----------------
 * - totalCount：螺丝总数（自动规整为 3 的倍数）
 * - colorCount：使用的螺丝颜色种类数（每种颜色数量为 3 的倍数，便于游戏 3 个一组消除）
 * - 候选点位：每个物件所有外露面（排除朝下贴地）的面中心
 * - 数量分配：按各物件体素数量比例分配，位置不足时自动转移给其他物件
 */
// 收集某物件可放螺丝的候选点位（局部 pos + normal），排除朝下(-Y)贴地面
function collectScrewSlots(obj){
  const clusters = clusterExposedFaces(obj);
  const slots = [];
  clusters.forEach(cl => {
    if (cl.face[1] === -1) return; // 朝下贴地，不放
    cl.cells.forEach(c => {
      // 直接用面的精确中心（已按体素真实尺寸计算，小/大体素都紧贴表面，不穿模/悬空）
      const p = c.fc || [ (c.x+0.5)*vsizeOf(obj)+cl.face[0]*vsizeOf(obj)/2,
                          (c.y+0.5)*vsizeOf(obj)+cl.face[1]*vsizeOf(obj)/2,
                          (c.z+0.5)*vsizeOf(obj)+cl.face[2]*vsizeOf(obj)/2 ];
      slots.push({ pos:[p[0], p[1], p[2]], normal:[...cl.face] });
    });
  });
  return slots;
}

// 从候选点位中选 n 个，尽量分散（最远点采样）。
// 起点随机：每次从一个随机点位开始扩散，因此同一物件多次布点得到的分布各不相同
// （避免总是从 slots[0] 开始、结果固定或聚集在同一处）。
function pickSpread(slots, n){
  if (n >= slots.length) return shuffleArr(slots.slice());
  if (n <= 0) return [];
  const picked = [];
  const used = new Set();
  const seed = Math.floor(Math.random() * slots.length);   // 随机起点
  picked.push(slots[seed]); used.add(seed);
  while (picked.length < n){
    let best = -1, bestDist = -1;
    for (let i=0; i<slots.length; i++){
      if (used.has(i)) continue;
      let md = Infinity;
      for (const p of picked){
        const dx=slots[i].pos[0]-p.pos[0], dy=slots[i].pos[1]-p.pos[1], dz=slots[i].pos[2]-p.pos[2];
        const d = dx*dx+dy*dy+dz*dz;
        if (d < md) md = d;
      }
      if (md > bestDist){ bestDist = md; best = i; }
    }
    if (best < 0) break;
    picked.push(slots[best]); used.add(best);
  }
  return picked;
}

function shuffleArr(arr){
  for (let i=arr.length-1; i>0; i--){ const j = Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; }
  return arr;
}

// 全局自动布点。
//  · autoRandomCount=true：忽略传入的 totalCount，自动在 [30,108] 随机取一个 3 的倍数作为
//    螺丝总数（每次布点数量随机，位置也随机）。
//  · 螺丝数量按各物件体素总数比例分配（体素多的物件分到更多螺丝）。
const AUTO_SCREW_MIN = 30, AUTO_SCREW_MAX = 108;
function randomScrewTotal(){
  // [30,108] 内的 3 的倍数：min/max 均为 3 的倍数，组数区间 [10,36]
  const gMin = AUTO_SCREW_MIN/3, gMax = AUTO_SCREW_MAX/3;
  const g = gMin + Math.floor(Math.random() * (gMax - gMin + 1));
  return g * 3;
}
function autoGenScrewsAll(totalCount, colorCount, autoRandomCount){
  if (autoRandomCount) totalCount = randomScrewTotal();
  totalCount = Math.max(3, Math.floor(totalCount/3)*3);
  colorCount = Math.max(1, Math.min(colorCount|0, SCREW_COLORS.length));

  const objs = level.objects.filter(o => Object.keys(o.voxels).length > 0);
  if (!objs.length){ toast('场景中没有体素，无法布点'); return; }

  // 1. 各物件候选点位
  const slotMap = new Map();
  let totalSlots = 0;
  objs.forEach(o => { const sl = collectScrewSlots(o); slotMap.set(o.id, sl); totalSlots += sl.length; });
  if (totalSlots === 0){ toast('没有可放螺丝的外露面'); return; }
  if (totalCount > totalSlots){
    totalCount = Math.floor(totalSlots/3)*3;
    if (totalCount < 3){ toast('可放置的位置太少，无法满足 3 的倍数'); return; }
    toast(`位置不足，已调整为 ${totalCount} 颗`);
  }

  // 2. 按体素数量比例分配每个物件的螺丝数（位置不足则转移给其他物件）
  const voxCounts = objs.map(o => Object.keys(o.voxels).length);
  const totalVox = voxCounts.reduce((a,b)=>a+b,0);
  let alloc = objs.map((o,i)=> Math.min(
    Math.floor(totalCount * voxCounts[i] / totalVox),
    slotMap.get(o.id).length
  ));
  let remain = totalCount - alloc.reduce((a,b)=>a+b,0);
  while (remain > 0){
    let progressed = false;
    for (let i=0; i<objs.length && remain>0; i++){
      if (alloc[i] < slotMap.get(objs[i].id).length){ alloc[i]++; remain--; progressed = true; }
    }
    if (!progressed) break;
  }

  // 3. 每个物件分散选点
  const chosen = [];
  objs.forEach((o,i)=>{
    pickSpread(slotMap.get(o.id), alloc[i]).forEach(p => chosen.push({ objId:o.id, pos:p.pos, normal:p.normal }));
  });
  const finalTotal = Math.floor(chosen.length/3)*3;
  chosen.length = finalTotal;
  if (finalTotal < 3){ toast('可放置的位置太少'); return; }

  // 4. 颜色配额：colorCount 种，每种为 3 的倍数，总和 = finalTotal
  const groups = finalTotal / 3;
  const perColorGroups = new Array(colorCount).fill(0);
  for (let g=0; g<groups; g++) perColorGroups[g % colorCount]++;
  const colorBag = [];
  for (let ci=0; ci<colorCount; ci++){
    for (let k=0; k<perColorGroups[ci]*3; k++) colorBag.push(SCREW_COLORS[ci].name);
  }
  shuffleArr(colorBag);

  // 5. 清空全部物件螺丝并写入
  level.objects.forEach(o => { o.screws = []; });
  chosen.forEach((c, idx) => {
    const o = level.objects.find(x => x.id === c.objId);
    o.screws.push({ pos:c.pos, normal:c.normal, color: colorBag[idx], scale: 0.5 });
  });
  level.objects.forEach(o => rebuildScrewMeshes(o));
  invalidateSolution();
  refreshStats(); autoSave();
  toast(`全局布点完成：${finalTotal} 颗 · ${colorCount} 色`);
}

/* ---------------- 随机螺丝颜色（整体颜色置换 · 保持位置/分组/可行解不变） ----------------
 * 新语义（配合固化可行解）：不再重新分配数量，而是把「当前用到的每种颜色」一一映射到
 * 另一种颜色（双射置换，如 红→黄、黄→灰、灰→红），对所有螺丝按此映射整体替换色号。
 * 由于每颗螺丝的相对分组（哪些是同色三连）完全不变，之前固化的可行解依然成立，
 * 只是整体"换了一套配色"。同时同步置换 level.solution.demand 里的需求颜色。
 * colorCount 参数在此语义下不再影响颜色数量（保留形参以兼容旧调用）。
 */
function randomizeScrewColorsAll(colorCount){
  // 收集当前用到的颜色种类
  const all = [];
  level.objects.forEach(o => (o.screws || []).forEach(s => all.push(s)));
  if (all.length === 0){ toast('请先放置螺丝再随机配色'); return; }
  const usedColors = Array.from(new Set(all.map(s => s.color)));
  if (usedColors.length === 0){ toast('螺丝没有颜色'); return; }

  // 目标色池：从 8 色中取「用到的种类数」个不同颜色，随机洗牌后与原色一一对应，
  // 并尽量确保每种原色映射到「不同于自身」的新色（种类>1 时避免恒等映射）。
  let target = shuffleArr(SCREW_COLORS.map(c => c.name)).slice(0, usedColors.length);
  // 若恰好映射成完全相同（恒等），且种类>1，则循环移位一位，保证"确实换了颜色"
  const isIdentity = usedColors.every((c, i) => c === target[i]);
  if (isIdentity && target.length > 1){ target = target.slice(1).concat(target[0]); }

  const map = {};
  usedColors.forEach((c, i) => { map[c] = target[i] || c; });

  // 整体替换所有螺丝颜色（位置/法线/分组均不变）
  all.forEach(s => { s.color = map[s.color] || s.color; });
  // 同步置换固化解的需求槽颜色，使通关流程与新配色一致（可行解不变）
  if (level.solution && Array.isArray(level.solution.demand)){
    level.solution.demand = level.solution.demand.map(c => map[c] || c);
  }
  level.objects.forEach(o => rebuildScrewMeshes(o));
  refreshStats(); autoSave();

  const pairs = usedColors.map(c => `${screwByName(c).name}→${screwByName(map[c]).name}`).join('，');
  toast(`已整体置换配色：${pairs}`);
}

// 手动在某个外露面上加一颗螺丝（位于该面中心，尺寸默认贴合单体素）
function addScrewAtFace(obj, key, face, colorName){
  const [x,y,z] = parseKey(key);
  const s = vsizeOf(obj);
  // 按被点击体素的真实尺寸(mult)定位面中心：小体素(<1)只占 mult*s，若按整数格(1×s)
  // 计算会让螺丝悬空或穿进相邻体素。用真实几何中心 + 真实半尺寸的法线偏移，紧贴表面。
  const mult = (decodeVoxel(obj.voxels[key]).mult) || 1;
  const half = mult * s / 2;
  const center = new THREE.Vector3(
    (x + mult/2)*s + face[0]*half,
    (y + mult/2)*s + face[1]*half,
    (z + mult/2)*s + face[2]*half
  );
  // 若该位置已有螺丝（很近），则改色
  const TOL = s * 0.3;
  const idx = obj.screws.findIndex(sc => {
    const d = new THREE.Vector3(sc.pos[0],sc.pos[1],sc.pos[2]).distanceTo(center);
    return d < TOL && sc.normal[0]===face[0] && sc.normal[1]===face[1] && sc.normal[2]===face[2];
  });
  if (idx >= 0) { obj.screws[idx].color = colorName; rebuildScrewMeshes(obj); invalidateSolution(); return; }
  obj.screws.push({ pos:[center.x, center.y, center.z], normal:[face[0],face[1],face[2]], color: colorName, scale: 0.5 });
  rebuildScrewMeshes(obj);
  invalidateSolution();
}

function removeScrewByIndex(obj, index){
  if (index < 0 || index >= obj.screws.length) return;
  obj.screws.splice(index, 1);
  rebuildScrewMeshes(obj);
  invalidateSolution();
}

/* 使已固化的可行解失效：任何会改变螺丝集合 / 位置 / 层级 / 体素结构的编辑，
 * 都会让之前算好的通关流程不再匹配，需重新点「验证可解」再固化。
 * （注意：整体颜色置换 randomizeScrewColorsAll 会保持位置与分组不变，故不失效。） */
function invalidateSolution(){
  if (level && level.solution){ level.solution = null; }
}

/* =========================================================
 * 关卡可行解验证（Solve Checker）
 * ---------------------------------------------------------
 * 目标：判断当前摆放的螺丝，在游戏规则下是否存在「可以全部取完而不失败」的解。
 * 完整复刻游戏（index.html）三大机制：
 *   1) 层级检测：layer 越大越靠外，须先取外层；与全局自动布点/配色配合，
 *      按 layer 降序优先取（同层可任意顺序）。
 *   2) 射线检测（遮挡）：一颗螺丝要能被拧下，其「螺丝头朝外」方向（法线方向）
 *      必须没有被任何「尚未掉落」物件的体素挡住（沿法线发射射线判定）。
 *   3) 5 颗容错：不匹配当前 2 个需求槽的螺丝进备用槽，备用槽最多 5 颗，
 *      放不下即失败（与游戏 SPARE_MAX=5、DEMAND_SHOW=2 完全一致）。
 *
 * 由于游戏进场会「随机重新配色」（makeCustomColorPlan / buildDemandQueue），
 * 验证采用多次蒙特卡洛模拟：任一次能通关即判定「存在可行解」。
 * 同时给出结构性硬约束诊断（总数非 3 倍数、某些螺丝任何时候都够不到等）。
 * ========================================================= */

const SOLVE_SPARE_MAX = 5;   // 与 index.html SPARE_MAX 对齐
const SOLVE_DEMAND_SHOW = 2; // 与 index.html DEMAND_SHOW 对齐

// 收集全场螺丝的世界坐标信息：{ objId, groupId, layer, color, worldPos, worldNormal }
function collectWorldScrews(){
  const list = [];
  level.objects.forEach(obj => {
    if (!obj.screws || !obj.screws.length) return;
    const mat = objWorldMatrix(obj);
    const nrmMat = new THREE.Matrix3().getNormalMatrix(mat);
    obj.screws.forEach((s, i) => {
      const wp = new THREE.Vector3(s.pos[0], s.pos[1], s.pos[2]).applyMatrix4(mat);
      const wn = new THREE.Vector3(s.normal[0], s.normal[1], s.normal[2]).applyMatrix3(nrmMat).normalize();
      list.push({
        objId: obj.id,
        groupId: obj.groupId || null,
        layer: obj.layer ?? 0,
        color: s.color,
        screwIndex: i,
        worldPos: wp,
        worldNormal: wn,
      });
    });
  });
  return list;
}

// 构建一次射线遮挡检测用的「体素网格快照」：按物件收集所有可见体素 mesh（世界矩阵已更新）。
// droppedObjIds：已掉落物件集合（其体素不再参与遮挡）。
function buildOcclusionMeshes(){
  // 复用渲染中的体素 mesh（已在场景内、矩阵最新），按 objId 分组
  const byObj = new Map();
  renderRefs.forEach((ref, id) => {
    ref.group.updateMatrixWorld(true);
    const arr = [];
    if (ref.pickMeshes) ref.pickMeshes.forEach(m => arr.push(m));
    else {
      const unique = new Set();
      ref.voxelMeshes.forEach(m => unique.add(m));
      unique.forEach(m => arr.push(m));
    }
    byObj.set(id, arr);

  });
  return byObj;
}

const _solveRay = new THREE.Raycaster();
// 生成以螺丝法线为中心轴、半张角 maxAngle 的一组采样方向（含中心 + 若干锥面方向）。
// 游戏中遮挡是「从相机方向」判定且玩家可自由旋转视角，因此只要存在任意一个可看见
// 螺丝头且不被体素挡住的方向，就视为「可拧」——这更贴近真实可玩性，避免把
// 「凹面里、法线正前方恰好被相邻体素略挡、但斜着看能点到」的螺丝误判为死局。
function sampleDirsAroundNormal(normal){
  const n = normal.clone().normalize();
  const dirs = [n.clone()];
  // 构造与 n 正交的两个基向量
  let ref = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0,1,0) : new THREE.Vector3(1,0,0);
  const u = new THREE.Vector3().crossVectors(n, ref).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  // 更密的采样：多圈半张角（到 85°，接近侧视）+ 每圈更多方向，覆盖更多"玩家能看到"的视角，
  // 避免明明某个角度能看到却因采样太稀被判为被挡。
  const rings = [20, 40, 55, 70, 85];   // 半张角（度）
  const perRing = 12;                   // 每圈方向数
  rings.forEach(angDeg => {
    const a = THREE.MathUtils.degToRad(angDeg);
    const cosA = Math.cos(a), sinA = Math.sin(a);
    for (let k = 0; k < perRing; k++){
      const phi = (k / perRing) * Math.PI * 2 + (angDeg*0.017); // 每圈错开一点，分布更均匀
      const d = n.clone().multiplyScalar(cosA)
        .add(u.clone().multiplyScalar(sinA * Math.cos(phi)))
        .add(v.clone().multiplyScalar(sinA * Math.sin(phi)));
      dirs.push(d.normalize());
    }
  });
  return dirs;
}

// 射线可达性缓存：key = 掉落集合签名 + 螺丝唯一标识 → bool。
// 同一掉落状态下同一颗螺丝的可达性不变，避免重复的多方向射线计算（大幅提速）。
let _reachCache = new Map();
function resetReachCache(){ _reachCache = new Map(); }
function droppedSig(droppedObjIds){
  return Array.from(droppedObjIds).sort((a,b)=>a-b).join(',');
}

function screwReachableCached(sw, meshesByObj, droppedObjIds, sig){
  const key = sig + '|' + sw.objId + '#' + sw.screwIndex;
  const c = _reachCache.get(key);
  if (c !== undefined) return c;
  const v = screwReachable(sw, meshesByObj, droppedObjIds);
  _reachCache.set(key, v);
  return v;
}

// 判定某颗螺丝当前是否「可拧」（射线遮挡检测）：只要存在任意一个「朝外」方向，
// 从螺丝头沿该方向发射的射线不被任何「尚未掉落」物件的体素挡住，即视为可拧。
function screwReachable(sw, meshesByObj, droppedObjIds){
  // 收集所有未掉落物件的体素作为遮挡目标
  const targets = [];
  meshesByObj.forEach((arr, id) => {
    if (droppedObjIds.has(id)) return;
    for (const m of arr) targets.push(m);
  });
  if (!targets.length) return true;

  const headHalf = (SCREW_DIAMETER * screwSizeMul()) * 0.5;
  // 参考体素世界尺寸（用当前物件体素大小估计紧邻结构的尺度）
  const vs = (function(){ const o = level.objects.find(x=>x.id===sw.objId); return o ? vsizeOf(o) : DEFAULT_VOXEL_SIZE; })();
  // 起点从螺丝头沿法线抬高约「一个体素」，越过紧贴螺丝的相邻表面结构，避免它们把
  // 斜向视线在极近处误判为遮挡（玩家实际能从更侧/更远的角度看到并点到螺丝头）。
  const lift = headHalf + Math.max(0.12, vs * 0.9);
  const base = sw.worldPos.clone().add(sw.worldNormal.clone().multiplyScalar(lift));
  // 近距离容忍：起点附近这段距离内的命中忽略（属螺丝头周边紧邻体素，玩家可微调角度绕过）。
  const NEAR_IGNORE = Math.max(0.14, vs * 1.1);
  const dirs = sampleDirsAroundNormal(sw.worldNormal);
  for (const dir of dirs){
    _solveRay.set(base.clone(), dir);
    _solveRay.far = 500;
    const hits = _solveRay.intersectObjects(targets, false);
    let blocked = false;
    for (const h of hits){
      if (h.distance > NEAR_IGNORE){ blocked = true; break; }  // 只有离开螺丝头一定距离后仍被挡才算真遮挡
    }
    if (!blocked) return true;   // 该方向通透 → 玩家可从此视角点到 → 可拧
  }
  return false;                   // 所有采样方向都被挡 → 确实够不到
}

// 判断某物件是否属于某组；返回同组全部 objId
function groupMembers(objId){
  const obj = level.objects.find(o => o.id === objId);
  if (!obj || !obj.groupId) return [objId];
  return level.objects.filter(o => o.groupId === obj.groupId).map(o => o.id);
}

/* 生成一份「随机配色方案」——复刻 index.html makeCustomColorPlan 的核心：
 * 按 layer 降序、每 3 颗连续同色、颜色种类数=colorCount、每色 3 的倍数。
 * 返回：与 screws 顺序无关，直接给每颗螺丝赋一个颜色 name（覆盖原色）。
 * screwList：collectWorldScrews 的结果（会就地写入 .planColor）。 */
function makeSolveColorPlan(screwList, colorCount){
  const K = Math.max(1, Math.min(SCREW_COLORS.length, Math.round(colorCount || 1)));
  const idxs = screwList.map((s, i) => i);
  // 按 layer 降序，同层随机
  idxs.forEach(i => { screwList[i]._rand = Math.random(); });
  idxs.sort((a, b) => (screwList[b].layer - screwList[a].layer) || (screwList[a]._rand - screwList[b]._rand));
  const total = idxs.length;
  const palette = shuffleArr(SCREW_COLORS.map(c => c.name)).slice(0, K);
  const groupCount = Math.floor(total / 3);
  const groupColors = [];
  for (let g = 0; g < groupCount; g++){
    groupColors.push(g < K ? (g % K) : Math.floor(Math.random() * K));
  }
  // 打散（保留前两组稍后强制不同色）
  for (let i = groupColors.length - 1; i > 2; i--){
    const j = 2 + Math.floor(Math.random() * (i - 1));
    [groupColors[i], groupColors[j]] = [groupColors[j], groupColors[i]];
  }
  if (groupCount >= 2 && K >= 2){ groupColors[0] = 0; groupColors[1] = 1; }
  else if (groupCount >= 1){ groupColors[0] = 0; }
  const assign = new Array(total).fill(palette[0]);
  for (let g = 0; g < groupCount; g++)
    for (let k = 0; k < 3; k++) assign[g*3 + k] = palette[groupColors[g]];
  for (let i = groupCount*3; i < total; i++) assign[i] = palette[Math.floor(Math.random()*K)];
  idxs.forEach((slotIdx, order) => { screwList[slotIdx].planColor = assign[order]; });
}

/* 生成一份「可行配色方案」：
 * 按「射线可达时机 + 层级」把螺丝排成一个可拆解顺序，然后每连续 3 颗同色成组、
 * 相邻组用不同颜色，使需求槽总能匹配上正在拆的那批螺丝。
 * 【随机化】每次调用都会随机产生一个「不同但仍然可通关」的方案：
 *   ① 拆解顺序：在「当前层级最高的一批可达螺丝」中随机选一颗（而非固定取第一个）；
 *   ② 配色：调色板随机洗牌，且每组颜色在「与上一组不同」的前提下随机选取。
 * 说明：颜色种类仍受 colorCount 约束（与游戏一致）。*/
function makeIdealColorPlan(screwList, meshesByObj, colorCount){
  const K = Math.max(1, Math.min(SCREW_COLORS.length, Math.round(colorCount || 1)));
  const palette = shuffleArr(SCREW_COLORS.map(c => c.name)).slice(0, K);   // 随机取 K 种颜色

  // 用一次「无配色约束」的拆解模拟求出一个可行的取螺丝顺序（层级优先 + 射线可达 + 同层随机）
  const order = [];
  const screws = screwList.map((s, i) => ({ idx:i, objId:s.objId, layer:s.layer, taken:false }));
  const dropped = new Set();
  const updateDrops = () => {
    const remain = new Map();
    screws.forEach(s => { if (!s.taken) remain.set(s.objId, (remain.get(s.objId)||0)+1); });
    level.objects.forEach(o => {
      if (dropped.has(o.id)) return;
      const members = groupMembers(o.id);
      const hadScrews = members.some(mid => screws.some(s => s.objId === mid));
      const allEmpty = members.every(mid => !(remain.get(mid) > 0));
      if (hadScrews && allEmpty) members.forEach(mid => dropped.add(mid));
    });
  };
  let guard = screws.length * 4 + 20;
  while (order.length < screws.length && guard-- > 0){
    updateDrops();
    const sig = droppedSig(dropped);
    const reach = screws.filter(s => !s.taken && !dropped.has(s.objId)
      && screwReachableCached(screwList[s.idx], meshesByObj, dropped, sig));
    if (!reach.length) break;
    // 找出当前可达螺丝中的最高层级，在「同为最高层级」的候选里随机取一颗，
    // 使每次求出的可行拆解顺序不同（但仍满足层级优先与可达约束）。
    const maxLayer = reach.reduce((m, s) => Math.max(m, s.layer), -Infinity);
    const top = reach.filter(s => s.layer === maxLayer);
    const pick = top[Math.floor(Math.random() * top.length)];
    pick.taken = true; order.push(pick.idx);
  }
  const complete = (order.length === screws.length);   // 是否求出了「取完全部螺丝」的可行顺序
  // 若有取不到的螺丝（死局），把它们追加到末尾（仅为配色完整性）
  screws.forEach(s => { if (!s.taken) order.push(s.idx); });

  // 为每个「3 颗一组」随机分配颜色：仅约束「相邻组不同色」，其余随机，
  // 使配色每次不同但仍便于需求槽消化（同组同色、相邻组区分明显）。
  const groupCount = Math.ceil(order.length / 3);
  const groupColorIdx = [];
  for (let g = 0; g < groupCount; g++){
    let c = Math.floor(Math.random() * K);
    if (K > 1 && g > 0 && c === groupColorIdx[g-1]) c = (c + 1 + Math.floor(Math.random()*(K-1))) % K;
    groupColorIdx.push(c);
  }
  order.forEach((screwIdx, pos) => {
    const group = Math.floor(pos / 3);
    screwList[screwIdx].planColor = palette[groupColorIdx[group]];
  });
  return { complete, order };
}

// 复刻 index.html buildDemandQueue：按颜色分组、每 3 颗一个三连、按解锁层级降序排队
function buildSolveDemandQueue(screwList){
  const byColor = {};
  screwList.forEach(s => {
    const e = byColor[s.planColor] || (byColor[s.planColor] = { name: s.planColor, layers: [] });
    e.layers.push(s.layer ?? 0);
  });
  const triples = [];
  Object.keys(byColor).forEach(name => {
    const e = byColor[name];
    e.layers.sort((a, b) => b - a);
    const groups = Math.floor(e.layers.length / 3);
    for (let t = 0; t < groups; t++){
      triples.push({ name, unlockLayer: e.layers[t*3 + 2], rand: Math.random() });
    }
  });
  triples.sort((a, b) => (b.unlockLayer - a.unlockLayer) || (a.rand - b.rand));
  if (triples.length >= 2 && triples[0].name === triples[1].name){
    const j = triples.findIndex((t, idx) => idx >= 2 && t.name !== triples[0].name);
    if (j > 1){ const picked = triples.splice(j, 1)[0]; triples.splice(1, 0, picked); }
  }
  return triples.map(t => ({ color: t.name, filled: 0, done: false }));
}

/* 判断某物件（含同组）在给定「已取螺丝集合」下是否已掉落。 */
function computeDropped(screws){
  const remainByObj = new Map();
  screws.forEach(s => { if (!s.taken) remainByObj.set(s.objId, (remainByObj.get(s.objId)||0)+1); });
  const dropped = new Set();
  level.objects.forEach(o => {
    const members = groupMembers(o.id);
    const hadScrews = members.some(mid => screws.some(s => s.objId === mid));
    const allEmpty = members.every(mid => !(remainByObj.get(mid) > 0));
    if (hadScrews && allEmpty) members.forEach(mid => dropped.add(mid));
  });
  return dropped;
}

/* 单次求解一局（给定固定配色方案，判断该配色是否存在通关走法）。
 * 采用「无损贪心推进 + 备用槽决策处有限回溯 + 记忆化」的搜索：
 *   - 无损步骤：凡是「可达且能直接进需求槽」的螺丝，取它一定不会让局面变差，直接取（不分支）。
 *   - 分支步骤：当没有可直接进槽的螺丝、必须往备用槽放时，对「可达螺丝的不同颜色」逐一尝试，回溯。
 *   - 记忆化：以「已取螺丝集合」的位图为键，剪掉重复到达的失败状态。
 * 这样能在游戏规则下可靠判断该配色是否真的有解（避免纯贪心的假失败）。
 * 返回 { win, reason, maxSpareUsed }。*/
function simulateOneRun(screwList, meshesByObj){
  const N = screwList.length;
  const base = screwList.map(s => ({ objId:s.objId, screwIndex:s.screwIndex, layer:s.layer, planColor:s.planColor }));
  const demandQueue = buildSolveDemandQueue(base);
  const failMemo = new Set();
  let bestMaxSpare = 0;
  let deadline = performance.now() + 1200;   // 单配色求解时间上限（防极端关卡卡死 UI）
  let timedOut = false;

  // 由「已取螺丝集合(taken[]) + 取螺丝顺序无关的需求推进」重建 slots/spares：
  // 需求槽的推进只取决于「按需求队列消耗了多少个三连」，而三连消耗只取决于每种颜色已进槽多少个。
  // 为严格正确，这里用「事件序」重放：我们只在搜索里维护 taken 状态，slots/spares 由一次线性重放得出。
  // 但重放需要顺序——因此改为在搜索节点内显式携带 (slots, spares, cursor)。

  function cloneSlots(slots){ return slots.map(s => s ? { color:s.color, filled:s.filled, done:s.done } : null); }

  // 回流：把备用槽里能进当前可见需求槽的颜色回填
  function flush(slots, spares, cursorRef){
    let changed = true;
    while (changed){
      changed = false;
      for (let i=0;i<slots.length;i++){
        const sl = slots[i];
        if (!sl || sl.done || sl.filled>=3) continue;
        const k = spares.indexOf(sl.color);
        if (k>=0){
          spares.splice(k,1); sl.filled++;
          if (sl.filled>=3){ sl.done=true; slots[i] = cursorRef.c < demandQueue.length ? { ...demandQueue[cursorRef.c++] } : null; }
          changed = true;
        }
      }
    }
  }

  // 递归搜索：返回是否能从当前状态通关
  function dfs(screws, slots, spares, cursor){
    if (performance.now() > deadline){ timedOut = true; return false; }
    const takenCount = screws.reduce((a,s)=>a+(s.taken?1:0),0);
    if (takenCount >= N) return true;

    // 记忆化键：已取集合位图
    let sig = '';
    for (let i=0;i<N;i++) sig += screws[i].taken ? '1':'0';
    sig += '|' + spares.slice().sort().join(',');
    if (failMemo.has(sig)) return false;

    const dropped = computeDropped(screws);
    const dsig = droppedSig(dropped);
    const reachable = [];
    for (let i=0;i<N;i++){
      const s = screws[i];
      if (s.taken || dropped.has(s.objId)) continue;
      if (screwReachableCached(screwList[i], meshesByObj, dropped, dsig)) reachable.push(i);
    }
    if (!reachable.length){ failMemo.add(sig); return false; }  // 卡死

    bestMaxSpare = Math.max(bestMaxSpare, spares.length);

    const visColors = slots.filter(sl => sl && !sl.done && sl.filled<3).map(sl => sl.color);

    // 1) 无损步骤：存在可直接进槽的螺丝 → 取层级最高的一颗（不分支）
    const direct = reachable
      .filter(i => visColors.includes(screws[i].planColor))
      .sort((a,b)=> screws[b].layer - screws[a].layer);
    if (direct.length){
      const i = direct[0];
      const ns = screws.map(s=>({ ...s }));
      const nslots = cloneSlots(slots);
      const nsp = spares.slice();
      const cRef = { c: cursor };
      ns[i].taken = true;
      const sl = nslots.find(x => x && !x.done && x.filled<3 && x.color===ns[i].planColor);
      sl.filled++;
      if (sl.filled>=3){ sl.done=true; const idx=nslots.indexOf(sl); nslots[idx] = cRef.c < demandQueue.length ? { ...demandQueue[cRef.c++] } : null; }
      flush(nslots, nsp, cRef);
      if (dfs(ns, nslots, nsp, cRef.c)) return true;
      failMemo.add(sig);
      return false;   // 无损步唯一，无需尝试其它
    }

    // 2) 必须进备用槽：备用槽已满则失败
    if (spares.length >= SOLVE_SPARE_MAX){ failMemo.add(sig); return false; }

    // 分支：按「可达螺丝的不同颜色」逐一尝试放入备用槽（同色只试一次，且优先更可能被回流的）
    const triedColor = new Set();
    const future = {};
    for (let i=cursor;i<demandQueue.length;i++){ const c=demandQueue[i].color; future[c]=(future[c]||0)+1; }
    const spareCount = {}; spares.forEach(c => spareCount[c]=(spareCount[c]||0)+1);
    const cand = reachable.slice().sort((a,b)=>{
      const sa=(spareCount[screws[a].planColor]?100:0)+(future[screws[a].planColor]?20:0)+screws[a].layer;
      const sb=(spareCount[screws[b].planColor]?100:0)+(future[screws[b].planColor]?20:0)+screws[b].layer;
      return sb-sa;
    });
    for (const i of cand){
      const col = screws[i].planColor;
      if (triedColor.has(col)) continue;   // 同色的多颗，取哪颗对备用槽状态等价，只试一种
      triedColor.add(col);
      const ns = screws.map(s=>({ ...s }));
      const nslots = cloneSlots(slots);
      const nsp = spares.slice();
      const cRef = { c: cursor };
      ns[i].taken = true;
      nsp.push(col);
      flush(nslots, nsp, cRef);
      if (nsp.length <= SOLVE_SPARE_MAX && dfs(ns, nslots, nsp, cRef.c)) return true;
    }
    failMemo.add(sig);
    return false;
  }

  const screws0 = base.map(s => ({ ...s, taken:false }));
  let cursor0 = 0;
  const slots0 = new Array(SOLVE_DEMAND_SHOW).fill(null).map(() => (cursor0 < demandQueue.length ? { ...demandQueue[cursor0++] } : null));
  const win = dfs(screws0, slots0, [], cursor0);

  let reason = '';
  if (!win){
    if (timedOut) reason = '求解超时（关卡规模较大），在时间内未找到通关走法';
    else reason = '该配色下无论如何取螺丝都会卡死或占满 5 颗备用槽';
  }
  return { win, reason, maxSpareUsed: bestMaxSpare, timedOut };
}

/* 结构性硬约束诊断（与随机配色无关，任何配色都躲不过的问题）。
 * 返回 { errors:[], warnings:[], initiallyBlocked:[] } */
function diagnoseStructure(screwList, meshesByObj){
  const errors = [], warnings = [];
  const total = screwList.length;
  if (total === 0){ errors.push('场景中没有任何螺丝。'); return { errors, warnings, blockedCount: 0 }; }
  if (total % 3 !== 0) errors.push(`螺丝总数为 ${total}，不是 3 的倍数，游戏无法凑齐整组消除。`);

  // 初始（未拆任何东西时）就一颗都够不到的物件，几乎必然导致死局
  const droppedNone = new Set();
  const sig0 = droppedSig(droppedNone);
  let reachableNow = 0;
  screwList.forEach(s => { if (screwReachableCached(s, meshesByObj, droppedNone, sig0)) reachableNow++; });
  if (reachableNow === 0) errors.push('开局没有任何一颗螺丝可以被拧下（全部被遮挡）。');
  else if (reachableNow < 3) warnings.push(`开局仅 ${reachableNow} 颗螺丝可拧，起步空间很小，容易被迫占满备用槽。`);

  return { errors, warnings, reachableNow };
}

/* 对外主入口：验证当前关卡是否有可行解。
 * 与游戏 index.html 的 makeGuaranteedPlan 采用【完全相同】的求解逻辑：
 *   反复取「射线方向存在可拧视角（不被未掉落体素遮挡）且层级优先」的螺丝，
 *   能把全部螺丝取完即「有可行解」；取不完（中途卡死）即「无可行解」。
 * 因为游戏进场会用同一算法生成配色/需求槽，所以：
 *   验证可行 ⇒ 游戏进场必定生成一个可通关的配色（保证至少一个可行解）。
 *   验证不可行 ⇒ 关卡结构本身死局，游戏也无法解出。
 * 返回结构化结果，供 UI 展示。*/
function validateLevelSolvable(){
  resetReachCache();   // 场景可能已变，清空上次的可达性缓存
  const screwList = collectWorldScrews();
  const meshesByObj = buildOcclusionMeshes();
  const colorCount = Math.max(1, Math.min(SCREW_COLORS.length, editor.screwColorCount || 3));

  const diag = diagnoseStructure(screwList, meshesByObj);
  const result = {
    totalScrews: screwList.length,
    colorCount,
    errors: diag.errors.slice(),
    warnings: diag.warnings.slice(),
    reachableNow: diag.reachableNow || 0,
    solvable: false,
    sample: null,
  };

  // 硬错误直接判定不可行
  if (diag.errors.length){ result.solvable = false; return result; }

  // 核心：用与游戏一致的算法求「可行拆解顺序」。complete=true 表示能取完全部螺丝。
  const plan = makeIdealColorPlan(screwList, meshesByObj, colorCount);
  result.solvable = !!(plan && plan.complete);

  if (result.solvable){
    // 再用完整模拟验证这份配色 + 需求队列确实能通关（双重确认）
    const run = simulateOneRun(screwList, meshesByObj);
    result.sample = run;
    // 【关键】把求出的可行解「固化」到关卡：写回每颗螺丝的实际颜色，并按可拆顺序
    // 生成需求槽序列，存进 level.solution。游戏进场将直接使用这套方案（不再随机分配）。
    freezeSolutionToLevel(screwList, plan);
    result.frozen = true;
    // 生成可回放的解题轨迹（仅内存，供编辑器「解法回放」动画 + 螺丝序号标注使用；不持久化以免膨胀存档）
    const trace = buildSolveTrace(screwList, plan);
    result.trace = trace;
    result.maxSpareUsed = trace.maxSpareUsed;
  } else {
    // 无解：清除任何旧的固化解，避免误用
    level.solution = null;
    result.warnings.push('关卡结构存在死局：按任何顺序拆解，都有螺丝会被永久遮挡 / 够不到。');
    result.warnings.push('建议：检查是否有螺丝被其它物件完全包裹、或层级设置导致内层螺丝永远无法在外层拆除后露出，调整螺丝位置或层级后重试。');
  }
  return result;
}

/* 把求出的可行解固化进关卡数据：
 *  1) 把 plan 里每颗螺丝的 planColor 写回对应 obj.screws[i].color（这就是玩家将看到的固定颜色）；
 *  2) 按可行拆解顺序（plan.order）生成需求槽序列 level.solution.demand = [colorName,...]（每 3 颗一组一个需求）；
 *  3) 记录 level.solution.order（可拆顺序，供调试/回放）与颜色种类数。
 * 保存后游戏进场直接用这套颜色与需求顺序，只允许「整体颜色置换」的随机（见 randomizeScrewColorsAll）。*/
function freezeSolutionToLevel(screwList, plan){
  // 1) 写回螺丝颜色
  screwList.forEach(s => {
    const obj = level.objects.find(o => o.id === s.objId);
    if (obj && obj.screws[s.screwIndex]) obj.screws[s.screwIndex].color = s.planColor;
  });
  // 2) 需求槽序列：plan.order 是 screwList 下标的可拆顺序，每 3 颗同色成一个需求
  const demand = [];
  for (let g = 0; g * 3 < plan.order.length; g++){
    const idx = plan.order[g * 3];
    if (idx != null && screwList[idx]) demand.push(screwList[idx].planColor);
  }
  // 3) 保存固化解
  level.solution = {
    demand,                                   // 需求槽出现顺序（每项为一种颜色 name，代表一个 3 连需求）
    colorCount: Math.max(1, Math.min(SCREW_COLORS.length, editor.screwColorCount || 3)),
    frozenAt: Date.now(),
  };
  // 立即重建螺丝网格以反映新颜色，并保存
  level.objects.forEach(o => rebuildScrewMeshes(o));
  refreshStats();
  autoSave();
}

/* 沿可行拆解顺序 plan.order 生成「可回放的解题轨迹」：
 * 逐颗取螺丝，按游戏规则（2 个可见需求槽 + 5 备用槽 + 回流）推进，记录每一步的动作与状态快照。
 * 返回 { steps:[ { objId, screwIndex, color, action:'demand'|'spare',
 *                  slots:[{color,filled}|null,...], spares:[color,...], demandCursor } ], maxSpareUsed }
 * 供编辑器的「解法回放」动画使用。*/
function buildSolveTrace(screwList, plan){
  const order = plan.order;
  const N = order.length;
  // 需求队列：与 freezeSolutionToLevel 的 demand 完全一致（每 3 颗一组的颜色）
  const demand = [];
  for (let g = 0; g * 3 < N; g++){ const idx = order[g*3]; if (idx != null && screwList[idx]) demand.push(screwList[idx].planColor); }

  let cursor = 0;
  const slots = [ demand[cursor] ? { color: demand[cursor++], filled:0 } : null,
                  demand[cursor] ? { color: demand[cursor++], filled:0 } : null ];
  const spares = [];
  let maxSpareUsed = 0;
  const steps = [];

  const refill = (i)=>{ slots[i] = cursor < demand.length ? { color: demand[cursor++], filled:0 } : null; };
  // 与游戏 index.html pickDemandTarget 一致：多个同色槽时优先填「已填最多」的那个（并列取靠前）
  const pickTarget = (col)=>{
    let best=-1, bestFilled=-1;
    for (let i=0;i<slots.length;i++){
      const sl=slots[i]; if(!sl||sl.color!==col||sl.filled>=3) continue;
      if (sl.filled>bestFilled){ bestFilled=sl.filled; best=i; }
    }
    return best;
  };
  const flush = ()=>{
    let changed = true;
    while (changed){
      changed = false;
      for (let k=0;k<spares.length;k++){
        const i = pickTarget(spares[k]);
        if (i>=0){ spares.splice(k,1); slots[i].filled++; if (slots[i].filled>=3) refill(i); changed=true; break; }
      }
    }
  };

  // 追踪已取螺丝，用于计算每步之后哪些物件已「取空并掉落」
  const takenState = screwList.map(s => ({ objId:s.objId, taken:false }));
  const takenByIdx = new Map();       // screwList 下标 → takenState 下标（此处一致）
  screwList.forEach((s,i)=> takenByIdx.set(i, i));

  order.forEach(idx=>{
    const s = screwList[idx];
    const col = s.planColor;
    // 优先进「已填最多」的同色可见需求槽
    const ti = pickTarget(col);
    let action;
    if (ti>=0){
      slots[ti].filled++;
      action = 'demand';
      if (slots[ti].filled>=3) refill(ti);
      flush();
    } else {
      spares.push(col);
      action = 'spare';
      maxSpareUsed = Math.max(maxSpareUsed, spares.length);
      flush();
    }
    maxSpareUsed = Math.max(maxSpareUsed, spares.length);

    // 标记该螺丝已取，计算当前已掉落物件（同组螺丝全取空 → 整组掉落）
    takenState[idx].taken = true;
    const dropped = computeDropped(takenState);

    steps.push({
      objId: s.objId, screwIndex: s.screwIndex, color: col, action,
      slots: slots.map(sl => sl ? { color: sl.color, filled: sl.filled } : null),
      spares: spares.slice(),
      dropped: Array.from(dropped),   // 该步之后已掉落（消失）的物件 id 列表
    });
  });

  return { steps, maxSpareUsed, demand };
}

/* =========================================================
 * 射线拾取
 * ========================================================= */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let lastClientX = 0, lastClientY = 0;

function setPointer(clientX, clientY){
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((clientX-rect.left)/rect.width)*2 - 1;
  pointer.y = -((clientY-rect.top)/rect.height)*2 + 1;
  raycaster.setFromCamera(pointer, camera);
}
function setPointerFromLast(){ setPointer(lastClientX, lastClientY); }

// 判断某物件当前是否隐藏（隐藏的物件不参与射线拾取——雕刻/吸色/上色/螺丝/定位均忽略）
function isObjHidden(id){
  const o = level.objects.find(ob => ob.id === id);
  return !!(o && o.hidden);
}
function allVoxelMeshes(){
  const arr = [];
  renderRefs.forEach((ref, id) => {
    if (isObjHidden(id)) return;
    if (ref.pickMeshes) ref.pickMeshes.forEach(m => arr.push(m));
    else {
      const unique = new Set();
      ref.voxelMeshes.forEach(m => unique.add(m));
      unique.forEach(m => arr.push(m));
    }
  });
  return arr;
}
function voxelKeyFromHit(hit){
  if (!hit || !hit.object) return null;
  const ud = hit.object.userData || {};
  if (hit.instanceId != null && ud.instanceKeys) return ud.instanceKeys[hit.instanceId] || null;
  return ud.key || null;
}
function voxelHitWorldCenter(hit){
  if (!hit || !hit.object) return new THREE.Vector3();
  if (hit.instanceId != null && hit.object.isInstancedMesh) {
    const m = new THREE.Matrix4();
    hit.object.getMatrixAt(hit.instanceId, m);
    return hit.object.localToWorld(new THREE.Vector3().setFromMatrixPosition(m));
  }
  return hit.object.getWorldPosition(new THREE.Vector3());
}

// 判定「被点击的是体素的哪个面」——鲁棒做法：把命中点转到物件局部空间，
// 与被点体素的几何中心比较，取偏移量最大的轴与符号作为面法线。
// 因为使用 group.worldToLocal（完整逆矩阵），无论物件如何旋转/缩放，
// 都能得到正确的局部面方向 [±1,0,0]/[0,±1,0]/[0,0,±1]，从而让螺丝/雕刻
// 始终贴合到用户看到的那个面（不再依赖会被非等比缩放扭曲的法线变换）。
function localFaceFromHit(obj, hit, x, y, z, span){
  const ref = renderRefs.get(obj.id);
  if (!ref || !ref.group || !hit || !hit.point) return [0,1,0];
  const s = vsizeOf(obj);
  const sp = span || 1;
  const lp = ref.group.worldToLocal(hit.point.clone());
  const cx = (x + sp/2) * s, cy = (y + sp/2) * s, cz = (z + sp/2) * s;
  const dx = lp.x - cx, dy = lp.y - cy, dz = lp.z - cz;
  const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
  if (ax >= ay && ax >= az) return [dx >= 0 ? 1 : -1, 0, 0];
  if (ay >= az)             return [0, dy >= 0 ? 1 : -1, 0];
  return [0, 0, dz >= 0 ? 1 : -1];
}
function voxelWorldCenterForKey(obj, key){
  const dec = decodeVoxel(obj.voxels[key]);
  const ref = renderRefs.get(obj.id);
  const [x,y,z] = parseKey(key);
  return ref.group.localToWorld(voxelCenterLocal(obj, x, y, z, dec.mult || 1));
}
function allScrewMeshes(){

  const arr = [];
  renderRefs.forEach((ref, id) => { if (!isObjHidden(id)) ref.screwMeshes.forEach(m => arr.push(m)); });
  return arr;
}

function worldToLocalVoxel(obj, worldPoint){
  const ref = renderRefs.get(obj.id);
  const s = vsizeOf(obj);
  const local = ref.group.worldToLocal(worldPoint.clone());
  return new THREE.Vector3(Math.floor(local.x/s), Math.floor(local.y/s), Math.floor(local.z/s));
}

/* ---------------- 片状笔刷核心 ---------------- */
function getBrushOffsets(){
  const r = editor.brush;
  const offs = [];
  for (let a=-r; a<=r; a++) for (let b=-r; b<=r; b++) {
    if (editor.shape === 'round' && (a*a + b*b) > r*r + 0.001) continue;
    offs.push([a,b]);
  }
  return offs;
}
function tangentAxes(face){
  // 手动指定朝向：不再跟随点击面自动变更
  if (editor.brushOrient === 'horizontal') return [[1,0,0],[0,0,1]];      // 水平横片：铺在 XZ 平面
  if (editor.brushOrient === 'vertical'){
    // 竖直竖片：高度沿 Y，宽度取"面向镜头"的那个水平轴（使竖片正对当前视角）
    const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd);
    const widthAxis = Math.abs(fwd.x) >= Math.abs(fwd.z) ? [0,0,1] : [1,0,0];
    return [widthAxis, [0,1,0]];
  }
  // auto：跟随被点击面的两个切向轴
  const [fx,fy,fz] = face;
  if (fx !== 0) return [[0,1,0],[0,0,1]];
  if (fy !== 0) return [[1,0,0],[0,0,1]];
  return [[1,0,0],[0,1,0]];
}

// 在当前物件局部网格上，从某个基准体素 + 面法线展开片状目标
function brushCellsOnFace(obj, base, face, forErase){
  const [u, v] = tangentAxes(face);
  const offs = getBrushOffsets();
  const cells = [];
  for (const [a,b] of offs) {
    const bx = base.x + u[0]*a + v[0]*b;
    const by = base.y + u[1]*a + v[1]*b;
    const bz = base.z + u[2]*a + v[2]*b;
    if (forErase) {
      if (cellOccupied(obj, bx, by, bz)) cells.push({ x:bx, y:by, z:bz });
    } else {
      if (!cellOccupied(obj, bx, by, bz)) cells.push({ x:bx, y:by, z:bz });
    }
  }
  return cells;
}

// 计算当前指向的"片"目标（add/erase 通用）。add 工具在选择了非默认尺寸（editor.voxelMult≠1，
// 包括更大的 1.5/2/3 或更小的 0.25/0.5）时，不再展开笔刷片（避免同尺寸互相重叠冲突/避免
// 小尺寸被误当作整片铺开），改为只对准点击处放置单个体素。
function computeBrushTargets(forErase){
  const obj = getActiveObj();
  if (!obj) return null;
  const ref = renderRefs.get(obj.id);
  setPointerFromLast();
  const bigMult = (!forErase && Math.abs(editor.voxelMult - 1) > 1e-6) ? editor.voxelMult : 1;

  const meshes = allVoxelMeshes();
  const voxHits = raycaster.intersectObjects(meshes, false);

  // 擦除：仅作用于当前物件自身的体素（避免误删其他物件）
  if (forErase) {
    const myVoxHit = voxHits.find(h => h.object.userData.objId === obj.id);
    if (!myVoxHit) return { cells: [], face:[0,1,0], mult:1 };
    const [x,y,z] = parseKey(voxelKeyFromHit(myVoxHit));

    const nLocal = myVoxHit.face.normal.clone();
    const face = [Math.round(nLocal.x), Math.round(nLocal.y), Math.round(nLocal.z)];
    const cells = brushCellsOnFace(obj, { x, y, z }, face, true);
    return { cells, face, mult:1 };
  }

  // 雕刻：命中任意物件的表面都可贴合放置。方块为单面渲染，正向可能打不到"背对相机的面"，
  // 这里在正向未命中时，用一次"反向射线"从远端往回打命中背面（仅在需要时执行，几乎无开销），
  // 从而无需双面渲染就能贴到背对相机的面上。
  let hit = voxHits[0];
  if (!hit) {
    const backHit = backfaceVoxelHit(meshes);
    if (backHit) hit = backHit;
  }
  if (hit) {
    if (hit.object.userData.objId === obj.id) {
      // 命中当前物件：用精确网格，行为与原来一致；新体素紧贴在被点击面的外侧
      // ——沿面法线方向按"被点中体素自身的尺寸"整体偏移，而不是固定偏移 1，
      // 从而正确支持点中一个大/小体素的外侧面时也能贴合摆放（不会与被点中体素重叠）。
      const hitKey = voxelKeyFromHit(hit);
      const [x,y,z] = parseKey(hitKey);
      const hitSpan = decodeVoxel(obj.voxels[hitKey]).mult || 1;

      // 用命中点相对被点体素中心的偏移来判定面（localFaceFromHit）。它基于
      // group.worldToLocal 的完整逆矩阵，无论物件如何旋转 / 非等比缩放都能得到正确的
      // 局部外法线，从而彻底解决"旋转后雕刻方向错乱、刻到别的面"的问题
      // （不再依赖会被缩放扭曲、又要额外翻面的 transformDirection 法线）。
      const face = localFaceFromHit(obj, hit, x, y, z, hitSpan);
      const base = {
        x: x + (face[0] ? (face[0]>0 ? hitSpan : -bigMult) : 0),
        y: y + (face[1] ? (face[1]>0 ? hitSpan : -bigMult) : 0),
        z: z + (face[2] ? (face[2]>0 ? hitSpan : -bigMult) : 0),
      };
      const cells = bigMult !== 1 ? [base] : brushCellsOnFace(obj, base, face, false);
      return { cells, face, mult: bigMult };
    }
    // 命中其他物件：通过世界坐标把放置点对齐到当前物件的体素网格，贴在被点面的外侧
    const hitObj = level.objects.find(o => o.id === hit.object.userData.objId);
    const hitRef = renderRefs.get(hitObj.id);
    const hitKey = voxelKeyFromHit(hit);
    const [hx,hy,hz] = parseKey(hitKey);
    const hitVS = vsizeOf(hitObj);
    const hitSpan = decodeVoxel(hitObj.voxels[hitKey]).mult || 1;

    const myVS = vsizeOf(obj);
    // 在被命中物件的局部空间用命中点判定面（旋转/缩放鲁棒），再经其 group 旋转
    // 转成世界外法线，供后续世界坐标对齐使用。
    const faceOnHit = localFaceFromHit(hitObj, hit, hx, hy, hz, hitSpan);
    const worldN = new THREE.Vector3(faceOnHit[0], faceOnHit[1], faceOnHit[2])
      .applyQuaternion(hitRef.group.quaternion).normalize();
    // 被点击面的世界中心 = 命中体素世界中心 + 世界法线 * (命中物件体素半边长，按其实际尺寸)
    const hitCenterWorld = voxelHitWorldCenter(hit);

    const faceCenterWorld = hitCenterWorld.add(worldN.clone().multiplyScalar(hitVS*hitSpan/2));
    // 当前物件新体素的世界中心：贴在面外侧半个自身体素（按所选尺寸）
    const targetCenterWorld = faceCenterWorld.add(worldN.clone().multiplyScalar(myVS*bigMult/2));
    // 转到当前物件局部，得到网格坐标（吸附到 0.25 粒度）
    const localCenter = ref.group.worldToLocal(targetCenterWorld.clone());
    const base = {
      x: snap4(localCenter.x/myVS - bigMult/2),
      y: snap4(localCenter.y/myVS - bigMult/2),
      z: snap4(localCenter.z/myVS - bigMult/2),
    };
    // 面法线转到当前物件局部空间（物件只绕 Y 旋转）
    const localN = worldN.clone().applyQuaternion(ref.group.quaternion.clone().invert());
    const face = [Math.round(localN.x), Math.round(localN.y), Math.round(localN.z)];
    const cells = bigMult !== 1 ? [base] : brushCellsOnFace(obj, base, face, false);
    return { cells, face, mult: bigMult };
  }

  // 未命中任何体素表面（例如相邻面背对相机、或想直填某个空格）：
  // 先沿射线在当前物件网格里步进，找到「射线穿过的第一个空格」直接填入（空格直填），
  // 这样任意角度都能填同一个位置，不再依赖"必须看得见某个相邻面"。
  const s = vsizeOf(obj);
  const spaceHit = raySpaceCell(obj, bigMult);
  if (spaceHit) {
    const base = spaceHit;
    if (bigMult !== 1) return { cells: [base], face:[0,1,0], mult: bigMult };
    const cells = brushCellsOnFace(obj, base, [0,1,0], false);
    return { cells, face:[0,1,0], mult:1 };
  }

  // 兜底：落到平面层（地面），从底层开始
  const planeWorldY = obj.pos.y + (editor.mode === 'plane' ? editor.planeY*s : 0);
  const planeObj = new THREE.Plane(new THREE.Vector3(0,1,0), -planeWorldY);
  const hitPt = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(planeObj, hitPt)) return null;
  const lv = worldToLocalVoxel(obj, hitPt);
  const baseY = editor.mode === 'plane' ? editor.planeY : 0;
  // 地面兜底同样属于"凭空落点"：把落点夹回 50×50 网格区域内，
  // 杜绝相机正前方远处（射线与地面在远处相交）凭空生成体素的情况。

  const clamped = clampAnchorToFreeRange({ x: lv.x, y: baseY, z: lv.z }, bigMult);
  if (bigMult !== 1) {
    return { cells: [{ x:clamped.x, y:baseY, z:clamped.z }], face:[0,1,0], mult: bigMult };
  }
  // 按当前笔刷朝向展开（auto/水平→平躺；竖直→在此处立起）
  const base = { x: clamped.x, y: baseY, z: clamped.z };
  const cells = brushCellsOnFace(obj, base, [0,1,0], false);
  return { cells, face:[0,1,0], mult:1 };
}

// 反向射线命中：方块单面渲染时，正向射线打不到"背对相机的面"。这里从当前射线的远端
// 反向发射，取最靠近相机的一次命中——它正是正向被背面剔除的那个面。返回结构与正向 hit
// 兼容（含 object/face/point）。仅在正向未命中时调用，开销极低。
const _backRay = new THREE.Raycaster();
function backfaceVoxelHit(meshes){
  const far = 1000;
  const origin = raycaster.ray.origin.clone().add(raycaster.ray.direction.clone().multiplyScalar(far));
  const dir = raycaster.ray.direction.clone().negate();
  _backRay.set(origin, dir);
  const hits = _backRay.intersectObjects(meshes, false);
  if (!hits.length) return null;
  // 反向命中里，离相机最近（沿正向射线 t 最小）的那个才是玩家真正指着的"背面"
  const camO = raycaster.ray.origin, camD = raycaster.ray.direction;
  let best = null, bestT = Infinity;
  for (const h of hits){
    const t = h.point.clone().sub(camO).dot(camD);   // 沿正向射线的投影距离
    if (t > 0 && t < bestT){ bestT = t; best = h; }
  }
  return best;
}

// 沿当前射线在物件的整数网格中步进，返回射线穿过的「第一个紧邻已有体素的可放置空格」锚点。
// 语义：周围有物件时“优先贴面摆放”。此函数只认“紧邻已有体素（贴面/支撑）”的落点，
// 不再返回悬浮的凭空落点；找不到贴面空格时返回 null（交由调用方回退到水平地面平面）。
function raySpaceCell(obj, mult){
  const ref = renderRefs.get(obj.id);
  if (!ref) return null;
  const s = vsizeOf(obj);
  const m = mult > 0 ? mult : 1;
  // 射线换到物件局部空间（物件仅绕 Y 旋转 + 平移 + 缩放；worldToLocal 处理全部）
  const o = ref.group.worldToLocal(raycaster.ray.origin.clone());
  const tip = ref.group.worldToLocal(raycaster.ray.origin.clone().add(raycaster.ray.direction));
  const d = tip.sub(o).normalize();
  // 以体素为单位步进：把局部坐标除以 s 换算到"格坐标"空间
  const og = new THREE.Vector3(o.x/s, o.y/s, o.z/s);
  const step = 0.34;                 // 采样步长（格）：足够细避免跳过薄空隙，又不至于采样过多
  const maxDist = 140;                // 最大步进格数：覆盖 50×50 建模范围即可，避免空指向时空转到十分远处
  const anchorOf = (gx,gy,gz) => ({
    x: Math.floor(gx - (m-1)/2),
    y: Math.floor(gy),
    z: Math.floor(gz - (m-1)/2),
  });
  const hasNeighbor = (a) => {
    // 该锚点占用块的六个方向是否存在已有体素（作为"支撑"，让直填更符合直觉）
    const checks = [[-1,0,0],[1,0,0],[0,-1,0],[0,1,0],[0,0,-1],[0,0,1]];
    for (let dx=0; dx<m; dx++) for (let dy=0; dy<m; dy++) for (let dz=0; dz<m; dz++){
      for (const [nx,ny,nz] of checks){
        if (cellOccupied(obj, a.x+dx+nx, a.y+dy+ny, a.z+dz+nz)) return true;
      }
    }
    return false;
  };
  for (let t=0; t<=maxDist; t+=step){
    const gx = og.x + d.x*t, gy = og.y + d.y*t, gz = og.z + d.z*t;
    const a = anchorOf(gx, gy, gz);
    if (!canPlaceBlock(obj, a.x, a.y, a.z, m)) continue;   // 被占用/禁放区跳过
    if (hasNeighbor(a)) return a;                          // 紧邻已有体素：贴面摆放，优先返回
    // 不紧邻任何体素的空格：不再作为悬浮凭空落点，交由调用方回退到水平地面
  }
  return null;
}

/* ---------------- 悬停预览 ---------------- */
function updateHover(){
  clearHover();
  const obj = getActiveObj();
  // 定位工具不依赖当前选中物件，允许在无选中物件时也做悬停高亮
  if (!obj && editor.tool !== 'locate') return;
  const ref = obj ? renderRefs.get(obj.id) : null;
  const s = obj ? vsizeOf(obj) : DEFAULT_VOXEL_SIZE;
  setPointerFromLast();

  // 当前物件被隐藏时，不显示雕刻/擦除预览
  if (obj && obj.hidden && (editor.tool === 'add' || editor.tool === 'erase')) return;

  if (editor.tool === 'add' || editor.tool === 'erase') {
    const res = computeBrushTargets(editor.tool === 'erase');
    if (!res || !res.cells.length) return;
    const mult = res.mult || 1;
    // add 工具：剔除放不下（与已有体素冲突）的格子（不预览）
    const cells = editor.tool === 'add'
      ? res.cells.filter(c => canPlaceBlock(obj, c.x, c.y, c.z, mult))
      : res.cells;
    if (!cells.length) return;
    const col = editor.tool === 'erase' ? 0xff5d5d : voxelValueToHexInt(editor.voxelColor);
    // 预览体素形状：erase 用方块；add 用当前选中形状（朝向跟随放置面），尺寸按所选"大体素"倍数放大
    let geoProto;
    if (editor.tool === 'add' && editor.voxelShape !== 'cube') {
      const dir = faceToDir([-res.face[0], -res.face[1], -res.face[2]]);
      const params = isParamShape(editor.voxelShape) ? (editor.shapeParams[editor.voxelShape] || null) : null;
      geoProto = makeVoxelGeometry(editor.voxelShape, dir, s*mult, params);
    } else {
      geoProto = new THREE.BoxGeometry(s*mult, s*mult, s*mult);
    }
    const edgeGeo = new THREE.EdgesGeometry(geoProto);
    cells.forEach(c => {
      const localCenter = voxelCenterLocal(obj, c.x, c.y, c.z, mult);
      const wp = ref.group.localToWorld(localCenter.clone());
      const box = new THREE.Mesh(geoProto, new THREE.MeshBasicMaterial({ color:col, transparent:true, opacity:0.25, depthWrite:false }));
      box.position.copy(wp); box.quaternion.copy(ref.group.quaternion);
      const edge = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: col }));
      box.add(edge);
      hoverGroup.add(box);
    });
  } else if (editor.tool === 'locate') {
    // 定位悬停：高亮当前指向物件的"所有体素"，直观提示会定位到哪个物件
    const voxHits = raycaster.intersectObjects(allVoxelMeshes(), false);
    const myHit = voxHits[0];
    if (myHit) {
      const tObj = level.objects.find(o => o.id === myHit.object.userData.objId);
      const tRef = tObj && renderRefs.get(tObj.id);
      if (tRef) {
        const keys = Object.keys(tObj.voxels);
        if (keys.length > 500) {
          const helper = new THREE.Box3Helper(new THREE.Box3().setFromObject(tRef.group), 0x43b9ff);
          hoverGroup.add(helper);
        } else {
          const ts = vsizeOf(tObj);
          keys.forEach(key => {
            const dec = decodeVoxel(tObj.voxels[key]);
            const size = ts * (dec.mult || 1);
            const box = new THREE.Mesh(
              new THREE.BoxGeometry(size, size, size),
              new THREE.MeshBasicMaterial({ color:0x43b9ff, transparent:true, opacity:0.28, depthWrite:false })
            );
            box.position.copy(voxelWorldCenterForKey(tObj, key));
            box.quaternion.copy(tRef.group.quaternion);
            hoverGroup.add(box);
          });
        }
      }

    }
  } else if (editor.tool === 'paint' || editor.tool === 'pick') {
    const voxHits = raycaster.intersectObjects(allVoxelMeshes(), false);
    const myHit = voxHits[0];
    if (myHit) {
      const tObj = level.objects.find(o => o.id === myHit.object.userData.objId) || obj;
      const hitKey = voxelKeyFromHit(myHit);
      const dec = decodeVoxel(tObj.voxels[hitKey]);
      const ts = vsizeOf(tObj) * (dec.mult || 1);
      const hitCenter = voxelHitWorldCenter(myHit);
      // 吸色：高亮显示"将要吸到的颜色"；上色：显示当前画笔色
      const col = editor.tool === 'pick' ? voxelValueToHexInt(tObj.voxels[hitKey]) : voxelValueToHexInt(editor.voxelColor);

      if (editor.tool !== 'pick' && editor.paintFace && dec.shape === SHAPE_CUBE && myHit.face) {
        // 单面高亮：在被点击面外侧贴一个小平面
        const worldN = myHit.face.normal.clone().transformDirection(myHit.object.matrixWorld).normalize();
        const center = hitCenter.clone().add(worldN.clone().multiplyScalar(ts/2 + 0.003));

        const quad = new THREE.Mesh(
          new THREE.PlaneGeometry(ts*0.94, ts*0.94),
          new THREE.MeshBasicMaterial({ color: col, transparent:true, opacity:0.6, side:THREE.DoubleSide, depthWrite:false })
        );
        quad.position.copy(center);
        quad.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1), worldN);
        hoverGroup.add(quad);
      } else {
        const box = new THREE.Mesh(new THREE.BoxGeometry(ts, ts, ts), new THREE.MeshBasicMaterial({ color: col, transparent:true, opacity:0.4, depthWrite:false }));
        box.position.copy(hitCenter);

        box.quaternion.copy(myHit.object.parent.quaternion);
        hoverGroup.add(box);
      }
    }
  }
}

/* ---------------- 点击 ---------------- */
function handleClick(){
  // 验证预览态：只允许旋转查看，禁止任何编辑操作
  if (validationPreview){ toast('验证预览中，暂不可编辑（关闭回放后恢复）'); return; }
  const obj = getActiveObj();
  // 定位工具不需要预先选中物件（它的作用就是去选中）
  if (!obj && editor.tool !== 'locate') { toast('请先新建/选择一个物件'); return; }
  // 当前物件被隐藏时，禁止对它的雕刻/擦除（避免对看不见的物件操作）
  if (obj && obj.hidden && (editor.tool === 'add' || editor.tool === 'erase')) {
    toast('当前物件已隐藏，请先显示它再操作');
    return;
  }
  setPointerFromLast();

  if (editor.tool === 'add') {
    const res = computeBrushTargets(false);
    if (res && res.cells.length) {
      const mult = res.mult || 1;
      // 形状朝向：让形状的平面/斜面朝向放置面的反方向（即贴合被点击的面）
      const dir = faceToDir([-res.face[0], -res.face[1], -res.face[2]]);
      // 编码时带上实际尺寸倍数 mult，保证三角/半圆等形状在非 1× 尺寸档也正确（此前写死为 1 是个 bug）
      // 参数化形状（圆柱/圆台/棱锥等）附带当前参数（第 7 段）
      const params = isParamShape(editor.voxelShape) ? (editor.shapeParams[editor.voxelShape] || null) : null;
      const value = encodeVoxel(editor.voxelColor, editor.voxelShape, dir, null, mult, editor.voxelAlpha, params);
      let blocked = 0;
      res.cells.forEach(c => {
        if (!canPlaceBlock(obj, c.x, c.y, c.z, mult)) { blocked++; return; }
        addVoxel(obj, c.x, c.y, c.z, value, mult);
      });
      pushRecent(editor.voxelColor);
      refreshStats(); autoSave();
      if (blocked) toast(mult !== 1 ? '该位置放不下这个尺寸的体素（与已有体素冲突）' : '该位置已被体素占用');
    }
    return;
  }
  if (editor.tool === 'erase') {
    const res = computeBrushTargets(true);
    if (res && res.cells.length) {
      res.cells.forEach(c => removeVoxel(obj, keyOf(c.x,c.y,c.z)));
      refreshStats(); autoSave();
    }
    return;
  }
  if (editor.tool === 'paint') {
    // 上色支持跨物件：作用于被点击的体素
    const voxHits = raycaster.intersectObjects(allVoxelMeshes(), false);
    const myHit = voxHits[0];
    if (myHit) {
      const tObj = level.objects.find(o => o.id === myHit.object.userData.objId) || obj;
      const key = voxelKeyFromHit(myHit);

      const fi = myHit.face ? myHit.face.materialIndex : undefined;
      if (editor.paintFace && fi != null) paintVoxelFace(tObj, key, fi, editor.voxelColor);
      else paintVoxel(tObj, key, editor.voxelColor);
      pushRecent(editor.voxelColor); autoSave();
    }
    return;
  }
  if (editor.tool === 'locate') {
    // 定位：点任意体素直接选中它所属的物件（跨物件），并同步右侧面板/列表
    const voxHits = raycaster.intersectObjects(allVoxelMeshes(), false);
    const myHit = voxHits[0];
    if (myHit) {
      const tObj = level.objects.find(o => o.id === myHit.object.userData.objId);
      if (tObj) {
        activeObjId = tObj.id;
        refreshObjList(); refreshRightPanel(); syncPlaneIndicator();
        toast('已定位到「' + tObj.name + '」');
      }
    } else {
      toast('没点到体素，请点在物件上');
    }
    return;
  }
  if (editor.tool === 'pick') {
    // 吸色：点体素（或其某个面）把颜色吸取为当前画笔色
    const voxHits = raycaster.intersectObjects(allVoxelMeshes(), false);
    const myHit = voxHits[0];
    if (myHit) {
      const tObj = level.objects.find(o => o.id === myHit.object.userData.objId);
      const dec = tObj && decodeVoxel(tObj.voxels[voxelKeyFromHit(myHit)]);

      if (dec) {
        // 若该面有单面覆盖色，优先吸取被点面的颜色，否则吸取体素主色
        const fi = myHit.face ? myHit.face.materialIndex : undefined;
        const picked = (dec.faces && fi != null && dec.faces[fi]) ? dec.faces[fi] : dec.hex;
        const n = normHex(picked);
        if (n) { setVoxelColor(n); pushRecent(n); toast('已吸取颜色 ' + n); }
      }
    } else {
      toast('没吸到体素，请点在体素上');
    }
    return;
  }
  if (editor.tool === 'screw') {
    // 优先：点已有螺丝改色（跨物件——作用于螺丝所属物件）
    const screwHits = raycaster.intersectObjects(allScrewMeshes(), true);
    if (screwHits.length) {
      const root = findRoot(screwHits[0].object, 'screw');
      if (root) {
        const tObj = level.objects.find(o => o.id === root.userData.objId);
        const i = root.userData.screwIndex;
        if (tObj && tObj.screws[i]) { tObj.screws[i].color = editor.screwColor; rebuildScrewMeshes(tObj); refreshStats(); autoSave(); }
        return;
      }
    }
    // 否则：在被点击物件的外露面上加螺丝（跨物件）
    const voxHits = raycaster.intersectObjects(allVoxelMeshes(), false);
    const hit = voxHits[0];
    if (hit) {
      const tObj = level.objects.find(o => o.id === hit.object.userData.objId);
      const key = voxelKeyFromHit(hit);

      const n = hit.face.normal;
      const face = [Math.round(n.x), Math.round(n.y), Math.round(n.z)];
      addScrewAtFace(tObj, key, face, editor.screwColor); refreshStats(); autoSave();
    }
    return;
  }
  if (editor.tool === 'screw-erase') {
    const screwHits = raycaster.intersectObjects(allScrewMeshes(), true);
    if (screwHits.length) {
      const root = findRoot(screwHits[0].object, 'screw');
      if (root) {
        const tObj = level.objects.find(o => o.id === root.userData.objId);
        if (tObj) { removeScrewByIndex(tObj, root.userData.screwIndex); refreshStats(); autoSave(); }
      }
    }
    return;
  }
}

function findRoot(o, type){ while(o){ if (o.userData && o.userData.type === type) return o; o = o.parent; } return null; }

/* =========================================================
 * 鼠标/触摸
 * ========================================================= */
const drag = { active:false, moved:false, btn:0, lx:0, ly:0, sx:0, sy:0, orbiting:false, downT:0 };
const THRESH = 5;
const CLICK_MAX_MS = 300;   // 按下到松开在此时长内、即使有轻微位移也算「点击」（防止快速连点被当拖拽丢弃）
const CLICK_MOVE_TOL = 10;  // 快速点击允许的最大位移（像素），比拖拽阈值略大以容忍手抖

let _hoverTimer = null;
function scheduleHoverUpdate(){
  if (_hoverTimer != null) return;
  _hoverTimer = setTimeout(() => {
    _hoverTimer = null;
    if (!drag.active) updateHover();
  }, 32);
}
renderer.domElement.addEventListener('pointermove', e => {
  lastClientX = e.clientX; lastClientY = e.clientY;
  if (!drag.active) scheduleHoverUpdate();
});

renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());

// 左键"放置/编辑"类工具：按下即用于操作，不用于转视角（无需在 pointerdown 做射线判断）
const PLACE_TOOLS = { add:1, erase:1, paint:1, screw:1, 'screw-erase':1 };
renderer.domElement.addEventListener('pointerdown', e => {
  drag.active = true; drag.moved = false; drag.btn = e.button;
  drag.sx = drag.lx = e.clientX; drag.sy = drag.ly = e.clientY;
  drag.downT = (e.timeStamp || performance.now());
  try { renderer.domElement.setPointerCapture(e.pointerId); } catch(_){}
  if (e.button === 0) {
    // 放置类工具：左键固定用于放置，直接免去两次全场景射线检测（螺丝/体素很多时这会拖慢快速连点）。
    if (PLACE_TOOLS[editor.tool]) {
      drag.orbiting = false;
    } else {
      // 其余工具（如"选择/框选"等）：仍按是否命中物体决定转不转视角
      setPointer(e.clientX, e.clientY);
      const hitVox = raycaster.intersectObjects(allVoxelMeshes(), false).length > 0;
      const hitScrew = raycaster.intersectObjects(allScrewMeshes(), true).length > 0;
      drag.orbiting = !(hitVox || hitScrew);
    }
  } else {
    drag.orbiting = true;
  }
});
window.addEventListener('pointermove', e => {
  if (!drag.active) return;
  const dx = e.clientX - drag.lx, dy = e.clientY - drag.ly;
  if (!drag.moved && Math.hypot(e.clientX-drag.sx, e.clientY-drag.sy) > THRESH) drag.moved = true;
  if (drag.moved && (drag.btn === 2 || drag.btn === 1 || (drag.btn===0 && drag.orbiting))) {
    orbit.theta -= dx*0.008; orbit.phi -= dy*0.008;
    orbit.phi = Math.max(orbit.minPhi, Math.min(orbit.maxPhi, orbit.phi));
    updateCamera();
    updateLightAzimuth(); // 光影仅随镜头左右(水平)旋转联动，不随上下俯仰变化
  }
  drag.lx = e.clientX; drag.ly = e.clientY;
});
window.addEventListener('pointerup', e => {
  if (!drag.active) return;
  drag.active = false;
  try { renderer.domElement.releasePointerCapture(e.pointerId); } catch(_){}
  // 是否算作一次"点击"：未明显拖拽（moved=false），或者虽有轻微位移但按下→松开很快
  // 且总位移在容忍范围内（快速连点时手常有微抖，避免被误判成拖拽而"没反应"）。
  const dt = (e.timeStamp || performance.now()) - drag.downT;
  const dist = Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy);
  const isClick = !drag.moved || (dt <= CLICK_MAX_MS && dist <= CLICK_MOVE_TOL);
  if (isClick && e.button === 0 && !drag.orbiting) {
    lastClientX = e.clientX; lastClientY = e.clientY;
    handleClick();
  }
  updateHover();
  refreshObjColorList();   // 一笔结束后同步「按颜色批量调整」的可选颜色
});

renderer.domElement.addEventListener('wheel', e => {
  e.preventDefault();
  orbit.radius += e.deltaY * 0.015;
  orbit.radius = Math.max(3, Math.min(70, orbit.radius));
  updateCamera();
}, { passive:false });

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* =========================================================
 * UI
 * ========================================================= */
const $ = id => document.getElementById(id);

document.querySelectorAll('[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => {
    editor.tool = btn.dataset.tool;
    document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b === btn));
    updateHover();
  });
});
document.querySelectorAll('[data-mode]').forEach(btn => {
  btn.addEventListener('click', () => {
    editor.mode = btn.dataset.mode;
    document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('active', b === btn));
    planeIndicator.visible = editor.mode === 'plane';
    syncPlaneIndicator();
    toast(editor.mode === 'plane' ? '平面层模式：在当前层成片绘制' : '贴面雕刻：在体素面上成片堆叠');
  });
});
document.querySelectorAll('[data-shape]').forEach(btn => {
  btn.addEventListener('click', () => {
    editor.shape = btn.dataset.shape;
    document.querySelectorAll('[data-shape]').forEach(b => b.classList.toggle('active', b === btn));
    updateHover();
  });
});
// 笔刷片朝向：自动 / 水平 / 竖直
document.querySelectorAll('[data-brushorient]').forEach(btn => {
  btn.addEventListener('click', () => {
    editor.brushOrient = btn.dataset.brushorient;
    document.querySelectorAll('[data-brushorient]').forEach(b => b.classList.toggle('active', b === btn));
    updateHover();
  });
});
document.querySelectorAll('[data-vshape]').forEach(btn => {
  btn.addEventListener('click', () => {
    editor.voxelShape = btn.dataset.vshape;
    document.querySelectorAll('[data-vshape]').forEach(b => b.classList.toggle('active', b === btn));
    refreshShapeParamsPanel();
    updateHover();
  });
});

/* ---------------- 参数化形状：参数输入面板 ---------------- */
// 每个形状的参数 <input> id 列表（顺序与 editor.shapeParams[shape] 对齐）
const SHAPE_PARAM_INPUTS = {
  cylinder:     [['sp-cyl-r','v-sp-cyl-r'], ['sp-cyl-h','v-sp-cyl-h']],
  halfcylinder: [['sp-hcyl-r','v-sp-hcyl-r'], ['sp-hcyl-h','v-sp-hcyl-h']],
  cone:         [['sp-cone-rt','v-sp-cone-rt'], ['sp-cone-rb','v-sp-cone-rb'], ['sp-cone-h','v-sp-cone-h']],
  pyramid:      [['sp-pyr-n','v-sp-pyr-n'], ['sp-pyr-r','v-sp-pyr-r'], ['sp-pyr-h','v-sp-pyr-h'], ['sp-pyr-off','v-sp-pyr-off']],
  torusp:       [['sp-tp-id','v-sp-tp-id'], ['sp-tp-od','v-sp-tp-od'], ['sp-tp-h','v-sp-tp-h']],
};
// 根据当前选中形状显示对应参数组（非参数化形状则整体隐藏），并把值同步到控件
function refreshShapeParamsPanel(){
  const panel = $('shape-params');
  if (!panel) return;
  const shape = editor.voxelShape;
  const isParam = isParamShape(shape);
  panel.style.display = isParam ? 'block' : 'none';
  document.querySelectorAll('#shape-params .sp-group').forEach(g => {
    g.style.display = (g.dataset.sp === shape) ? 'block' : 'none';
  });
  if (!isParam) return;
  const vals = editor.shapeParams[shape] || SHAPE_PARAM_DEFAULTS[shape].slice();
  (SHAPE_PARAM_INPUTS[shape] || []).forEach((ids, i) => {
    const r = $(ids[0]), n = $(ids[1]);
    if (r) r.value = vals[i];
    if (n) n.value = vals[i];
  });
}
// 绑定所有参数输入（滑块 + 数字框）到 editor.shapeParams
function bindShapeParamInputs(){
  Object.keys(SHAPE_PARAM_INPUTS).forEach(shape => {
    SHAPE_PARAM_INPUTS[shape].forEach((ids, i) => {
      const apply = (val) => {
        if (!isFinite(val)) return;
        if (!editor.shapeParams[shape]) editor.shapeParams[shape] = SHAPE_PARAM_DEFAULTS[shape].slice();
        editor.shapeParams[shape][i] = val;
        const r = $(ids[0]), n = $(ids[1]);
        if (r && document.activeElement !== r) r.value = val;
        if (n && document.activeElement !== n) n.value = val;
        updateHover();
        autoSave();
      };
      const r = $(ids[0]), n = $(ids[1]);
      if (r) r.addEventListener('input', e => apply(parseFloat(e.target.value)));
      if (n) n.addEventListener('input', e => apply(parseFloat(e.target.value)));
    });
  });
}
bindShapeParamInputs();
refreshShapeParamsPanel();
// 体素大小倍数：0.25×/0.5×/1×/1.5×/2×/3×，可与同物件内其它体素混合摆放
document.querySelectorAll('[data-vmult]').forEach(btn => {
  btn.addEventListener('click', () => {
    editor.voxelMult = parseFloat(btn.dataset.vmult) || 1;
    document.querySelectorAll('[data-vmult]').forEach(b => b.classList.toggle('active', b === btn));
    updateHover();
  });
});
document.querySelectorAll('[data-paintmode]').forEach(btn => {
  btn.addEventListener('click', () => {
    editor.paintFace = btn.dataset.paintmode === 'face';
    document.querySelectorAll('[data-paintmode]').forEach(b => b.classList.toggle('active', b === btn));
    // 切到上色工具，方便立即使用
    if (editor.tool !== 'paint') { const pb = document.querySelector('[data-tool="paint"]'); if (pb) pb.click(); }
    updateHover();
  });
});

function syncPlaneIndicator(){
  const obj = getActiveObj();
  const baseY = obj ? obj.pos.y : 0;
  const s = vsizeOf(obj);
  planeIndicator.position.y = baseY + editor.planeY*s + 0.001;
}

/* 体素自定义颜色 */
function setVoxelColor(hex, opts){
  const n = normHex(hex);
  if (!n) return;
  editor.voxelColor = n;
  const ci = $('voxel-color'); if (ci) ci.value = n;   // 隐藏原生输入仅作状态载体
  const hx = $('voxel-hex'); if (hx) hx.value = n;
  const sw = $('voxel-swatch'); if (sw) sw.style.background = n;   // 更新可见色块
  renderRecent();
  // 若取色面板打开，且不是面板自身触发的变更，则同步面板上的滑块/预览
  if (!(opts && opts.fromPicker) && typeof syncColorPicker === 'function') syncColorPicker(n);
}
function setVoxelAlpha(a){
  const v = typeof a === 'number' ? Math.max(0, Math.min(1, a)) : parseFloat(a);
  if (!isFinite(v)) return;
  editor.voxelAlpha = v;
  $('voxel-alpha').value = v;
  $('v-valpha').textContent = v.toFixed(2);
}
function pushRecent(hex){
  const n = normHex(hex); if (!n) return;
  editor.recent = [n, ...editor.recent.filter(c => c !== n)].slice(0, 8);
  renderRecent();
}
function renderRecent(){
  const box = $('recent-colors'); box.innerHTML = '';
  editor.recent.forEach(hex => {
    const chip = document.createElement('div');
    chip.className = 'chip' + (hex === editor.voxelColor ? ' active' : '');
    chip.style.background = hex; chip.title = hex;
    chip.addEventListener('click', () => setVoxelColor(hex));
    box.appendChild(chip);
  });
}
$('voxel-hex').addEventListener('change', e => setVoxelColor(e.target.value));
$('voxel-alpha').addEventListener('input', e => setVoxelAlpha(parseFloat(e.target.value)));

/* ---------------- 自绘 HSV 取色面板（替代系统取色器，杜绝崩溃） ----------------
 * 点击色块打开面板：SV 方块（饱和度×明度）+ 色相条 + 预览 + hex 输入。全程纯 DOM，
 * 不调用系统取色对话框、不占用额外 GPU，因此不会再触发浏览器崩溃。
 */
function hsvToRgb(h, s, v){
  h = ((h % 360) + 360) % 360; s = Math.max(0,Math.min(1,s)); v = Math.max(0,Math.min(1,v));
  const c = v*s, x = c*(1-Math.abs(((h/60)%2)-1)), m = v-c;
  let r=0,g=0,b=0;
  if (h<60){ r=c; g=x; } else if (h<120){ r=x; g=c; } else if (h<180){ g=c; b=x; }
  else if (h<240){ g=x; b=c; } else if (h<300){ r=x; b=c; } else { r=c; b=x; }
  return [Math.round((r+m)*255), Math.round((g+m)*255), Math.round((b+m)*255)];
}
function rgbToHsv(r, g, b){
  r/=255; g/=255; b/=255;
  const mx=Math.max(r,g,b), mn=Math.min(r,g,b), d=mx-mn;
  let h=0; if (d){ if (mx===r) h=((g-b)/d)%6; else if (mx===g) h=(b-r)/d+2; else h=(r-g)/d+4; h*=60; if (h<0) h+=360; }
  const s = mx ? d/mx : 0;
  return [h, s, mx];
}
const CP = { h:45, s:1, v:1, open:false };
function cpHexFromState(){ const [r,g,b]=hsvToRgb(CP.h,CP.s,CP.v); return rgbToHex([r,g,b]); }
function cpRender(){
  const sv=$('cp-sv'), thumb=$('cp-sv-thumb'), hue=$('cp-hue'), prev=$('cp-preview'), hx=$('cp-hex');
  if (!sv) return;
  const pure = rgbToHex(hsvToRgb(CP.h,1,1));
  // SV 方块底色随色相变化（白→纯色 叠加 透明→黑）
  sv.style.background = `linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,transparent),${pure}`;
  const w = sv.clientWidth||180, hgt = sv.clientHeight||120;
  thumb.style.left = (CP.s*w)+'px';
  thumb.style.top  = ((1-CP.v)*hgt)+'px';
  const hex = cpHexFromState();
  thumb.style.background = hex;
  if (hue) hue.value = Math.round(CP.h);
  if (prev) prev.style.background = hex;
  if (hx && document.activeElement !== hx) hx.value = hex;
}
// 外部颜色变化时，把 hex 同步到面板状态（供 setVoxelColor 调用）
function syncColorPicker(hex){
  const rgb = hexToRgb(hex); const [h,s,v] = rgbToHsv(rgb[0],rgb[1],rgb[2]);
  CP.h = h; CP.s = s; CP.v = v;
  if (CP.open) cpRender();
}
function cpCommit(){ setVoxelColor(cpHexFromState(), { fromPicker:true }); const prev=$('cp-preview'); if(prev) prev.style.background=cpHexFromState(); const hx=$('cp-hex'); if(hx && document.activeElement!==hx) hx.value=cpHexFromState(); }
function openColorPopover(){
  const pop=$('color-popover'); if(!pop) return;
  syncColorPicker(editor.voxelColor);
  pop.classList.add('open'); CP.open=true; cpRender();
}
function closeColorPopover(){ const pop=$('color-popover'); if(pop){ pop.classList.remove('open'); CP.open=false; } }
(function setupColorPicker(){
  const swatch=$('voxel-swatch'), sv=$('cp-sv'), hue=$('cp-hue'), hx=$('cp-hex');
  if (!swatch || !sv) return;
  swatch.style.background = editor.voxelColor;
  swatch.addEventListener('click', e => { e.stopPropagation(); CP.open ? closeColorPopover() : openColorPopover(); });
  // 点击面板外部关闭
  document.addEventListener('click', e => { const pop=$('color-popover'); if (CP.open && pop && !pop.contains(e.target) && e.target!==swatch) closeColorPopover(); });
  if ($('color-popover')) $('color-popover').addEventListener('click', e => e.stopPropagation());
  // SV 方块拖拽
  let svDrag=false;
  const svPick = e => {
    const r = sv.getBoundingClientRect();
    const cx = (e.touches?e.touches[0].clientX:e.clientX);
    const cy = (e.touches?e.touches[0].clientY:e.clientY);
    CP.s = Math.max(0, Math.min(1, (cx-r.left)/r.width));
    CP.v = Math.max(0, Math.min(1, 1-(cy-r.top)/r.height));
    cpRender(); cpCommit();
  };
  sv.addEventListener('pointerdown', e => { svDrag=true; sv.setPointerCapture(e.pointerId); svPick(e); });
  sv.addEventListener('pointermove', e => { if (svDrag) svPick(e); });
  sv.addEventListener('pointerup', () => { svDrag=false; });
  // 色相条
  if (hue) hue.addEventListener('input', e => { CP.h = parseFloat(e.target.value)||0; cpRender(); cpCommit(); });
  // 面板内 hex 输入
  if (hx) hx.addEventListener('change', e => { const n=normHex(e.target.value); if(n){ syncColorPicker(n); cpRender(); setVoxelColor(n, {fromPicker:true}); } });
})();

/* 按颜色批量调整（透明度 + 加减色度） */
if ($('bulk-alpha')) $('bulk-alpha').addEventListener('input', e => {
  const v = parseFloat(e.target.value);
  if ($('v-bulkalpha')) $('v-bulkalpha').textContent = isFinite(v) ? v.toFixed(2) : '1.00';
  applyBulkAlpha(v);
});
if ($('btn-shade-dark')) $('btn-shade-dark').addEventListener('click', () => applyBulkShade(-16));
if ($('btn-shade-light')) $('btn-shade-light').addEventListener('click', () => applyBulkShade(16));

/* 8 色螺丝面板 */
function buildScrewPalette(){
  const c = $('screw-palette'); c.innerHTML = '';
  SCREW_COLORS.forEach(col => {
    const s = document.createElement('div');
    s.className = 'swatch' + (col.name === editor.screwColor ? ' active' : '');
    s.style.background = col.css; s.title = col.name;
    s.addEventListener('click', () => { editor.screwColor = col.name; buildScrewPalette(); });
    c.appendChild(s);
  });
}

/* 笔刷 */
$('brush-size').addEventListener('input', e => { editor.brush = parseInt(e.target.value); $('v-brush').textContent = editor.brush; updateHover(); });

/* 体素尺寸（小体素核心） */
$('voxel-size').addEventListener('input', e => {
  const v = parseFloat(e.target.value);
  $('v-vsize').textContent = v.toFixed(2);
  const o = getActiveObj();
  if (o) {
    o.voxelSize = v;
    rebuildObject(o);     // 体素 + 螺丝按新尺寸重建
    // 螺丝大小全场统一跟随「主物件(objects[0])」体素大小：若改的正是主物件，
    // 其它物件的螺丝也要按新的统一大小重建，保证编辑器所见即所得。
    if (level.objects[0] && o.id === level.objects[0].id){
      level.objects.forEach(ob => { if (ob.id !== o.id) rebuildScrewMeshes(ob); });
    }
    syncPlaneIndicator();
    autoSave();
  }
});

/* ---------------- 按颜色批量调整（当前物件） ----------------
 * 选中一种颜色后，可一键对当前物件中「所有该颜色的体素」批量：
 *   · 调整透明度（0~1）
 *   · 加 / 减色度（整体提亮 / 变暗）
 */
let bulkSelColor = null;        // 当前选中的批量目标色（hex 字符串）

// 统计当前物件里出现的不同颜色及其体素数量：Map<hex, count>
function objDistinctColors(obj){
  const map = new Map();
  if (!obj) return map;
  for (const k in obj.voxels){
    const hex = decodeVoxel(obj.voxels[k]).hex;
    if (typeof hex !== 'string') continue;
    map.set(hex, (map.get(hex) || 0) + 1);
  }
  return map;
}

// 重建「按颜色批量调整」里的色块列表
function refreshObjColorList(){
  const box = $('obj-color-list'); if (!box) return;
  box.innerHTML = '';
  const obj = getActiveObj();
  const map = objDistinctColors(obj);
  // 选中的颜色若已不存在（被改色/删除）则清空选中
  if (bulkSelColor && !map.has(bulkSelColor)) bulkSelColor = null;
  if (!map.size){
    box.innerHTML = '<span class="hint">当前物件暂无体素</span>';
    syncBulkAlphaSlider();
    return;
  }
  [...map.entries()].sort((a,b)=>b[1]-a[1]).forEach(([hex,cnt])=>{
    const chip = document.createElement('div');
    chip.className = 'chip' + (hex === bulkSelColor ? ' active' : '');
    chip.style.background = hex;
    chip.title = `${hex} · ${cnt} 个体素`;
    chip.addEventListener('click', ()=>{ bulkSelColor = hex; syncBulkAlphaSlider(); refreshObjColorList(); });
    box.appendChild(chip);
  });
  syncBulkAlphaSlider();
}

// 让批量透明度滑块显示所选颜色当前的透明度（取该颜色首个体素的 alpha）
function syncBulkAlphaSlider(){
  const slider = $('bulk-alpha'); if (!slider) return;
  const lbl = $('v-bulkalpha');
  const obj = getActiveObj();
  let a = 1;
  if (obj && bulkSelColor){
    for (const k in obj.voxels){
      const dec = decodeVoxel(obj.voxels[k]);
      if (dec.hex === bulkSelColor){ a = dec.alpha; break; }
    }
  }
  slider.value = a;
  if (lbl) lbl.textContent = a.toFixed(2);
}

// 对当前物件中所有「bulkSelColor 颜色」的体素设置透明度
function applyBulkAlpha(a){
  const obj = getActiveObj();
  if (!obj || !bulkSelColor) return;   // 未选颜色时静默忽略（拖动滑块不刷屏提示）
  const v = Math.max(0, Math.min(1, a));
  let n = 0;
  for (const k in obj.voxels){
    const dec = decodeVoxel(obj.voxels[k]);
    if (dec.hex !== bulkSelColor) continue;
    obj.voxels[k] = encodeVoxel(dec.hex, dec.shape, dec.dir, dec.faces, dec.mult, v, dec.params);
    n++;
  }
  if (n){ rebuildObject(obj); refreshStats(); autoSave(); }
}

// 对当前物件中所有「bulkSelColor 颜色」的体素整体加/减色度（amt 为各通道加减值）
function applyBulkShade(amt){
  const obj = getActiveObj();
  if (!obj || !bulkSelColor){ toast('请先点上方色块选择一种颜色'); return; }
  const newHex = normHex(shadeHex(bulkSelColor, amt));
  if (!newHex) return;
  if (newHex === bulkSelColor){ toast(amt>0 ? '已到最亮' : '已到最暗'); return; }
  let n = 0;
  for (const k in obj.voxels){
    const dec = decodeVoxel(obj.voxels[k]);
    if (dec.hex !== bulkSelColor) continue;
    obj.voxels[k] = encodeVoxel(newHex, dec.shape, dec.dir, dec.faces, dec.mult, dec.alpha, dec.params);
    n++;
  }
  if (n){
    bulkSelColor = newHex;
    rebuildObject(obj);
    refreshObjColorList();
    autoSave();
    toast(`${amt>0?'加':'减'}色度 · ${n} 个体素`);
  }
}

/* 通用确认弹窗（替代原生 confirm）：返回 Promise<boolean>。
   原生 confirm/alert 在部分内置预览浏览器 / 沙箱 iframe 中会被禁用并直接返回 false，
   导致"点删除没反应"。这里用自绘浮层，任何环境都能正常弹出与响应。 */
function confirmDialog(message, opts){
  opts = opts || {};
  return new Promise(resolve => {
    const old = document.getElementById('confirm-dialog'); if (old) old.remove();
    const mask = document.createElement('div');
    mask.id = 'confirm-dialog';
    mask.style.cssText = 'position:absolute;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;background:rgba(8,10,20,.6);backdrop-filter:blur(3px);';
    const box = document.createElement('div');
    box.className = 'panel';
    box.style.cssText = 'width:min(90vw,340px);padding:18px;';
    const msg = document.createElement('div');
    msg.style.cssText = 'font-size:14px;color:#e6ebff;line-height:1.6;margin-bottom:16px;white-space:pre-wrap;';
    msg.textContent = message;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';
    const cancel = document.createElement('button');
    cancel.className = 'tool';
    cancel.textContent = opts.cancelText || '取消';
    const ok = document.createElement('button');
    ok.className = 'tool ' + (opts.danger === false ? '' : 'warn');
    ok.textContent = opts.okText || '删除';
    const close = (val) => { mask.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
    cancel.addEventListener('click', () => close(false));
    ok.addEventListener('click', () => close(true));
    mask.addEventListener('click', e => { if (e.target === mask) close(false); });
    const onKey = e => { if (e.key === 'Escape') close(false); else if (e.key === 'Enter') close(true); };
    document.addEventListener('keydown', onKey);
    row.append(cancel, ok);
    box.append(msg, row);
    mask.appendChild(box);
    document.body.appendChild(mask);
    ok.focus();
  });
}

/* 绑定选择浮层：勾选多个物件绑成一组（支持多组）。打开时预勾选「当前选中物件」所在组的成员。 */
function openBindPicker(){
  const objs = level.objects.slice();
  if (objs.length < 2){ toast('至少需要两个物件才能绑定'); return; }

  // 移除可能残留的旧浮层
  const old = document.getElementById('bind-picker'); if (old) old.remove();

  const active = getActiveObj();
  // 预勾选：当前选中物件所在组的成员；若当前物件未绑定，则默认勾选它自己
  const preset = new Set();
  if (active){
    if (active.groupId) level.objects.forEach(o => { if (o.groupId === active.groupId) preset.add(o.id); });
    else preset.add(active.id);
  }

  const mask = document.createElement('div');
  mask.id = 'bind-picker';
  mask.style.cssText = 'position:absolute;inset:0;z-index:70;display:flex;align-items:center;justify-content:center;background:rgba(8,10,20,.6);backdrop-filter:blur(3px);';
  const box = document.createElement('div');
  box.className = 'panel';
  box.style.cssText = 'width:min(90vw,380px);max-height:74vh;overflow-y:auto;padding:18px;';

  // 标题行：标题 + 右上角「全选 / 全部取消」
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px;';
  const title = document.createElement('h2');
  title.style.cssText = 'font-size:16px;color:#fff;margin:0;';
  title.textContent = '绑定物件（整组一起掉落）';
  const selAll = document.createElement('button');
  selAll.className = 'tool';
  selAll.style.cssText = 'flex:0 0 auto;padding:4px 10px;font-size:12px;';
  header.append(title, selAll);
  const sub = document.createElement('div');
  sub.style.cssText = 'font-size:12px;color:#8e9ac4;margin-bottom:14px;line-height:1.6;';
  sub.innerHTML = `勾选要<b style="color:#ffe477;">绑成一组</b>的物件（至少 2 个）。绑定后各物件的体素与位置都不变，` +
                  `只有当<b style="color:#9fd0ff;">同组所有物件身上的螺丝全部被取走</b>时，整组才会一起掉落。`;
  box.append(header, sub);

  // 给每个组分配一个显示序号，便于在行尾标注「组N」
  const groupIndex = {}; let gi = 0;
  level.objects.forEach(o => { if (o.groupId && !(o.groupId in groupIndex)) groupIndex[o.groupId] = ++gi; });

  const checks = new Map();
  const selectedIds = () => objs.filter(o => checks.get(o.id).checked).map(o => o.id);
  const allChecked = () => objs.every(o => checks.get(o.id).checked);
  const syncSelAll = () => { selAll.textContent = allChecked() ? '全部取消' : '全选'; };

  objs.forEach(o => {
    const row = document.createElement('label');
    row.className = 'tool';
    row.style.cssText = 'width:100%;display:flex;align-items:center;gap:10px;justify-content:flex-start;margin-bottom:8px;cursor:pointer;';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = preset.has(o.id);
    cb.style.cssText = 'width:16px;height:16px;flex:0 0 auto;accent-color:#7a4fff;';
    cb.addEventListener('change', syncSelAll);
    checks.set(o.id, cb);
    const sw = document.createElement('span');
    sw.className = 'obj-swatch';
    sw.style.background = '#' + voxelValueToHexInt(o.colorName).toString(16).padStart(6,'0');
    const nm = document.createElement('span');
    nm.style.cssText = 'flex:1;text-align:left;';
    nm.textContent = o.name;
    const tag = document.createElement('span');
    tag.style.cssText = 'font-size:12px;';
    tag.innerHTML = o.groupId ? `<span style="color:#c7b3ff;">组${groupIndex[o.groupId]}</span>`
                              : `<span style="color:#8e9ac4;">${(o.screws||[]).length} 螺丝</span>`;
    row.append(cb, sw, nm, tag);
    box.appendChild(row);
  });
  syncSelAll();

  selAll.addEventListener('click', () => {
    const target = !allChecked();
    objs.forEach(o => { checks.get(o.id).checked = target; });
    syncSelAll();
  });

  // 底部：绑定 / 取消绑定
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;margin-top:6px;';
  const bindBtn = document.createElement('button');
  bindBtn.className = 'btn-primary';
  bindBtn.style.cssText = 'flex:1;';
  bindBtn.textContent = '绑定';
  bindBtn.addEventListener('click', () => { if (bindObjectsMulti(selectedIds())) mask.remove(); });
  const unbindBtn = document.createElement('button');
  unbindBtn.className = 'btn-secondary';
  unbindBtn.style.cssText = 'flex:1;';
  unbindBtn.textContent = '取消绑定';
  unbindBtn.addEventListener('click', () => { if (unbindGroupsByIds(selectedIds())) mask.remove(); });
  btnRow.append(bindBtn, unbindBtn);
  box.appendChild(btnRow);

  mask.appendChild(box);
  mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });
  document.getElementById('app').appendChild(mask);
}

/* 物件列表 */
function refreshObjList(){
  const list = $('obj-list'); list.innerHTML = '';
  // 给每个绑定组分配一个从 1 开始的显示序号（仅用于列表徽标）
  const groupIndex = {};
  let gi = 0;
  level.objects.forEach(o => { if (o.groupId && !(o.groupId in groupIndex)) groupIndex[o.groupId] = ++gi; });
  level.objects.forEach(obj => {
    const item = document.createElement('div');
    item.className = 'obj-item' + (obj.id === activeObjId ? ' active' : '') + (obj.hidden ? ' hidden' : '');
    const sw = document.createElement('div'); sw.className = 'obj-swatch';
    sw.style.background = '#' + voxelValueToHexInt(obj.colorName).toString(16).padStart(6,'0');
    const name = document.createElement('div'); name.className='obj-name'; name.textContent = obj.name;
    name.title = '双击可重命名';
    // 双击名称 → 就地重命名
    name.addEventListener('dblclick', e => {
      e.stopPropagation();
      const inp = document.createElement('input');
      inp.type = 'text'; inp.value = obj.name; inp.className = 'obj-name';
      inp.style.cssText = 'flex:1;min-width:0;font-size:13px;padding:2px 4px;border-radius:6px;border:1px solid #43b9ff;background:rgba(0,0,0,.35);color:#fff;';
      const commit = () => {
        const v = inp.value.trim();
        if (v) { obj.name = v; }
        refreshObjList(); refreshRightPanel(); autoSave();
      };
      inp.addEventListener('keydown', ev => { if (ev.key==='Enter'){ ev.preventDefault(); commit(); } else if (ev.key==='Escape'){ refreshObjList(); } });
      inp.addEventListener('blur', commit);
      inp.addEventListener('click', ev => ev.stopPropagation());
      name.replaceWith(inp); inp.focus(); inp.select();
    });
    const cnt = document.createElement('div'); cnt.className='obj-count';
    cnt.textContent = obj.groupId ? `L${obj.layer} · 组${groupIndex[obj.groupId]}` : `L${obj.layer}`;
    if (obj.groupId) cnt.title = '已绑定为第 ' + groupIndex[obj.groupId] + ' 组（整组螺丝取光后一起掉落）';
    const eye = document.createElement('div'); eye.className='obj-op'; eye.textContent = obj.hidden ? '🚫' : '👁'; eye.title = obj.hidden ? '点击显示该物件' : '点击隐藏该物件';
    eye.addEventListener('click', e => { e.stopPropagation(); toggleObjHidden(obj.id); });
    const dup = document.createElement('div'); dup.className='obj-del'; dup.textContent='⧉'; dup.title='复制物件';
    dup.addEventListener('click', e => { e.stopPropagation(); duplicateObject(obj.id); });
    const del = document.createElement('div'); del.className='obj-del'; del.textContent='✕'; del.title='删除物件';
    del.addEventListener('click', async e => { e.stopPropagation(); if (await confirmDialog(`删除「${obj.name}」？`)) deleteObject(obj.id); });
    item.append(sw, name, cnt, eye, dup, del);
    item.addEventListener('click', () => { activeObjId = obj.id; refreshObjList(); refreshRightPanel(); syncPlaneIndicator(); });
    list.appendChild(item);
  });
  refreshStats();
}

function refreshRightPanel(){
  const obj = getActiveObj();
  const nameInput = $('obj-name-input');
  $('v-brush').textContent = editor.brush;
  $('brush-size').value = editor.brush;
  refreshObjColorList();
  if (!obj) { nameInput.value=''; return; }
  nameInput.value = obj.name;
  $('voxel-size').value = vsizeOf(obj); $('v-vsize').textContent = vsizeOf(obj).toFixed(2);
  $('pos-x').value = obj.pos.x; $('v-px').value = obj.pos.x;
  $('pos-y').value = obj.pos.y; $('v-py').value = obj.pos.y;
  $('pos-z').value = obj.pos.z; $('v-pz').value = obj.pos.z;
  $('rot-x').value = obj.rotX || 0; $('v-rx').value = obj.rotX || 0;
  $('rot-y').value = obj.rotY || 0; $('v-ry').value = obj.rotY || 0;
  $('rot-z').value = obj.rotZ || 0; $('v-rz').value = obj.rotZ || 0;
  const sc = scaleOf(obj);
  $('scale-x').value = sc.x; $('v-sx').textContent = sc.x.toFixed(2);
  $('scale-y').value = sc.y; $('v-sy').textContent = sc.y.toFixed(2);
  $('scale-z').value = sc.z; $('v-sz').textContent = sc.z.toFixed(2);
  $('layer').value = obj.layer; $('v-layer').textContent = obj.layer;
}

$('obj-name-input').addEventListener('input', e => { const o = getActiveObj(); if (o){ o.name = e.target.value; refreshObjList(); autoSave(); } });
['x','y','z'].forEach(ax => {
  // 滑块拖动：更新位置并同步数字框
  $('pos-'+ax).addEventListener('input', e => {
    const o = getActiveObj(); if (!o) return;
    const snap = o.groupId ? snapshotObjXform(o) : null;
    o.pos[ax] = parseFloat(e.target.value);
    $('v-p'+ax).value = o.pos[ax];
    applyObjTransform(o); applyGroupCoTransform(o, snap); syncPlaneIndicator(); autoSave();
  });
  // 数字框手动输入：精确任意值（不受滑块步进限制），同步滑块显示
  $('v-p'+ax).addEventListener('input', e => {
    const o = getActiveObj(); if (!o) return;
    const v = parseFloat(e.target.value);
    if (!isFinite(v)) return;                 // 允许中间态（如空串/负号）时不改动
    const snap = o.groupId ? snapshotObjXform(o) : null;
    o.pos[ax] = v;
    $('pos-'+ax).value = v;                    // 同步滑块（超范围时滑块自动 clamp，不影响实际值）
    applyObjTransform(o); applyGroupCoTransform(o, snap); syncPlaneIndicator(); autoSave();
  });
});
// 三轴旋转（绕物件中心），axis 为 'x' | 'y' | 'z'
function applyRot(axis, v){
  const o = getActiveObj(); if (!o) return;
  if (!isFinite(v)) return;
  const snap = o.groupId ? snapshotObjXform(o) : null;
  o['rot' + axis.toUpperCase()] = v;
  $('rot-' + axis).value = v; $('v-r' + axis).value = v;
  applyObjTransform(o); applyGroupCoTransform(o, snap); autoSave();
}
['x','y','z'].forEach(ax => {
  $('rot-' + ax).addEventListener('input', e => applyRot(ax, parseFloat(e.target.value)));
  $('v-r' + ax).addEventListener('input', e => applyRot(ax, parseFloat(e.target.value)));
});
$('btn-rot-reset').addEventListener('click', () => {
  const o = getActiveObj(); if (!o) return;
  const snap = o.groupId ? snapshotObjXform(o) : null;
  o.rotX = 0; o.rotY = 0; o.rotZ = 0;
  ['x','y','z'].forEach(ax => { $('rot-' + ax).value = 0; $('v-r' + ax).value = 0; });
  applyObjTransform(o); applyGroupCoTransform(o, snap); autoSave();
  toast('旋转已重置');
});

/* ---------------- 人形模特：位置 / 旋转 / 缩放 / 显隐 控制 ---------------- */
// 把 mannequinXform 的值同步回控件显示
function syncMannequinControls(){
  const t = mannequinXform;
  const setv = (rangeId, numId, val, fixed) => {
    const r = $(rangeId), n = $(numId);
    if (r) r.value = val;
    if (n) n.value = (fixed != null ? Number(val).toFixed(fixed) : val);
  };
  setv('mann-x', 'v-mann-x', t.x, 2);
  setv('mann-y', 'v-mann-y', t.y, 2);
  setv('mann-z', 'v-mann-z', t.z, 2);
  setv('mann-rot', 'v-mann-rot', t.rotY, 0);
  setv('mann-scale', 'v-mann-scale', t.scale, 2);
  const tg = $('btn-mann-toggle');
  if (tg){
    tg.textContent = t.visible !== false ? '👤 模特：显示' : '🚫 模特：隐藏';
    tg.classList.toggle('active', t.visible !== false);
  }
}
// 通用：绑定「滑块 + 数字框」双向联动到 mannequinXform 的某个字段
function bindMannPair(rangeId, numId, field, fixed){
  const apply = (v) => {
    if (!isFinite(v)) return;
    mannequinXform[field] = v;
    const r = $(rangeId), n = $(numId);
    if (r) r.value = v;
    if (n && document.activeElement !== n) n.value = (fixed != null ? v.toFixed(fixed) : v);
    applyMannequinXform();
    autoSave();
  };
  const r = $(rangeId), n = $(numId);
  if (r) r.addEventListener('input', e => apply(parseFloat(e.target.value)));
  if (n) n.addEventListener('input', e => apply(parseFloat(e.target.value)));
}
bindMannPair('mann-x', 'v-mann-x', 'x', 2);
bindMannPair('mann-y', 'v-mann-y', 'y', 2);
bindMannPair('mann-z', 'v-mann-z', 'z', 2);
bindMannPair('mann-rot', 'v-mann-rot', 'rotY', 0);
bindMannPair('mann-scale', 'v-mann-scale', 'scale', 2);
if ($('btn-mann-toggle')) $('btn-mann-toggle').addEventListener('click', () => {
  mannequinXform.visible = !(mannequinXform.visible !== false);
  applyMannequinXform(); syncMannequinControls(); autoSave();
});
if ($('btn-mann-reset')) $('btn-mann-reset').addEventListener('click', () => {
  mannequinXform.x = 0; mannequinXform.y = 0; mannequinXform.z = 0;
  mannequinXform.rotY = 0; mannequinXform.scale = 1; mannequinXform.visible = true;
  applyMannequinXform(); syncMannequinControls(); autoSave();
  toast('已重置模特位置与缩放');
});


// 整体缩放（X/Y/Z）——围绕物体中心缩放整个物件（含螺丝）
let scaleUniform = false;
['x','y','z'].forEach(ax => {
  $('scale-'+ax).addEventListener('input', e => {
    const o = getActiveObj(); if (!o) return;
    // 绑定组（未覆盖全部物件）内禁止缩放：中间浮现提示，并把滑块显示恢复为真实值
    if (scaleBlockedFor(o)){ centerFlash('当前状态下不可缩放'); refreshRightPanel(); return; }
    if (!o.scale) o.scale = { x:1, y:1, z:1 };
    const snap = o.groupId ? snapshotObjXform(o) : null;
    const v = parseFloat(e.target.value);
    if (scaleUniform){
      o.scale.x = o.scale.y = o.scale.z = v;
      ['x','y','z'].forEach(a => { $('scale-'+a).value = v; $('v-s'+a).textContent = v.toFixed(2); });
    } else {
      o.scale[ax] = v; $('v-s'+ax).textContent = v.toFixed(2);
    }
    applyObjTransform(o); applyGroupCoTransform(o, snap); autoSave();
  });
});
$('btn-scale-uniform').addEventListener('click', () => {
  scaleUniform = !scaleUniform;
  $('btn-scale-uniform').classList.toggle('active', scaleUniform);
  toast(scaleUniform ? '已锁定三轴：拖任一滑块整体等比缩放' : '已解锁：可分别缩放各轴');
});
$('btn-scale-reset').addEventListener('click', () => {
  const o = getActiveObj(); if (!o) return;
  if (scaleBlockedFor(o)){ centerFlash('当前状态下不可缩放'); return; }
  const snap = o.groupId ? snapshotObjXform(o) : null;
  o.scale = { x:1, y:1, z:1 };
  ['x','y','z'].forEach(a => { $('scale-'+a).value = 1; $('v-s'+a).textContent = '1.00'; });
  applyObjTransform(o); applyGroupCoTransform(o, snap); autoSave();
});
$('layer').addEventListener('input', e => {
  const o = getActiveObj(); if (!o) return;
  o.layer = parseInt(e.target.value); $('v-layer').textContent = o.layer;
  invalidateSolution();
  refreshObjList(); autoSave();
});

$('btn-add-obj').addEventListener('click', () => { createObject({ colorName: editor.voxelColor, voxelSize: getActiveObj() ? vsizeOf(getActiveObj()) : DEFAULT_VOXEL_SIZE }); autoSave(); });
if ($('btn-bind-obj')) $('btn-bind-obj').addEventListener('click', () => openBindPicker());
if ($('btn-dup-obj')) $('btn-dup-obj').addEventListener('click', () => { const o = getActiveObj(); if (o) duplicateObject(o.id); else toast('请先选择一个物件'); });
if ($('btn-clear-objs')) $('btn-clear-objs').addEventListener('click', deleteAllObjects);
$('btn-auto-screw').addEventListener('click', () => { const o = getActiveObj(); if (o){ autoGenScrews(o); toast(`已按表面智能布点 ${o.screws.length} 颗螺丝`); } });
if ($('btn-auto-screw-all')) $('btn-auto-screw-all').addEventListener('click', () => { autoGenScrewsAll(editor.screwCount, editor.screwColorCount, true); });
if ($('btn-rand-screw-color')) $('btn-rand-screw-color').addEventListener('click', () => { randomizeScrewColorsAll(editor.screwColorCount); });
$('btn-clear-screw').addEventListener('click', () => {
  // 清空场景中所有物件的螺丝
  level.objects.forEach(o => { o.screws = []; clearScrewMeshes(o); });
  invalidateSolution();
  refreshStats(); autoSave(); toast('已清空全部螺丝');
});
if ($('screw-count')) $('screw-count').addEventListener('input', e => {
  let v = parseInt(e.target.value); v = Math.max(3, Math.round(v/3)*3);
  editor.screwCount = v; $('v-screw-count').textContent = v;
});
if ($('screw-colorcount')) $('screw-colorcount').addEventListener('input', e => {
  const v = parseInt(e.target.value); editor.screwColorCount = v; $('v-screw-colorcount').textContent = v;
});
// 螺丝布局方式：手动 / 自动。选择后写入 level.screwMode 并刷新按钮高亮。
function refreshScrewModeButtons(){
  const m = level && level.screwMode;
  const b1 = $('sm-manual'), b2 = $('sm-auto');
  if (b1) b1.classList.toggle('active', m === 'manual');
  if (b2) b2.classList.toggle('active', m === 'auto');
}
if ($('sm-manual')) $('sm-manual').addEventListener('click', () => {
  level.screwMode = 'manual';
  invalidateSolution();   // 手动模式不需要固化解，清掉避免残留干扰
  refreshScrewModeButtons(); autoSave();
  toast('已选：手动布置（试玩颜色与编辑器完全一致）');
});
if ($('sm-auto')) $('sm-auto').addEventListener('click', () => {
  level.screwMode = 'auto';
  refreshScrewModeButtons(); autoSave();
  toast('已选：自动布置（进场自动配色，保留原玩法）');
});

function refreshStats(){
  let vox = 0, screw = 0;
  level.objects.forEach(o => {
    if (!Number.isFinite(o._voxelCount)) o._voxelCount = Object.keys(o.voxels).length;
    vox += o._voxelCount;
    screw += o.screws.length;
  });

  $('stat-vox').textContent = vox;
  $('stat-screw').textContent = screw;
  $('stat-obj').textContent = level.objects.length;
}

/* =========================================================
 * 保存 / 加载 / 导出 / 导入
 * ========================================================= */
// 旧数据兼容：把 {key, face} 形式的螺丝转成 {pos, normal, scale}
function migrateScrews(obj){
  const s = vsizeOf(obj);
  obj.screws = (obj.screws || []).map(sc => {
    if (sc.pos && sc.normal) return { pos: sc.pos, normal: sc.normal, color: sc.color, scale: sc.scale || 0.5 };
    // 旧格式 {key, face}
    if (sc.key && sc.face) {
      const [x,y,z] = parseKey(sc.key);
      // 按体素真实尺寸(mult)定位面中心，避免小体素上的旧螺丝迁移后穿模/悬空
      const mult = (obj.voxels && obj.voxels[sc.key] != null) ? (decodeVoxel(obj.voxels[sc.key]).mult || 1) : 1;
      const half = mult * s / 2;
      const center = new THREE.Vector3(
        (x + mult/2)*s + sc.face[0]*half,
        (y + mult/2)*s + sc.face[1]*half,
        (z + mult/2)*s + sc.face[2]*half
      );
      return { pos:[center.x, center.y, center.z], normal:[...sc.face], color: sc.color, scale: 0.5 };
    }
    return null;
  }).filter(Boolean);
}

// 序列化时剥离运行时字段（如占用表 _occ）——它体积很大且载入时会自动重建，
// 保留会成倍膨胀存档体积，容易触发 localStorage 配额上限导致保存失败。
function serializableObjects(){
  return (level.objects || []).map(o => {
    const { _occ, _occCompact, _voxelCount, ...rest } = o;
    return rest;

  });
}
function serialize(){ return JSON.stringify({ name: level.name, nextId, screwSize: screwSizeMul(), screwColorCount: editor.screwColorCount, screwMode: level.screwMode || null, solution: level.solution || null, mannequin: { ...mannequinXform }, objects: serializableObjects() }); }

// 是否为"存储空间不足"错误（各浏览器 name/code 不一）
function isQuotaError(e){
  return !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
}
// 写入 localStorage：成功返回 true；失败返回 false。配额不足时先清理可牺牲的键再重试。
function safeStore(key, value){
  try { localStorage.setItem(key, value); return true; }
  catch(e){
    if (!isQuotaError(e)) { console.error('[save] localStorage 写入失败：', e); return false; }
    // 配额不足：优先丢弃"旧入口试玩副本"这类可再生的冗余键，再重试
    try { if (key !== CUSTOM_LEVEL_KEY) localStorage.removeItem(CUSTOM_LEVEL_KEY); } catch(_){}
    try { localStorage.setItem(key, value); return true; } catch(_){}
    // 仍不足：连自动存档一起清（自动存档可从已保存关卡再生），最后一次重试
    try { if (key !== STORAGE_KEY) localStorage.removeItem(STORAGE_KEY); } catch(_){}
    try { localStorage.setItem(key, value); return true; } catch(_){ return false; }
  }
}
// 立即保存：序列化整关卡并写入 localStorage（较重的同步操作）
function autoSaveNow(){ return safeStore(STORAGE_KEY, serialize()); }
// 防抖保存：连续编辑（快速连点放置体素/螺丝、拖动滑块等）时不每次都同步序列化 + 写 localStorage，
// 而是合并到操作停止后延迟一次执行。避免快速连点时每一下都被 serialize/localStorage 阻塞主线程
// 造成"点太快没反应"。关键节点（导出/切关卡/关闭页面）会调用 autoSaveNow 立即落盘。
let _autoSaveTimer = null, _autoSaveIdle = null;
function autoSave(){
  if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
  if (_autoSaveIdle != null && window.cancelIdleCallback) { cancelIdleCallback(_autoSaveIdle); _autoSaveIdle = null; }
  _autoSaveTimer = setTimeout(() => {
    _autoSaveTimer = null;
    if (window.requestIdleCallback) {
      _autoSaveIdle = requestIdleCallback(() => { _autoSaveIdle = null; autoSaveNow(); }, { timeout:1500 });
    } else autoSaveNow();
  }, 700);
}
function flushAutoSave(){
  const pending = _autoSaveTimer || _autoSaveIdle != null;
  if (_autoSaveTimer) { clearTimeout(_autoSaveTimer); _autoSaveTimer = null; }
  if (_autoSaveIdle != null && window.cancelIdleCallback) { cancelIdleCallback(_autoSaveIdle); _autoSaveIdle = null; }
  if (pending) autoSaveNow();
}
// 页面隐藏/关闭前确保未保存的改动落盘。
window.addEventListener('pagehide', flushAutoSave);
window.addEventListener('visibilitychange', () => { if (document.hidden) flushAutoSave(); });

function loadFromStorage(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    applyLevelData(JSON.parse(raw));
    return true;
  } catch(e){ return false; }
}
function applyLevelData(data){
  renderRefs.forEach(ref => scene.remove(ref.group));
  renderRefs.clear();
  level = { name: data.name || '我的雕塑关卡', objects: data.objects || [] };
  level.screwSize = (data.screwSize > 0) ? data.screwSize : 1;   // 兼容旧字段（现螺丝大小自动跟随体素）
  level.solution = data.solution || null;                        // 恢复已固化的可行解（若有）
  level.screwMode = (data.screwMode === 'manual' || data.screwMode === 'auto') ? data.screwMode : null;  // 螺丝布局方式（未选为 null）
  nextId = data.nextId || (level.objects.reduce((m,o)=>Math.max(m,o.id),0)+1);
  // 同步关卡名输入框
  const nameEl = $('level-name');
  if (nameEl) nameEl.value = level.name || '';
  refreshScrewModeButtons();   // 同步「手动/自动」按钮高亮
  // 恢复「螺丝颜色种类数」到 editor 与滑块（游玩时按此种类数动态配色）
  if (data.screwColorCount >= 1){
    editor.screwColorCount = Math.max(1, Math.min(8, Math.round(data.screwColorCount)));
    const ccEl = $('screw-colorcount'), ccVal = $('v-screw-colorcount');
    if (ccEl) ccEl.value = editor.screwColorCount;
    if (ccVal) ccVal.textContent = editor.screwColorCount;
  }
  // 补齐默认字段 + 螺丝迁移
  level.objects.forEach(o => {
    if (!(o.voxelSize > 0)) o.voxelSize = DEFAULT_VOXEL_SIZE;
    if (!Number.isFinite(o.rotX)) o.rotX = 0;
    if (!Number.isFinite(o.rotY)) o.rotY = 0;
    if (!Number.isFinite(o.rotZ)) o.rotZ = 0;
    if (!o.scale || !(o.scale.x>0) || !(o.scale.y>0) || !(o.scale.z>0)) o.scale = { x:1, y:1, z:1 };
    if (o.groupId != null && !(o.groupId > 0)) o.groupId = null;   // 清理非法组号
    migrateScrews(o);
  });
  ensureGroupIdCounter();   // 让绑定组编号计数器跟上已加载数据
  // 恢复人形模特的位置/旋转/缩放/显隐（无则用默认）
  const md = data.mannequin || {};
  mannequinXform.x = isFinite(md.x) ? md.x : 0;
  mannequinXform.y = isFinite(md.y) ? md.y : 0;
  mannequinXform.z = isFinite(md.z) ? md.z : 0;
  mannequinXform.rotY = isFinite(md.rotY) ? md.rotY : 0;
  mannequinXform.scale = (md.scale > 0) ? md.scale : 1;
  mannequinXform.visible = false;   // 强制默认关闭：进入编辑器一律不显示模特（忽略存档），需手动开启
  applyMannequinXform();
  syncMannequinControls();
  activeObjId = level.objects.length ? level.objects[0].id : null;
  level.objects.forEach(buildObjectGroup);
  refreshObjList(); refreshRightPanel(); refreshStats(); syncPlaneIndicator();
}

let currentCustomLevelId = null;

function levelPayload(){
  const nameEl = $('level-name');
  let name = (nameEl && nameEl.value.trim()) || level.name || '我的雕塑关卡';
  if (nameEl && nameEl.value !== name) nameEl.value = name;
  level.name = name;
  return { name, screwSize: screwSizeMul(), screwColorCount: editor.screwColorCount, screwMode: level.screwMode || null, solution: level.solution || null, mannequin: { ...mannequinXform }, objects: serializableObjects() };
}
function loadCustomLevels(){
  try {
    const raw = localStorage.getItem(CUSTOM_LEVELS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch(e){ return []; }
}
function saveCustomLevels(list){
  return safeStore(CUSTOM_LEVELS_KEY, JSON.stringify(list));
}
function syncLegacyCustomLevel(data){
  // 旧入口（?custom=1 试玩）用的副本，失败无所谓，best-effort
  try { localStorage.setItem(CUSTOM_LEVEL_KEY, JSON.stringify(data)); } catch(e){}
}
function fmtTime(ts){
  const d = new Date(ts || Date.now());
  const p = n => String(n).padStart(2,'0');
  return `${d.getMonth()+1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function renderMyCustomLevels(){
  const box = $('my-levels');
  if (!box) return;
  const list = loadCustomLevels().sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
  box.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = '还没有自定义关卡，点「快速保存」即可加入。';
    box.appendChild(empty);
    return;
  }
  list.forEach(item => {
    const row = document.createElement('div');
    row.className = 'my-level-item' + (item.id === currentCustomLevelId ? ' active' : '');

    const info = document.createElement('div');
    info.className = 'my-level-info';
    const nm = document.createElement('div'); nm.className = 'my-level-name'; nm.textContent = item.name || '未命名关卡';
    const tm = document.createElement('div'); tm.className = 'my-level-time'; tm.textContent = `更新于 ${fmtTime(item.updatedAt)}`;
    info.append(nm, tm);

    const ops = document.createElement('div');
    ops.className = 'my-level-ops';
    const bEdit = document.createElement('button');
    bEdit.className = 'tool'; bEdit.textContent = '编辑';
    bEdit.addEventListener('click', () => {
      applyLevelData(item.data || { name:item.name, objects:[] });
      currentCustomLevelId = item.id;
      autoSave();
      renderMyCustomLevels();
      toast(`已加载「${item.name || '未命名关卡'}」`);
    });
    const bExport = document.createElement('button');
    bExport.className = 'tool'; bExport.textContent = '导出';
    bExport.title = '导出为本地 .json 文件';
    bExport.addEventListener('click', () => {
      const data = item.data || { name:item.name, objects:[] };
      triggerJsonDownload(data, safeFileName(item.name || '关卡') + '.json');
      toast('已导出为 ' + safeFileName(item.name || '关卡') + '.json');
    });
    const bDel = document.createElement('button');
    bDel.className = 'tool warn'; bDel.textContent = '删除';
    bDel.addEventListener('click', () => {
      if (!confirm(`删除自定义关卡「${item.name || '未命名关卡'}」？`)) return;
      const next = loadCustomLevels().filter(x => x.id !== item.id);
      saveCustomLevels(next);
      if (currentCustomLevelId === item.id) currentCustomLevelId = null;
      // 兼容旧入口：保持 legacy 指向首个关卡
      if (next.length) syncLegacyCustomLevel(next[0].data);
      renderMyCustomLevels();
      toast('已删除');
    });
    ops.append(bEdit, bExport, bDel);

    row.append(info, ops);
    box.appendChild(row);
  });
}

function saveCurrentToMyLevels(opts = {}){
  const { forceNew = false, silent = false } = opts;
  const payload = levelPayload();
  if (!payload.objects.length) { if (!silent) toast('当前没有体素，无法保存到我的关卡'); return false; }

  const now = Date.now();
  const list = loadCustomLevels();
  const prevId = currentCustomLevelId;   // 保存失败时用于回滚
  let entry = null, isNew = false;
  if (!forceNew && currentCustomLevelId) entry = list.find(x => x.id === currentCustomLevelId);

  if (!entry) {
    entry = {
      id: `cst_${now}_${Math.floor(Math.random()*10000)}`,
      name: payload.name || `我的关卡 ${list.length + 1}`,
      updatedAt: now,
      data: payload,
    };
    list.unshift(entry);
    currentCustomLevelId = entry.id;
    isNew = true;
  } else {
    entry.name = payload.name || entry.name;
    entry.updatedAt = now;
    entry.data = payload;
  }

  list.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
  const ok = saveCustomLevels(list);
  if (!ok) {
    // 真实写入失败（多为浏览器本地存储空间不足）：回滚内存状态并如实告知
    if (isNew) currentCustomLevelId = prevId;
    if (!silent) toast('保存失败：浏览器本地存储空间已满，请先删除一些旧关卡，或用「导出」备份后再试');
    return false;
  }
  // 兼容 index.html 旧入口（?custom=1 试玩）——best-effort，不影响主存档结果
  syncLegacyCustomLevel(entry.data);
  renderMyCustomLevels();
  if (!silent) toast(forceNew ? '已另存到我的自定义关卡' : '已保存到我的自定义关卡');
  return true;
}

function loadCustomLevelFromQuery(){
  const id = new URLSearchParams(location.search).get('edit');
  if (!id) return false;
  const entry = loadCustomLevels().find(x => x.id === id);
  if (!entry || !entry.data) return false;
  applyLevelData(entry.data);
  currentCustomLevelId = id;
  return true;
}

$('btn-save').addEventListener('click', () => { if (_autoSaveTimer){ clearTimeout(_autoSaveTimer); _autoSaveTimer = null; } toast(autoSaveNow() ? '已保存到本地' : '保存失败：浏览器本地存储空间已满，请删除旧关卡或用「导出」备份'); });
if ($('btn-quick-save')) $('btn-quick-save').addEventListener('click', () => { saveCurrentToMyLevels({ forceNew:false }); });
if ($('btn-save-as-new')) $('btn-save-as-new').addEventListener('click', () => { saveCurrentToMyLevels({ forceNew:true }); });

/* ---------------- 本地 .json 文件 导出 / 导入 ----------------
 * 关卡数据平时存在浏览器 localStorage 里（不是磁盘文件）；这里提供把关卡
 * 下载成真正的 .json 文件、以及从 .json 文件读取导入的能力，便于备份与迁移。
 */
function safeFileName(s){
  return ((s || '关卡').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').slice(0, 60)) || '关卡';
}
// 触发浏览器把一个 JS 对象下载为 .json 文件
function triggerJsonDownload(obj, filename){
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// 导出「当前编辑中的关卡」为 .json 文件
function exportCurrentLevelFile(){
  if (!level.objects.length){ toast('当前没有物件，无法导出'); return; }
  const nameEl = $('level-name');
  const name = (nameEl && nameEl.value.trim()) || level.name || '我的雕塑关卡';
  level.name = name;
  triggerJsonDownload({ name, nextId, screwSize: screwSizeMul(), screwColorCount: editor.screwColorCount, screwMode: level.screwMode || null, solution: level.solution || null, mannequin: { ...mannequinXform }, objects: serializableObjects() }, safeFileName(name) + '.json');
  toast('已导出为 ' + safeFileName(name) + '.json');
}
// 把导入的 JSON 数据应用为当前关卡并入库
function applyImportedLevel(data, srcName){
  applyLevelData(data);
  currentCustomLevelId = null;                       // 导入默认视为新关卡
  autoSave();
  saveCurrentToMyLevels({ forceNew:true, silent:true });
  toast('已导入' + (srcName ? '：' + srcName : '，并加入我的自定义关卡'));
}
// 隐藏的文件选择框（读取 .json）
let importFileInput = null;
function openImportFilePicker(){
  if (!importFileInput){
    importFileInput = document.createElement('input');
    importFileInput.type = 'file';
    importFileInput.accept = 'application/json,.json';
    importFileInput.style.display = 'none';
    importFileInput.addEventListener('change', () => {
      const f = importFileInput.files && importFileInput.files[0];
      importFileInput.value = '';                    // 允许再次选择同一文件
      if (!f) return;
      const reader = new FileReader();
      reader.onload = ev => {
        try { applyImportedLevel(JSON.parse(ev.target.result), f.name); }
        catch(e){ toast('导入失败：文件不是有效的关卡 JSON'); }
      };
      reader.onerror = () => toast('读取文件失败');
      reader.readAsText(f);
    });
    document.body.appendChild(importFileInput);
  }
  importFileInput.click();
}

const modalMask = $('modal-mask');
// 导出：直接下载 .json 文件到本地
$('btn-export').addEventListener('click', exportCurrentLevelFile);
// 导入：打开系统文件选择框读取 .json
$('btn-import').addEventListener('click', openImportFilePicker);
// 保留：粘贴 JSON 文本导入的兼容弹窗（modal-ok/cancel 仍可用，供分享的纯文本使用）
let modalMode = 'export';
if ($('modal-cancel')) $('modal-cancel').addEventListener('click', () => modalMask && (modalMask.style.display = 'none'));
if ($('modal-ok')) $('modal-ok').addEventListener('click', async () => {
  if (modalMode === 'export') {
    try { await navigator.clipboard.writeText($('modal-text').value); toast('已复制到剪贴板'); }
    catch(e){ $('modal-text').select(); document.execCommand('copy'); toast('已复制'); }
  } else {
    try { applyImportedLevel(JSON.parse($('modal-text').value)); if (modalMask) modalMask.style.display='none'; }
    catch(e){ toast('JSON 格式错误'); }
  }
});

/* 试玩 */
$('btn-test').addEventListener('click', () => {
  if (!level.objects.length) { toast('请先创建物件'); return; }
  // 未选择螺丝布局方式：中间浮现提示 0.5 秒，不跳转（不影响继续编辑）
  if (level.screwMode !== 'manual' && level.screwMode !== 'auto'){ centerFlash('请选择螺丝布局方式'); return; }
  const totalScrews = level.objects.reduce((s,o)=>s+o.screws.length, 0);
  if (totalScrews === 0) { toast('请先布置螺丝'); return; }
  if (totalScrews % 3 !== 0) {
    const need = (3 - (totalScrews % 3)) % 3;
    centerFlash(`螺丝总数需为 3 的倍数，目前是 ${totalScrews} 颗螺丝，至少还需要布置 ${need} 颗螺丝`, 2400);
    return;
  }
  try {
    // 试玩前先把挂起的防抖存档立即落盘，再写入我的关卡库（更新当前项），兼容旧 CUSTOM_LEVEL_KEY
    if (_autoSaveTimer){ clearTimeout(_autoSaveTimer); _autoSaveTimer = null; autoSaveNow(); }
    saveCurrentToMyLevels({ forceNew:false, silent:true });
    location.href = 'index.html?custom=1';
  } catch(e){ toast('保存失败'); }
});

/* ---------------- 关卡可行解验证：UI 接线 ---------------- */
function renderValidateResult(res){
  const mask = $('validate-mask');
  const badge = $('vd-badge');
  const body = $('vd-body');
  if (!mask || !body) return;

  // 两档结论：可行 / 不可行。
  // 因为游戏进场会用同一算法生成「保证可行」的配色，所以「可行」即代表玩家进游戏
  // 一定拿到能通关的配色；「不可行」代表关卡结构本身死局。
  const ok = res.solvable && !res.errors.length;
  badge.textContent = ok ? '✅' : '⛔';
  badge.style.background = ok ? 'rgba(80,220,140,.16)' : 'rgba(255,90,90,.16)';
  badge.style.boxShadow = 'inset 0 0 0 1px ' + (ok ? 'rgba(80,220,140,.35)' : 'rgba(255,90,90,.35)');

  let html = '';
  html += `<div id="vd-verdict" class="${ok ? 'ok' : 'bad'}">`
        + (ok
            ? '✔ 本关有可行解：游戏进场会自动分配一套可通关的螺丝颜色与需求顺序（保证至少一个可行解）。'
            : '✘ 本关无可行解：关卡结构存在死局，任何分配都无法通关，请调整螺丝摆放或层级。')
        + `</div>`;

  html += '<div class="vd-stats">';
  html += `<div class="vd-stat"><div class="k">螺丝总数</div><div class="v">${res.totalScrews}</div></div>`;
  html += `<div class="vd-stat"><div class="k">颜色种类</div><div class="v">${res.colorCount}</div></div>`;
  html += `<div class="vd-stat"><div class="k">开局可拧</div><div class="v">${res.reachableNow}</div></div>`;
  html += `<div class="vd-stat"><div class="k">结论</div><div class="v">${ok ? '可行' : '不可行'}</div></div>`;
  html += '</div>';

  // 错误
  if (res.errors.length){
    html += '<div class="vd-section-title">阻断问题（必须修复）</div><ul class="vd-list">';
    res.errors.forEach(e => { html += `<li class="err">${e}</li>`; });
    html += '</ul>';
  }
  // 警告 / 建议
  if (res.warnings.length){
    html += '<div class="vd-section-title">提示 / 建议</div><ul class="vd-list">';
    res.warnings.forEach(w => { html += `<li class="warn">${w}</li>`; });
    html += '</ul>';
  }
  // 检测明细
  if (ok){
    html += '<div class="vd-section-title">检测明细</div><ul class="vd-list">';
    html += `<li class="ok">层级检测：存在一条「层级由高到低」的可行拆解顺序，可取完全部螺丝。</li>`;
    html += `<li class="ok">射线遮挡检测：该顺序下每颗螺丝都能找到不被体素遮挡的可拧视角。</li>`;
    if (res.trace) html += `<li class="ok">5 颗容错：照此顺序拆解，备用槽最多仅占用 ${res.trace.maxSpareUsed} 颗即可通关。</li>`;
    html += `<li class="ok">游戏进场采用与本验证相同的算法分配颜色与需求槽，保证玩家拿到可行方案。</li>`;
    html += '</ul>';
    // 让人「看得见有解」的两个工具
    html += '<div class="vd-section-title">看看这套解法（可视化验证）</div>';
    html += '<div class="row" style="gap:8px;">';
    html += '<button class="tool" id="vd-play" style="flex:1;justify-content:center;background:rgba(80,220,140,.16);color:#9ff0c0;border-color:rgba(80,220,140,.35);">▶ 观看解法回放</button>';
    html += '<button class="tool" id="vd-numbers" style="flex:1;justify-content:center;">①② 显示拆解序号</button>';
    html += '</div>';
    html += '<div class="hint" style="margin-top:6px;">「解法回放」会按可行顺序逐颗取下螺丝并演示需求槽/备用槽的填充过程；「显示序号」在每颗螺丝上标出拆除次序。</div>';
  }

  body.innerHTML = html;

  // 保存本次可行解轨迹供回放/标号使用
  lastValidateTrace = ok ? (res.trace || null) : null;
  if (ok){
    const playBtn = $('vd-play'), numBtn = $('vd-numbers');
    if (playBtn) playBtn.addEventListener('click', ()=>{ mask.style.display='none'; startSolutionPlayback(lastValidateTrace); });
    if (numBtn) numBtn.addEventListener('click', ()=>{ toggleScrewOrderLabels(lastValidateTrace); });
  }

  mask.style.display = 'flex';
}
let lastValidateTrace = null;

/* ===========================================================
 * 解法可视化：① 螺丝拆解序号标注   ② 解法回放动画
 * =========================================================== */

// 根据 objId+screwIndex 找到当前场景里那颗螺丝的网格
function findScrewMesh(objId, screwIndex){
  const ref = renderRefs.get(objId);
  if (!ref) return null;
  return ref.screwMeshes.get(screwIdKey(screwIndex)) || null;
}

// 生成一个「圆底 + 数字」的精灵贴图
function makeNumberSprite(num, colorHex){
  const size = 128;
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const g = cv.getContext('2d');
  g.beginPath(); g.arc(size/2, size/2, size/2-6, 0, Math.PI*2);
  g.fillStyle = 'rgba(20,22,34,0.9)'; g.fill();
  g.lineWidth = 8; g.strokeStyle = colorHex || '#7cf0b0'; g.stroke();
  g.fillStyle = '#ffffff';
  g.font = `bold ${num >= 100 ? 52 : 64}px "Microsoft YaHei",sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(num), size/2, size/2+4);
  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true });
  const sp = new THREE.Sprite(mat);
  const worldSize = SCREW_DIAMETER * screwSizeMul() * 1.5;
  sp.scale.set(worldSize, worldSize, worldSize);
  sp.renderOrder = 999;
  return sp;
}

let orderLabelSprites = [];   // 当前显示的序号精灵
let orderLabelsOn = false;

function clearScrewOrderLabels(){
  orderLabelSprites.forEach(sp => { if (sp.parent) sp.parent.remove(sp); if (sp.material.map) sp.material.map.dispose(); sp.material.dispose(); });
  orderLabelSprites = [];
  orderLabelsOn = false;
}

// 切换：在每颗螺丝上标出「拆解次序」编号（1,2,3…）
function toggleScrewOrderLabels(trace){
  if (orderLabelsOn){ clearScrewOrderLabels(); toast('已隐藏拆解序号'); return; }
  if (!trace || !trace.steps || !trace.steps.length){ toast('没有可用的解法数据，请先验证可解'); return; }
  clearScrewOrderLabels();
  trace.steps.forEach((step, i)=>{
    const mesh = findScrewMesh(step.objId, step.screwIndex);
    if (!mesh) return;
    const c = screwByName(step.color);
    const sp = makeNumberSprite(i+1, c.css);
    // 用世界坐标定位并挂到 scene，避免物件 group 的非均匀缩放拉伸精灵
    mesh.updateMatrixWorld(true);
    const wp = new THREE.Vector3(); mesh.getWorldPosition(wp);
    const ref = renderRefs.get(step.objId);
    const nWorld = new THREE.Vector3(...(level.objects.find(o=>o.id===step.objId).screws[step.screwIndex].normal));
    if (ref && ref.group){ nWorld.applyQuaternion(ref.group.getWorldQuaternion(new THREE.Quaternion())); }
    nWorld.normalize().multiplyScalar(SCREW_DIAMETER * screwSizeMul() * 1.1);
    sp.position.copy(wp).add(nWorld);
    scene.add(sp); orderLabelSprites.push(sp);
  });
  orderLabelsOn = true;
  toast(`已按拆解顺序标注 ${orderLabelSprites.length} 颗螺丝（数字=拆除次序）`);
}

/* ---------------- 验证预览态：禁止编辑 + 物件可掉落，结束恢复 ---------------- */
let validationPreview = false;
let previewBanner = null;
function setValidationPreview(on){
  validationPreview = !!on;
  if (on){
    if (!previewBanner){
      previewBanner = document.createElement('div');
      previewBanner.style.cssText = 'position:absolute;left:12px;bottom:12px;z-index:45;'
        + 'background:rgba(122,79,255,.18);border:1px solid rgba(122,79,255,.5);color:#cdb3ff;'
        + 'padding:8px 14px;border-radius:10px;font-size:12px;font-weight:700;box-shadow:0 6px 18px rgba(0,0,0,.4);';
      previewBanner.textContent = '🔒 验证预览中：仅可旋转查看，暂不可编辑（关闭回放后自动恢复）';
      document.getElementById('app').appendChild(previewBanner);
    }
    previewBanner.style.display = 'block';
  } else {
    if (previewBanner) previewBanner.style.display = 'none';
  }
}

// 回放中「让某物件掉落」：隐藏其全部体素网格（模拟游戏里螺丝取空后整组掉落消失）。
function setObjVoxelsVisible(objId, visible){
  const ref = renderRefs.get(objId);
  if (!ref) return;
  if (ref.pickMeshes) ref.pickMeshes.forEach(m => { m.visible = visible; });
  else ref.voxelMeshes.forEach(m => { m.visible = visible; });
}
// 恢复所有物件体素显示
function restoreAllVoxelsVisible(){
  renderRefs.forEach(ref => {
    if (ref.pickMeshes) ref.pickMeshes.forEach(m => { m.visible = true; });
    else ref.voxelMeshes.forEach(m => { m.visible = true; });
  });
}


/* ---------------- 解法回放动画 ---------------- */
let playbackState = null;   // { steps, i, playing, timer, hud, hiddenMeshes:[] }

function ensurePlaybackHud(){
  let hud = document.getElementById('playback-hud');
  if (hud) return hud;
  hud = document.createElement('div');
  hud.id = 'playback-hud';
  hud.style.cssText = 'position:absolute;left:50%;top:70px;transform:translateX(-50%);z-index:40;'
    + 'background:rgba(24,28,46,.94);border:1px solid rgba(255,255,255,.12);border-radius:14px;'
    + 'padding:12px 16px;box-shadow:0 10px 30px rgba(0,0,0,.5);color:#e8ecf7;min-width:320px;font-size:13px;';
  hud.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">'
    +   '<b style="color:#9ff0c0;">解法回放</b>'
    +   '<span id="pb-progress" style="color:#8e9ac4;">0 / 0</span>'
    +   '<span style="flex:1;"></span>'
    +   '<button class="tool" id="pb-close" style="padding:4px 8px;">✕ 关闭</button>'
    + '</div>'
    + '<div style="display:flex;gap:16px;align-items:flex-start;">'
    +   '<div><div style="font-size:11px;color:#8e9ac4;margin-bottom:4px;">需求槽（每格需 3 颗同色）</div><div id="pb-slots" style="display:flex;gap:8px;"></div></div>'
    +   '<div><div style="font-size:11px;color:#8e9ac4;margin-bottom:4px;">备用槽（上限 5）</div><div id="pb-spares" style="display:flex;gap:4px;"></div></div>'
    + '</div>'
    + '<div style="display:flex;gap:8px;margin-top:12px;align-items:center;">'
    +   '<button class="tool" id="pb-prev" style="padding:6px 10px;">◀ 上一步</button>'
    +   '<button class="tool active" id="pb-play" style="padding:6px 12px;">⏸ 暂停</button>'
    +   '<button class="tool" id="pb-next" style="padding:6px 10px;">下一步 ▶</button>'
    +   '<span style="flex:1;"></span>'
    +   '<span style="font-size:11px;color:#8e9ac4;">速度</span>'
    +   '<select id="pb-speed" style="background:rgba(0,0,0,.3);color:#e8ecf7;border:1px solid rgba(255,255,255,.16);border-radius:6px;padding:3px 6px;">'
    +     '<option value="900">慢</option><option value="500" selected>中</option><option value="250">快</option>'
    +   '</select>'
    + '</div>';
  document.getElementById('app').appendChild(hud);
  hud.querySelector('#pb-close').addEventListener('click', stopSolutionPlayback);
  hud.querySelector('#pb-play').addEventListener('click', togglePlaybackPlay);
  hud.querySelector('#pb-prev').addEventListener('click', ()=> playbackStep(-1));
  hud.querySelector('#pb-next').addEventListener('click', ()=> playbackStep(1));
  hud.querySelector('#pb-speed').addEventListener('change', ()=>{ if (playbackState && playbackState.playing){ schedulePlaybackTick(); } });
  return hud;
}

function colorSwatchHtml(name, dim){
  const c = screwByName(name);
  return `<span style="display:inline-block;width:16px;height:16px;border-radius:4px;background:${c.css};${dim?'opacity:.35;':''}box-shadow:inset 0 0 0 1px rgba(0,0,0,.35);"></span>`;
}

function renderPlaybackHud(){
  const st = playbackState; if (!st) return;
  const hud = ensurePlaybackHud();
  const step = st.i >= 0 ? st.steps[st.i] : null;
  hud.querySelector('#pb-progress').textContent = `${st.i+1} / ${st.steps.length}`;
  // 需求槽（取当前步的快照；未开始时用第一步之前的初始态）
  const slots = step ? step.slots : (st.steps[0] ? st.steps[0].slots.map(s=>s?{color:s.color,filled:0}:null) : []);
  const spares = step ? step.spares : [];
  const slotsEl = hud.querySelector('#pb-slots'); slotsEl.innerHTML = '';
  (slots||[]).forEach(sl=>{
    const box = document.createElement('div');
    box.style.cssText = 'border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:4px 6px;display:flex;gap:3px;align-items:center;';
    if (sl){ box.innerHTML = colorSwatchHtml(sl.color) + `<b style="font-size:12px;">${sl.filled}/3</b>`; }
    else { box.innerHTML = '<span style="font-size:11px;color:#8e9ac4;">—</span>'; }
    slotsEl.appendChild(box);
  });
  const sparesEl = hud.querySelector('#pb-spares'); sparesEl.innerHTML = '';
  for (let i=0;i<5;i++){
    const has = spares && spares[i];
    const box = document.createElement('span');
    box.style.cssText = `width:18px;height:18px;border-radius:5px;border:1px dashed rgba(255,255,255,.2);display:inline-block;${has?`background:${screwByName(spares[i]).css};border-style:solid;`:''}`;
    sparesEl.appendChild(box);
  }
  const playBtn = hud.querySelector('#pb-play');
  playBtn.textContent = st.playing ? '⏸ 暂停' : '▶ 播放';
  playBtn.classList.toggle('active', st.playing);
}

// 应用「第 i 步」的场景可见性：前 i+1 颗螺丝隐藏（已取），其余显示
function applyPlaybackVisual(){
  const st = playbackState; if (!st) return;
  // 先全部恢复显示（螺丝 + 体素）
  st.steps.forEach(step=>{ const m = findScrewMesh(step.objId, step.screwIndex); if (m) m.visible = true; });
  restoreAllVoxelsVisible();
  // 隐藏已取（0..i）
  for (let k=0;k<=st.i;k++){ const step=st.steps[k]; const m=findScrewMesh(step.objId, step.screwIndex); if (m) m.visible = false; }
  // 物件掉落：隐藏「当前步已掉落」物件的全部体素（模拟游戏里取空后整组掉落消失）
  if (st.i >= 0){
    const dropped = st.steps[st.i].dropped || [];
    dropped.forEach(objId => setObjVoxelsVisible(objId, false));
  }
  // 高亮「当前刚取的那颗」的位置：把相机聚焦（用一个短暂放大的高亮精灵）
  clearPlaybackHighlight();
  if (st.i >= 0){
    const step = st.steps[st.i];
    const m = findScrewMesh(step.objId, step.screwIndex);
    // 已隐藏，用一个高亮环精灵标出它刚才的位置（世界坐标，挂到 scene）
    if (m){
      m.updateMatrixWorld(true);
      const wp = new THREE.Vector3(); m.getWorldPosition(wp);
      const sp = makeRingSprite(screwByName(step.color).css);
      sp.position.copy(wp);
      scene.add(sp); st.highlight = sp;
    }
  }
}
function makeRingSprite(colorHex){
  const size=128; const cv=document.createElement('canvas'); cv.width=cv.height=size;
  const g=cv.getContext('2d'); g.lineWidth=12; g.strokeStyle=colorHex||'#fff';
  g.beginPath(); g.arc(size/2,size/2,size/2-10,0,Math.PI*2); g.stroke();
  const tex=new THREE.CanvasTexture(cv); tex.needsUpdate=true;
  const mat=new THREE.SpriteMaterial({ map:tex, depthTest:false, transparent:true });
  const sp=new THREE.Sprite(mat); const w=SCREW_DIAMETER*screwSizeMul()*2.4; sp.scale.set(w,w,w); sp.renderOrder=1000;
  return sp;
}
function clearPlaybackHighlight(){ const st=playbackState; if (st && st.highlight){ if (st.highlight.parent) st.highlight.parent.remove(st.highlight); if (st.highlight.material.map) st.highlight.material.map.dispose(); st.highlight.material.dispose(); st.highlight=null; } }

function playbackStep(dir){
  const st = playbackState; if (!st) return;
  const ni = st.i + dir;
  if (ni < -1 || ni >= st.steps.length) {
    if (ni >= st.steps.length){ st.playing = false; clearTimeout(st.timer); toast('解法演示完成：全部螺丝已取完 ✔'); }
    return;
  }
  st.i = ni;
  applyPlaybackVisual();
  renderPlaybackHud();
  if (st.playing && st.i < st.steps.length-1) schedulePlaybackTick();
  else if (st.i >= st.steps.length-1){ st.playing=false; renderPlaybackHud(); }
}

function schedulePlaybackTick(){
  const st = playbackState; if (!st) return;
  clearTimeout(st.timer);
  const hud = document.getElementById('playback-hud');
  const speed = hud ? parseInt(hud.querySelector('#pb-speed').value)||500 : 500;
  st.timer = setTimeout(()=>{ if (playbackState && playbackState.playing) playbackStep(1); }, speed);
}

function togglePlaybackPlay(){
  const st = playbackState; if (!st) return;
  st.playing = !st.playing;
  if (st.playing){ if (st.i >= st.steps.length-1) { st.i = -1; applyPlaybackVisual(); } schedulePlaybackTick(); }
  else clearTimeout(st.timer);
  renderPlaybackHud();
}

function startSolutionPlayback(trace){
  if (!trace || !trace.steps || !trace.steps.length){ toast('没有可用的解法数据，请先验证可解'); return; }
  stopSolutionPlayback();
  clearScrewOrderLabels();
  setValidationPreview(true);   // 进入验证预览态：禁止编辑
  playbackState = { steps: trace.steps, i: -1, playing: true, timer: null, highlight: null };
  ensurePlaybackHud().style.display = 'block';
  applyPlaybackVisual();
  renderPlaybackHud();
  schedulePlaybackTick();
  toast('开始回放可行解法…');
}

function stopSolutionPlayback(){
  const st = playbackState;
  if (st){
    clearTimeout(st.timer);
    clearPlaybackHighlight();
    // 恢复所有螺丝显示
    st.steps.forEach(step=>{ const m = findScrewMesh(step.objId, step.screwIndex); if (m) m.visible = true; });
  }
  playbackState = null;
  const hud = document.getElementById('playback-hud');
  if (hud) hud.remove();
  // 退出验证预览态：恢复所有体素显示与可编辑
  restoreAllVoxelsVisible();
  setValidationPreview(false);
}

function runLevelValidation(){
  if (!level.objects.length){ toast('请先创建物件'); return; }
  const total = level.objects.reduce((s,o)=>s+o.screws.length, 0);
  if (total === 0){ toast('请先布置螺丝再验证'); return; }
  // 开始新验证前，清掉上次的序号/回放
  clearScrewOrderLabels();
  stopSolutionPlayback();
  toast('正在验证关卡可解性…');
  // 让 toast 先渲染，再执行较重的模拟
  setTimeout(() => {
    try {
      const res = validateLevelSolvable();
      renderValidateResult(res);
    } catch(e){
      console.error(e);
      toast('验证出错：' + (e && e.message ? e.message : e));
    }
  }, 30);
}

if ($('btn-validate')) $('btn-validate').addEventListener('click', runLevelValidation);
if ($('vd-close')) $('vd-close').addEventListener('click', () => { const m = $('validate-mask'); if (m) m.style.display = 'none'; });
if ($('vd-recheck')) $('vd-recheck').addEventListener('click', runLevelValidation);
if ($('validate-mask')) $('validate-mask').addEventListener('click', (e) => { if (e.target === $('validate-mask')) $('validate-mask').style.display = 'none'; });

/* =========================================================
 * ✨ AI / 程序化体素生成（雕塑编辑器版 · 任意 hex 颜色）
 * - 输入：文字描述（+可选图片取色）+ 物件数量 + 体素精细度
 * - 在「人头模型附近」围绕分布生成体素物件
 * - 优先使用用户填写的 LLM 端点；否则用内置形状生成器
 * ========================================================= */

// 关键词 -> hex 颜色
function aiColorFromText(text){
  const map = [
    [/红|red|爱心|心|苹果|草莓|玫瑰/, '#ff5d5d'],
    [/绿|green|树|草|叶|仙人掌|青蛙/, '#4dd07a'],
    [/紫|purple|葡萄/, '#b06dff'],
    [/蓝|blue|海|水|冰/, '#4d8cff'],
    [/灰|gray|grey|石|铁|机器/, '#a0a7b8'],
    [/棕|褐|brown|木|熊|巧克力|面包|汉堡/, '#9b6b43'],
    [/白|white|云|雪|骨/, '#f3f5fa'],
    [/黄|yellow|金|星|太阳|玉米|香蕉|月/, '#ffd166'],
    [/橙|orange|橘|胡萝卜/, '#ff9a4d'],
    [/粉|pink|樱/, '#ff8ec7'],
    [/黑|black|夜/, '#2b2f3a'],
  ];
  for (const [re, hex] of map) if (re.test(text)) return hex;
  return null;
}

// ---- 形状生成：返回 voxels 对象 { "x,y,z": hex } ----
function aiGenShapeVoxels(text, colorHex){
  const t = text || '';
  const set = {};
  const put = (x,y,z,c)=>{ set[keyOf(x,y,z)] = c || colorHex; };

  // 爱心
  if (/爱心|心形|heart|❤|心/.test(t)){
    const pattern = ['011011','111111','111111','011110','001100'];
    pattern.forEach((row,ri)=>{ const y = pattern.length-1-ri; for (let x=0;x<row.length;x++) if (row[x]==='1') put(x-2, y, 0); });
    return set;
  }
  // 五角星
  if (/星|star|✦|✩/.test(t)){
    const pattern = ['0010100','0111110','1111111','0111110','0110110','1100011'];
    pattern.forEach((row,ri)=>{ const y=pattern.length-1-ri; for(let x=0;x<row.length;x++) if(row[x]==='1') put(x-3,y,0); });
    return set;
  }
  // 树
  if (/树|tree|圣诞/.test(t)){
    put(0,0,0,'#9b6b43'); put(0,1,0,'#9b6b43');
    const crown='#4dd07a';
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

  // 单个字母（A-Z）
  const letterMatch = t.toUpperCase().match(/字母\s*([A-Z])|^\s*([A-Z])\s*$|letter\s*([A-Z])/);
  const letter = letterMatch ? (letterMatch[1]||letterMatch[2]||letterMatch[3]) : null;
  if (letter){
    const FONT = {
      A:['01110','10001','11111','10001','10001'], B:['11110','10001','11110','10001','11110'],
      C:['01111','10000','10000','10000','01111'], H:['10001','10001','11111','10001','10001'],
      I:['11111','00100','00100','00100','11111'], L:['10000','10000','10000','10000','11111'],
      O:['01110','10001','10001','10001','01110'], T:['11111','00100','00100','00100','00100'],
      X:['10001','01010','00100','01010','10001'], Y:['10001','01010','00100','00100','00100'],
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

// ---- 从图片提取主色调（平均色 -> hex）----
let aiImageHex = null;
let aiImageAnalysis = null;   // { hex, aspect:[sx,sy,sz], colors:[...] }
function aiExtractImageColor(img){
  const a = aiAnalyzeImage(img);
  aiImageAnalysis = a;
  return a ? a.hex : null;
}

// ---- 分析图片：主色 + 前景形态（宽高比）+ 多主色，用于"优先参考整体形态" ----
function aiAnalyzeImage(img){
  try {
    const N = 48;
    const cv = document.createElement('canvas');
    cv.width = N; cv.height = N;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, N, N);
    const data = ctx.getImageData(0,0,N,N).data;
    // 估算背景色（四角平均），据此判定前景像素
    const corner = (x,y)=>{ const i=(y*N+x)*4; return [data[i],data[i+1],data[i+2],data[i+3]]; };
    const bg = [ [0,0],[N-1,0],[0,N-1],[N-1,N-1] ].map(c=>corner(c[0],c[1]));
    const bgAvg = [0,1,2].map(k=> bg.reduce((s,c)=>s+c[k],0)/bg.length);
    const isFg = (r,g,b,alpha)=> alpha>40 && (Math.abs(r-bgAvg[0])+Math.abs(g-bgAvg[1])+Math.abs(b-bgAvg[2]) > 60);
    let r=0,g=0,bl=0,n=0, minx=N,miny=N,maxx=-1,maxy=-1;
    const buckets = {};
    for(let y=0;y<N;y++)for(let x=0;x<N;x++){
      const i=(y*N+x)*4, R=data[i],G=data[i+1],B=data[i+2],A=data[i+3];
      if(!isFg(R,G,B,A)) continue;
      r+=R; g+=G; bl+=B; n++;
      if(x<minx)minx=x; if(y<miny)miny=y; if(x>maxx)maxx=x; if(y>maxy)maxy=y;
      // 量化配色统计
      const key = (R>>5)+','+(G>>5)+','+(B>>5);
      (buckets[key] = buckets[key] || { r:0,g:0,b:0,c:0 });
      buckets[key].r+=R; buckets[key].g+=G; buckets[key].b+=B; buckets[key].c++;
    }
    if(!n){ // 无明显前景：退回全图平均
      let R=0,G=0,B=0,c=0; for(let i=0;i<data.length;i+=4){ if(data[i+3]<40)continue; R+=data[i];G+=data[i+1];B+=data[i+2];c++; }
      if(!c) return null;
      const th=v=>Math.round(v/c).toString(16).padStart(2,'0');
      return { hex:'#'+th(R)+th(G)+th(B), aspect:[1,1,1], colors:[] };
    }
    const toHex = v => Math.round(v).toString(16).padStart(2,'0');
    const hex = '#'+toHex(r/n)+toHex(g/n)+toHex(bl/n);
    // 前景包围盒 -> 宽高比（映射到 x=宽, y=高, z 取宽高较小值给厚度）
    const w = (maxx-minx+1), h = (maxy-miny+1);
    const mx = Math.max(w,h);
    let sx = w/mx, sy = h/mx, sz = Math.min(sx,sy);
    // 适度归一，避免过极端
    sx = 0.5 + sx*0.5; sy = 0.5 + sy*0.5; sz = 0.5 + sz*0.5;
    // 主色列表（按占比排序，取前若干）
    const colors = Object.values(buckets).sort((a,b)=>b.c-a.c).slice(0,6)
      .map(b=> '#'+toHex(b.r/b.c)+toHex(b.g/b.c)+toHex(b.b/b.c));
    return { hex, aspect:[sx,sy,sz], colors };
  } catch(e){ return null; }
}

// ---- 人头世界位置 ----
function aiHeadAnchor(){
  if (mannequin && mannequin.userData.getHeadWorldSphere){
    const s = mannequin.userData.getHeadWorldSphere();
    return { center: s.center.clone(), radius: s.radius };
  }
  return { center: new THREE.Vector3(0, 6, 0), radius: 2 };
}

// ---- 图片剪影挤出：任意图片物体 → 3D 体素（无需预设词库，真正"理解"图片内容）----
// 提取前景剪影，沿 Z 轴挤出成 3D 形状，返回 shape 格式给 voxelizeShapes 统一处理
function aiSilhouetteToShapes(imgDataUrl, primaryColor, resolution){
  // 复用 aiAnalyzeImage 的背景检测逻辑得到前景掩码
  const N = 64;  // 剪影分辨率
  const cv = document.createElement('canvas');
  cv.width = N; cv.height = N;
  const ctx = cv.getContext('2d');
  const img = new Image();
  return new Promise((resolve)=>{
    img.onload = ()=>{
      ctx.drawImage(img, 0, 0, N, N);
      const data = ctx.getImageData(0,0,N,N).data;
      // 估算背景色
      const corners = [[0,0],[N-1,0],[0,N-1],[N-1,N-1]];
      const bgR = corners.reduce((s,c)=>{ const i=(c[1]*N+c[0])*4; return s+data[i]; },0)/4;
      const bgG = corners.reduce((s,c)=>{ const i=(c[1]*N+c[0])*4; return s+data[i+1]; },0)/4;
      const bgB = corners.reduce((s,c)=>{ const i=(c[1]*N+c[0])*4; return s+data[i+2]; },0)/4;
      // 建立剪影掩码 + 前景颜色
      const mask = new Uint8Array(N*N);
      const fgColors = new Array(N*N);
      let fgCount = 0;
      for(let y=0;y<N;y++)for(let x=0;x<N;x++){
        const i=(y*N+x)*4, R=data[i],G=data[i+1],B=data[i+2],A=data[i+3];
        if(A>40 && (Math.abs(R-bgR)+Math.abs(G-bgG)+Math.abs(B-bgB) > 50)){
          mask[y*N+x]=1; fgCount++;
          fgColors[y*N+x] = '#'+[R,G,B].map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');
        }
      }
      if(fgCount < 10){ resolve(null); return; }  // 前景太少
      // 前景包围盒 → 决定各轴比例
      let minx=N,miny=N,maxx=-1,maxy=-1;
      for(let y=0;y<N;y++)for(let x=0;x<N;x++)if(mask[y*N+x]){ if(x<minx)minx=x; if(y<miny)miny=y; if(x>maxx)maxx=x; if(y>maxy)maxy=y; }
      const w=(maxx-minx+1)/N, h=(maxy-miny+1)/N;
      const depth = Math.min(w,h)*0.6;  // Z 轴厚度取宽高中较小值
      // 返回单个 SDF 形状：XY 平面命中剪影 + Z 在厚度内
      const halfZ = depth/2;
      const cxF=(minx+maxx)/(2*N)*2-1, cyF=(miny+maxy)/(2*N)*2-1;
      const kx=N/2, ky=N/2;
      resolve([{
        name: '剪影物体',
        color: primaryColor,
        sdf: p=>{
          const ix = Math.round((p[0]+1)*kx), iy = Math.round((p[1]+1)*ky);
          const inMask = (ix>=0 && ix<N && iy>=0 && iy<N) ? mask[iy*N+ix] : 0;
          const zInside = Math.abs(p[2]) <= halfZ ? 0 : (Math.abs(p[2])-halfZ);
          // 前景外：距离 = 到前景边界的近似（用简单外扩弥散）
          if(!inMask){
            // 简单版本：采样周围像素最近的前景距
            let minDist = 100;
            for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){
              const tx=ix+dx, ty=iy+dy;
              if(tx>=0&&tx<N&&ty>=0&&ty<N&&mask[ty*N+tx]){ minDist=Math.min(minDist, Math.hypot(dx/N*2, dy/N*2)); }
            }
            const d = minDist===100 ? 0.5 : minDist;
            return Math.max(d, Math.max(zInside, 0));
          }
          return zInside;
        },
      }]);
    };
    img.src = imgDataUrl;
  });
}

// ---- 删除与人体模型（头 + 颈 + 躯干）重合的体素 ----
//  优先使用 mannequin.bodyBlocks 做精确全身检测；无模特时回退到头部球体近似。
function removeBodyOverlap(parts, pos, voxelSize){
  if (!parts || !parts.length) return parts;
  const useBody = mannequin && mannequin.userData.bodyBlocks;
  const anchor = aiHeadAnchor();
  const headC = anchor.center, headR = anchor.radius * 0.92;
  const wp = new THREE.Vector3();
  let removed = 0;
  parts.forEach(p=>{
    const keep = {};
    for(const k in p.voxels){
      const [x,y,z] = parseKey(k);
      const wx = pos.x + (x+0.5)*voxelSize, wy = pos.y + (y+0.5)*voxelSize, wz = pos.z + (z+0.5)*voxelSize;
      let blocked;
      if (useBody){ wp.set(wx, wy, wz); blocked = mannequin.userData.bodyBlocks(wp, 1.0); }
      else { blocked = Math.hypot(wx-headC.x, wy-headC.y, wz-headC.z) < headR; }
      if (!blocked) keep[k] = p.voxels[k];
      else removed++;
    }
    p.voxels = keep;
  });
  if (removed > 0) console.log(`[AI] 已删除与人体重合的 ${removed} 个体素`);
  return parts.filter(p=>Object.keys(p.voxels).length > 0);
}
// ---- 颜色工具：用于逐体素配色（渐变 / 明暗 / 稳定噪声）----
function hexToRgb(h){ h=(h||'#000000').replace('#',''); if(h.length===3) h=h[0]+h[0]+h[1]+h[1]+h[2]+h[2]; return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)]; }
function rgbToHex(rgb){ return '#'+rgb.map(v=>{ v=Math.max(0,Math.min(255,Math.round(v))); return v.toString(16).padStart(2,'0'); }).join(''); }
// 两色线性混合，t∈[0,1]
function mixHex(a,b,t){ const A=hexToRgb(a),B=hexToRgb(b); t=Math.max(0,Math.min(1,t)); return rgbToHex([A[0]+(B[0]-A[0])*t, A[1]+(B[1]-A[1])*t, A[2]+(B[2]-A[2])*t]); }
// 整体加深/提亮，amt 为各通道加减值
function shadeHex(a,amt){ const A=hexToRgb(a); return rgbToHex([A[0]+amt,A[1]+amt,A[2]+amt]); }
// 稳定伪随机噪声（同一坐标恒定），范围 [0,1)
function vnoise(x,y,z){ const n=Math.sin(x*127.1+y*311.7+(z||0)*74.7)*43758.5453; return n-Math.floor(n); }
// 以坐标为种子的对称抖动，范围约 [-amt,amt]
function jitter(p,amt,freq){ freq=freq||9; return (vnoise(p[0]*freq,p[1]*freq,p[2]*freq)-0.5)*2*amt; }

// 颜色相似度（0..1）：全局，AI 生成时使用。
//  越大 -> 每个物件配色越偏向单一（其代表色）；0 -> 完全保留预设的丰富配色
let aiColorSim = 0;
// 把各组件的体素配色按相似度 t 向该组件代表色收敛（t=0 不变，t=1 变为纯代表色）
function applyColorSimilarity(parts, t){
  t = Math.max(0, Math.min(1, t || 0));
  if (t <= 0 || !parts) return parts;
  parts.forEach(p => {
    const target = normHex(p.color) || '#cccccc';
    for (const k in p.voxels){
      const cur = normHex(p.voxels[k]) || target;
      p.voxels[k] = mixHex(cur, target, t);
    }
  });
  return parts;
}

// ---- SDF 基元（返回到表面的有向距离，<0 在内部）----
const SDF = {
  // 球
  sphere: (p, c, r)=> Math.hypot(p[0]-c[0], p[1]-c[1], p[2]-c[2]) - r,
  // 圆角盒：half 为半尺寸，round 为圆角半径 -> 天然不方正
  roundBox: (p, c, half, round=0.06)=>{
    const qx=Math.abs(p[0]-c[0])-half[0]+round, qy=Math.abs(p[1]-c[1])-half[1]+round, qz=Math.abs(p[2]-c[2])-half[2]+round;
    const ox=Math.max(qx,0), oy=Math.max(qy,0), oz=Math.max(qz,0);
    return Math.hypot(ox,oy,oz) + Math.min(Math.max(qx,qy,qz),0) - round;
  },
  // 沿 Y 的圆柱（可当扁圆盘）
  cylY: (p, c, r, hh)=>{
    const d = Math.hypot(p[0]-c[0], p[2]-c[2]) - r;
    const dy = Math.abs(p[1]-c[1]) - hh;
    const ox=Math.max(d,0), oy=Math.max(dy,0);
    return Math.min(Math.max(d,dy),0) + Math.hypot(ox,oy);
  },
  // 沿 Y 的圆锥（底半径 r，从 y0 到 y1 收成尖）
  coneY: (p, c, r, y0, y1)=>{
    const t = Math.max(0, Math.min(1, (p[1]-(c[1]+y0))/(y1-y0)));
    const rr = r*(1-t);
    const d = Math.hypot(p[0]-c[0], p[2]-c[2]) - rr;
    const dy = Math.max((c[1]+y0)-p[1], p[1]-(c[1]+y1));
    return Math.max(d, dy);
  },
  // 胶囊（两端球头的圆柱，用于四肢/剑柄，圆润）
  capsuleY: (p, c, r, y0, y1)=>{
    const py = Math.max(c[1]+y0, Math.min(c[1]+y1, p[1]));
    return Math.hypot(p[0]-c[0], p[1]-py, p[2]-c[2]) - r;
  },
  // 沿 Y 的圆台（y0 处半径 r0 → y1 处半径 r1；r0<r1 即向上外扩的喇叭/漏斗）
  frustumY: (p, c, y0, y1, r0, r1)=>{
    const t = Math.max(0, Math.min(1, (p[1]-(c[1]+y0))/(y1-y0)));
    const rr = r0 + (r1-r0)*t;
    const d = Math.hypot(p[0]-c[0], p[2]-c[2]) - rr;
    const dy = Math.max((c[1]+y0)-p[1], p[1]-(c[1]+y1));
    return Math.max(d, dy);
  },
  union: (a,b)=> Math.min(a,b),
  sub: (a,b)=> Math.max(a,-b),
};

// ---- 把一组"形状(shape)"体素化：每个 shape = { sdf(p)->dist, color }，共享分辨率 res ----
// 归一化空间坐标范围 [-1,1]×[low..high]，采样到整数体素网格
function voxelizeShapes(shapes, res, scaleXYZ){
  // res：最长轴体素数；scaleXYZ：各轴相对比例（用于图片形态/物体比例）
  const sx = scaleXYZ ? scaleXYZ[0] : 1, sy = scaleXYZ ? scaleXYZ[1] : 1, sz = scaleXYZ ? scaleXYZ[2] : 1;
  const nx = Math.max(3, Math.round(res*sx)), ny = Math.max(3, Math.round(res*sy)), nz = Math.max(3, Math.round(res*sz));
  const comps = shapes.map(s=>({ name:s.name, color:s.color, voxels:{} }));
  // 每个体素中心映射到归一化坐标 [-1,1]（各轴独立），判定属于哪个 shape（取最近 sdf<0）
  for(let ix=0;ix<nx;ix++){
    const px = (ix+0.5)/nx*2-1;
    for(let iy=0;iy<ny;iy++){
      const py = (iy+0.5)/ny*2-1;
      for(let iz=0;iz<nz;iz++){
        const pz = (iz+0.5)/nz*2-1;
        const p = [px,py,pz];
        let best=-1, bestD=Infinity;
        for(let si=0;si<shapes.length;si++){
          const d = shapes[si].sdf(p);
          if (d < 0 && d < bestD){ bestD=d; best=si; }
        }
        if (best>=0){
          const sh = shapes[best];
          // 逐体素配色：优先 colorFn(p)，否则用固定 color
          const col = sh.colorFn ? sh.colorFn(p, [ix,iy,iz]) : sh.color;
          comps[best].voxels[keyOf(ix,iy,iz)] = col || sh.color;
        }
      }
    }
  }
  return comps.filter(c=>Object.keys(c.voxels).length);
}

// ---- 统计各组件体素总数 ----
function totalVoxels(parts){ let n=0; if(parts) parts.forEach(p=>n+=Object.keys(p.voxels).length); return n; }

/* ---- 贪心合并同色小体素为"大体素"（同物件内混合体素大小的核心优化） ----
 * 只合并「纯色 + 方块 + 无单面覆盖」的体素（形状/朝向修饰或单面上色的体素语义上
 * 不能简单合并，原样保留）：把相邻、颜色完全相同、能拼成 N×N×N 立方体的若干个
 * 1×1×1 小体素替换为 1 个 N× 大体素，视觉完全不变（同色同形状拼接本就无缝），
 * 但体素条目数量大幅减少——大面积同色平面（如相机机身面板）会自动变成少数几个
 * 大体素，细节区域（旋钮、圆环等逐格变色的部分）颜色不一致，天然不会被合并，
 * 因而保持原有精细度。maxMult 限制单边最大合并倍数（默认 3，对应编辑器手动可选的
 * 最大档位）。
 */
function mergeUniformVoxelBlocks(voxels, maxMult){
  maxMult = maxMult > 1 ? Math.round(maxMult) : 3;
  const eligible = {}; // key -> "hex|alpha" 组合（可参与合并的纯色方块）
  const keep = {};     // 原样保留（非纯色方块，如带形状/朝向/单面覆盖/透明度的体素）
  for (const k in voxels) {
    const v = voxels[k];
    const dec = decodeVoxel(v);
    if ((!dec.shape || dec.shape === SHAPE_CUBE) && !dec.faces && (!dec.mult || dec.mult === 1)) {
      const a = (dec.alpha != null && dec.alpha < 1 - 1e-6) ? dec.alpha : null;
      eligible[k] = (normHex(dec.hex) || dec.hex) + (a != null ? '|' + a.toFixed(4) : '');
    } else {
      keep[k] = v;
    }
  }
  const used = new Set();
  const out = {};
  for (const k in eligible) {
    if (used.has(k)) continue;
    const [x0,y0,z0] = parseKey(k);
    const token = eligible[k];
    const pipe = token.indexOf('|');
    const col = pipe >= 0 ? token.slice(0, pipe) : token;
    const alpha = pipe >= 0 ? parseFloat(token.slice(pipe + 1)) : 1;
    let m = 1;
    while (m < maxMult) {
      const nm = m + 1;
      let ok = true;
      for (let dx=0; dx<nm && ok; dx++) for (let dy=0; dy<nm && ok; dy++) for (let dz=0; dz<nm && ok; dz++) {
        if (dx<m && dy<m && dz<m) continue; // 已在更小立方体内确认过，跳过重复检查
        const kk = keyOf(x0+dx, y0+dy, z0+dz);
        if (used.has(kk) || eligible[kk] !== token) { ok = false; break; }
      }
      if (!ok) break;
      m = nm;
    }
    for (let dx=0; dx<m; dx++) for (let dy=0; dy<m; dy++) for (let dz=0; dz<m; dz++) used.add(keyOf(x0+dx,y0+dy,z0+dz));
    out[k] = m > 1 ? encodeVoxel(col, SHAPE_CUBE, 0, null, m, alpha) : (alpha < 1 - 1e-6 ? encodeVoxel(col, SHAPE_CUBE, 0, null, 1, alpha) : col);
  }
  Object.assign(out, keep);
  return out;
}

// ---- 按"目标体素总数(budget)"搜索最合适的分辨率 res ----
//  体素数随 res 单调递增，用二分逼近；过程中记录所有访问过的 res 里总数最接近 budget 的一档。
//  返回 { parts, res, total }。
function voxelizeToBudget(shapes, budget, scaleXYZ){
  let lo = 3, hi = 96;                       // res 上限防止体素爆炸（96³ 采样二分只需 ~7 次）
  let best = null, bestRes = lo, bestTotal = 0, bestDiff = Infinity;
  while (lo <= hi){
    const mid = (lo + hi) >> 1;
    const parts = voxelizeShapes(shapes, mid, scaleXYZ);
    const n = totalVoxels(parts);
    const diff = Math.abs(n - budget);
    if (diff < bestDiff){ bestDiff = diff; best = parts; bestRes = mid; bestTotal = n; }
    if (n === budget) break;
    if (n < budget) lo = mid + 1; else hi = mid - 1;
  }
  return { parts: best || [], res: bestRes, total: bestTotal };
}

// ---- 物品库：返回"参数化形状"数组（连续几何，随分辨率变平滑）----
// 归一化空间：x,z ∈ [-1,1]，y ∈ [-1,1]（底-1 顶+1）。tune: baseHex 影响主色，aspect 影响比例
function aiBuildShapes(text, baseHex){
  const t = text || '';
  const S = SDF;
  const cx=0, cz=0;

  // 豪华汉堡2（精细版 — 50000+体素级，参照爆炸图与实拍）
  // 层次（自底向上）：底面包烤切面 → 特调沙拉酱 → 荷叶边生菜 → 厚切番茄 → 紫洋葱圈 → 厚切炙烤牛肉饼 → 瀑布融化芝士 → 芝麻顶面包
  if (/汉堡预设2|汉堡2|豪华汉堡|特制汉堡|burger2|hamburger2/.test(t)){
    return [
      // ── 1. 底层面包 ──────────────────────────────
      // 爆炸图可见切面：顶面有浓郁烤焦网格纹+金黄面包芯；外表面浅麦黄，底部略深
      { name:'底面包', color:'#c97c2a', colorFn:p=>{
          const up = Math.max(0, Math.min(1, (p[1]+0.92)/0.32));
          let c = mixHex('#a86120','#dfa054', up);                  // 底深→顶金黄
          // 切面烤焦网格纹（顶面 y ≈ -0.60）——用平滑渐变代替硬阈值，
          // 并按高度做淡入：避免在圆柱转球面的夹角（凹角）处，网格线因走样
          // 叠加出锐利的尖角状深色团块（"贴图不正常"的锯齿斑）。
          if (p[1] > -0.60){
            const band = Math.max(0, Math.min(1, (p[1]+0.60)/0.14));
            const sx = Math.max(0, (Math.sin(p[0]*18) - 0.42) / 0.58);
            const sz = Math.max(0, (Math.sin(p[2]*18) - 0.42) / 0.58);
            c = shadeHex(c, -(Math.max(sx,sz)*28 + sx*sz*18) * band);
          }
          if (p[1] < -0.84) c = shadeHex(c, -16);                   // 底部焦化
          return shadeHex(c, jitter(p,11,9));
        }, sdf:p=> S.union(
          S.cylY(p,[cx,-0.76,cz],0.84,0.14),
          S.sphere(p,[cx,-0.88,cz],0.87)
        ) },

      // ── 2. 特调沙拉酱 ────────────────────────────
      // 爆炸图清晰可见粉橙千岛酱铺在底面包上，带黑胡椒香草碎微粒
      { name:'特调沙拉酱', color:'#e8a07a', colorFn:p=>{
          let c = mixHex('#e09068','#f0b898', vnoise(p[0]*8,p[2]*8,p[1]*6));
          // 黑胡椒颗粒
          if (vnoise(p[0]*38,p[1]*38,p[2]*38) > 0.84) c = mixHex(c,'#2c1a0e',0.85);
          // 香草碎（细小墨绿点）
          else if (vnoise(p[0]*44,p[2]*44,p[1]*22) > 0.88) c = mixHex(c,'#3a6e28',0.7);
          return c;
        }, sdf:p=>{
          const wob = 0.018*Math.sin(p[0]*13)*Math.cos(p[2]*11);
          return S.roundBox(p,[cx,-0.60+wob,cz],[0.74,0.032,0.74],0.042);
        } },

      // ── 3. 荷叶边皱折生菜 ────────────────────────
      // 参考图1叶片超宽、边缘强烈褶皱；爆炸图叶边极度锯齿荷叶边
      { name:'皱折生菜', color:'#5ab832', colorFn:p=>{
          const t2 = vnoise(p[0]*7,p[2]*7,p[1]*5);
          let c = mixHex('#2d6e15','#7ccc38', t2);
          // 叶脉（乳白色细线条，沿径向分布）
          const ang = Math.atan2(p[2],p[0]);
          const rad = Math.hypot(p[0],p[2]);
          if (Math.abs(Math.sin(ang*9 + rad*3.5)) > 0.90 && rad < 0.82)
            c = mixHex(c,'#c8eea0',0.55);
          // 叶边泛浅黄绿
          if (rad > 0.88) c = mixHex(c,'#d2f0a0',0.35);
          return shadeHex(c, jitter(p,9,11));
        }, sdf:p=>{
          const ang = Math.atan2(p[2],p[0]);
          const rad = Math.hypot(p[0],p[2]);
          // 多频叠加：大波浪+中褶皱+小锯齿
          const wob = 0.072*Math.sin(ang*7)*Math.cos(rad*3.8)
                    + 0.038*Math.sin(ang*13+1.2)*Math.sin(rad*6.5)
                    + 0.022*Math.cos(p[0]*18+p[2]*14);
          return S.cylY(p,[cx,-0.46+wob,cz],1.00,0.065);
        } },

      // ── 4. 厚切番茄片 ────────────────────────────
      // 爆炸图切面清晰：同心果肉环、放射状籽室(6瓣)、橙黄色番茄籽、鲜红果皮
      { name:'厚切番茄', color:'#d43420', colorFn:p=>{
          const rad = Math.hypot(p[0],p[2]);
          const ang = Math.atan2(p[2],p[0]);
          let c = mixHex('#b82414','#e85040', vnoise(p[0]*6,p[2]*6,0));
          // 同心果肉环（3圈由外到内逐渐变橙）
          const ring = (Math.sin(rad*14)+1)*0.5;
          c = mixHex(c,'#f07050', ring*0.28);
          // 放射状籽室（6瓣）
          const spoke = Math.sin(ang*6);
          if (spoke > 0.55 && rad < 0.72) {
            c = mixHex(c,'#f8d090',0.55);   // 籽腔浅橙黄
            if (vnoise(p[0]*28,p[2]*28,0) > 0.74)
              c = mixHex(c,'#c8e840',0.5);  // 番茄籽绿色
          }
          // 外缘表皮深红
          if (rad > 0.80) c = shadeHex(c,-24);
          return shadeHex(c, jitter(p,8,10));
        }, sdf:p=> S.cylY(p,[cx,-0.315,cz],0.88,0.062) },

      // ── 5. 紫洋葱圈 ──────────────────────────────
      // 参考图1叠放一圈半，爆炸图为单圆切片；外缘紫红，内部白+淡紫年轮
      { name:'紫洋葱圈', color:'#9e4080', colorFn:p=>{
          const rad = Math.hypot(p[0],p[2]);
          // 同心年轮
          const ring = (Math.sin(rad*20)+1)*0.5;
          let c = rad > 0.50
            ? mixHex('#7a2860','#b85090', ring)      // 外层紫红
            : mixHex('#f0e4ef','#ccaaca', ring);     // 内层白紫
          // 年轮分隔线
          if (Math.abs(Math.sin(rad*20)) < 0.12) c = shadeHex(c,-20);
          return shadeHex(c, jitter(p,7,9));
        }, sdf:p=> S.cylY(p,[cx,-0.218,cz],0.84,0.038) },

      // ── 6. 厚切炙烤黑椒牛肉饼 ────────────────────
      // 爆炸图：超厚、炭黑表面、顶面密集炙烤烤纹、粗糙颗粒、边缘焦化
      { name:'炙烤牛肉饼', color:'#5c3010', colorFn:p=>{
          // 基础：深红褐炙烤肉色
          let c = mixHex('#4c280e','#7c4825', vnoise(p[0]*11,p[1]*11,p[2]*11));
          c = shadeHex(c, jitter(p,22,16));          // 粗糙颗粒感
          // 顶面炙烤平行焦纹（双向格纹）——同样改为平滑渐变 + 按高度淡入，
          // 避开肉饼表面凹凸(bump)较大处产生的锐利走样团块
          const pband = Math.max(0, Math.min(1, (p[1]+0.02)/0.10));
          if (pband > 0){
            const gx = Math.max(0, (Math.sin(p[0]*17) - 0.45) / 0.55);
            const gz = Math.max(0, (Math.sin(p[2]*14+0.8) - 0.45) / 0.55);
            c = mixHex(c,'#180a02', gx*0.75*pband); // X向烤纹
            c = mixHex(c,'#1e0c04', gz*0.60*pband); // Z向
          }
          // 边缘焦化（炭烤深黑）
          const rad2 = Math.hypot(p[0],p[2]);
          if (rad2 > 0.76) c = mixHex(c,'#0e0602',0.65);
          // 内部肉汁微红点
          if (p[1] < 0.0 && vnoise(p[0]*20,p[1]*20,p[2]*20) > 0.88)
            c = mixHex(c,'#a03020',0.5);
          // 黑椒颗粒（随机散布）
          if (vnoise(p[0]*45,p[1]*30,p[2]*45) > 0.88) c = mixHex(c,'#0c0806',0.9);
          return c;
        }, sdf:p=>{
          const bump = 0.032*vnoise(p[0]*14,p[1]*14,p[2]*14); // 表面凹凸
          return S.cylY(p,[cx,-0.055,cz],0.90+bump,0.155);
        } },

      // ── 7. 瀑布融化切达芝士 ──────────────────────
      // 参考图1芝士从肉饼顶面向下流淌包裹，四角/多点下垂成流体水滴
      { name:'融化芝士', color:'#f5b820', colorFn:p=>{
          let c = mixHex('#f0a010','#ffd84c', vnoise(p[0]*10,p[2]*10,p[1]*8));
          // 垂流边缘更橙（近芯更黄）
          const rad3 = Math.hypot(p[0],p[2]);
          if (rad3 > 0.80) c = mixHex(c,'#e07808',0.45);
          // 半融化高光斑
          if (vnoise(p[0]*16,p[1]*16,p[2]*16) > 0.80) c = mixHex(c,'#fff3a0',0.55);
          return c;
        }, sdf:p=>{
          const ang = Math.atan2(p[2],p[0]);
          const rad4 = Math.hypot(p[0],p[2]);
          // 4角主垂流 + 8波浪次级
          const drape4 = Math.pow(Math.abs(Math.sin(ang*4.0)),1.8);
          const drape8 = 0.4*Math.abs(Math.sin(ang*8.0+0.4));
          const drape  = Math.max(0, rad4-0.78) * 0.32 * (drape4+drape8);
          const cy = 0.110 - drape;
          return S.roundBox(p,[cx,cy,cz],[0.96,0.046,0.96],0.058);
        } },

      // ── 8. 饱满芝麻顶面包 ────────────────────────
      // 参考图1面包顶极饱满圆润；表面油亮金黄+焦化圈；密集立体白芝麻
      { name:'芝麻顶面包', color:'#d08830', colorFn:p=>{
          const up = Math.max(0,Math.min(1,(p[1]-0.20)/0.72));
          let c = mixHex('#c07528','#ecb458', up);   // 下部偏深→顶部金亮
          c = shadeHex(c, jitter(p,13,9));
          // 侧腰烘烤焦边
          if (p[1] < 0.28) c = shadeHex(c,-12);
          // 立体白芝麻（高密度覆盖顶部半球）
          if (p[1] > 0.38){
            // 球坐标格网 → 每格随机中心+倾角 → 椭球检测
            const sScale = 10.5;
            const gx = Math.floor(p[0]*sScale + 0.5);
            const gy = Math.floor(p[1]*sScale + 0.5);
            const gz = Math.floor(p[2]*sScale + 0.5);
            const seed = vnoise(gx*1.1, gy*2.3, gz*0.7);
            if (seed > 0.58){                         // 此格生长一粒芝麻
              const ox = p[0] - (gx/sScale);
              const oy = p[1] - (gy/sScale);
              const oz = p[2] - (gz/sScale);
              // 随机倾角（通过 seed 扰动局部坐标轴）
              const tilt = seed * 2.4;
              const lx = ox*Math.cos(tilt) + oz*Math.sin(tilt);
              const lz =-ox*Math.sin(tilt) + oz*Math.cos(tilt);
              // 椭球检测：长轴 0.038，短轴 0.020
              const sesame = Math.hypot(lx/0.038, oy/0.020, lz/0.020);
              if (sesame < 1.0){
                // 中心米白，边缘淡金
                c = sesame < 0.55
                  ? mixHex('#f8f0d8','#f0e0b0', sesame)
                  : mixHex('#f0e0b0','#d6b86a', (sesame-0.55)/0.45);
              }
            }
          }
          return c;
        }, sdf:p=> S.union(
          S.cylY(p,[cx,0.28,cz],0.84,0.082),
          S.sphere(p,[cx,0.36,cz],0.86)
        ) },
    ];
  }

  // 汉堡：参考实拍分层 —— 底面包 / 生菜 / 番茄 / 洋葱 / 肉饼 / 芝士 / 芝麻顶面包
  // 每层用 colorFn 逐体素配色（渐变+噪声+纹理），避免整层单色
  if (/汉堡|burger|hamburger|三明治/.test(t)){
    return [
      // 底面包：金黄烘烤，底部略深、侧面偏浅，含焙烤斑点
      { name:'底层面包', color:'#d68b42', colorFn:p=>{
          const up = (p[1]+0.95)/0.4;                 // 从底到顶
          let c = mixHex('#b06a2c', '#e2a55e', Math.max(0,Math.min(1,up)));
          c = shadeHex(c, jitter(p, 12, 8));           // 烘烤斑驳
          if (p[1] < -0.86) c = shadeHex(c, -14);      // 底面焦色
          return c;
        }, sdf:p=> S.union(S.cylY(p,[cx,-0.72,cz],0.82,0.14), S.sphere(p,[cx,-0.86,cz],0.86)) },
      // 生菜：起伏最宽的一层，明暗多变的绿
      { name:'生菜', color:'#6fbf46', colorFn:p=>{
          const t2 = vnoise(p[0]*6.5, p[2]*6.5, p[1]*6.5);
          let c = mixHex('#3c7d28', '#8fd257', t2);    // 深绿↔嫩绿
          c = shadeHex(c, jitter(p, 10, 11));
          if (Math.hypot(p[0],p[2]) > 0.82) c = mixHex(c, '#e9f3cf', 0.25); // 叶缘泛白
          return c;
        }, sdf:p=>{ const wob=0.09*Math.sin(p[0]*8)*Math.cos(p[2]*8); return S.cylY(p,[cx,-0.48+wob,cz],0.99,0.075); } },
      // 番茄：红润果肉，中心带籽室浅色放射
      { name:'番茄', color:'#d8402f', colorFn:p=>{
          const rad = Math.hypot(p[0],p[2]);
          let c = mixHex('#c22f22', '#e8674c', vnoise(p[0]*7,p[2]*7,0));
          if (rad < 0.5) c = mixHex(c, '#f3b7a0', 0.35 * (1-rad/0.5)); // 中央果肉更浅
          const spoke = Math.sin(Math.atan2(p[2],p[0])*6);            // 放射籽室
          if (spoke > 0.6 && rad < 0.7) c = mixHex(c, '#f6d9a0', 0.4);
          return c;
        }, sdf:p=> S.cylY(p,[cx,-0.34,cz],0.9,0.055) },
      // 洋葱：紫红外环 + 白色内环
      { name:'洋葱', color:'#a4497f', colorFn:p=>{
          const rad = Math.hypot(p[0],p[2]);
          const ring = (Math.sin(rad*22) + 1) / 2;                    // 同心环纹
          let c = rad > 0.55 ? mixHex('#8e3b6e', '#c06aa0', ring)
                             : mixHex('#efe1ec', '#d3aecb', ring);
          return shadeHex(c, jitter(p, 8, 12));
        }, sdf:p=> S.cylY(p,[cx,-0.25,cz],0.86,0.04) },
      // 肉饼：厚实炙烤，边缘焦化 + 表面烤纹 + 粗糙颗粒
      { name:'肉饼', color:'#6b4020', colorFn:p=>{
          let c = mixHex('#5c3618', '#7d4b25', vnoise(p[0]*10,p[1]*10,p[2]*10));
          c = shadeHex(c, jitter(p, 20, 14));          // 粗糙颗粒感
          const rad = Math.hypot(p[0],p[2]);
          if (rad > 0.74) c = shadeHex(c, -32);        // 边缘焦化
          if (Math.sin(p[0]*13) > 0.55 && p[1] > -0.06) c = shadeHex(c, -22); // 顶面烤纹
          if (p[1] > 0.02 && vnoise(p[0]*16,0,p[2]*16) > 0.85) c = shadeHex(c, 26); // 高光焦点
          return c;
        }, sdf:p=> S.cylY(p,[cx,-0.08,cz],0.9,0.125) },
      // 芝士：融化的橙黄，边缘垂流、表面亮斑
      { name:'芝士', color:'#f7bd2c', colorFn:p=>{
          let c = mixHex('#f0a81f', '#ffd85a', vnoise(p[0]*9,p[2]*9,p[1]*9));
          if (p[1] < 0.02) c = mixHex(c, '#e8971a', 0.5);   // 下缘更橙（垂流）
          if (vnoise(p[0]*14,p[1]*14,p[2]*14) > 0.82) c = mixHex(c, '#fff0b0', 0.6); // 高光
          return c;
        }, sdf:p=>{
          // 略宽于肉饼的薄片，边缘按方位起伏形成下垂融化感
          const ang = Math.atan2(p[2], p[0]);
          const wob = 0.025*Math.sin(p[0]*9) + 0.03*Math.sin(ang*7);
          return S.roundBox(p,[cx,0.085+wob,cz],[0.95,0.05,0.95],0.06);
        } },
      // 顶面包：饱满圆顶 + 散布芝麻
      { name:'顶层面包', color:'#d98f45', colorFn:(p)=>{
          const up = (p[1]-0.18)/0.6;
          let c = mixHex('#c67d34', '#eab063', Math.max(0,Math.min(1,up))); // 顶部受光更亮
          c = shadeHex(c, jitter(p, 12, 8));
          // 芝麻：圆顶上半部按栅格散点，米白椭斑
          if (p[1] > 0.34){
            const gx=Math.floor(p[0]*9), gy=Math.floor(p[1]*9), gz=Math.floor(p[2]*9);
            if (vnoise(gx,gy,gz) > 0.7) c = mixHex('#f7ead0', '#e9d29a', vnoise(p[2]*5,p[0]*5,0));
          }
          return c;
        }, sdf:p=> S.union(S.cylY(p,[cx,0.30,cz],0.8,0.08), S.sphere(p,[cx,0.36,cz],0.82)) },
    ];
  }
  // 留声机（复古留声机 — 完善版，参照低模参考图）
  //  结构：三层台阶底座 → 木质箱体(正面嵌板) → 黑胶唱片(红标) → 唱针臂 → 黄铜弯颈(双环) → 巨大花瓣喇叭(金边) → 侧摇把
  if (/留声机|唱机|唱片机|gramophone|phonograph|grammophon/.test(t)){
    const brass = '#b8860b';                 // 黄铜主色
    const brightBrass = '#d4af37';           // 亮黄铜（环/边）
    const hornCz = -0.06;                    // 喇叭中心偏后
    const hornBaseY = 0.450;                 // 喇叭起始 Y
    const hornH = 1.08;                       // 喇叭总高度
    return [
      // ════════════════════════════════════════
      //  底座系统 — 三层台阶式（由宽→窄逐层收进）
      // ════════════════════════════════════════

      // 第1层：最下层踢脚板（最深最宽）
      { name:'底座底层', color:'#361c0b',
        sdf:p=> S.roundBox(p,[cx,-0.96,cz],[0.70,0.040,0.62],0.028) },

      // 第2层：中间台座
      { name:'底座中层', color:'#4a2812',
        sdf:p=> S.roundBox(p,[cx,-0.90,cz],[0.65,0.048,0.57],0.030) },

      // 第3层：木箱主箱体（木质，竖直木纹 + 受光明暗）
      { name:'木箱底座', color:'#6b4226', colorFn:p=>{
          let c = mixHex('#4a2812', '#7d4a24', vnoise(p[0]*4.5, p[1]*5.5, p[2]*4));
          if (Math.sin(p[0]*28) > 0.54) c = shadeHex(c, -14);
          if (p[1] > -0.44) c = shadeHex(c, 11);
          return shadeHex(c, jitter(p, 6, 10));
        }, sdf:p=> S.roundBox(p,[cx,-0.66,cz],[0.58,0.30,0.50],0.052) },

      // 正面装饰嵌板（圆角矩形，略凹于表面）
      { name:'正面嵌板', color:'#593520', colorFn:p=>{
          const pc = mixHex('#482c18', '#6b4226', vnoise(p[0]*9, 0, p[2]*3.5));
          return shadeHex(pc, jitter(p, 4, 6) - 10);
        }, sdf:p=> S.roundBox(p,[cx,-0.615,0.274],[0.26,0.148,0.008],0.022) },

      // 嵌板内框线（细边框装饰）
      { name:'嵌板框线', color:'#3d2414',
        sdf:p=> {
          const b = S.roundBox(p,[cx,-0.615,0.280],[0.26,0.148,0.002],0.022);
          const i = S.roundBox(p,[cx,-0.615,0.280],[0.22,0.122,0.004],0.018);
          return Math.max(b, -i);
        } },

      // ════════════════════════════════════════
      //  顶面托盘与唱片系统
      // ════════════════════════════════════════

      // 顶盖托盘（放唱片的平台，略前伸）
      { name:'顶盖托盘', color:'#7a4a28', colorFn:p=>
        shadeHex(mixHex('#6b4226','#8c5a32',vnoise(p[0]*5.5,0,p[2]*5)), jitter(p,5,8)),
        sdf:p=> S.roundBox(p,[cx,-0.348,0.022],[0.60,0.030,0.52],0.040) },

      // 托盘边缘金线（一圈细黄铜饰条）
      { name:'托盘金边', color:brightBrass,
        sdf:p=> {
          const outer = S.roundBox(p,[cx,-0.346,0.022],[0.60,0.032,0.52],0.040);
          const inner = S.roundBox(p,[cx,-0.344,0.022],[0.57,0.024,0.49],0.036);
          return Math.max(outer, -inner);
        } },

      // 黑胶唱片主体（密集同心凹槽反光）
      { name:'黑胶唱片', color:'#121214', colorFn:p=>{
          const rad = Math.hypot(p[0], p[2]-0.044);
          const groove = (Math.sin(rad*72)+1)/2;
          // 径向明暗变化（中心稍亮）
          const radialFade = Math.max(0, 1 - rad/0.44);
          return shadeHex('#151517', groove*15 + radialFade*6);
        }, sdf:p=> S.cylY(p,[cx,-0.315,0.044],0.420,0.018) },

      // 唱片中心标签（红色，参照参考图2）
      { name:'唱片红标', color:'#c74b32', colorFn:p=> shadeHex('#d45840', jitter(p,6,9)),
        sdf:p=> S.cylY(p,[cx,-0.300,0.044],0.130,0.020) },

      // 标签中心金色小圆点（模拟唱片区轴孔）
      { name:'标签轴心', color:brightBrass,
        sdf:p=> S.cylY(p,[cx,-0.294,0.044],0.024,0.024) },

      // ════════════════════════════════════════
      //  唱针臂系统（右后区域）
      // ════════════════════════════════════════

      // 臂支柱（右后角黄铜立柱）
      { name:'臂支柱', color:brass, colorFn:p=>
        shadeHex(mixHex('#98751a','#dbb84a',(p[1]+0.26)/0.13), jitter(p,5,7)),
        sdf:p=> S.cylY(p,[0.462,-0.198,-0.202],0.046,0.102) },

      // 支柱顶部装饰环（水平环绕）
      { name:'支柱金环', color:brightBrass,
        sdf:p=> S.roundBox(p,[0.462,-0.142,-0.202],[0.056,0.012,0.056],0.004) },

      // 唱针臂横杆（从支柱向左前方延伸至唱片上方）
      { name:'唱针臂', color:'#cba83c', colorFn:p=> shadeHex('#cba83c', jitter(p,4,6)),
        sdf:p=> S.roundBox(p,[0.175,-0.142,-0.058],[0.305,0.026,0.026],0.022) },

      // 唱头拾音器（臂末端深色方块）
      { name:'唱头', color:'#2a2e39',
        sdf:p=> S.roundBox(p,[-0.088,-0.206,0.032],[0.052,0.038,0.032],0.018) },

      // 唱针尖（微小深色探针）
      { name:'唱针尖', color:'#1a1c24',
        sdf:p=> S.roundBox(p,[-0.098,-0.228,0.038],[0.010,0.018,0.010],0.004) },

      // ════════════════════════════════════════
      //  侧面摇把（手动发条曲柄，参考图2右侧）
      // ════════════════════════════════════════

      // 摇把安装座（箱体右侧面的小圆柱基座）
      { name:'摇把座', color:brass,
        sdf:p=> S.cylY(p,[0.585,-0.545,0.120],0.026,0.082) },

      // 摇把曲柄（横向伸出的小杆）
      { name:'摇把曲柄', color:'#8b6914',
        sdf:p=> S.roundBox(p,[0.668,-0.518,0.120],[0.102,0.022,0.022],0.018) },

      // 摇把握球（末端的球形旋钮）
      { name:'摇把握球', color:brass, colorFn:p=> shadeHex(brass, jitter(p,6,8)),
        sdf:p=> S.sphere(p,[0.732,-0.500,0.120],0.029) },

      // ════════════════════════════════════════
      //  黄铜弯颈（连接箱体与喇叭的弯曲管道 + 双装饰环）
      // ════════════════════════════════════════

      // 弯颈主管（下段直立 + 上段向后倾弯）
      { name:'弯颈主管', color:brass, colorFn:p=>{
          const t = Math.max(0, Math.min(1, (p[1]+0.06)/0.52));
          return shadeHex(mixHex('#967318','#ddb852', t), jitter(p,7,8));
        }, sdf:p=> S.union(
          S.cylY(p,[cx,-0.052,-0.202],0.058,0.260),               // 下段直立管
          S.union(
            S.cylY(p,[cx,0.245,-0.165],0.054,0.175),              // 中段微斜
            S.sphere(p,[cx,0.365,-0.115],0.056)                     // 顶端转接球
          )
        ) },

      // 弯颈下部金环（近底座的环）
      { name:'弯颈下环', color:brightBrass,
        sdf:p=> S.roundBox(p,[cx,0.018,-0.198],[0.070,0.014,0.070],0.005) },

      // 弯颈上部金环（近喇叭的环）
      { name:'弯颈上环', color:brightBrass,
        sdf:p=> S.roundBox(p,[cx,0.290,-0.146],[0.066,0.013,0.066],0.005) },

      // ════════════════════════════════════════
      //  喇叭系统（巨大花瓣喇叭 + 金边厚缘）
      // ════════════════════════════════════════

      // 喇叭喉部（窄过渡段，连接弯颈与喇叭主体）
      { name:'喇叭喉', color:brass,
        sdf:p=> S.frustumY(p,[cx,0.360,hornCz+0.035],0.078,0.165,0.052,0.105) },

      // 主喇叭体（巨型花瓣喇叭花：8瓣波浪棱线 + 深腔暗影 + 口缘金边）
      { name:'喇叭花', color:'#c9a227', colorFn:p=>{
          const up = Math.max(0, Math.min(1, (p[1] - hornBaseY) / hornH));

          // 纵向渐变：底部深黄铜 → 口部明亮金黄
          let c = mixHex('#987318', '#f2d46a', Math.pow(up, 0.75));

          // 极坐标（以喇叭轴线为中心）
          const ang = Math.atan2(p[2] - hornCz, p[0]);
          const rad = Math.hypot(p[0], p[2] - hornCz);

          // ── 8 瓣花瓣波浪分割线 ──
          const petalFreq = 8;
          const petalSin = Math.sin(ang * petalFreq);

          // 瓣谷凹陷（每瓣之间的深色沟壑，越往口部越明显）
          if (petalSin > 0.82) c = shadeHex(c, -36 * up);

          // 花瓣起伏造成的明暗交替
          const petalShade = petalSin * 10 * up;
          c = shadeHex(c, petalShade);

          // ── 喇叭内部深邃阴影 ──
          // 径向归一化（0=中心轴，1=喇叭口边缘）
          const normR = Math.min(1, rad / 0.68);
          // 越靠内且越靠下 → 越暗（模拟喇叭内部吸收光线）
          const cavity = Math.max(0, (1 - up) * (1 - normR * 0.6));
          if (cavity > 0.15 && normR < 0.75) c = shadeHex(c, -cavity * 28);

          // ── 喇叭口边缘厚金边 ──
          if (up > 0.86) {
            const edgeT = (up - 0.86) / 0.14;   // 边缘区归一化
            c = mixHex(c, '#ffe480', edgeT * 0.55);
            // 最外沿最亮
            if (normR > 0.80) c = mixHex(c, '#ffd700', (normR - 0.80) * 3.5);
          }

          // 全局黄铜金属斑驳
          return shadeHex(c, jitter(p, 9, 8));
        }, sdf:p=> S.frustumY(p,[cx,hornBaseY,hornCz],0.105,hornH,0.100,0.665) },

      // 喇叭口金边厚缘（独立的外围高亮环，强化"花边"视觉效果）
      { name:'喇叭金边', color:'#ffd54f', colorFn:p=>{
          const ang = Math.atan2(p[2] - hornCz, p[0]);
          // 8 波浪随动
          const wave = Math.sin(ang * 8) * 12;
          return shadeHex('#ffc800', wave + jitter(p, 4, 5));
        }, sdf:p=> {
          const rimY = hornBaseY + hornH;        // 与喇叭口齐平
          const dy = Math.abs(p[1] - rimY);
          const dxz = Math.hypot(p[0], p[2] - hornCz);
          const ri = 0.645, ro = 0.695;          // 内/外半径
          const rm = (ri + ro) * 0.5;
          const bw = (ro - ri) * 0.5;
          return Math.max(dy - 0.028, Math.abs(dxz - rm) - bw);
        } },

      // 喇叭内唇（口部内侧的一圈细微亮线，增加层次感）
      { name:'喇叭内唇', color:'#e8c860',
        sdf:p=> {
          const lipY = hornBaseY + hornH - 0.03;
          const dy = Math.abs(p[1] - lipY);
          const dxz = Math.hypot(p[0], p[2] - hornCz);
          const ri = 0.595, ro = 0.640;
          const rm = (ri + ro) * 0.5;
          const bw = (ro - ri) * 0.5;
          return Math.max(dy - 0.016, Math.abs(dxz - rm) - bw);
        } },
    ];
  }
  // 复古相机（135 单反/旁轴风格 — 精细版）
  //  结构：皮革机身 → 银色顶/底盖 → 突出镜头筒(对焦环/光圈环/前镜片) → 五棱镜取景器 → 热靴 → 快门钮 → 过片扳手 → 回卷/模式旋钮 → 品牌红点 → 背面取景目镜
  if (/相机|照相机|camera|单反|旁轴|拍立得|胶片机|菲林|复古相机/.test(t)){
    // 沿 Z 轴（朝向 +Z 前方）的圆柱基元 —— 镜头筒专用
    const cylZ = (p,c,r,hh)=>{
      const d = Math.hypot(p[0]-c[0], p[1]-c[1]) - r;
      const dz = Math.abs(p[2]-c[2]) - hh;
      const ox=Math.max(d,0), oz=Math.max(dz,0);
      return Math.min(Math.max(d,dz),0) + Math.hypot(ox,oz);
    };
    // 沿 Z 轴的环（圆环/装饰环）
    const ringZ = (p,c,ri,ro,hh)=>{
      const rad = Math.hypot(p[0]-c[0], p[1]-c[1]);
      const rm=(ri+ro)/2, bw=(ro-ri)/2;
      const dz = Math.abs(p[2]-c[2]) - hh;
      return Math.max(Math.abs(rad-rm)-bw, dz);
    };
    const chrome = '#c6ccd4';                 // 铬合金银
    const lensCx = -0.02, lensCy = -0.05;     // 镜头轴心（略偏左，仿真实机身）
    return [
      // ════════════════════════════════════════
      //  机身系统（皮革包裹主体 + 银色顶/底盖）
      // ════════════════════════════════════════

      // 主机身（黑色蒙皮，横向皮纹 + 磨砂噪声）
      { name:'机身', color:'#1e1e20', colorFn:p=>{
          let c = mixHex('#161618','#2b2b30', vnoise(p[0]*6, p[1]*6, p[2]*3.5));
          // 横向皮革压纹
          if (Math.sin(p[1]*64) > 0.35) c = shadeHex(c, -9);
          // 正/背面比侧面略亮
          if (Math.abs(p[2]) > 0.16) c = shadeHex(c, 6);
          return shadeHex(c, jitter(p, 5, 12));
        }, sdf:p=> S.roundBox(p,[cx,-0.05,cz],[0.58,0.30,0.22],0.05) },

      // 顶盖（银色，受光渐变）
      { name:'顶盖', color:chrome, colorFn:p=>
          shadeHex(mixHex('#9aa0a8','#eef2f7',(p[1]+0.35)/0.14), jitter(p,6,9)),
        sdf:p=> S.roundBox(p,[cx,0.29,cz],[0.575,0.055,0.205],0.04) },

      // 底盖（银色）
      { name:'底盖', color:chrome, colorFn:p=>
          shadeHex(mixHex('#8f959d','#cdd3db',(p[1]+0.44)/0.10), jitter(p,6,9)),
        sdf:p=> S.roundBox(p,[cx,-0.375,cz],[0.575,0.045,0.205],0.035) },

      // ════════════════════════════════════════
      //  镜头系统（朝 +Z 突出的镜头筒）
      // ════════════════════════════════════════

      // 镜头后座（机身连接的宽卡口环）
      { name:'镜头卡口', color:chrome, colorFn:p=> shadeHex(chrome, jitter(p,6,8)),
        sdf:p=> cylZ(p,[lensCx,lensCy,0.24],0.30,0.055) },

      // 镜头主筒（黑色磨砂）
      { name:'镜头筒', color:'#121214', colorFn:p=>{
          const t = Math.max(0, Math.min(1, (p[2]-0.20)/0.34));
          return shadeHex(mixHex('#0e0e10','#232327', t*0.6), jitter(p,6,10));
        }, sdf:p=> cylZ(p,[lensCx,lensCy,0.37],0.255,0.17) },

      // 对焦环（银色滚花环 — 竖向条纹）
      { name:'对焦环', color:chrome, colorFn:p=>{
          const ang = Math.atan2(p[1]-lensCy, p[0]-lensCx);
          const rib = Math.sin(ang*44) * 12;
          return shadeHex(mixHex('#a8aeb6','#e2e6ec',0.4), rib + jitter(p,4,6));
        }, sdf:p=> cylZ(p,[lensCx,lensCy,0.32],0.268,0.045) },

      // 光圈环（细银环，靠前）
      { name:'光圈环', color:'#b7bdc5', colorFn:p=>{
          const ang = Math.atan2(p[1]-lensCy, p[0]-lensCx);
          return shadeHex('#b7bdc5', Math.sin(ang*60)*9 + jitter(p,3,5));
        }, sdf:p=> cylZ(p,[lensCx,lensCy,0.44],0.262,0.028) },

      // 前镜圈（镜头最前的银色厚边框）
      { name:'前镜圈', color:chrome, colorFn:p=> shadeHex(chrome, jitter(p,5,7)),
        sdf:p=> ringZ(p,[lensCx,lensCy,0.53],0.205,0.262,0.03) },

      // 前镜片（蓝紫镀膜玻璃 — 径向渐变 + 高光）
      { name:'镜片', color:'#2f5170', colorFn:p=>{
          const rad = Math.hypot(p[0]-lensCx, p[1]-lensCy);
          let c = mixHex('#3a6a9a','#132638', Math.min(1, rad/0.205));
          // 左上高光点
          const hl = Math.hypot(p[0]-(lensCx-0.09), p[1]-(lensCy+0.08));
          if (hl < 0.07) c = mixHex(c,'#e6f0fa',(0.07-hl)/0.07*0.85);
          // 镀膜偏紫反光
          c = mixHex(c, '#6a4a8a', 0.12);
          return c;
        }, sdf:p=> cylZ(p,[lensCx,lensCy,0.525],0.202,0.022) },

      // ════════════════════════════════════════
      //  顶部取景器与操作件
      // ════════════════════════════════════════

      // 五棱镜取景器凸包（顶部中央梯形隆起）
      { name:'取景器', color:chrome, colorFn:p=>
          shadeHex(mixHex('#a2a8b0','#e8ecf2',(p[1]-0.34)/0.14), jitter(p,5,7)),
        sdf:p=> S.frustumY(p,[cx,0.345,-0.01],0.0,0.17,0.185,0.115) },

      // 热靴（取景器顶的插槽方块）
      { name:'热靴', color:'#26272b', colorFn:p=> shadeHex('#26272b', jitter(p,4,8)),
        sdf:p=> S.roundBox(p,[cx,0.52,-0.01],[0.085,0.022,0.06],0.012) },

      // 过片扳手（右侧扁平银拨杆）
      { name:'过片扳手', color:chrome, colorFn:p=> shadeHex(chrome, jitter(p,4,6)),
        sdf:p=> S.roundBox(p,[0.40,0.355,-0.06],[0.16,0.016,0.05],0.014) },

      // 快门按钮（右侧小圆钮，银座）
      { name:'快门钮', color:'#d9dde3', colorFn:p=> shadeHex('#d9dde3', jitter(p,4,6)),
        sdf:p=> S.cylY(p,[0.42,0.375,0.06],0.055,0.035) },

      // 模式/速度旋钮（右侧滚花旋钮）
      { name:'速度旋钮', color:chrome, colorFn:p=>{
          const ang = Math.atan2(p[2]+0.06, p[0]-0.34);
          return shadeHex(mixHex('#a0a6ae','#e0e4ea',0.4), Math.sin(ang*40)*10 + jitter(p,4,6));
        }, sdf:p=> S.cylY(p,[0.36,0.38,-0.08],0.095,0.045) },

      // 回卷旋钮（左侧滚花旋钮）
      { name:'回卷旋钮', color:chrome, colorFn:p=>{
          const ang = Math.atan2(p[2]+0.02, p[0]+0.42);
          return shadeHex(mixHex('#9ca2aa','#dde1e7',0.4), Math.sin(ang*36)*10 + jitter(p,4,6));
        }, sdf:p=> S.cylY(p,[-0.42,0.375,-0.02],0.085,0.05) },

      // 品牌红点（机身正面左上的红色标记）
      { name:'红点', color:'#d63b2f', colorFn:p=> shadeHex('#d63b2f', jitter(p,6,8)),
        sdf:p=> S.sphere(p,[-0.42,0.12,0.225],0.045) },

      // 背面取景目镜（机身后方的黑色方框）
      { name:'取景目镜', color:'#0f0f11',
        sdf:p=> S.roundBox(p,[cx,0.30,-0.225],[0.10,0.06,0.03],0.02) },
    ];
  }
  // 体素双铃闹钟（精细版 — 参照体素低模爆炸图）
  //  精确 9 个组件（与爆炸视图一一对应）：
  //   ① 闹钟壳 — 厚壁圆角方框（中空），深灰色 1×1×1 Voxel，模拟圆角
  //   ② 表盘    — 米白色圆形嵌入壳内正面凹槽，含12时标刻度线
  //   ③ 指针    — 黑色时针+分针+中心轴帽（三件合一组件）
  //   ④ 支撑脚左 / ⑤ 支撑脚右 — 底部前侧两只外撇小脚
  //   ⑥ 警铃左  / ⑦ 警铃右 — 顶部两侧深灰色 Voxel 锥台（外撇低多边形棱面）
  //   ⑧ 金属手柄 — 连接两铃顶的银色拱形 Voxel 结构
  //   ⑨ 击锤     — 两铃之间的 T 形银色 Voxel 构造（竖柱+横臂）
  if (/闹钟|马蹄钟|双铃钟|台钟|座钟|alarm ?clock/.test(t)){
    const S2 = SDF;
    const chrome = '#c7ccd4';                        // 铬合金银（手柄/击锤）
    const darkGray = '#242427';                       // 深灰主色（壳/铃/脚）
    const cream = '#ece2ca';                          // 米白表盘

    // ── 几何参数 ──
    const bodyCy = 0.00;                              // 壳几何中心 Y（归一化坐标原点附近）
    const bodyHx = [0.58, 0.54, 0.38];               // 壳半宽/半高/半深（外壳尺寸）
    const wallT = 0.16;                                // 壳壁厚度（内孔比外形小这么多）
    const innerHx = [bodyHx[0]-wallT, bodyHx[1]-wallT*0.85, bodyHx[2]+0.04]; // 内孔半尺寸（Z方向穿透到背面）
    const bodyRound = 0.14;                            // 壳圆角半径
    const dialCy = bodyCy + 0.01;                      // 表盘中心 Y
    const dialCz = cz + bodyHx[2] - 0.02;             // 表盘中心 Z（略凹于壳正面）
    const dialR = Math.min(innerHx[0], innerHx[1]) * 0.88;  // 表盘半径（适配内孔）

    // 铃参数
    const bellCxOff = 0.38;                            // 铃中心 X 偏移量（左右对称）
    const bellBaseY = bodyCy + bodyHx[1] * 0.92;       // 铃底面 Y
    const bellH = 0.28;                                 // 铃总高度
    const bellRBot = 0.175;                             // 铃底半径（大口朝下）
    const bellRTop = 0.115;                             // 铃顶半径（小口朝上）
    const bellLeanX = 0.085;                            // 铃外撇量 X 方向
    const bellCz = cz + 0.05;                           // 铃中心 Z（略靠后于壳正面）
    const bellTopY = bellBaseY + bellH;
    const bellTopX = bellCxOff + bellLeanX;             // 铃顶中心 X（含外撇偏移，即手柄应落脚的位置）

    // 手柄拱形参数：由"弧的两端点必须恰好落在两侧铃顶中心"反推 R / 弧心Y，
    // 避免手柄与铃罩顶部之间出现悬空间隙（摆放对齐的关键）
    const handleAngMin = 38*Math.PI/180;               // 弧起始角（右端点）
    const handleAngMax = Math.PI - handleAngMin;        // 弧终止角（左端点，与右端严格对称）
    const handleR = bellTopX / Math.cos(handleAngMin);  // 拱弧半径：令端点 X 落在 bellTopX
    const handleY0 = bellTopY - handleR*Math.sin(handleAngMin); // 弧心 Y：令端点 Y 落在 bellTopY
    const handleTubeR = 0.032;                          // 拱管粗细（略粗于铃顶半径的 1/3，视觉上稳固咬合）

    // 击锤参数
    const hammerPostY0 = bodyCy + bodyHx[1] + 0.08;    // 击锤竖柱底 Y
    const hammerPostH = 0.10;                           // 竖柱高度
    const hammerBarY = hammerPostY0 + hammerPostH;      // 横臂中心 Y

    // 脚参数
    const footCxOff = 0.22;                             // 脚 X 偏移
    const footZ = cz + bodyHx[2] * 0.45;               // 脚 Z（前侧偏前）
    const footBotY = bodyCy - bodyHx[1];                // 脚底部 Y
    const footH = 0.14;                                 // 脚高度

    // ── 辅助基元 ──
    // 沿 Z 的圆柱（表盘/指针专用：圆在 XY 平面，沿 Z 挤出）
    const cylZ = (p,c,r,hh)=>{
      const d=Math.hypot(p[0]-c[0],p[1]-c[1])-r;
      const dz=Math.abs(p[2]-c[2])-hh;
      return Math.min(Math.max(d,dz),0)+Math.hypot(Math.max(d,0),Math.max(dz,0));
    };
    // 沿 X 的圆柱（击锤横臂专用：圆在 YZ 平面，沿 X 挤出）
    const cylX = (p,c,r,hh)=>{
      const d=Math.hypot(p[1]-c[1],p[2]-c[2])-r;
      const dx=Math.abs(p[0]-c[0])-hh;
      return Math.min(Math.max(d,dx),0)+Math.hypot(Math.max(d,0),Math.max(dx,0));
    };
    // 带侧倾圆台（铃罩专用）：从 y0→y1，半径 r0→r1，轴心随高度线性外撇 leanX/leanZ
    const frustumLeanY = (p, c0, y0, y1, r0, r1, leanX, leanZ)=>{
      const tt=Math.max(0,Math.min(1,(p[1]-(c0[1]+y0))/(y1-y0)));
      const rr=r0+(r1-r0)*tt;
      const sx=c0[0]+leanX*tt, sz=c0[2]+leanZ*tt;
      const d=Math.hypot(p[0]-sx,p[2]-sz)-rr;
      return Math.max(d, Math.max((c0[1]+y0)-p[1], p[1]-(c0[1]+y1)));
    };
    // 径向条（时标/指针共用）：angDeg 以 12 点为 0°顺时针；返回到条带的距离
    const radialBar = (p, angDeg, r0, r1, halfW, zc, halfT)=>{
      const ang=angDeg*Math.PI/180, sa=Math.sin(ang), ca=Math.cos(ang);
      const u=p[0]*ca-p[1]*sa, v=p[0]*sa+p[1]*ca;
      const vc=(r0+r1)/2, hV=(r1-r0)/2;
      const qu=Math.abs(u)-halfW, qv=Math.abs(v-vc)-hV, qz=Math.abs(p[2]-zc)-halfT;
      return Math.hypot(Math.max(qu,0),Math.max(qv,0),Math.max(qz,0))
        + Math.min(Math.max(qu,qv,qz),0);
    };
    // 拱弧管（金属手柄专用）
    const bailArc = p=>{
      let ang=Math.atan2(p[1]-handleY0, p[0]-cx);
      ang=Math.max(handleAngMin, Math.min(handleAngMax, ang));
      const ax=cx+handleR*Math.cos(ang), ay=handleY0+handleR*Math.sin(ang);
      return Math.hypot(p[0]-ax,p[1]-ay,p[2]-bellCz)-handleTubeR;
    };

    return [
      // ════════════════════════════════════════
      //  ① 闹钟壳 — 圆角厚壁方框（中空环形），深灰磨砂
      // ════════════════════════════════════════
      { name:'闹钟壳', color:darkGray, colorFn:p=>{
          let c=mixHex('#18181b','#323238',vnoise(p[0]*5.5,p[1]*5.5,p[2]*3));
          const topT=Math.max(0,Math.min(1,(p[1]-bodyCy)/bodyHx[1]));
          c=mixHex(c,'#404148',topT*0.32);
          // 外边缘略暗（模拟倒角阴影）
          if(Math.abs(p[0]-cx)>bodyHx[0]*0.82||Math.abs(p[2]-cz)>bodyHx[2]*0.82)
            c=shadeHex(c,-6);
          // 内孔壁受光渐亮
          const inRad=Math.hypot(p[0]-cx,p[1]-dialCy);
          if(inRad<innerHx[0]*0.88&&inRad>innerHx[0]*0.55)
            c=shadeHex(c,8*(1-inRad/(innerHx[0]*0.88)));
          return shadeHex(c,jitter(p,5,9));
        }, sdf:p=>S2.sub(
          // 外轮廓：大圆角方盒
          S2.roundBox(p,[cx,bodyCy,cz],bodyHx,bodyRound),
          // 内挖空：稍小的圆角方盒（Z方向完全贯穿形成前后通孔）
          S2.roundBox(p,[cx,bodyCy,cz],innerHx,bodyRound*0.75)
        ) },

      // ════════════════════════════════════════
      //  ② 表盘 — 米白色圆盘嵌入壳内正面，含 12 条时标刻度
      // ════════════════════════════════════════
      { name:'表盘', color:cream, colorFn:p=>{
          const rad=Math.hypot(p[0]-cx,p[1]-dialCy);
          let c=mixHex('#f6edd8','#d9cfb2',Math.min(1,rad/dialR));
          // 12 时标区域加深（时标直接画在表盘颜色函数里）
          for(let i=0;i<12;i++){
            const ad=i*30*Math.PI/180;
            const proj=(p[0]-cx)*Math.cos(ad)+(p[1]-dialCy)*Math.sin(ad);
            const perp=Math.abs(-(p[0]-cx)*Math.sin(ad)+(p[1]-dialCy)*Math.cos(ad));
            if(perp<0.018 && proj>dialR*0.78 && proj<dialR*0.97)
              c=mixHex(c,'#222',0.72);
          }
          return shadeHex(c,jitter(p,2,3));
        }, sdf:p=>cylZ(p,[cx,dialCy,dialCz],dialR,0.022) },

      // ════════════════════════════════════════
      //  ③ 指针 — 黑色时针+分针+中心轴帽（三合一组件）
      // ════════════════════════════════════════
      { name:'指针', color:'#141414', sdf:p=>{
          // 时针（约11点方向，短粗）
          const dH=radialBar(p,-18,-0.03,0.172,0.020,dialCz+0.028,0.014);
          // 分针（约2点10分方向，长细）
          const dM=radialBar(p,62,-0.03,0.270,0.015,dialCz+0.028,0.013);
          // 中心轴帽（压住指针根部的小圆钮）
          const dCap=cylZ(p,[cx,dialCy,dialCz+0.034],0.025,0.017);
          return Math.min(dH, dM, dCap);
        }},

      // ════════════════════════════════════════
      //  ④ 左支撑脚 — 壳底部前左侧外撇小脚
      // ════════════════════════════════════════
      { name:'支撑脚左', color:'#1a1a1c', colorFn:p=>shadeHex('#151518',jitter(p,3,4)),
        sdf:p=>S2.frustumY(p,[-footCxOff,footBotY,footZ],-footH*0.35,0,0.052,0.028) },

      // ════════════════════════════════════════
      //  ⑤ 右支撑脚 — 壳底部前右侧外撇小脚
      // ════════════════════════════════════════
      { name:'支撑脚右', color:'#1a1a1c', colorFn:p=>shadeHex('#151518',jitter(p,3,4)),
        sdf:p=>S2.frustumY(p,[footCxOff,footBotY,footZ],-footH*0.35,0,0.052,0.028) },

      // ════════════════════════════════════════
      //  ⑥ 左警铃 — 壳顶左上方深灰锥台（大口在下、小口在上，略外撇）
      // ════════════════════════════════════════
      { name:'警铃左', color:'#26262a', colorFn:p=>{
          const ang=Math.atan2(p[2]-bellCz,p[0]+bellCxOff);
          // 低多边形棱面明暗分割（模拟 Voxel 阶梯感）
          const facet=Math.sin(ang*7)*11;
          const tt=Math.max(0,Math.min(1,(p[1]-bellBaseY)/bellH));
          let c=mixHex('#1b1b1e','#36363c',tt*0.55);
          return shadeHex(c,facet+jitter(p,5,8));
        }, sdf:p=>frustumLeanY(p,[-bellCxOff,0,bellCz],bellBaseY,bellTopY,
          bellRBot,bellRTop,-bellLeanX,0) },

      // ════════════════════════════════════════
      //  ⑦ 右警铃 — 壳顶右上方深灰锥台（镜像对称）
      // ════════════════════════════════════════
      { name:'警铃右', color:'#26262a', colorFn:p=>{
          const ang=Math.atan2(p[2]-bellCz,p[0]-bellCxOff);
          const facet=Math.sin(ang*7)*11;
          const tt=Math.max(0,Math.min(1,(p[1]-bellBaseY)/bellH));
          let c=mixHex('#1b1b1e','#36363c',tt*0.55);
          return shadeHex(c,facet+jitter(p,5,8));
        }, sdf:p=>frustumLeanY(p,[bellCxOff,0,bellCz],bellBaseY,bellTopY,
          bellRBot,bellRTop,bellLeanX,0) },

      // ════════════════════════════════════════
      //  ⑧ 金属手柄 — 连接左右两铃顶的镀铬拱形握把
      // ════════════════════════════════════════
      { name:'金属手柄', color:chrome, colorFn:p=>{
          const tt=Math.max(0,Math.min(1,(p[1]-handleY0)/handleR));
          return shadeHex(mixHex('#989ea6','#eef2f7',tt),jitter(p,5,7));
        }, sdf:bailArc },

      // ════════════════════════════════════════
      //  ⑨ 击锤 — 两铃之间 T 形银色构造（竖柱 + 横臂）
      // ════════════════════════════════════════
      { name:'击锤', color:chrome, colorFn:p=>shadeHex(chrome,jitter(p,4,6)),
        sdf:p=>S2.union(
          // 竖柱（从壳顶伸到两铃之间）
          S2.cylY(p,[cx,hammerPostY0+hammerPostH*0.5,bellCz],0.030,hammerPostH*0.5),
          // 横臂（顶端水平短杆）
          cylX(p,[cx,hammerBarY,bellCz],0.026,0.048)
        ) },
    ];
  }
  // 复古CRT电视机（精细版 — 50000+体素级）
  //  结构：深色塑料外壳 + 圆角屏幕井 + CRT弧面玻璃 + 米白前面板 + 扬声器矩阵 + 卡带仓 + 双旋钮 + 后部管颈 + 4个支撑脚
  if (/电视|television|\bTV\b|\bCRT\b|黑白电视|monitor|显示器/.test(t)){
    const TV_W = 1.04, TV_H = 0.92, TV_D = 0.78;          // 主机身宽高深
    const TV_FRONT_Z = cz + TV_D*0.5;                    // 前面板Z
    // 屏幕几何
    const SCR_W = 0.78, SCR_H = 0.50;                     // 玻璃宽高
    const SCR_CX = cx, SCR_CY = 0.04;                    // 玻璃中心
    const SCR_R = 0.10;                                  // 圆角半径
    const BEZEL = 0.05;                                  // 米白边框厚度
    // 圆角矩形SDF（中心cx0, cy0，宽w, 高h，圆角r）
    const roundRectSDF = (p, c, w, h, r)=>{
      const qx = Math.max(Math.abs(p[0]-c[0]) - (w*0.5 - r), 0);
      const qy = Math.max(Math.abs(p[1]-c[1]) - (h*0.5 - r), 0);
      const ox = Math.max(qx,0), oy = Math.max(qy,0);
      return Math.hypot(ox, oy) + Math.min(Math.max(Math.abs(p[0]-c[0])-(w*0.5-r), Math.abs(p[1]-c[1])-(h*0.5-r)), 0) - r;
    };
    return [
      // ── 1. 主机身外壳（深蓝灰塑料，磨砂质感） ──
      { name:'电视外壳', color:'#2c3540', colorFn:p=>{
          // 顶面受光略亮；底面偏暗；侧面带轻微噪声（磨砂塑料）
          let c = mixHex('#1a222c','#3a4654', Math.max(0, Math.min(1, (p[1]+TV_H*0.5)/TV_H)));
          // 顶部后部隆起区域（容纳CRT管颈）更深
          if (p[1] > 0.18 && p[2] < 0.0) c = shadeHex(c, -8);
          return shadeHex(c, jitter(p, 5, 8));
        }, sdf:p=> S.roundBox(p,[cx, 0.0, cz],[TV_W*0.5, TV_H*0.5, TV_D*0.5], 0.04) },

      // ── 2. 后部CRT管颈凸起（从机箱后部向后上方隆起的锥形） ──
      { name:'CRT管颈', color:'#252d38', colorFn:p=>{
          let c = mixHex('#1a222c','#2e3845', p[1]*0.8);
          return shadeHex(c, jitter(p, 4, 6));
        }, sdf:p=> S.frustumY(p,[cx, 0.20, cz - 0.05], -0.45, 0.30, 0.22, 0.50) },

      // ── 3. 前面板米白底盘（屏幕+扬声器+旋钮共用的浅色基座） ──
      { name:'米白前面板', color:'#e8e0d0', colorFn:p=>{
          let c = mixHex('#dccfb5','#efe7d4', vnoise(p[0]*4, p[2]*4, 0));
          return shadeHex(c, jitter(p, 4, 5));
        }, sdf:p=> S.roundBox(p,[cx, 0.04, TV_FRONT_Z + 0.001],[0.495, 0.36, 0.012], 0.020) },

      // ── 4. 屏幕井凹陷外框（前面板上挖出的大圆角矩形井位） ──
      // 用 sub(前面板, 屏幕井凹陷体) 实现，先做屏幕井本身的体素覆盖
      { name:'屏幕井', color:'#1a1a1c', colorFn:p=>{
          return shadeHex('#15151a', -p[1]*8 + jitter(p,3,4));
        }, sdf:p=> S.union(
          // 井壁厚度
          S.roundBox(p,[SCR_CX, SCR_CY, TV_FRONT_Z + 0.005],[(SCR_W+BEZEL*2)*0.5, (SCR_H+BEZEL*2)*0.5, 0.020], 0.035),
          // 井底（屏幕位置）留出空间
          S.roundBox(p,[SCR_CX, SCR_CY, TV_FRONT_Z - 0.005],[(SCR_W+BEZEL)*0.5, (SCR_H+BEZEL)*0.5, 0.030], 0.030)
        ) },

      // ── 5. CRT屏幕玻璃（深色圆角矩形，模拟CRT暗屏） ──
      { name:'CRT玻璃', color:'#1a2530', colorFn:p=>{
          // 屏幕蓝色反光渐变（左上→右下）
          const dx = (p[0] - SCR_CX) / (SCR_W*0.5);
          const dy = (p[1] - SCR_CY) / (SCR_H*0.5);
          // 基础色：深蓝灰
          let c = mixHex('#0e1418','#1f2c3c', 0.5 + dx*0.3 - dy*0.2);
          // 右上角椭圆高光（模拟环境光反射）
          const hx = p[0] - (SCR_CX + 0.18);
          const hy = p[1] - (SCR_CY + 0.12);
          const hd = (hx*hx)/0.04 + (hy*hy)/0.012;
          if (hd < 1.0) c = mixHex(c, '#6a9bc4', (1.0-hd)*0.55);
          // 屏幕细密扫描线
          if (Math.sin(p[1]*220) > 0.85) c = mixHex(c, '#000000', 0.35);
          return shadeHex(c, jitter(p, 4, 6));
        }, sdf:p=> {
          // 玻璃面板（带轻微Z方向凸出，模拟CRT弧面）
          const zFront = TV_FRONT_Z + 0.018;
          const dz = p[2] - zFront;
          // 用球面偏移让玻璃中央凸出
          const dxz = Math.hypot(p[0]-SCR_CX, p[2]-zFront);
          const dy2 = p[1] - SCR_CY;
          const bulge = 0.030 * Math.max(0, 1 - dxz*dxz/0.30 - dy2*dy2/0.15);
          return roundRectSDF(p, [SCR_CX, SCR_CY, zFront + bulge*0.5], SCR_W, SCR_H, SCR_R);
        } },

      // ── 6. 扬声器面板底色（左侧格栅基底） ──
      { name:'扬声器面板', color:'#e0d8c4', colorFn:p=>{
          let c = mixHex('#d4c8b0','#ece2c8', vnoise(p[0]*5,p[2]*5,0));
          return shadeHex(c, jitter(p, 3, 4));
        }, sdf:p=> S.roundBox(p,[-0.30, -0.30, TV_FRONT_Z + 0.013],[0.16, 0.08, 0.006], 0.008) },

      // ── 7. 扬声器圆孔矩阵（密集小孔，黑色） ──
      { name:'扬声器孔阵', color:'#0a0a0c', colorFn:p=>{
          return shadeHex('#080810', jitter(p, 2, 3));
        }, sdf:p=> {
          // 扬声器区域中心
          const cxL = -0.30, cyL = -0.30, czF = TV_FRONT_Z + 0.018;
          // 6列 x 4行 = 24个孔，孔径 0.012，间距 0.024
          const spacing = 0.024;
          const r = 0.011;
          let dMin = Infinity;
          // 找最近的孔中心
          for (let ix = -3; ix <= 2; ix++){
            for (let iy = -2; iy <= 1; iy++){
              const hx = cxL + ix*spacing;
              const hy = cyL + iy*spacing;
              const dx = Math.hypot(p[0]-hx, p[1]-hy);
              const dz = Math.abs(p[2]-czF);
              // 圆柱孔：dx <= r && dz <= 0.005
              const d = Math.max(dx - r, dz - 0.005);
              if (d < dMin) dMin = d;
            }
          }
          // 限制在扬声器面板范围内
          const inPanel = S.roundBox(p,[cxL,cyL,czF],[0.155,0.075,0.020],0.005);
          return Math.max(dMin, inPanel);
        } },

      // ── 8. 卡带仓门（中间长条形黑色凹槽） ──
      { name:'卡带仓门', color:'#0c0c10', colorFn:p=>{
          // 仓门有轻微的塑料反射光
          let c = mixHex('#0a0a0e','#252528', vnoise(p[0]*8, p[2]*8, 0));
          return shadeHex(c, jitter(p, 3, 4));
        }, sdf:p=> S.roundBox(p,[-0.05, -0.30, TV_FRONT_Z + 0.014],[0.18, 0.055, 0.006], 0.006) },

      // ── 9. 卡带仓门边框线（细深色饰条） ──
      { name:'卡带仓框', color:'#2a2a30',
        sdf:p=> {
          const outer = S.roundBox(p,[-0.05, -0.30, TV_FRONT_Z + 0.016],[0.185, 0.060, 0.003], 0.008);
          const inner = S.roundBox(p,[-0.05, -0.30, TV_FRONT_Z + 0.016],[0.178, 0.052, 0.005], 0.006);
          return Math.max(outer, -inner);
        } },

      // ── 10. 旋钮1（小旋钮，右侧上方） ──
      { name:'旋钮_小', color:'#1a1a1c', colorFn:p=>{
          let c = mixHex('#101014','#28282e', vnoise(p[0]*10, p[2]*10, 0));
          // 旋钮顶部圆周刻痕（5条短线）
          const ang = Math.atan2(p[2]-TV_FRONT_Z-0.018, p[0]-0.18);
          if (Math.abs(Math.sin(ang*5)) > 0.92 && p[1] > -0.295) c = mixHex(c, '#444', 0.4);
          return shadeHex(c, jitter(p, 4, 5));
        }, sdf:p=> S.cylY(p,[0.18, -0.305, TV_FRONT_Z + 0.015], 0.022, 0.012) },

      // ── 11. 旋钮2（大旋钮，右侧下方） ──
      { name:'旋钮_大', color:'#1a1a1c', colorFn:p=>{
          let c = mixHex('#101014','#28282e', vnoise(p[0]*10, p[2]*10, 0));
          // 旋钮顶部圆周刻痕（8条）
          const ang = Math.atan2(p[2]-TV_FRONT_Z-0.018, p[0]-0.32);
          if (Math.abs(Math.sin(ang*8)) > 0.90 && p[1] > -0.305) c = mixHex(c, '#444', 0.4);
          return shadeHex(c, jitter(p, 4, 5));
        }, sdf:p=> S.cylY(p,[0.32, -0.305, TV_FRONT_Z + 0.015], 0.032, 0.015) },

      // ── 12. 顶部散热栅格（顶面后部几条细缝） ──
      { name:'顶部散热栅', color:'#1a1d24',
        sdf:p=> {
          // 6条横向细缝
          let dMin = Infinity;
          for (let i = -3; i <= 2; i++){
            const slotY = 0.36 + i*0.020;
            const slot = S.roundBox(p,[cx, slotY, cz - 0.30],[0.30, 0.005, 0.08], 0.001);
            if (slot < dMin) dMin = slot;
          }
          return dMin;
        } },

      // ── 13. 底部4个支撑脚 ──
      { name:'支撑脚', color:'#1a1a1c', colorFn:p=>{
          return shadeHex('#15151a', jitter(p, 3, 4));
        }, sdf:p=> {
          // 4个角的小脚（前后左右）
          const feet = [
            [cx - 0.42, -TV_H*0.5 - 0.03, cz + 0.28],
            [cx + 0.42, -TV_H*0.5 - 0.03, cz + 0.28],
            [cx - 0.42, -TV_H*0.5 - 0.03, cz - 0.28],
            [cx + 0.42, -TV_H*0.5 - 0.03, cz - 0.28],
          ];
          let dMin = Infinity;
          for (const f of feet){
            const d = S.cylY(p,[f[0], f[1], f[2]], 0.045, 0.04);
            if (d < dMin) dMin = d;
          }
          return dMin;
        } },
    ];
  }

  // 红绿灯（三色信号灯 — 精细版，参照实拍低模参考图）
  //  结构：方形垫脚底座 → 立杆颈 → 黑色竖长机身 → 银色前框(相框式) → 黑色内嵌面板
  //       → 三联深色灯罩座(带遮阳阴影) → 红/黄/绿三联玻璃灯罩(径向渐变+高光) → 背部接线盒
  if (/红绿灯|交通灯|信号灯|traffic ?light|红黄绿灯|指挥灯/.test(t)){
    // 沿 Z 轴（朝向 +Z 前方）的圆柱基元 —— 灯罩镜片专用
    const cylZ = (p,c,r,hh)=>{
      const d = Math.hypot(p[0]-c[0], p[1]-c[1]) - r;
      const dz = Math.abs(p[2]-c[2]) - hh;
      const ox=Math.max(d,0), oz=Math.max(dz,0);
      return Math.min(Math.max(d,dz),0) + Math.hypot(ox,oz);
    };
    // 沿 Z 轴的环（灯罩座装饰环）
    const ringZ = (p,c,ri,ro,hh)=>{
      const rad = Math.hypot(p[0]-c[0], p[1]-c[1]);
      const rm=(ri+ro)/2, bw=(ro-ri)/2;
      const dz = Math.abs(p[2]-c[2]) - hh;
      return Math.max(Math.abs(rad-rm)-bw, dz);
    };
    const FRONT = cz + 0.24;                              // 机身前表面
    const lampY = [0.62, 0.17, -0.28];                     // 红/黄/绿 灯位（自上而下）
    const lampColors = ['#ff4438', '#ffab2e', '#39cf58'];  // 红/黄/绿 主色
    const lensR = 0.155, ringOuterR = lensR + 0.032;
    // 找到与 p 最近的灯位索引（用于三联件共用一份 sdf/colorFn）
    const nearestLamp = p=>{
      let best = Infinity, idx = 0;
      for (let i=0;i<lampY.length;i++){ const d = Math.abs(p[1]-lampY[i]); if (d < best){ best = d; idx = i; } }
      return idx;
    };
    return [
      // 支撑底座（垫脚方板）
      { name:'底座', color:'#1c1e22', colorFn:p=>
          shadeHex(mixHex('#101214','#20242a', vnoise(p[0]*6,p[2]*6,0)), jitter(p,4,7)),
        sdf:p=> S.roundBox(p,[cx,-0.93,cz],[0.22,0.07,0.22],0.03) },

      // 立杆颈（连接底座与机身）
      { name:'立杆', color:'#20232a', colorFn:p=>
          shadeHex(mixHex('#151820','#282c34', vnoise(p[0]*8,p[2]*8,p[1]*4)), jitter(p,4,8)),
        sdf:p=> S.cylY(p,[cx,-0.72,cz],0.11,0.14) },

      // 机身外壳（黑色磨砂塑料，顶部受光渐亮 + 侧棱高光）
      { name:'机身', color:'#191b1e', colorFn:p=>{
          let c = mixHex('#141619','#26292e', vnoise(p[0]*6,p[2]*6,p[1]*3));
          const topT = Math.max(0, Math.min(1, (p[1]-0.5)/0.42));
          c = mixHex(c, '#343840', topT*0.4);
          if (Math.abs(p[0]) > 0.30) c = shadeHex(c, 6);
          return shadeHex(c, jitter(p,5,9));
        }, sdf:p=> S.roundBox(p,[cx,0.17,cz],[0.34,0.75,0.24],0.055) },

      // 银色前框（相框式，围住整块面板的凸起金属边）
      { name:'银色前框', color:'#c6ccd4', colorFn:p=>{
          const tt = Math.max(0, Math.min(1, (p[1]+0.10)/1.30));
          return shadeHex(mixHex('#9aa0a8','#e8ecf2', tt), jitter(p,6,8));
        }, sdf:p=>{
          const outer = S.roundBox(p,[cx,0.17,0.26],[0.30,0.70,0.020],0.05);
          const inner = S.roundBox(p,[cx,0.17,0.26],[0.256,0.656,0.026],0.04);
          return Math.max(outer, -inner);
        } },

      // 黑色内嵌面板（哑光黑，安装三联灯罩的基座）
      { name:'内嵌面板', color:'#0f1013', colorFn:p=>
          shadeHex(mixHex('#0b0c0f','#1a1c20', vnoise(p[0]*7,p[1]*7,0)), jitter(p,3,6)),
        sdf:p=> S.roundBox(p,[cx,0.17,0.25],[0.255,0.655,0.010],0.045) },

      // 三联灯罩座（深色收口环，靠遮阳侧带阴影，呼应参考图的檐影细节）
      { name:'灯罩座', color:'#111214', colorFn:p=>{
          const by = lampY[nearestLamp(p)];
          let c = '#111214';
          const ang = Math.atan2(p[1]-by, p[0]-cx);
          const shadow = Math.cos(ang - 2.3);         // 约132°方向（左上）加深，模拟遮阳檐投影
          if (shadow > 0.5) c = shadeHex(c, -10*(shadow-0.5)*2);
          return shadeHex(c, jitter(p,4,10));
        }, sdf:p=>{
          const by = lampY[nearestLamp(p)];
          return ringZ(p,[cx,by,0.28],lensR,ringOuterR,0.02);
        } },

      // 三联玻璃灯罩（红/黄/绿，径向渐变 + 玻璃高光，向前鼓起如凸镜）
      { name:'灯罩镜片', color:'#ff4438', colorFn:p=>{
          const idx = nearestLamp(p);
          const by = lampY[idx];
          const base = lampColors[idx];
          const rad = Math.hypot(p[0]-cx, p[1]-by);
          let c = mixHex(shadeHex(base,26), shadeHex(base,-18), Math.min(1, rad/lensR));
          const hl = Math.hypot(p[0]-(cx-0.055), p[1]-(by+0.055));
          if (hl < 0.05) c = mixHex(c, '#ffffff', (0.05-hl)/0.05*0.7);
          return shadeHex(c, jitter(p,5,10));
        }, sdf:p=>{
          const by = lampY[nearestLamp(p)];
          return S.union(
            S.sphere(p,[cx,by,0.20],0.205),
            cylZ(p,[cx,by,0.29],lensR,0.015)
          );
        } },

      // 背部接线盒（机身后方的小凸盒，走线细节）
      { name:'接线盒', color:'#15171a', colorFn:p=>
          shadeHex(mixHex('#101114','#1e2024', vnoise(p[0]*8,p[1]*8,0)), jitter(p,4,8)),
        sdf:p=> S.roundBox(p,[cx,-0.05,-0.29],[0.16,0.10,0.05],0.02) },
    ];
  }

  // 圣诞树：树干 + 三层圆锥树冠 + 顶球
  if (/树|tree|圣诞/.test(t)){
    return [
      { name:'树干',   color:'#9b6b43', sdf:p=> S.cylY(p,[cx,-0.7,cz],0.16,0.35) },
      { name:'树冠下', color:'#3fa45b', sdf:p=> S.coneY(p,[cx,0,cz],0.9,-0.4,0.25) },
      { name:'树冠中', color:'#4dd07a', sdf:p=> S.coneY(p,[cx,0,cz],0.68,0.1,0.6) },
      { name:'树冠上', color:'#6fe39a', sdf:p=> S.coneY(p,[cx,0,cz],0.46,0.5,0.9) },
      { name:'顶星',   color:'#ffd166', sdf:p=> S.sphere(p,[cx,0.94,cz],0.12) },
    ];
  }

  // 金字塔：圆滑棱锥（多层由拆分产生）
  if (/金字塔|pyramid/.test(t)){
    const col = (baseHex && baseHex!=='#f3f5fa') ? baseHex : '#d9b25a';
    return [{ name:'塔身', color:col, sdf:p=> S.coneY(p,[cx,0,cz],0.95,-0.95,0.95) }];
  }
  // 爱心：两球 + 底部锥（近似心形，圆润）
  if (/爱心|心形|heart|心/.test(t)){
    const col = baseHex || '#ff5d5d';
    return [{ name:'爱心', color:col, sdf:p=> S.union(S.union(S.sphere(p,[-0.32,0.32,0],0.44), S.sphere(p,[0.32,0.32,0],0.44)), S.coneY(p,[cx,0,cz],0.62,-0.95,0.36)) }];
  }
  // 球 / 苹果 / 太阳等
  if (/球|圆|sphere|苹果|太阳|月|气球/.test(t)){
    const col = baseHex || '#ff5d5d';
    return [{ name:'球体', color:col, sdf:p=> S.sphere(p,[cx,0,cz],0.92) }];
  }
  // 兜底：一个圆润的椭球（比立方块更自然），交由后续拆分
  return [{ name:'主体', color:(baseHex||'#ffd166'), sdf:p=> S.sphere(p,[cx,0,cz],0.9) }];
}

/* =========================================================
 * 体素鱼缸预设（直接装配 18 个组件，不走 SDF/自动拆分管线）
 *   组件：底座 ×1、框架 ×4、玻璃缸壁 ×4（半透明）、
 *        沙子+碎石+小海草 ×1、岩石 ×2、海藻 ×2、游鱼 ×4
 *   所有组件共享同一整数网格与同一 pos/voxelSize，天然对齐拼装。
 * ========================================================= */
function buildFishTankPreset(opts){
  opts = opts || {};
  const sizeMul = Math.max(0.3, opts.sizeMul || 2.6);
  const off = opts.posOffset || { x:0, y:0, z:0 };
  const s = 0.07 * sizeMul;              // 体素世界大小（默认约 0.18）

  // ── 网格参数（整数体素坐标） ──
  const WX = 28, WZ = 18;               // 缸内 x 宽 / z 深
  const SAND_H = 3;                     // 沙层厚度（y 0..2）
  const WALL_H = 18;                    // 玻璃/缸体高度（y 0..17）
  const BASE_H = 3;                     // 底座厚度（y -3..-1）

  // ── 组件体素字典 ──
  const baseVox={}, sandVox={};
  const posts=[{},{},{},{}];
  const glassF={}, glassB={}, glassL={}, glassR={};
  const rock1={}, rock2={}, weed1={}, weed2={};
  const fishO={}, fishB={}, fishY={}, fishP={};

  const GLASS = encodeVoxel('#d6eef7','cube',0,null,1,0.24);   // 半透明玻璃

  // ── 底座（比缸体略大的深灰托盘 + 外沿凸边） ──
  for(let x=-2;x<=WX+1;x++) for(let z=-2;z<=WZ+1;z++) for(let y=-BASE_H;y<=-1;y++){
    baseVox[keyOf(x,y,z)] = (y===-1) ? '#3d434b' : '#33383f';
  }
  // 托盘外沿抬高一圈（tray lip）
  for(let x=-2;x<=WX+1;x++) for(let z=-2;z<=WZ+1;z++){
    if(x===-2||x===WX+1||z===-2||z===WZ+1) baseVox[keyOf(x,0,z)] = '#454b54';
  }

  // ── 4 个角柱框架（2×2 立柱，从底座贯通到略高于缸顶） ──
  const postCorners=[[-1,-1],[WX-1,-1],[-1,WZ-1],[WX-1,WZ-1]];
  postCorners.forEach((c,i)=>{
    const [px,pz]=c;
    for(let dx=0;dx<2;dx++) for(let dz=0;dz<2;dz++) for(let y=-BASE_H;y<=WALL_H;y++){
      posts[i][keyOf(px+dx, y, pz+dz)] = (y>=WALL_H-1)?'#3a3f47':'#2b2f36';  // 顶端稍亮做柱帽
    }
  });

  // ── 4 面玻璃缸壁（1 格厚，避开角柱所在的角列） ──
  for(let x=1;x<=WX-2;x++) for(let y=0;y<=WALL_H-1;y++){ glassF[keyOf(x,y,-1)]=GLASS; glassB[keyOf(x,y,WZ)]=GLASS; }
  for(let z=1;z<=WZ-2;z++) for(let y=0;y<=WALL_H-1;y++){ glassL[keyOf(-1,y,z)]=GLASS; glassR[keyOf(WX,y,z)]=GLASS; }

  // ── 沙子 + 碎石 + 小海草（合为一个组件） ──
  const sands=['#e6d5a8','#dcc896','#efe0b6','#d8c48c'];
  for(let x=0;x<WX;x++) for(let z=0;z<WZ;z++) for(let y=0;y<SAND_H;y++){
    const idx=(Math.floor(x/3)+Math.floor(z/3)+Math.floor(y/2))%sands.length;
    sandVox[keyOf(x,y,z)]=sands[idx];
  }
  // 起伏沙丘：部分顶格再抬高 1
  for(let x=0;x<WX;x++) for(let z=0;z<WZ;z++){
    if(vnoise(x*0.7,z*0.7,0)>0.62) sandVox[keyOf(x,SAND_H,z)]='#efe0b6';
  }
  // 碎石（散布在沙面的深色小石粒）
  const gravels=['#9a9383','#8d867a','#7d776b','#a49b8a'];
  for(let g=0; g<26; g++){
    const gx=Math.floor(vnoise(g*3.1,1.7,0)*(WX-2))+1;
    const gz=Math.floor(vnoise(g*1.9,4.3,0)*(WZ-2))+1;
    sandVox[keyOf(gx,SAND_H,gz)]=gravels[g%gravels.length];
  }
  // 小海草（沙面上矮小的绿色簇）
  const sprigPos=[[4,3],[9,12],[15,4],[20,13],[24,7]];
  sprigPos.forEach(([sx,sz],i)=>{
    const h=2+(i%2);
    for(let y=SAND_H;y<SAND_H+h;y++) sandVox[keyOf(sx,y,sz)]= i%2?'#5cc257':'#4fb04a';
  });

  // ── 岩石生成器（半椭球灰色堆） ──
  function addRock(vox, ox,oy,oz, rx,ry,rz){
    const grays=['#5a5f66','#6b7178','#4c5157','#787f86'];
    for(let lx=-rx;lx<=rx;lx++) for(let ly=0;ly<=ry;ly++) for(let lz=-rz;lz<=rz;lz++){
      const e=(lx*lx)/((rx+0.5)*(rx+0.5))+(ly*ly)/((ry*1.7)*(ry*1.7))+(lz*lz)/((rz+0.5)*(rz+0.5));
      if(e<=1){ const gi=(Math.abs(lx*3+lz*5+ly*7))%grays.length; vox[keyOf(ox+lx,oy+ly,oz+lz)]=grays[gi]; }
    }
  }
  addRock(rock1, 7, SAND_H, 6, 3, 3, 2);
  addRock(rock2, 21, SAND_H, 13, 3, 2, 3);

  // ── 海藻生成器（多条摇曳的高绿藻） ──
  function addSeaweed(vox, ox,oz, baseH){
    const greens=['#3f9a3a','#4fb04a','#2f7d2c','#5cc257'];
    const strands=[{dx:0,dz:0,h:baseH},{dx:1,dz:1,h:baseH-3},{dx:-1,dz:1,h:baseH-2},{dx:1,dz:-1,h:baseH-4}];
    strands.forEach((sd,si)=>{
      for(let t=0;t<sd.h;t++){
        const y=SAND_H+t;
        const sway=Math.round(Math.sin(t*0.55+si)*1.3);
        vox[keyOf(ox+sd.dx+sway, y, oz+sd.dz)] = greens[(t+si)%greens.length];
        if(t%3===1) vox[keyOf(ox+sd.dx+sway+(si%2?1:-1), y, oz+sd.dz)] = greens[t%greens.length];
      }
    });
  }
  addSeaweed(weed1, 5, 4, 13);
  addSeaweed(weed2, 23, 12, 12);

  // ── 鱼生成器（椭球身 + 尾鳍 + 背鳍 + 眼；dir=+1 头朝 +x，-1 头朝 -x；stripe 可选白条） ──
  function addFish(vox, ox,oy,oz, dir, body, belly, fin, stripe){
    const put=(lx,ly,lz,c)=>{ vox[keyOf(ox+dir*lx, oy+ly, oz+lz)]=c; };
    const at =(lx,ly,lz)=> keyOf(ox+dir*lx, oy+ly, oz+lz);
    // 身体椭球
    for(let lx=-3;lx<=3;lx++) for(let ly=-2;ly<=2;ly++) for(let lz=-1;lz<=1;lz++){
      const e=(lx*lx)/(3.6*3.6)+(ly*ly)/(2.3*2.3)+(lz*lz)/(1.7*1.7);
      if(e<=1) put(lx,ly,lz, (ly<=-1)?belly:body);
    }
    // 尾鳍（身后三角）
    for(let lx=-4;lx>=-5;lx--){ const sp=(-4-lx)+1; for(let ly=-sp-1;ly<=sp+1;ly++) put(lx,ly,0,fin); }
    // 背鳍
    put(-1,3,0,fin); put(0,3,0,fin); put(1,2,0,fin);
    // 眼睛（贴在头部已有体素上）
    [ [2,1,1],[2,1,-1] ].forEach(([lx,ly,lz])=>{ const k=at(lx,ly,lz); if(vox[k]) vox[k]='#141414'; });
    // 竖白条（小丑鱼）
    if(stripe){ [1,-1].forEach(bx=>{ for(let ly=-2;ly<=2;ly++) for(let lz=-1;lz<=1;lz++){ const k=at(bx,ly,lz); if(vox[k]) vox[k]=stripe; } }); }
  }
  addFish(fishO, 8, 13, 5, 1, '#e8722a','#f2a15a','#c85a18','#f4f0e8');  // 橙色小丑鱼（左上）
  addFish(fishB, 19, 12, 13, -1, '#2f6fd0','#5b93e6','#f2c53a', null);   // 蓝鱼（右上·黄鳍）
  addFish(fishY, 11, 6, 14, 1, '#f2c21e','#f7d95a','#d99a12', null);     // 黄鱼（左下）
  addFish(fishP, 21, 8, 5, -1, '#8a4fd0','#a877e0','#6a34a8', null);     // 紫鱼（右下）

  // ── 组件清单（共 18 个） ──
  const comps=[
    { name:'底座',            color:'#33383f', vox:baseVox },
    { name:'框架①(角柱)',     color:'#2b2f36', vox:posts[0] },
    { name:'框架②(角柱)',     color:'#2b2f36', vox:posts[1] },
    { name:'框架③(角柱)',     color:'#2b2f36', vox:posts[2] },
    { name:'框架④(角柱)',     color:'#2b2f36', vox:posts[3] },
    { name:'玻璃缸壁·前',     color:'#d6eef7', vox:glassF },
    { name:'玻璃缸壁·后',     color:'#d6eef7', vox:glassB },
    { name:'玻璃缸壁·左',     color:'#d6eef7', vox:glassL },
    { name:'玻璃缸壁·右',     color:'#d6eef7', vox:glassR },
    { name:'沙子+碎石+小海草', color:'#e6d5a8', vox:sandVox },
    { name:'岩石①',           color:'#6b7178', vox:rock1 },
    { name:'岩石②',           color:'#6b7178', vox:rock2 },
    { name:'海藻①',           color:'#4fb04a', vox:weed1 },
    { name:'海藻②',           color:'#4fb04a', vox:weed2 },
    { name:'游鱼·橙(小丑鱼)',  color:'#e8722a', vox:fishO },
    { name:'游鱼·蓝',         color:'#2f6fd0', vox:fishB },
    { name:'游鱼·黄',         color:'#f2c21e', vox:fishY },
    { name:'游鱼·紫',         color:'#8a4fd0', vox:fishP },
  ].filter(c=>Object.keys(c.vox).length);

  // ── 计算整体包围盒 → 共享 pos（水平居中于原点、底部落在地面 y≈0） ──
  let minx=Infinity,miny=Infinity,minz=Infinity,maxx=-Infinity,maxy=-Infinity,maxz=-Infinity;
  comps.forEach(c=>{ for(const k in c.vox){ const [x,y,z]=parseKey(k);
    if(x<minx)minx=x; if(y<miny)miny=y; if(z<minz)minz=z;
    if(x>maxx)maxx=x; if(y>maxy)maxy=y; if(z>maxz)maxz=z; } });
  const pos={
    x: -((minx+maxx+1)/2)*s + (off.x||0),
    y: -miny*s + (off.y||0),
    z: -((minz+maxz+1)/2)*s + (off.z||0),
  };

  // ── 逐组件创建物件（合并同色体素以降低网格数量） ──
  let total=0;
  comps.forEach(c=>{
    const merged = mergeUniformVoxelBlocks(c.vox);
    total += Object.keys(merged).length;
    createObject({ name:c.name, colorName:c.color, layer:0, voxelSize:s, voxels:merged, pos:{ x:pos.x, y:pos.y, z:pos.z }, rotY:0 });
  });
  refreshObjList(); refreshRightPanel(); refreshStats(); autoSave();
  return { count: comps.length, finalTotal: total, rawTotal: total, budget: 0 };
}

/* =========================================================
 * 体素小屋预设（重新精细搭建，参照参考图重做比例与结构，目标 4000-6000 体素）
 *   组件：底座托盘 / 框架柱梁 / 墙体 / 窗框 / 玻璃 / 屋顶左右坡 / 屋脊 / 门 /
 *         一楼地板 / 二楼阁楼 / 护栏 / 楼梯 / 卧室家具 / 餐桌椅 / 厨房 / 烟囱
 * ========================================================= */
function buildHousePreset(opts){
  opts = opts || {};
  const sizeMul = Math.max(0.3, opts.sizeMul || 2.6);
  const off = opts.posOffset || { x:0, y:0, z:0 };
  const s = 0.15 * sizeMul;

  const WX = 20, WZ = 16;
  const BX0 = -3, BX1 = WX + 2, BZ0 = -3, BZ1 = WZ + 2;
  const WALL_Y0 = 1, WALL_Y1 = 9;
  const LOFT_Y = 7;
  const BEAM_Y = 10;
  const GABLE_Y0 = 11;
  const ROOF_STEPS = 6;
  const RIDGE_Y = GABLE_Y0 + ROOF_STEPS;

  const baseTray = {}, framePosts = {}, frameBeams = {}, wallShell = {}, wallTrim = {};
  const glassFront = {}, glassLeft = {}, glassRight = {}, glassBack = {}, glassAttic = {};
  const roofLeft = {}, roofRight = {}, roofUnder = {}, roofRidge = {}, door = {};

  const floor1 = {}, loftFloor = {}, loftRail = {}, stairs = {};
  const bed = {}, dining = {}, kitchen = {}, chimney = {};

  const BASE_DARK = '#58606a';
  const BASE_LIGHT = '#747b85';
  const FRAME_C = '#5a4635';
  const FRAME_D = '#3f2f22';
  const WALL_C = '#f0e4c8';
  const WALL_S = '#d7c49b';
  const TRIM_C = '#8a6845';
  const DOOR_C = '#b38352';
  const FLOOR_C = '#ad7d4d';
  const FLOOR_D = '#8a6037';
  const ROOF_A = '#8f5a32';
  const ROOF_B = '#754623';
  const ROOF_U = '#6a3e1d';
  const RIDGE_C = '#5d3318';

  const GLASS_V = encodeVoxel('#dff4ff', 'cube', 0, null, 1, 0.28);
  const BED_C = '#f3efe7';
  const PILLOW_C = '#ffffff';
  const STAIR_C = '#8b6037';
  const TABLE_C = '#a06f42';
  const CHAIR_C = '#8f6037';
  const KITCHEN_C = '#b8b0a3';
  const FRIDGE_C = '#d8dce2';
  const CHIM_C = '#8f4c2a';
  const KNOB_C = '#d7b46c';

  const frontDoor = (x,y,z) => z===0 && x>=8 && x<=11 && y>=1 && y<=6;
  const frontWindow = (x,y,z) => z===0 && x>=14 && x<=16 && y>=3 && y<=5;
  const frontAttic = (x,y,z) => z===0 && x>=9 && x<=10 && y>=12 && y<=13;
  const leftWindow  = (x,y,z) => x===0 && z>=5 && z<=7 && y>=3 && y<=5;
  const rightWindow = (x,y,z) => x===WX-1 && z>=6 && z<=8 && y>=3 && y<=5;
  const backWindow  = (x,y,z) => z===WZ-1 && x>=7 && x<=10 && y>=3 && y<=5;

  function put(vox, x, y, z, val){ vox[keyOf(x,y,z)] = (typeof val === 'function') ? val(x,y,z) : val; }
  function fill(vox, x0, x1, y0, y1, z0, z1, val){
    for(let x=x0; x<=x1; x++) for(let y=y0; y<=y1; y++) for(let z=z0; z<=z1; z++) put(vox, x, y, z, val);
  }
  function carve(target, cutter){ for (const k in cutter) delete target[k]; }

  // ── 底座托盘：做成更像参考图的深灰色托盘，并用轻微明暗变化阻止大块自动合并 ──
  fill(baseTray, BX0, BX1, -2, -1, BZ0, BZ1, (x,y,z)=>{
    const base = y === -2 ? BASE_DARK : '#666d77';
    return shadeHex(base, ((x + z) & 1) ? 6 : -6);
  });
  fill(baseTray, BX0, BX1, 0, 0, BZ0, BZ1, (x,y,z)=>{
    const edge = (x===BX0||x===BX1||z===BZ0||z===BZ1);
    return shadeHex(edge ? '#7d838d' : BASE_LIGHT, ((x - z) & 1) ? 4 : -4);
  });
  for(let x=BX0; x<=BX1; x++) for(let z=BZ0; z<=BZ1; z++){
    if (x===BX0 || x===BX1 || z===BZ0 || z===BZ1) put(baseTray, x, 1, z, shadeHex('#5d646e', ((x+z)&1)?8:-8));
  }

  // ── 外框：四角柱 + 顶部圈梁，对齐参考图的"框架与墙壁"结构 ──
  [[0,0],[WX-1,0],[0,WZ-1],[WX-1,WZ-1]].forEach(([x,z], i)=>{
    fill(framePosts, x, x, WALL_Y0, BEAM_Y, z, z, shadeHex(FRAME_C, i % 2 ? 5 : -4));
  });
  fill(frameBeams, 1, WX-2, BEAM_Y, BEAM_Y, 0, 0, FRAME_D);
  fill(frameBeams, 1, WX-2, BEAM_Y, BEAM_Y, WZ-1, WZ-1, FRAME_D);
  fill(frameBeams, 0, 0, BEAM_Y, BEAM_Y, 1, WZ-2, FRAME_D);
  fill(frameBeams, WX-1, WX-1, BEAM_Y, BEAM_Y, 1, WZ-2, FRAME_D);
  fill(frameBeams, 1, WX-2, LOFT_Y, LOFT_Y, 0, 0, shadeHex(TRIM_C, -10));
  fill(frameBeams, 1, WX-2, LOFT_Y, LOFT_Y, WZ-1, WZ-1, shadeHex(TRIM_C, -10));

  // ── 墙壳：一楼高、二楼矮、正面带门窗，前后有山墙 ──
  for(let x=1; x<=WX-2; x++) for(let y=WALL_Y0; y<=WALL_Y1; y++){
    if (!frontDoor(x,y,0) && !frontWindow(x,y,0)) put(wallShell, x, y, 0, shadeHex(WALL_C, ((x+y)&1)?2:-2));
    if (!backWindow(x,y,WZ-1)) put(wallShell, x, y, WZ-1, shadeHex(WALL_C, ((x-y)&1)?1:-3));
  }
  for(let z=1; z<=WZ-2; z++) for(let y=WALL_Y0; y<=WALL_Y1; y++){
    if (!leftWindow(0,y,z)) put(wallShell, 0, y, z, shadeHex(WALL_C, ((z+y)&1)?1:-2));
    if (!rightWindow(WX-1,y,z)) put(wallShell, WX-1, y, z, shadeHex(WALL_C, ((z-y)&1)?2:-2));
  }
  for(let r=0; r<ROOF_STEPS; r++){
    const y = GABLE_Y0 + r;
    const x0 = 4 + r;
    const x1 = 15 - r;
    for(let x=x0; x<=x1; x++){
      if (!frontAttic(x,y,0)) put(wallShell, x, y, 0, shadeHex(WALL_C, (r&1)?3:-1));
      put(wallShell, x, y, WZ-1, shadeHex(WALL_C, (r&1)?1:-3));
    }
  }

  // ── 墙体深色木边 / 窗框 / 门框 ──
  fill(wallTrim, 7, 12, 1, 7, 0, 0, TRIM_C);
  fill(wallTrim, 13, 17, 2, 6, 0, 0, TRIM_C);
  fill(wallTrim, 8, 11, 11, 14, 0, 0, TRIM_C);
  fill(wallTrim, 0, 0, 2, 6, 4, 8, TRIM_C);
  fill(wallTrim, WX-1, WX-1, 2, 6, 5, 9, TRIM_C);
  fill(wallTrim, 6, 11, 2, 6, WZ-1, WZ-1, TRIM_C);
  fill(wallTrim, 1, WX-2, 1, 1, 0, 0, shadeHex(TRIM_C, -12));
  fill(wallTrim, 1, WX-2, 1, 1, WZ-1, WZ-1, shadeHex(TRIM_C, -12));
  fill(wallTrim, 0, 0, 1, 1, 1, WZ-2, shadeHex(TRIM_C, -12));
  fill(wallTrim, WX-1, WX-1, 1, 1, 1, WZ-2, shadeHex(TRIM_C, -12));
  fill(wallTrim, 1, WX-2, LOFT_Y, LOFT_Y, 0, 0, shadeHex(TRIM_C, -8));

  // 挖掉与独立窗框重合的浅色墙壳，避免重叠闪烁
  carve(wallShell, wallTrim);

  // ── 玻璃：正面、左右、背面与阁楼小窗 ──
  fill(glassFront, 14, 16, 3, 5, 0, 0, GLASS_V);
  fill(glassLeft, 0, 3, 5, 7, 5, 7, GLASS_V);
  fill(glassRight, WX-1, WX-1, 3, 5, 6, 8, GLASS_V);
  fill(glassBack, 7, 10, 3, 5, WZ-1, WZ-1, GLASS_V);
  fill(glassAttic, 9, 10, 12, 13, 0, 0, GLASS_V);

  // ── 门 ──
  fill(door, 8, 11, 1, 6, 0, 0, (x,y)=> shadeHex(DOOR_C, (x===8||x===11) ? -16 : (((x+y)&1) ? 5 : -4)));
  fill(door, 8, 11, 7, 7, 0, 0, shadeHex(TRIM_C, -16));
  put(door, 10, 3, -1, KNOB_C);
  put(door, 10, 4, -1, shadeHex(KNOB_C, -12));

  // ── 一楼 / 二楼楼板 ──
  fill(floor1, 1, WX-2, 1, 1, 1, WZ-2, (x,y,z)=> shadeHex(FLOOR_C, ((x+z)&1)?5:-6));
  fill(loftFloor, 1, 9, LOFT_Y, LOFT_Y, 2, WZ-3, (x,y,z)=> shadeHex(FLOOR_C, (z&1)?4:-5));
  fill(loftFloor, 9, 10, 1, LOFT_Y, 11, 13, shadeHex(FLOOR_D, -8)); // 楼梯旁支撑

  // ── 二楼护栏 ──
  for(let z=2; z<=WZ-3; z++){
    put(loftRail, 10, LOFT_Y+1, z, FRAME_D);
    if ((z-2)%2===0) put(loftRail, 10, LOFT_Y+2, z, FRAME_D);
  }
  fill(loftRail, 10, 10, LOFT_Y+3, LOFT_Y+3, 2, WZ-3, FRAME_D);
  fill(loftRail, 8, 10, LOFT_Y+1, LOFT_Y+1, 2, 2, FRAME_D);
  fill(loftRail, 8, 10, LOFT_Y+3, LOFT_Y+3, 2, 2, FRAME_D);
  fill(loftRail, 8, 8, LOFT_Y+1, LOFT_Y+3, 2, 2, FRAME_D);

  // ── 楼梯：紧贴右后墙，尺度比床/桌子更大，符合图中主次关系 ──
  for(let step=0; step<7; step++){
    const y = 1 + step;
    const x0 = 15 - step;
    const x1 = 17 - step;
    fill(stairs, x0, x1, y, y, 11, 13, shadeHex(STAIR_C, (step&1)?4:-4));
  }
  fill(stairs, 9, 11, LOFT_Y, LOFT_Y, 11, 13, shadeHex(STAIR_C, -4));
  for(let step=0; step<7; step++) put(stairs, 17-step, 2+step, 14, FRAME_D);
  fill(stairs, 10, 10, LOFT_Y+1, LOFT_Y+3, 14, 14, FRAME_D);

  // ── 卧室家具：床、枕头、床头柜 ──
  fill(bed, 2, 5, LOFT_Y+1, LOFT_Y+1, 4, 7, shadeHex(STAIR_C, -2));
  fill(bed, 2, 5, LOFT_Y+2, LOFT_Y+2, 4, 7, BED_C);
  fill(bed, 2, 2, LOFT_Y+2, LOFT_Y+3, 4, 7, shadeHex(STAIR_C, -8));
  fill(bed, 3, 4, LOFT_Y+3, LOFT_Y+3, 4, 5, PILLOW_C);
  fill(bed, 6, 7, LOFT_Y+1, LOFT_Y+2, 5, 6, shadeHex(TABLE_C, -10));

  // ── 一楼家具：餐桌 + 两把椅子 ──
  fill(dining, 7, 10, 3, 3, 7, 10, TABLE_C);
  [[7,7],[10,7],[7,10],[10,10]].forEach(([x,z]) => fill(dining, x, x, 1, 2, z, z, shadeHex(TABLE_C, -14)));
  fill(dining, 5, 6, 1, 3, 7, 7, CHAIR_C);
  fill(dining, 5, 6, 1, 2, 6, 6, shadeHex(CHAIR_C, -10));
  fill(dining, 11, 12, 1, 3, 10, 10, CHAIR_C);
  fill(dining, 11, 12, 1, 2, 11, 11, shadeHex(CHAIR_C, -10));

  // ── 厨房：后墙柜体 + 炉灶 + 冰箱 ──
  fill(kitchen, 13, 18, 2, 3, 12, 14, KITCHEN_C);
  fill(kitchen, 17, 18, 2, 6, 9, 10, FRIDGE_C);
  fill(kitchen, 13, 15, 4, 5, 13, 14, shadeHex(KITCHEN_C, -14));
  fill(kitchen, 12, 14, 2, 5, 10, 11, shadeHex('#6f6c68', -8));
  fill(kitchen, 12, 14, 6, 6, 10, 11, shadeHex('#9c9b97', 10));
  put(kitchen, 13, 6, 10, '#e28052');
  put(kitchen, 14, 6, 11, '#f2b35d');

  // ── 屋顶：左右两坡分开建，保证像参考图那样是"叠片状"的山墙屋顶，而不是实心块 ──
  for(let step=0; step<ROOF_STEPS; step++){
    const y = GABLE_Y0 + step;
    const left0 = 2 + step;
    const left1 = 3 + step;
    const right0 = 16 - step;
    const right1 = 17 - step;
    fill(roofLeft, left0, left1, y, y, -1, WZ, (x,yy,z)=> shadeHex(step % 2 ? ROOF_B : ROOF_A, (z&1)?5:-5));
    fill(roofRight, right0, right1, y, y, -1, WZ, (x,yy,z)=> shadeHex(step % 2 ? ROOF_A : ROOF_B, (z&1)?4:-4));
    fill(roofUnder, left1, left1, y-1, y-1, 0, WZ-1, (x,yy,z)=> shadeHex(ROOF_U, (z&1)?3:-3));
    fill(roofUnder, right0, right0, y-1, y-1, 0, WZ-1, (x,yy,z)=> shadeHex(ROOF_U, (z&1)?3:-3));
    fill(roofUnder, left0, left1, y-1, y-1, -1, -1, shadeHex(ROOF_U, -6));
    fill(roofUnder, left0, left1, y-1, y-1, WZ, WZ, shadeHex(ROOF_U, -6));
    fill(roofUnder, right0, right1, y-1, y-1, -1, -1, shadeHex(ROOF_U, -6));
    fill(roofUnder, right0, right1, y-1, y-1, WZ, WZ, shadeHex(ROOF_U, -6));
  }

  fill(roofRidge, 9, 10, RIDGE_Y, RIDGE_Y, -1, WZ, RIDGE_C);
  fill(roofRidge, 8, 11, GABLE_Y0, GABLE_Y0, -2, -2, RIDGE_C);
  fill(roofRidge, 8, 11, GABLE_Y0, GABLE_Y0, WZ+1, WZ+1, RIDGE_C);

  // ── 烟囱 ──
  fill(chimney, 13, 14, 13, 16, 6, 7, (x,y,z)=> shadeHex(CHIM_C, ((x+y+z)&1)?4:-4));
  fill(chimney, 12, 15, 17, 17, 5, 8, shadeHex('#5a2a18', -4));

  const comps = [
    { name:'底座托盘', color:BASE_LIGHT, vox:baseTray },
    { name:'框架角柱', color:FRAME_C, vox:framePosts },
    { name:'框架梁', color:FRAME_D, vox:frameBeams },
    { name:'墙体外壳', color:WALL_C, vox:wallShell },
    { name:'窗框与木边', color:TRIM_C, vox:wallTrim },
    { name:'正面玻璃窗', color:'#dff4ff', vox:glassFront },
    { name:'左侧玻璃窗', color:'#dff4ff', vox:glassLeft },
    { name:'右侧玻璃窗', color:'#dff4ff', vox:glassRight },
    { name:'背面玻璃窗', color:'#dff4ff', vox:glassBack },
    { name:'阁楼玻璃窗', color:'#dff4ff', vox:glassAttic },
    { name:'正门', color:DOOR_C, vox:door },
    { name:'一楼木地板', color:FLOOR_C, vox:floor1 },
    { name:'二楼阁楼', color:FLOOR_C, vox:loftFloor },
    { name:'阁楼护栏', color:FRAME_D, vox:loftRail },
    { name:'楼梯', color:STAIR_C, vox:stairs },
    { name:'卧室家具', color:BED_C, vox:bed },
    { name:'餐桌椅', color:TABLE_C, vox:dining },
    { name:'厨房', color:KITCHEN_C, vox:kitchen },
    { name:'左坡屋顶', color:ROOF_A, vox:roofLeft },
    { name:'右坡屋顶', color:ROOF_B, vox:roofRight },
    { name:'屋顶底板', color:ROOF_U, vox:roofUnder },
    { name:'屋脊与檐口', color:RIDGE_C, vox:roofRidge },

    { name:'烟囱', color:CHIM_C, vox:chimney },
  ].filter(c => Object.keys(c.vox).length);

  let minx=Infinity,miny=Infinity,minz=Infinity,maxx=-Infinity,maxy=-Infinity,maxz=-Infinity;
  comps.forEach(c => {
    for(const k in c.vox){
      const [x,y,z]=parseKey(k);
      if(x<minx)minx=x; if(y<miny)miny=y; if(z<minz)minz=z;
      if(x>maxx)maxx=x; if(y>maxy)maxy=y; if(z>maxz)maxz=z;
    }
  });
  const pos = {
    x: -((minx+maxx+1)/2)*s + (off.x||0),
    y: -miny*s + (off.y||0),
    z: -((minz+maxz+1)/2)*s + (off.z||0),
  };

  let total = 0, rawTotal = 0;
  comps.forEach(c => {
    rawTotal += Object.keys(c.vox).length;
    const merged = mergeUniformVoxelBlocks(c.vox);
    total += Object.keys(merged).length;
    createObject({
      name:c.name,
      colorName:c.color,
      layer:0,
      voxelSize:s,
      voxels:merged,
      pos:{ x:pos.x, y:pos.y, z:pos.z },
      rotY:0
    });
  });

  orbit.target.set(0, 4.8, 0);
  orbit.radius = 28;
  orbit.phi = Math.PI * 0.34;
  updateCamera();
  refreshObjList(); refreshRightPanel(); refreshStats(); autoSave();
  return { count: comps.length, finalTotal: total, rawTotal, budget: 0 };
}

/* =========================================================
 * 双层生日蛋糕预设（尽力还原参考图）
 *  结构自下而上：
 *   3a 盘子（灰色圆托盘 + 齿状外沿，粗体素大块）
 *   2b 一层蛋糕（矮胖大圆柱：粉色胚 + 中部白色奶油夹心带 + 侧面竖褶）
 *      1b 侧面装饰：HAPPY BIRTHDAY 白字 + 彩色糖针
 *   2a 二层蛋糕（较小圆柱：粉色胚 + 顶沿白奶油 + 侧面竖褶）
 *   1a 顶部装饰：白色裱花团 + 红色樱桃(带柄) + 红白蜡烛(黄火焰)
 *  各组件使用不同体素粒度：盘子/蛋糕胚为"大块"，奶油/装饰为"细块"。
 *  统一整数网格坐标（gu 世界单位），保证严丝合缝对齐；不同组件通过
 *  合并大方块(mergeUniformVoxelBlocks)体现"体素大小不同"。目标约 4000-6000 体素。
 * ========================================================= */
function buildCakePreset(opts){
  opts = opts || {};
  const sizeMul = Math.max(0.3, opts.sizeMul || 2.6);
  const off = opts.posOffset || { x:0, y:0, z:0 };
  const gu = 0.09 * sizeMul;   // 统一网格世界单位

  // 各组件体素字典（同一整数网格）
  const plateV={}, plateRimV={};
  const t1BodyV={}, t1CreamV={}, t1RidgeV={};
  const t2BodyV={}, t2CreamV={}, t2RidgeV={};
  const creamTopV={}, cherryV={}, candleV={}, sprinkleV={}, lettersV={};

  const set=(vox,x,y,z,c)=>{ vox[keyOf(x,y,z)]=c; };
  // 圆盘（半径 rx,rz 的椭圆）。solid=true 填实；solid=false 只填最外约 2 圈的环（空心）。
  function disc(vox, y, rx, rz, colFn, solid){
    if (solid === undefined) solid = true;
    for(let x=-rx;x<=rx;x++) for(let z=-rz;z<=rz;z++){
      const e=(x*x)/(rx*rx)+(z*z)/(rz*rz);
      if(e>1) continue;
      if(!solid && e<0.7) continue;    // 空心：仅保留外环（e≈0.7..1）
      set(vox,x,y,z, colFn(x,z,e));
    }
  }
  // 空心圆柱（y0..y1）：只保留外壳(最外约 2 圈) + 顶面 + 底面，省去看不见的内部体素。
  function cyl(vox, y0, y1, rx, rz, colFn){
    for(let y=y0;y<=y1;y++){
      const shell = (y===y0 || y===y1);   // 顶/底整面填实，便于叠放与承托
      disc(vox, y, rx, rz, (x,z,e)=>colFn(x,z,e,y), shell);
    }
  }
  function addDome(vox, ox,oy,oz, rx,ry,rz, c){
    for(let x=-rx;x<=rx;x++) for(let y=0;y<=ry;y++) for(let z=-rz;z<=rz;z++){
      const e=(x*x)/(rx*rx)+(y*y)/(ry*ry)+(z*z)/(rz*rz);
      if(e<=1) set(vox, ox+x, oy+y, oz+z, c);
    }
  }
  function addBall(vox, ox,oy,oz, r, c){
    for(let x=-r;x<=r;x++) for(let y=-r;y<=r;y++) for(let z=-r;z<=r;z++){
      if(x*x+y*y+z*z<=r*r) set(vox, ox+x, oy+y, oz+z, c);
    }
  }

  // ---- 3a 盘子：单层圆托盘 + 齿状外沿（薄托盘，避免体素过多）----
  disc(plateV, 0, 16, 16, (x,z,e)=> e>0.82 ? '#6f747c' : '#8a8f97');
  disc(plateV, 1, 15, 15, (x,z,e)=> e>0.7 ? '#7a7f87' : '#9297a0', false);
  // 齿状外沿（一圈交替深浅小齿）
  for(let a=0;a<56;a++){
    const ang=a/56*Math.PI*2;
    const x=Math.round(Math.cos(ang)*16), z=Math.round(Math.sin(ang)*16);
    set(plateRimV, x,1,z, a%2? '#5c616a':'#70757e');
    set(plateRimV, x,0,z, '#565b63');
  }

  // ---- 2b 一层蛋糕：矮胖大圆柱 ----
  const RB=13, RBz=13;
  cyl(t1BodyV, 2, 8, RB, RBz, (x,z,e,y)=>{
    if(e>0.86) return '#e07f9c';             // 侧面稍深
    return y>=8 ? '#f4aabb' : '#f19bb3';     // 顶面稍亮
  });
  // 中部白色奶油夹心带（y=5 外圈一圈更亮奶油，略微外凸；只外环省体素）
  disc(t1CreamV, 5, RB+1, RBz+1, (x,z,e)=> e>0.88 ? '#f3e6c9' : '#fff4da', false);
  // 顶部一圈奶油边（贴合二层底部，只外环）
  disc(t1CreamV, 9, RB, RBz, ()=> '#fff2d6', false);
  // 侧面竖褶（外圈每隔一列压深，做出参考图的竖纹质感）
  for(let a=0;a<60;a++){
    if(a%2) continue;
    const ang=a/60*Math.PI*2;
    const x=Math.round(Math.cos(ang)*RB), z=Math.round(Math.sin(ang)*RBz);
    for(let y=2;y<=8;y++) if(y!==5) set(t1RidgeV, x,y,z, '#d67793');
  }

  // ---- 2a 二层蛋糕：较小圆柱，居中叠在一层顶部 ----
  const RT=8, RTz=8, T2Y0=10, T2Y1=15;
  cyl(t2BodyV, T2Y0, T2Y1, RT, RTz, (x,z,e,y)=>{
    if(e>0.86) return '#dd7d99';
    return y>=T2Y1 ? '#f4aabb' : '#ef9bb3';
  });
  // 二层顶沿奶油
  disc(t2CreamV, T2Y1+1, RT, RTz, (x,z,e)=> e>0.82 ? '#f3e6c9' : '#fff4da');
  // 二层底沿奶油带（与一层衔接处一圈）
  disc(t2CreamV, T2Y0, RT+1, RTz+1, (x,z,e)=> e>0.86 ? '#f3e6c9' : '#fff4da');
  // 二层侧面竖褶
  for(let a=0;a<48;a++){
    if(a%2) continue;
    const ang=a/48*Math.PI*2;
    const x=Math.round(Math.cos(ang)*RT), z=Math.round(Math.sin(ang)*RTz);
    for(let y=T2Y0+1;y<=T2Y1-1;y++) set(t2RidgeV, x,y,z, '#d3768f');
  }

  // ---- 1a 顶部装饰：裱花团 + 樱桃 + 蜡烛 ----
  const topY=T2Y1+2;
  // 白色裱花团（环绕蜡烛一圈 + 几个散点，半径匹配二层 RT=8）
  [[-5,-2],[0,-5],[5,-2],[-5,2],[5,2],[-2,4],[3,4]].forEach(p=> addDome(creamTopV, p[0],topY,p[1], 2,3,2, '#fff6e2'));
  // 红色樱桃（两颗，带巧克力柄），放在裱花之间
  [[-4,3],[4,-3]].forEach((p,i)=>{
    addBall(cherryV, p[0], topY+2, p[1], 2, i? '#c62828':'#d83232');
    set(cherryV, p[0], topY+4, p[1], '#5a3a27');
    set(cherryV, p[0]+1, topY+5, p[1], '#6b4630');
    set(cherryV, p[0]+2, topY+5, p[1], '#6b4630');
  });
  // 红白相间蜡烛（居中）+ 黄色火焰
  const cy0=topY+1;
  for(let y=cy0;y<=cy0+11;y++){
    const band=Math.floor((y-cy0)/3);
    const col = band%2===0 ? '#e23a3a' : '#f4f4f4';
    for(let dx=-1;dx<=1;dx++) for(let dz=-1;dz<=1;dz++) if(dx*dx+dz*dz<=2) set(candleV, dx, y, dz, col);
  }
  set(candleV,0,cy0+12,0,'#f4a020');
  addBall(candleV, 0, cy0+14, 0, 1, '#ffbf2e');
  set(candleV,0,cy0+16,0,'#ffe45a');

  // ---- 1b 侧面装饰：彩色糖针（贴在一/二层侧面与顶面）----
  const sc=['#4d8cff','#4dd07a','#ffd166','#b06dff','#ff5d5d','#ff9a4d','#43e0d0','#ff8ec7'];
  let si=0;
  // 一层侧面糖针
  for(let a=0;a<120;a++){
    if(vnoise(a*1.3,7,0)<0.45) continue;
    const ang=a/120*Math.PI*2;
    const x=Math.round(Math.cos(ang)*(RB));
    const z=Math.round(Math.sin(ang)*(RBz));
    const y=3+Math.floor(vnoise(a*2.1,0,0)*6);
    if(y===5||y===6) continue;               // 避开奶油带
    set(sprinkleV, x,y,z, sc[si++%sc.length]);
  }
  // 二层侧面糖针
  for(let a=0;a<80;a++){
    if(vnoise(a*1.7,3,0)<0.5) continue;
    const ang=a/80*Math.PI*2;
    const x=Math.round(Math.cos(ang)*RT);
    const z=Math.round(Math.sin(ang)*RTz);
    const y=T2Y0+1+Math.floor(vnoise(a*1.1,5,0)*5);
    set(sprinkleV, x,y,z, sc[si++%sc.length]);
  }

  // ---- HAPPY BIRTHDAY 白色字母（贴一层正面，沿弧面排布）----
  // 紧凑 3 高小字体（每字宽 3），贴在一层前弧面上，字随弧面轻微内凹
  const font3 = {
    H:['101','101','111','101','101'],
    A:['111','101','111','101','101'],
    P:['111','101','111','100','100'],
    Y:['101','101','111','010','010'],
    B:['110','101','111','101','111'],
    I:['111','010','010','010','111'],
    R:['110','101','111','110','101'],
    T:['111','010','010','010','010'],
    D:['110','101','101','101','110'],
    ' ':['0','0','0','0','0'],
  };
  // 在一层前侧弧面按角度排布一段文字；centerA 为中心角度（弧度），baseY 为底行 y
  function drawArcWord(word, baseY, spanCols, startCol){
    // 把字母列映射到前弧（z<0）上的一段角度范围，贴合圆柱表面
    let col = startCol;
    for(const ch of word){
      const pat=font3[ch]||font3[' ']; const w=pat[0].length;
      for(let cc=0;cc<w;cc++){
        // 当前列在整段中的归一化位置 → 角度（集中在正前方 ±0.9 弧度内）
        const frac = (col) / spanCols;          // 0..1
        const ang = -Math.PI/2 + (frac-0.5)*1.7; // 正前方为 -PI/2（指向 -z）
        const x = Math.round(Math.cos(ang)*(RB));
        const z = Math.round(Math.sin(ang)*(RBz));
        for(let r=0;r<5;r++) if(pat[r][cc]==='1'){
          set(lettersV, x, baseY-r, z, '#ffffff');
        }
        col++;
      }
      col++; // 字间距
    }
  }
  // 两行：HAPPY（上）/ BIRTHDAY（下），沿一层前弧面
  drawArcWord('HAPPY',    8, 34, 7);
  drawArcWord('BIRTHDAY', 3, 34, 3);

  // ---- 组件清单：各自可有不同"块粗细"（通过合并大方块体现体素大小不同）----
  const comps = [
    { name:'3a 盘子',            color:'#83888f', vox:plateV,     merge:true  },
    { name:'3a 盘子·齿边',       color:'#5c616a', vox:plateRimV,  merge:false },
    { name:'2b 一层蛋糕胚',      color:'#f19bb3', vox:t1BodyV,    merge:true  },
    { name:'2b 一层奶油夹心',    color:'#fff4da', vox:t1CreamV,   merge:false },
    { name:'2b 一层侧面竖褶',    color:'#d67793', vox:t1RidgeV,   merge:false },
    { name:'2a 二层蛋糕胚',      color:'#ef9bb3', vox:t2BodyV,    merge:true  },
    { name:'2a 二层奶油',        color:'#fff4da', vox:t2CreamV,   merge:false },
    { name:'2a 二层侧面竖褶',    color:'#d3768f', vox:t2RidgeV,   merge:false },
    { name:'1a 顶部裱花团',      color:'#fff6e2', vox:creamTopV,  merge:false },
    { name:'1a 樱桃装饰',        color:'#d83232', vox:cherryV,    merge:false },
    { name:'1a 生日蜡烛',        color:'#e23a3a', vox:candleV,    merge:false },
    { name:'1b 彩色糖针',        color:'#4d8cff', vox:sprinkleV,  merge:false },
    { name:'1b HAPPY BIRTHDAY',  color:'#ffffff', vox:lettersV,   merge:false },
  ].filter(c=>Object.keys(c.vox).length);

  // 统一整数网格 → 公共世界包围盒，水平居中、底部落地
  let minx=Infinity,miny=Infinity,minz=Infinity,maxx=-Infinity,maxy=-Infinity,maxz=-Infinity;
  comps.forEach(c=>{ for(const k in c.vox){ const [x,y,z]=parseKey(k);
    if(x<minx)minx=x; if(y<miny)miny=y; if(z<minz)minz=z;
    if(x>maxx)maxx=x; if(y>maxy)maxy=y; if(z>maxz)maxz=z; } });
  const pos = {
    x: -((minx+maxx+1)/2)*gu + (off.x||0),
    y: -miny*gu + (off.y||0),
    z: -((minz+maxz+1)/2)*gu + (off.z||0),
  };

  let total=0, rawTotal=0;
  comps.forEach(c=>{
    rawTotal += Object.keys(c.vox).length;   // 合并前实际体素格数（对外"体素数量"）
    // 大块组件合并同色相邻体素为更大的方块（体素数变少、单块更大），细节组件保持原粒度
    const voxels = c.merge ? mergeUniformVoxelBlocks(c.vox) : c.vox;
    total += Object.keys(voxels).length;
    createObject({
      name:c.name,
      colorName:c.color,
      layer:0,
      voxelSize:gu,
      voxels,
      pos:{ x:pos.x, y:pos.y, z:pos.z },
      rotY:0
    });
  });

  orbit.target.set(0, 5.5, 0);
  orbit.radius = 30;
  orbit.phi = Math.PI * 0.34;
  updateCamera();
  refreshObjList(); refreshRightPanel(); refreshStats(); autoSave();
  return { count: comps.length, finalTotal: rawTotal, rawTotal, budget: 0 };
}

/* =========================================================
 * 双层生日蛋糕预设 2（分件拼装完整模型，参考图）
 *  ① 盘子、一二层糕体、奶油、樱桃、蜡烛、彩糖、文字均为独立物件；
 *  ② 每件使用不同 voxelSize，并按参考图位置装配成一体；
 *  ③ 通过空心糕体与可见表面细节，将总量控制在约 4000-6000 体素。
 * ========================================================= */
function buildCakePreset2(opts){
  opts = opts || {};
  const sizeMul = Math.max(0.3, opts.sizeMul || 2.6);
  const off = opts.posOffset || { x:0, y:0, z:0 };

  // 通用体素工具（在"组件本地整数网格"上作画，坐标以各组件自身为原点）
  function newVox(){ return {}; }
  const set=(vox,x,y,z,c)=>{ vox[keyOf(x,y,z)]=c; };
  function disc(vox,y,rx,rz,colFn,solid){
    if(solid===undefined) solid=true;
    for(let x=-rx;x<=rx;x++) for(let z=-rz;z<=rz;z++){
      const e=(x*x)/(rx*rx)+(z*z)/(rz*rz);
      if(e>1) continue;
      if(!solid && e<0.68) continue;
      set(vox,x,y,z,colFn(x,z,e));
    }
  }
  function cyl(vox,y0,y1,rx,rz,colFn){
    for(let y=y0;y<=y1;y++){ const solid=(y===y0||y===y1); disc(vox,y,rx,rz,(x,z,e)=>colFn(x,z,e,y),solid); }
  }
  function dome(vox,ox,oy,oz,rx,ry,rz,c){
    for(let x=-rx;x<=rx;x++) for(let y=0;y<=ry;y++) for(let z=-rz;z<=rz;z++){
      const e=(x*x)/(rx*rx)+(y*y)/(ry*ry)+(z*z)/(rz*rz); if(e<=1) set(vox,ox+x,oy+y,oz+z,c);
    }
  }
  function ball(vox,ox,oy,oz,r,c){
    for(let x=-r;x<=r;x++) for(let y=-r;y<=r;y++) for(let z=-r;z<=r;z++) if(x*x+y*y+z*z<=r*r) set(vox,ox+x,oy+y,oz+z,c);
  }

  // ---- 逐组件构建（每件本地坐标，底部约在 y=0）----
  // 3a 盘子（较大粒度体素）
  const plate=newVox();
  disc(plate,0,15,15,(x,z,e)=> e>0.82?'#6f747c':'#8a8f97');
  disc(plate,1,14,14,(x,z,e)=> e>0.7?'#7a7f87':'#9297a0', false);
  for(let a=0;a<52;a++){ const ang=a/52*Math.PI*2; const x=Math.round(Math.cos(ang)*15), z=Math.round(Math.sin(ang)*15); set(plate,x,1,z,a%2?'#5c616a':'#70757e'); set(plate,x,0,z,'#565b63'); }

  // 2b 一层蛋糕（中等粒度）：空心圆柱 + 中部奶油带 + 竖褶
  const tier1=newVox(); const R1=13;
  cyl(tier1,0,7,R1,R1,(x,z,e,y)=> e>0.86?'#e07f9c':(y>=7?'#f4aabb':'#f19bb3'));
  disc(tier1,4,R1+1,R1+1,(x,z,e)=> e>0.86?'#f3e6c9':'#fff4da', false);
  disc(tier1,8,R1,R1,()=> '#fff2d6', false);
  for(let a=0;a<60;a++){ if(a%2)continue; const ang=a/60*Math.PI*2; const x=Math.round(Math.cos(ang)*R1), z=Math.round(Math.sin(ang)*R1); for(let y=0;y<=7;y++) if(y!==4) set(tier1,x,y,z,'#d67793'); }

  // 2a 二层蛋糕（中等粒度，略小）
  const tier2=newVox(); const R2=8;
  cyl(tier2,0,5,R2,R2,(x,z,e,y)=> e>0.86?'#dd7d99':(y>=5?'#f4aabb':'#ef9bb3'));
  disc(tier2,6,R2,R2,(x,z,e)=> e>0.82?'#f3e6c9':'#fff4da');
  disc(tier2,0,R2+1,R2+1,(x,z,e)=> e>0.86?'#f3e6c9':'#fff4da', false);
  for(let a=0;a<48;a++){ if(a%2)continue; const ang=a/48*Math.PI*2; const x=Math.round(Math.cos(ang)*R2), z=Math.round(Math.sin(ang)*R2); for(let y=1;y<=4;y++) set(tier2,x,y,z,'#d3768f'); }

  // 1a 顶部奶油裱花团（细粒度）：一簇裱花
  const cream=newVox();
  [[0,0,0],[5,0,0],[-5,0,0],[0,0,5],[0,0,-5],[3,0,3],[-3,0,-3]].forEach(p=> dome(cream,p[0],0,p[2],2,3,2,'#fff6e2'));

  // 1a 樱桃（细粒度）：两颗带柄
  const cherry=newVox();
  ball(cherry,-3,2,0,2,'#d83232'); ball(cherry,3,2,0,2,'#c62828');
  set(cherry,-3,5,0,'#5a3a27'); set(cherry,-2,6,0,'#6b4630');
  set(cherry,3,5,0,'#5a3a27'); set(cherry,4,6,0,'#6b4630');

  // 1a 蜡烛（细粒度）：红白柱 + 黄火焰
  const candle=newVox();
  for(let y=0;y<=11;y++){ const band=Math.floor(y/3); const col=band%2===0?'#e23a3a':'#f4f4f4'; for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++) if(dx*dx+dz*dz<=2) set(candle,dx,y,dz,col); }
  set(candle,0,12,0,'#f4a020'); ball(candle,0,14,0,1,'#ffbf2e'); set(candle,0,16,0,'#ffe45a');

  // 1b 彩色糖针（细粒度）：散落一片
  const sprinkle=newVox(); const sc=['#4d8cff','#4dd07a','#ffd166','#b06dff','#ff5d5d','#ff9a4d','#43e0d0','#ff8ec7'];
  for(let i=0;i<80;i++){ const x=Math.round((vnoise(i*1.7,0,0)*2-1)*12); const z=Math.round((vnoise(0,i*2.3,0)*2-1)*12); set(sprinkle,x,0,z,sc[i%sc.length]); }

  // 1b HAPPY BIRTHDAY 字母（细粒度）：平铺两行
  const letters=newVox();
  const font3={H:['101','101','111','101','101'],A:['111','101','111','101','101'],P:['111','101','111','100','100'],Y:['101','101','111','010','010'],B:['110','101','111','101','111'],I:['111','010','010','010','111'],R:['110','101','111','110','101'],T:['111','010','010','010','010'],D:['110','101','101','101','110'],' ':['0','0','0','0','0']};
  function drawWord(word,startX,baseY){ let cx=startX; for(const ch of word){ const pat=font3[ch]||font3[' ']; const w=pat[0].length; for(let r=0;r<5;r++)for(let c=0;c<w;c++) if(pat[r][c]==='1') set(letters,cx+c,baseY-r,0,'#ffffff'); cx+=w+1; } return cx; }
  drawWord('HAPPY',0,10); drawWord('BIRTHDAY',0,4);

  // ---- 组件清单：各自使用不同 voxelSize，并以独立物件装配为完整蛋糕 ----
  // at 是该组件局部包围盒的目标最小角，值基于默认 sizeMul=2.6；所有坐标会随整体大小同比缩放。
  const layoutScale = sizeMul / 2.6;
  const comps=[
    { name:'3a 盘子',            color:'#8a8f97', vox:plate,    vs:0.110, at:[-4.43,0.00,-4.43] },
    { name:'2b 一层蛋糕',        color:'#f19bb3', vox:tier1,    vs:0.100, at:[-3.51,0.57,-3.51] },
    { name:'2a 二层蛋糕',        color:'#ef9bb3', vox:tier2,    vs:0.100, at:[-2.21,2.91,-2.21] },
    { name:'1a 顶部奶油裱花',    color:'#fff6e2', vox:cream,    vs:0.055, at:[-1.07,4.73,-1.07] },
    { name:'1a 樱桃装饰',        color:'#d83232', vox:cherry,   vs:0.050, at:[-0.65,5.15,-0.26] },
    { name:'1a 生日蜡烛',        color:'#e23a3a', vox:candle,   vs:0.050, at:[-0.20,4.91,-0.20] },
    { name:'1b 彩色糖针',        color:'#4d8cff', vox:sprinkle, vs:0.045, at:[-1.52,2.93,-1.52] },
    { name:'1b HAPPY BIRTHDAY',  color:'#ffffff', vox:letters,  vs:0.045, at:[-1.90,0.86,-3.62] },
  ].filter(c=>Object.keys(c.vox).length);
  comps.forEach(c=> c.vs *= sizeMul);

  function worldBounds(c){
    let minx=Infinity,miny=Infinity,minz=Infinity,maxx=-Infinity,maxy=-Infinity,maxz=-Infinity;
    for(const k in c.vox){ const [x,y,z]=parseKey(k);
      if(x<minx)minx=x; if(y<miny)miny=y; if(z<minz)minz=z;
      if(x+1>maxx)maxx=x+1; if(y+1>maxy)maxy=y+1; if(z+1>maxz)maxz=z+1; }
    return { minx, miny, minz, maxx, maxy, maxz };
  }

  let total=0;
  comps.forEach(c=>{
    const b=worldBounds(c), [ax,ay,az]=c.at;
    total += Object.keys(c.vox).length;
    createObject({
      name:c.name,
      colorName:c.color,
      layer:0,
      voxelSize:c.vs,
      voxels:c.vox,
      pos:{
        x:ax*layoutScale-b.minx*c.vs+(off.x||0),
        y:ay*layoutScale-b.miny*c.vs+(off.y||0),
        z:az*layoutScale-b.minz*c.vs+(off.z||0),
      },
      rotY:0,
    });
  });

  orbit.target.set(0, 2.9*layoutScale+(off.y||0), 0);
  orbit.radius = 26;
  orbit.phi = Math.PI * 0.34;
  updateCamera();
  refreshObjList(); refreshRightPanel(); refreshStats(); autoSave();
  return { count: comps.length, finalTotal: total, rawTotal: total, budget: 0 };
}

function buildTruckPreset(opts){
  opts = opts || {};
  const sizeMul = Math.max(0.3, opts.sizeMul || 2.4);
  const layoutScale = sizeMul / 2.4;
  const off = opts.posOffset || { x:0, y:0, z:0 };

  const BODY_A = '#4aa5f2', BODY_B = '#328fdd', BODY_C = '#6cbcff';
  const FRAME_A = '#565c65', FRAME_B = '#767d87';
  const RUBBER_A = '#22252b', RUBBER_B = '#353942';
  const RIM_A = '#d6dde6', RIM_B = '#8d96a0';
  const WOOD_A = '#d8ae62', WOOD_B = '#bf9150', WOOD_C = '#8e6335';
  const GLASS_V = encodeVoxel('#dff4ff', 'cube', 0, null, 1, 0.28);

  function newVox(){ return {}; }
  const set = (vox, x, y, z, val) => { vox[keyOf(x,y,z)] = val; };
  function fill(vox, x0, x1, y0, y1, z0, z1, val){
    for(let x=x0; x<=x1; x++) for(let y=y0; y<=y1; y++) for(let z=z0; z<=z1; z++){
      vox[keyOf(x,y,z)] = (typeof val === 'function') ? val(x,y,z) : val;
    }
  }
  function del(vox, x0, x1, y0, y1, z0, z1){
    for(let x=x0; x<=x1; x++) for(let y=y0; y<=y1; y++) for(let z=z0; z<=z1; z++) delete vox[keyOf(x,y,z)];
  }
  function cylZ(vox, z0, z1, rx, ry, colFn, inner){
    inner = inner || 0;
    for(let z=z0; z<=z1; z++){
      const cap = (z===z0 || z===z1);
      for(let x=-rx; x<=rx; x++) for(let y=0; y<=ry*2; y++){
        const dx = x / Math.max(0.1, rx), dy = (y-ry) / Math.max(0.1, ry);
        const e = dx*dx + dy*dy;
        if (e > 1) continue;
        if (!cap && inner > 0){
          const ie = (x/Math.max(0.1, inner))*(x/Math.max(0.1, inner)) + ((y-ry)/Math.max(0.1, inner))*((y-ry)/Math.max(0.1, inner));
          if (ie < 1) continue;
        }
        set(vox, x, y, z, (typeof colFn === 'function') ? colFn(x,y,z,e,cap) : colFn);
      }
    }
  }
  function makeCrate(w, h, d, palette){
    const vox = {}, c1 = palette[0], c2 = palette[1], c3 = palette[2];
    for(let x=0; x<w; x++) for(let y=0; y<h; y++) for(let z=0; z<d; z++){
      if (!(x===0||x===w-1||y===0||y===h-1||z===0||z===d-1)) continue;
      let col = ((x+y+z)&1) ? c1 : c2;
      const edgeCount = (x===0||x===w-1) + (y===0||y===h-1) + (z===0||z===d-1);
      if (edgeCount >= 2) col = c3;
      if (y===h-1 && ((x%3===1)||(z%3===1))) col = shadeHex(c2, 10);
      if (y>0 && y<h-1 && (x===Math.floor(w/2) || z===Math.floor(d/2))) col = shadeHex(c1, -10);
      set(vox, x, y, z, col);
    }
    return vox;
  }
  function bounds(comp){
    let minx=Infinity,miny=Infinity,minz=Infinity,maxx=-Infinity,maxy=-Infinity,maxz=-Infinity;
    for(const k in comp.vox){
      const [x,y,z] = parseKey(k);
      if(x<minx)minx=x; if(y<miny)miny=y; if(z<minz)minz=z;
      if(x+1>maxx)maxx=x+1; if(y+1>maxy)maxy=y+1; if(z+1>maxz)maxz=z+1;
    }
    return { minx, miny, minz, maxx, maxy, maxz, w:(maxx-minx)*comp.vs, d:(maxz-minz)*comp.vs, cx:(minx+maxx)/2, cz:(minz+maxz)/2 };
  }

  const cabShell = newVox();
  fill(cabShell, 2, 17, 0, 0, 0, 15, (x,y,z)=> shadeHex(BODY_B, ((x+z)&1)?-8:6));
  fill(cabShell, 7, 17, 12, 15, 0, 15, (x,y,z)=> shadeHex(BODY_A, (z&1)?6:-4));
  fill(cabShell, 3, 6, 12, 13, 0, 15, (x,y,z)=> shadeHex(BODY_C, (x&1)?8:-2));
  fill(cabShell, 2, 3, 4, 11, 0, 1, BODY_B);
  fill(cabShell, 2, 3, 4, 11, 14, 15, BODY_B);
  fill(cabShell, 2, 4, 1, 3, 1, 14, (x,y,z)=> shadeHex(BODY_B, (z&1)?-6:4));
  fill(cabShell, 4, 17, 1, 11, 0, 0, (x,y,z)=> shadeHex(BODY_A, ((x+y)&1)?5:-5));
  fill(cabShell, 4, 17, 1, 11, 15, 15, (x,y,z)=> shadeHex(BODY_A, ((x+y)&1)?5:-5));
  fill(cabShell, 17, 17, 1, 14, 0, 15, BODY_B);
  fill(cabShell, 14, 17, 4, 11, 0, 1, shadeHex(BODY_A, -12));
  fill(cabShell, 14, 17, 4, 11, 14, 15, shadeHex(BODY_A, -12));
  fill(cabShell, 6, 13, 2, 5, 0, 0, shadeHex(BODY_A, -16));
  fill(cabShell, 6, 13, 2, 5, 15, 15, shadeHex(BODY_A, -16));
  fill(cabShell, 7, 13, 6, 6, 0, 0, '#274f84');
  fill(cabShell, 7, 13, 6, 6, 15, 15, '#274f84');
  fill(cabShell, 2, 6, 12, 12, 0, 15, shadeHex(BODY_A, -18));
  // 车顶只保留可见外壳，挖空内部不可见体素，使整车保持在 4000-6000 体素区间。
  del(cabShell, 8, 16, 13, 14, 1, 14);
  del(cabShell, 7, 13, 7, 10, 0, 0);
  del(cabShell, 7, 13, 7, 10, 15, 15);

  const cabGlass = newVox();
  fill(cabGlass, 2, 2, 5, 11, 2, 13, GLASS_V);
  fill(cabGlass, 7, 13, 7, 10, 0, 0, GLASS_V);
  fill(cabGlass, 7, 13, 7, 10, 15, 15, GLASS_V);
  fill(cabGlass, 16, 16, 7, 10, 4, 11, GLASS_V);

  const cabInterior = newVox();
  fill(cabInterior, 4, 7, 4, 5, 3, 12, '#2d3138');
  fill(cabInterior, 6, 6, 6, 7, 4, 5, '#1d2025');
  fill(cabInterior, 5, 5, 6, 6, 4, 6, '#1d2025');
  fill(cabInterior, 10, 13, 2, 5, 3, 6, '#3e434b');
  fill(cabInterior, 10, 13, 2, 5, 9, 12, '#3e434b');
  fill(cabInterior, 11, 12, 6, 7, 3, 6, '#4b525a');
  fill(cabInterior, 11, 12, 6, 7, 9, 12, '#4b525a');
  fill(cabInterior, 13, 16, 2, 3, 5, 10, '#31353c');

  const frontFace = newVox();
  fill(frontFace, -2, 0, 0, 1, 0, 15, (x,y,z)=> shadeHex('#808791', ((z+y)&1)?8:-8));
  fill(frontFace, -1, 0, 2, 2, 0, 15, shadeHex('#555b64', -4));
  fill(frontFace, 0, 1, 3, 6, 3, 12, (x,y,z)=> (z>=5 && z<=10 && y>=4 && y<=5) ? '#2d3138' : shadeHex('#cfd4dc', ((y+z)&1)?6:-6));
  fill(frontFace, -1, 0, 1, 2, 1, 3, '#f6f7fb');
  fill(frontFace, -1, 0, 1, 2, 12, 14, '#f6f7fb');
  fill(frontFace, -2, -2, 1, 2, 1, 3, '#ffb44d');
  fill(frontFace, -2, -2, 1, 2, 12, 14, '#ffb44d');
  fill(frontFace, -1, 0, 0, 0, 4, 11, '#1e2126');

  const roofTrim = newVox();
  fill(roofTrim, 0, 5, 0, 1, 2, 9, shadeHex('#b7c1cb', 4));
  fill(roofTrim, 1, 4, 2, 2, 3, 8, shadeHex('#9ba5af', -6));

  const mirrorL = newVox();
  fill(mirrorL, 0, 1, 2, 4, 2, 3, '#25282d');
  fill(mirrorL, 2, 4, 1, 5, 1, 4, '#3d434b');
  fill(mirrorL, 3, 4, 2, 4, 2, 3, '#101317');
  const mirrorR = newVox();
  fill(mirrorR, 0, 1, 2, 4, 2, 3, '#25282d');
  fill(mirrorR, 2, 4, 1, 5, 1, 4, '#3d434b');
  fill(mirrorR, 3, 4, 2, 4, 2, 3, '#101317');

  const bedShell = newVox();
  fill(bedShell, 1, 27, 0, 5, 0, 0, (x,y,z)=> shadeHex(BODY_A, ((x+y)&1)?7:-5));
  fill(bedShell, 1, 27, 0, 5, 17, 17, (x,y,z)=> shadeHex(BODY_A, ((x+y)&1)?7:-5));
  fill(bedShell, 0, 0, 0, 6, 1, 16, (x,y,z)=> shadeHex(BODY_B, ((z+y)&1)?6:-6));
  fill(bedShell, 27, 27, 0, 4, 1, 16, (x,y,z)=> shadeHex(BODY_B, ((z+y)&1)?4:-4));
  fill(bedShell, 0, 27, 6, 6, 0, 0, shadeHex(BODY_C, -12));
  fill(bedShell, 0, 27, 6, 6, 17, 17, shadeHex(BODY_C, -12));
  fill(bedShell, 0, 0, 6, 6, 1, 16, shadeHex(BODY_C, -10));
  for(let x=3; x<=25; x+=5){
    fill(bedShell, x, x, 0, 6, 0, 0, shadeHex(BODY_B, -16));
    fill(bedShell, x, x, 0, 6, 17, 17, shadeHex(BODY_B, -16));
  }
  del(bedShell, 7, 21, 2, 4, 0, 0);
  del(bedShell, 7, 21, 2, 4, 17, 17);

  const bedFloor = newVox();
  fill(bedFloor, 0, 23, 0, 0, 1, 14, (x,y,z)=> shadeHex('#b8bdc4', (z&1)?7:-7));
  for(let z=2; z<=13; z+=2) fill(bedFloor, 1, 22, 1, 1, z, z, shadeHex('#8e949d', (z&2)?4:-4));
  fill(bedFloor, 0, 23, -1, -1, 1, 1, shadeHex('#7c838c', -8));
  fill(bedFloor, 0, 23, -1, -1, 14, 14, shadeHex('#7c838c', -8));

  const chassis = newVox();
  fill(chassis, 0, 31, 0, 1, 4, 5, FRAME_A);
  fill(chassis, 0, 31, 0, 1, 12, 13, FRAME_A);
  [3,8,14,20,26].forEach(x => fill(chassis, x, x+1, 1, 2, 5, 12, shadeHex(FRAME_B, (x&2)?5:-5)));
  fill(chassis, 2, 8, 2, 3, 5, 12, '#6c727a');
  fill(chassis, 22, 29, 2, 3, 5, 12, '#646a73');
  fill(chassis, 10, 21, 2, 2, 3, 14, shadeHex(FRAME_A, -10));

  const tankL = newVox();
  fill(tankL, 0, 8, 0, 3, 0, 2, '#b5bbc4');
  fill(tankL, 1, 7, 4, 4, 0, 2, '#8e949d');
  fill(tankL, 1, 7, -1, -1, 0, 2, '#767d86');
  const tankR = newVox();
  fill(tankR, 0, 8, 0, 3, 0, 2, '#aab1ba');
  fill(tankR, 1, 7, 4, 4, 0, 2, '#858c95');
  fill(tankR, 1, 7, -1, -1, 0, 2, '#6d747e');

  function makeWheel(){
    const vox = {};
    cylZ(vox, 0, 3, 4, 4, (x,y,z,e,cap)=>{
      const inner = (x/4)*(x/4) + ((y-4)/4)*((y-4)/4);
      if (inner < 0.22) return cap ? shadeHex(RIM_A, 10) : shadeHex(RIM_B, -8);
      if (inner < 0.45) return cap ? RIM_A : RIM_B;
      return ((x+y+z)&1) ? RUBBER_A : RUBBER_B;
    }, 2.2);
    fill(vox, -1, 1, 3, 5, 0, 0, RIM_A);
    fill(vox, -1, 1, 3, 5, 3, 3, RIM_A);
    fill(vox, -2, 2, 4, 4, 0, 3, '#121417');
    return vox;
  }
  const wheelLF = makeWheel(), wheelRF = makeWheel(), wheelLM = makeWheel();
  const wheelRM = makeWheel(), wheelLR = makeWheel(), wheelRR = makeWheel();

  const crateA = makeCrate(8, 8, 8, [WOOD_A, WOOD_B, WOOD_C]);
  const crateB = makeCrate(9, 7, 7, [shadeHex(WOOD_A, -4), shadeHex(WOOD_B, 4), WOOD_C]);
  const crateC = makeCrate(7, 9, 7, [shadeHex(WOOD_A, 3), shadeHex(WOOD_B, -5), WOOD_C]);

  // 各组件保留略有差异的 voxelSize；差异足以体现粒度层次，同时保证能严丝合缝地拼装。
  const comps = [
    { name:'车头外壳',   color:BODY_A,   vox:cabShell,    vs:0.090, at:[-4.70,1.35,-1.55] },
    { name:'驾驶室玻璃', color:'#dff4ff', vox:cabGlass,    vs:0.088, at:[-4.72,2.00,-1.55] },
    { name:'驾驶室内饰', color:'#2d3138', vox:cabInterior, vs:0.086, at:[-4.38,1.62,-1.25] },
    { name:'前脸组件',   color:'#cfd4dc', vox:frontFace,   vs:0.091, at:[-5.10,1.08,-1.55] },
    { name:'车顶装饰',   color:'#b7c1cb', vox:roofTrim,    vs:0.087, at:[-4.38,4.80,-1.15] },
    { name:'左后视镜',   color:'#3d434b', vox:mirrorL,     vs:0.080, at:[-4.28,2.20,-2.02] },
    { name:'右后视镜',   color:'#3d434b', vox:mirrorR,     vs:0.081, at:[-4.28,2.20,1.58] },
    { name:'货箱外壳',   color:BODY_A,   vox:bedShell,    vs:0.089, at:[-1.45,1.55,-1.60] },
    { name:'货箱底板',   color:'#b8bdc4', vox:bedFloor,    vs:0.084, at:[-1.36,1.36,-1.30] },
    { name:'底盘车架',   color:FRAME_A,  vox:chassis,     vs:0.086, at:[-4.55,0.66,-1.22] },
    { name:'左侧油箱',   color:'#b5bbc4', vox:tankL,       vs:0.082, at:[-2.10,0.72,-2.04] },
    { name:'右侧油箱',   color:'#aab1ba', vox:tankR,       vs:0.081, at:[-2.10,0.72,1.76] },
    { name:'前轮·左',    color:RUBBER_A,  vox:wheelLF,     vs:0.088, at:[-4.18,0,-2.18] },
    { name:'前轮·右',    color:RUBBER_A,  vox:wheelRF,     vs:0.087, at:[-4.18,0,1.82] },
    { name:'中轮·左',    color:RUBBER_A,  vox:wheelLM,     vs:0.086, at:[-0.45,0,-2.15] },
    { name:'中轮·右',    color:RUBBER_A,  vox:wheelRM,     vs:0.085, at:[-0.45,0,1.81] },
    { name:'后轮·左',    color:RUBBER_A,  vox:wheelLR,     vs:0.084, at:[3.05,0,-2.12] },
    { name:'后轮·右',    color:RUBBER_A,  vox:wheelRR,     vs:0.083, at:[3.05,0,1.80] },
    { name:'货物木箱 A', color:WOOD_A,    vox:crateA,      vs:0.081, at:[-0.80,2.05,-1.14] },
    { name:'货物木箱 B', color:WOOD_A,    vox:crateB,      vs:0.079, at:[1.10,2.05,0.18] },
    { name:'货物木箱 C', color:WOOD_A,    vox:crateC,      vs:0.083, at:[2.88,2.05,-1.00] },
  ].filter(c => Object.keys(c.vox).length);
  comps.forEach(c => c.vs *= sizeMul);

  // 组件以独立对象保留，按参考图装配到同一辆完整卡车；at 为组件本地包围盒的世界最小角。
  let rawTotal = 0;
  comps.forEach(comp => {
    const info = bounds(comp);
    const [ax, ay, az] = comp.at;
    rawTotal += Object.keys(comp.vox).length;
    createObject({
      name:comp.name,
      colorName:comp.color,
      layer:0,
      voxelSize:comp.vs,
      voxels:comp.vox,
      pos:{
        x: ax * layoutScale - info.minx * comp.vs + (off.x||0),
        y: ay * layoutScale - info.miny * comp.vs + (off.y||0),
        z: az * layoutScale - info.minz * comp.vs + (off.z||0),
      },
      rotY:0,
    });
  });

  orbit.target.set(-0.2 * sizeMul, 2.1 * sizeMul, 0);
  orbit.radius = 28;
  orbit.phi = Math.PI * 0.34;
  updateCamera();
  refreshObjList(); refreshRightPanel(); refreshStats(); autoSave();
  return { count: comps.length, finalTotal: rawTotal, rawTotal, budget: 0 };
}

/* =========================================================
 * 体素礼盒预设（参考图的分件拼装完整模型）
 *  展示底座 + 礼盒盒体 + 丝带 + 倾斜盒盖 + 蝴蝶结 + 礼盒内物件；
 *  每个组件使用不同 voxelSize，采用中空/薄壳结构控制在 4000-8000 体素。
 * ========================================================= */
function buildGiftBoxPreset(opts){
  opts = opts || {};
  const sizeMul = Math.max(0.3, opts.sizeMul || 2.8);
  const layoutScale = sizeMul / 2.8;
  const off = opts.posOffset || { x:0, y:0, z:0 };
  const exportRaw = !!opts.exportRaw;
  const exportOnly = !!opts.exportOnly;

  const PINK = '#f0b6c4', PINK_D = '#d78d9f', PINK_L = '#ffdbe4', PINK_S = '#c7758a';
  const GOLD = '#efc85d', GOLD_D = '#c99a2c', GOLD_L = '#fff0a6';
  const IVORY = '#f2efe8', IVORY_D = '#d7d2ca';
  const GRAY = '#8d939d', GRAY_D = '#656a74', GRAY_L = '#b8bec8';
  const BOOK_A = '#f5efe2', BOOK_B = '#e6d0bb', BOOK_C = '#ceb298', PAGE = '#fbf8f2';
  const MUG = '#fff6ec', MUG_D = '#d8cabb';
  const BEAR = '#a06a40', BEAR_D = '#794b2a', BEAR_L = '#c1895b';
  const GIFT = '#dd9b30', GIFT_D = '#b76e17', RED = '#d34b3a', RED_D = '#a42f25';
  const BLUE = '#73aed8', GREEN = '#78af66', PURPLE = '#9076d6', ORANGE = '#e29c45';

  const V = () => ({});
  const put = (vox, x, y, z, c) => { vox[keyOf(x, y, z)] = c; };
  const fill = (vox, x0, x1, y0, y1, z0, z1, c) => {
    for (let x=x0; x<=x1; x++) for (let y=y0; y<=y1; y++) for (let z=z0; z<=z1; z++){
      put(vox, x, y, z, typeof c === 'function' ? c(x,y,z) : c);
    }
  };
  const shade = (c, x, y, z, amt) => shadeHex(c, ((x*9 + y*5 + z*7) & 1) ? (amt == null ? 6 : amt) : -((amt == null ? 6 : amt)));
  function bounds(vox){
    let minx=Infinity,miny=Infinity,minz=Infinity,maxx=-Infinity,maxy=-Infinity,maxz=-Infinity;
    for (const k in vox){ const [x,y,z]=parseKey(k);
      if (x < minx) minx = x; if (y < miny) miny = y; if (z < minz) minz = z;
      if (x + 1 > maxx) maxx = x + 1; if (y + 1 > maxy) maxy = y + 1; if (z + 1 > maxz) maxz = z + 1;
    }
    return { minx,miny,minz,maxx,maxy,maxz };
  }
  function shellOpenBox(vox, x0, x1, y0, y1, z0, z1, wallCol, rimCol, floorCol){
    for (let x=x0; x<=x1; x++) for (let y=y0; y<=y1; y++) for (let z=z0; z<=z1; z++){
      const onFloor = y === y0;
      const onWall = y > y0 && y < y1 && (x === x0 || x === x1 || z === z0 || z === z1);
      const onRim = y === y1 && (x <= x0 + 1 || x >= x1 - 1 || z <= z0 + 1 || z >= z1 - 1);
      if (!onFloor && !onWall && !onRim) continue;
      const col = onFloor ? floorCol : (y === y1 ? rimCol : wallCol);
      put(vox, x, y, z, shade(col, x, y, z, 6));
    }
  }
  function makeDisplayBase(){
    const vox = V();
    fill(vox, 0, 28, 3, 3, 0, 28, (x,y,z)=>shade((x===0||x===28||z===0||z===28)?GRAY:GRAY_L, x,y,z,6));
    for (let y=0; y<=2; y++){
      fill(vox, 0, 28, y, y, 0, 0, (x,yy,z)=>shade(y===0?GRAY_D:GRAY, x,yy,z,6));
      fill(vox, 0, 28, y, y, 28, 28, (x,yy,z)=>shade(y===0?GRAY_D:GRAY, x,yy,z,6));
      fill(vox, 0, 0, y, y, 1, 27, (x,yy,z)=>shade(y===0?GRAY_D:GRAY, x,yy,z,6));
      fill(vox, 28, 28, y, y, 1, 27, (x,yy,z)=>shade(y===0?GRAY_D:GRAY, x,yy,z,6));
    }
    for (let x=2; x<=26; x++){
      put(vox, x, 3, 1, shade(GRAY_D, x, 3, 1, 5));
      put(vox, x, 3, 27, shade(GRAY_D, x, 3, 27, 5));
    }
    for (let z=2; z<=26; z++){
      put(vox, 1, 3, z, shade(GRAY_D, 1, 3, z, 5));
      put(vox, 27, 3, z, shade(GRAY_D, 27, 3, z, 5));
    }
    return vox;
  }
  function makeGiftBody(){
    const vox = V();
    shellOpenBox(vox, 0, 21, 0, 15, 0, 21, PINK, PINK_L, PINK_D);
    fill(vox, 9, 10, 1, 13, 0, 0, (x,y,z)=>shade(PINK_S, x,y,z,6));
    fill(vox, 11, 12, 1, 13, 21, 21, (x,y,z)=>shade(PINK_S, x,y,z,6));
    fill(vox, 0, 0, 8, 10, 9, 12, (x,y,z)=>shade(IVORY_D, x,y,z,5));
    fill(vox, 21, 21, 8, 10, 9, 12, (x,y,z)=>shade(IVORY_D, x,y,z,5));
    for (let x=1; x<=20; x+=2){
      put(vox, x, 1, 1, shade(PINK_L, x, 1, 1, 4));
      put(vox, x, 1, 20, shade(PINK_L, x, 1, 20, 4));
    }
    return vox;
  }
  function makeVerticalRibbon(){
    const vox = V();
    fill(vox, 9, 12, 1, 15, 0, 0, (x,y,z)=>shade(y>11?GOLD_L:GOLD, x,y,z,6));
    fill(vox, 9, 12, 1, 15, 21, 21, (x,y,z)=>shade(y>11?GOLD_L:GOLD, x,y,z,6));
    fill(vox, 9, 12, 14, 15, 1, 20, (x,y,z)=>shade(GOLD_L, x,y,z,6));
    fill(vox, 0, 0, 12, 15, 9, 12, (x,y,z)=>shade(GOLD_D, x,y,z,5));
    fill(vox, 21, 21, 12, 15, 9, 12, (x,y,z)=>shade(GOLD_D, x,y,z,5));
    return vox;
  }
  function makeHorizontalRibbon(){
    const vox = V();
    fill(vox, 1, 20, 10, 12, 0, 0, (x,y,z)=>shade(y===12?GOLD_L:GOLD, x,y,z,6));
    fill(vox, 1, 20, 10, 12, 21, 21, (x,y,z)=>shade(y===12?GOLD_L:GOLD, x,y,z,6));
    fill(vox, 0, 0, 10, 12, 1, 20, (x,y,z)=>shade(GOLD_D, x,y,z,5));
    fill(vox, 21, 21, 10, 12, 1, 20, (x,y,z)=>shade(GOLD_D, x,y,z,5));
    return vox;
  }
  function makeLidShell(){
    const vox = V();
    const w = 24, d = 22, h = 5;
    for (let z=0; z<d; z++){
      const lift = Math.floor(z * 0.34);
      for (let x=0; x<w; x++) for (let y=0; y<h; y++){
        const top = y === h - 1;
        const bottom = y === 0;
        const side = x === 0 || x === w - 1 || z === 0 || z === d - 1;
        if (!top && !bottom && !side) continue;
        const py = y + lift;
        const col = top ? IVORY : (bottom ? PINK_D : PINK_L);
        put(vox, x, py, z, shade(col, x, py, z, 6));
      }
      for (let x=2 + (z & 1); x<w-2; x+=3) put(vox, x, h - 1 + lift, z, shade(IVORY_D, x, h - 1 + lift, z, 5));
    }
    return vox;
  }
  function makeLidLiner(){
    const vox = V();
    const w = 24, d = 22;
    for (let z=2; z<d-2; z++){
      const lift = Math.floor(z * 0.34);
      for (let x=3; x<w-3; x++){
        if (x <= 4 || x >= w-5 || z <= 3 || z >= d-4) put(vox, x, 1 + lift, z, shade(IVORY_D, x, 1 + lift, z, 5));
      }
    }
    return vox;
  }
  function makeLidRibbon(){
    const vox = V();
    for (let z=1; z<=20; z++){
      const lift = Math.floor(z * 0.34);
      fill(vox, 10, 13, 4 + lift, 4 + lift, z, z, (x,y,zz)=>shade(z < 5 ? GOLD_D : GOLD_L, x,y,zz,6));
      if (z < 5) fill(vox, 9, 14, 3 + lift, 3 + lift, z, z, (x,y,zz)=>shade(GOLD, x,y,zz,6));
    }
    return vox;
  }
  function makeBowLoop(){
    const vox = V();
    for (let x=0; x<=9; x++) for (let y=0; y<=6; y++) for (let z=-3; z<=3; z++){
      const dx = (x - 4.5) / 4.2, dy = (y - 3) / 2.8, dz = z / 2.8;
      const e = dx*dx + dy*dy + dz*dz;
      const inner = ((x - 4.5)*(x - 4.5))/7 + ((y - 3)*(y - 3))/3.2 + (z*z)/4.4;
      if (e <= 1.05 && inner >= 0.55) put(vox, x, y, z, shade((y > 3 || z === 0) ? GOLD_L : GOLD, x,y,z,7));
    }
    fill(vox, 0, 2, 2, 4, -1, 1, (x,y,z)=>shade(GOLD_D, x,y,z,6));
    return vox;
  }
  function makeBowCenter(){
    const vox = V();
    fill(vox, -2, 2, 2, 6, -2, 2, (x,y,z)=>shade((y > 4)?GOLD_L:GOLD, x,y,z,7));
    fill(vox, -5, -4, -5, 1, -1, 1, (x,y,z)=>shade(y < -1 ? GOLD_D : GOLD, x,y,z,6));
    fill(vox, 4, 5, -5, 1, -1, 1, (x,y,z)=>shade(y < -1 ? GOLD_D : GOLD, x,y,z,6));
    fill(vox, -6, -4, -6, -5, -1, 0, (x,y,z)=>shade(GOLD_D, x,y,z,6));
    fill(vox, 4, 6, -6, -5, 0, 1, (x,y,z)=>shade(GOLD_D, x,y,z,6));
    return vox;
  }
  function makeBooks(){
    const vox = V();
    function addBook(x, y, z, w, h, d, cover){
      fill(vox, x, x+w-1, y, y+h-1, z, z+d-1, (px,py,pz)=>shade(cover, px,py,pz,5));
      fill(vox, x+1, x+w-2, y+h-1, y+h-1, z+1, z+d-2, (px,py,pz)=>shade(PAGE, px,py,pz,3));
      for (let zz=z+1; zz<=z+d-2; zz+=2) put(vox, x+w-1, y+1, zz, shade(PAGE, x+w-1, y+1, zz, 3));
    }
    addBook(0, 0, 1, 8, 2, 6, BOOK_B);
    addBook(1, 2, 0, 7, 2, 5, BOOK_A);
    addBook(2, 4, 2, 6, 2, 4, BOOK_C);
    return vox;
  }
  function makeMug(){
    const vox = V();
    for (let x=0; x<=4; x++) for (let y=0; y<=5; y++) for (let z=0; z<=4; z++){
      const onBase = y === 0;
      const onWall = y < 5 && (x === 0 || x === 4 || z === 0 || z === 4);
      if (onBase || onWall) put(vox, x, y, z, shade((y > 3)?MUG:MUG_D, x,y,z,5));
    }
    fill(vox, 5, 6, 2, 4, 1, 3, (x,y,z)=>shade(MUG_D, x,y,z,5));
    fill(vox, 5, 5, 3, 3, 2, 2, (x,y,z)=>shade(MUG, x,y,z,5));
    return vox;
  }
  function makeBear(){
    const vox = V();
    fill(vox, 1, 4, 0, 3, 1, 3, (x,y,z)=>shade(BEAR, x,y,z,5));
    fill(vox, 1, 4, 4, 7, 0, 4, (x,y,z)=>shade((y > 5)?BEAR_L:BEAR, x,y,z,5));
    fill(vox, 1, 1, 2, 4, 1, 3, (x,y,z)=>shade(BEAR_D, x,y,z,5));
    fill(vox, 4, 4, 2, 4, 1, 3, (x,y,z)=>shade(BEAR_D, x,y,z,5));
    fill(vox, 0, 1, 7, 8, 1, 2, (x,y,z)=>shade(BEAR_D, x,y,z,5));
    fill(vox, 4, 5, 7, 8, 1, 2, (x,y,z)=>shade(BEAR_D, x,y,z,5));
    fill(vox, 2, 3, 5, 6, -1, 0, (x,y,z)=>shade(BEAR_L, x,y,z,4));
    put(vox, 2, 6, -1, shade('#30241d', 2,6,-1,3));
    put(vox, 3, 6, -1, shade('#30241d', 3,6,-1,3));
    return vox;
  }
  function makeMiniGift(){
    const vox = V();
    shellOpenBox(vox, 0, 4, 0, 4, 0, 4, GIFT, GIFT_D, GIFT_D);
    fill(vox, 2, 2, 0, 4, 0, 4, (x,y,z)=>shade(RED, x,y,z,6));
    fill(vox, 0, 4, 4, 4, 2, 2, (x,y,z)=>shade(RED_D, x,y,z,6));
    fill(vox, 1, 3, 5, 7, 1, 3, (x,y,z)=>shade((y > 6)?GOLD_L:RED, x,y,z,6));
    return vox;
  }
  function makePencils(){
    const vox = V();
    const cols = [RED, BLUE, GREEN, PURPLE, ORANGE];
    cols.forEach((col, i)=>{
      const x = i * 2;
      const z = (i & 1) ? 1 : 0;
      const h = 6 + (i % 3);
      fill(vox, x, x, 0, h, z, z, (px,py,pz)=>shade(col, px,py,pz,6));
      put(vox, x, h + 1, z, shade('#d9bf86', x, h + 1, z, 4));
      put(vox, x, h + 2, z, shade(col, x, h + 2, z, 6));
    });
    return vox;
  }

  const base = makeDisplayBase();
  const body = makeGiftBody();
  const ribbonV = makeVerticalRibbon();
  const ribbonH = makeHorizontalRibbon();
  const lid = makeLidShell();
  const lidLiner = makeLidLiner();
  const lidRibbon = makeLidRibbon();
  const bowLoopL = makeBowLoop();
  const bowLoopR = makeBowLoop();
  const bowCenter = makeBowCenter();
  const books = makeBooks();
  const mug = makeMug();
  const bear = makeBear();
  const miniGift = makeMiniGift();
  const pencils = makePencils();

  const comps = [
    { name:'1 展示底座', color:GRAY, vox:base, vs:0.052, at:[-2.20,0.00,-2.12] },
    { name:'2 礼盒盒体', color:PINK, vox:body, vs:0.045, at:[-1.62,0.42,-1.56] },
    { name:'3 盒体丝带·竖', color:GOLD, vox:ribbonV, vs:0.043, at:[-1.62,0.42,-1.56] },
    { name:'4 盒体丝带·横', color:GOLD, vox:ribbonH, vs:0.044, at:[-1.62,0.42,-1.56] },
    { name:'5 倾斜盒盖', color:IVORY, vox:lid, vs:0.047, at:[-1.86,2.18,-0.36] },
    { name:'6 盒盖内衬', color:IVORY_D, vox:lidLiner, vs:0.044, at:[-1.82,2.26,-0.32] },
    { name:'7 盒盖丝带', color:GOLD, vox:lidRibbon, vs:0.043, at:[-1.84,2.20,-0.34] },
    { name:'8 蝴蝶结左环', color:GOLD, vox:bowLoopL, vs:0.041, at:[-0.92,4.42,0.08] },
    { name:'9 蝴蝶结右环', color:GOLD, vox:bowLoopR, vs:0.041, at:[0.02,4.42,0.12] },
    { name:'10 蝴蝶结结芯与尾带', color:GOLD, vox:bowCenter, vs:0.040, at:[-0.34,4.18,0.10] },
    { name:'11 书本叠件', color:BOOK_A, vox:books, vs:0.039, at:[-0.98,1.04,-0.84] },
    { name:'12 马克杯', color:MUG, vox:mug, vs:0.037, at:[-0.10,1.24,-0.28] },
    { name:'13 小熊摆件', color:BEAR, vox:bear, vs:0.038, at:[0.52,1.04,0.04] },
    { name:'14 小礼盒', color:GIFT, vox:miniGift, vs:0.036, at:[1.02,1.12,-0.54] },
    { name:'15 彩笔束', color:BLUE, vox:pencils, vs:0.035, at:[0.16,1.14,0.56] },
  ].filter(c => Object.keys(c.vox).length);

  comps.forEach(c => c.vs *= sizeMul);

  const exported = [];
  let rawTotal = 0;
  comps.forEach(c=>{
    const b = bounds(c.vox), [ax, ay, az] = c.at;
    rawTotal += Object.keys(c.vox).length;
    const pos = {
      x: ax * layoutScale - b.minx * c.vs + (off.x || 0),
      y: ay * layoutScale - b.miny * c.vs + (off.y || 0),
      z: az * layoutScale - b.minz * c.vs + (off.z || 0),
    };
    if (exportRaw) exported.push({ name: c.name, color: c.color, voxelSize: c.vs, pos, rotY: 0, voxels: c.vox });
    if (!exportOnly) createObject({
      name: c.name,
      colorName: c.color,
      layer: 0,
      voxelSize: c.vs,
      voxels: mergeUniformVoxelBlocks(c.vox),
      pos,
      rotY: 0,
    });
  });

  if (!exportOnly){
    orbit.target.set(0 + (off.x||0), 2.20 * layoutScale + (off.y||0), -0.04 * layoutScale + (off.z||0));
    orbit.radius = 28;
    orbit.phi = Math.PI * 0.33;
    updateCamera();
    refreshObjList(); refreshRightPanel(); refreshStats(); autoSave();
  }
  return exportRaw
    ? { preset:'gift-box', count: comps.length, finalTotal: rawTotal, rawTotal, budget: 0, components: exported }
    : { count: comps.length, finalTotal: rawTotal, rawTotal, budget: 0 };
}

/* =========================================================
 * 体素花束预设（参考图的分件拼装完整模型）

 *  8 种不同花头 + 4 个枝叶框架 + 外包裹纸 + 底层纸包裹 + 蝴蝶结；
 *  每个组件使用不同 voxelSize，全部分开生成再装配，目标总量约 4000-6000 体素。
 * ========================================================= */
function buildBouquetPreset(opts){
  opts = opts || {};
  const sizeMul = Math.max(0.3, opts.sizeMul || 2.8);
  const layoutScale = sizeMul / 2.8;
  const off = opts.posOffset || { x:0, y:0, z:0 };
  const ROSE = '#db3535', ROSE_D = '#b91f2e', TULIP_Y = '#f2cf37', TULIP_Y2 = '#ffd95a';
  const PEONY = '#f2a3d3', PEONY_D = '#d97eb2', LAV = '#9565e6', LAV_D = '#6f46c8';
  const CORAL = '#ff8b68', CORAL_D = '#dc6a4c', ORANGE = '#ff9b2f', ORANGE_D = '#db7b1a';
  const RAN = '#f24444', RAN_D = '#d62534', LISI = '#f5b8d8', LISI_D = '#e18fc0';
  const STEM = '#69b45e', STEM_D = '#488a44', LEAF = '#59a64c', LEAF_D = '#3e8138';
  const NODE = '#b99770', NODE_D = '#9c7855';
  const KRAFT = '#d7b289', KRAFT_D = '#b88b63', KRAFT_L = '#efddc4', KRAFT_S = '#cba47c';
  const RIBBON = '#ee7fb0', RIBBON_D = '#cf5d8f', RIBBON_L = '#f6abc9';
  const V = () => ({});
  const put = (vox, x, y, z, c) => { vox[keyOf(x, y, z)] = c; };
  const fill = (vox, x0, x1, y0, y1, z0, z1, c) => {
    for (let x=x0; x<=x1; x++) for (let y=y0; y<=y1; y++) for (let z=z0; z<=z1; z++){
      put(vox, x, y, z, typeof c === 'function' ? c(x,y,z) : c);
    }
  };
  const shade = (c, x, y, z, amt) => shadeHex(c, ((x*11 + y*7 + z*5) & 1) ? (amt == null ? 6 : amt) : -((amt == null ? 6 : amt)));
  function bounds(vox){
    let minx=Infinity,miny=Infinity,minz=Infinity,maxx=-Infinity,maxy=-Infinity,maxz=-Infinity;
    for (const k in vox){ const [x,y,z]=parseKey(k);
      if (x < minx) minx = x; if (y < miny) miny = y; if (z < minz) minz = z;
      if (x + 1 > maxx) maxx = x + 1; if (y + 1 > maxy) maxy = y + 1; if (z + 1 > maxz) maxz = z + 1;
    }
    return { minx,miny,minz,maxx,maxy,maxz };
  }
  function disk(vox, cx, cy, cz, rx, rz, col, ringOnly, wobble){
    const wx = wobble || 0, wz = wobble || 0;
    for (let x=Math.floor(cx-rx-1); x<=Math.ceil(cx+rx+1); x++) for (let z=Math.floor(cz-rz-1); z<=Math.ceil(cz+rz+1); z++){
      const dx = (x-cx) / Math.max(1e-3, rx), dz = (z-cz) / Math.max(1e-3, rz);
      const e = dx*dx + dz*dz;
      const wave = wobble ? (Math.sin((x-cx)*1.1 + cy*0.75) + Math.cos((z-cz)*1.05 - cy*0.62)) * 0.035 : 0;
      if (e > 1.03 + wave) continue;
      if (ringOnly && e < 0.38 - wave) continue;
      put(vox, x, cy, z, shade(col, x, cy, z, 7));
    }
  }
  function shellEllipsoid(vox, rx, ry, rz, col, inner, yOff, xBias, zBias){
    const e0 = inner == null ? 0.58 : inner;
    for (let x=-rx; x<=rx; x++) for (let y=-ry; y<=ry; y++) for (let z=-rz; z<=rz; z++){
      const nx=(x-(xBias||0))/Math.max(1,rx), ny=y/Math.max(1,ry), nz=(z-(zBias||0))/Math.max(1,rz);
      const e = nx*nx + ny*ny + nz*nz;
      if (e <= 1 && e >= e0) put(vox, x, y + (yOff||0), z, shade(col, x, y + (yOff||0), z, 7));
    }
  }
  function addLeaf(vox, x0, y0, z0, dirX, dirZ, len, width, col){
    const L = Math.max(2, len);
    for (let t=0; t<=L; t++){
      const u = t / L;
      const cx = Math.round(x0 + dirX * t);
      const cz = Math.round(z0 + dirZ * t);
      const cy = Math.round(y0 + Math.sin(u * Math.PI) * 1.6);
      const half = Math.max(0, Math.round(width * Math.sin(u * Math.PI)));
      for (let s=-half; s<=half; s++){
        const px = cx + Math.round(-dirZ * s * 0.65);
        const pz = cz + Math.round(dirX * s * 0.65);
        if (Math.abs(s) === half || s === 0 || t === 0 || t === L || (t > 1 && t < L-1 && Math.abs(s) <= 1)){
          put(vox, px, cy, pz, shade(col, px, cy, pz, 6));
        }
      }
    }
  }
  function addStem(vox, x0, z0, h, leanX, leanZ, nodeYs){
    const pts = [];
    const H = Math.max(6, h);
    for (let y=0; y<=H; y++){
      const t = y / H;
      const x = Math.round(x0 + leanX * t + Math.sin(y*0.22 + x0*0.35) * 0.45);
      const z = Math.round(z0 + leanZ * t + Math.cos(y*0.18 + z0*0.31) * 0.38);
      put(vox, x, y, z, shade(STEM, x, y, z, 5));
      if (y < H*0.28 && y % 4 === 1) put(vox, x + (x0 < 0 ? -1 : 1), y, z, shade(STEM_D, x, y, z, 5));
      if (nodeYs && nodeYs.includes(y)) fill(vox, x, x+1, y, y+1, z, z+1, (px,py,pz)=>shade((py&1)?NODE:NODE_D, px, py, pz, 4));
      pts.push([x,y,z]);
    }
    return pts;
  }
  function makeRose(){
    const vox = V();
    const prof = [5,5,4,4,3,3,2,1];
    prof.forEach((r, y) => {
      for (let x=-r-1; x<=r+1; x++) for (let z=-r-1; z<=r+1; z++){
        const d = Math.sqrt(x*x + z*z);
        const a = Math.atan2(z, x);
        const rim = r + 0.35*Math.sin(a*4 + y*0.75) + 0.18*Math.cos(a*6 - y*0.45);
        if (d <= rim + 0.16 && (d >= rim - 1.2 || y >= 5 || ((x-z+y)&1) === 0)) put(vox, x, y, z, shade(y>3?ROSE:ROSE_D, x, y, z, 8));
      }
    });
    fill(vox,-1,1,-1,-1,-1,1,(x,y,z)=>shade(STEM_D,x,y,z,4));
    return vox;
  }
  function makeTulip(){
    const vox = V();
    for (let y=0; y<=11; y++){
      const rx = y < 3 ? 4 : (y < 8 ? 3 : 2);
      const rz = y < 3 ? 3 : (y < 8 ? 2 : 1);
      for (let x=-rx; x<=rx; x++) for (let z=-rz; z<=rz; z++){
        const e = (x*x)/(rx*rx + 0.2) + (z*z)/(rz*rz + 0.2);
        if (e <= 1.02 && (e >= 0.5 || y <= 2 || y >= 9)) put(vox, x, y, z, shade((y>8 && ((x+z)&1)) ? TULIP_Y2 : TULIP_Y, x,y,z,7));
      }
    }
    [[0,12,0],[1,11,-1],[-1,11,1]].forEach(([x,y,z])=>put(vox,x,y,z,shade(TULIP_Y2,x,y,z,7)));
    fill(vox,-1,1,-1,-1,-1,1,(x,y,z)=>shade(STEM_D,x,y,z,4));
    return vox;
  }
  function makePeony(){
    const vox = V();
    shellEllipsoid(vox, 5, 4, 5, PEONY, 0.5, 4, 0.25, -0.15);
    for (let y=1; y<=6; y++) disk(vox, 0, y, 0, Math.max(2, 5 - Math.floor(y*0.45)), Math.max(2, 5 - Math.floor(y*0.4)), y > 3 ? PEONY : PEONY_D, false, true);
    fill(vox,-1,1,-1,-1,-1,1,(x,y,z)=>shade(STEM_D,x,y,z,4));
    return vox;
  }
  function makeLavender(){
    const vox = V();
    for (let y=0; y<=12; y++){
      const r = y < 3 ? 1 : (y < 9 ? 2 : 1);
      for (let x=-r; x<=r; x++) for (let z=-r; z<=r; z++){
        const d = Math.abs(x) + Math.abs(z);
        if (d <= r + ((y&1)?0:1) && (d >= Math.max(0, r-1) || ((x+y+z)&1) === 0)) put(vox, x, y, z, shade((y%3===0)?LAV:LAV_D, x,y,z,7));
      }
    }
    fill(vox,-1,1,-1,-1,-1,1,(x,y,z)=>shade(STEM_D,x,y,z,4));
    return vox;
  }
  function makeCarnation(){
    const vox = V();
    for (let y=0; y<=8; y++){
      const r = y < 2 ? 3 : (y < 6 ? 4 : 3);
      for (let x=-r-1; x<=r+1; x++) for (let z=-r-1; z<=r+1; z++){
        const d = Math.sqrt(x*x + z*z);
        const edge = r + 0.45*Math.sin((x+z)*0.9 + y*0.8) + 0.2*Math.cos((x-z)*1.1 - y*0.45);
        if (d <= edge && (d >= edge - 1.1 || ((x*2+z+y)&1) === 0 || y >= 6)) put(vox, x, y, z, shade((y>5)?CORAL:CORAL_D, x,y,z,8));
      }
    }
    fill(vox,-1,1,-1,-1,-1,1,(x,y,z)=>shade(STEM_D,x,y,z,4));
    return vox;
  }
  function makeDahlia(){
    const vox = V();
    for (let y=0; y<=7; y++){
      const r = y < 2 ? 5 : (y < 5 ? 4 : 3);
      for (let arm=0; arm<10; arm++){
        const a = arm * Math.PI / 5 + y * 0.14;
        for (let t=1; t<=r; t++){
          const x = Math.round(Math.cos(a) * t);
          const z = Math.round(Math.sin(a) * t);
          put(vox, x, y, z, shade((t<2)?ORANGE:ORANGE_D, x,y,z,8));
          if (t < r-1 && ((arm+y)&1) === 0) put(vox, Math.round(x*0.65), y, Math.round(z*0.65), shade(ORANGE, x,y,z,7));
        }
      }
      disk(vox, 0, y, 0, Math.max(2, r-1), Math.max(2, r-1), ORANGE, false, true);
    }
    fill(vox,-1,1,-1,-1,-1,1,(x,y,z)=>shade(STEM_D,x,y,z,4));
    return vox;
  }
  function makeRanunculus(){
    const vox = V();
    for (let y=0; y<=6; y++){
      const r = 4 - Math.floor(y * 0.38);
      for (let x=-r-1; x<=r+1; x++) for (let z=-r-1; z<=r+1; z++){
        const d = Math.sqrt(x*x + z*z);
        const spiral = Math.sin(Math.atan2(z,x)*5 + y*1.05) * 0.35;
        if (d <= r + 0.25 && (d >= Math.max(0.7, r - 0.85 + spiral) || y >= 4 || ((x+y-z)&1) === 0)) put(vox, x, y, z, shade((y>4)?RAN:RAN_D, x,y,z,8));
      }
    }
    fill(vox,-1,1,-1,-1,-1,1,(x,y,z)=>shade(STEM_D,x,y,z,4));
    return vox;
  }
  function makeLisianthus(){
    const vox = V();
    for (let y=0; y<=8; y++){
      const rx = y < 3 ? 4 : (y < 6 ? 3 : 2);
      const rz = y < 3 ? 3 : (y < 6 ? 4 : 2);
      for (let x=-rx; x<=rx; x++) for (let z=-rz; z<=rz; z++){
        const e = (x*x)/(rx*rx + 0.2) + (z*z)/(rz*rz + 0.2);
        if (e <= 1.03 && (e >= 0.54 || y <= 2 || (y >= 6 && z >= -1))) put(vox, x, y, z, shade((y>5)?LISI:LISI_D, x,y,z,7));
      }
    }
    fill(vox,-1,1,-1,-1,-1,1,(x,y,z)=>shade(STEM_D,x,y,z,4));
    [[3,7,0],[4,8,1]].forEach(([x,y,z])=>put(vox,x,y,z,shade(LISI,x,y,z,8)));
    return vox;
  }
  function makeFrame(specs){
    const vox = V();
    specs.forEach(s=>{
      const pts = addStem(vox, s.x0, s.z0, s.h, s.leanX, s.leanZ, s.nodes || []);
      (s.leaves || []).forEach(l=>{
        const idx = Math.max(0, Math.min(pts.length-1, l.at));
        const [x,y,z] = pts[idx];
        addLeaf(vox, x, y, z, l.dx, l.dz, l.len, l.width, l.col || LEAF);
      });
    });
    return vox;
  }
  function makeOuterWrap(){
    const vox = V();
    for (let y=0; y<=22; y++){
      const left = -8 - Math.floor(y * 0.38);
      const right = 8 + Math.floor(y * 0.38);
      const front = -6 + Math.floor(y * 0.05);
      const back = 4 + Math.floor(y * 0.2);
      fill(vox, left, left+1, y, y, 0, back, (x,yy,z)=>shade((yy>16)?KRAFT_L:KRAFT, x,yy,z,6));
      fill(vox, right-1, right, y, y, 0, back, (x,yy,z)=>shade((yy>16)?KRAFT_L:KRAFT, x,yy,z,6));
      if (y <= 15) fill(vox, left+3, right-3, y, y, front, front, (x,yy,z)=>shade((Math.abs(x)>right-4)?KRAFT_D:KRAFT, x,yy,z,6));
      if (y >= 11 && (y & 1) === 0) fill(vox, left+4, right-4, y, y, back, back, (x,yy,z)=>shade(KRAFT_L, x,yy,z,6));
      if (y >= 7 && y <= 18){
        const lf = left + 2 + Math.floor((y-7)*0.18);
        const rf = right - 2 - Math.floor((y-7)*0.18);
        put(vox, lf, y, front-1, shade(KRAFT_D, lf,y,front-1,6));
        put(vox, rf, y, front-1, shade(KRAFT_D, rf,y,front-1,6));
      }
    }
    return vox;
  }
  function makeBottomWrap(){
    const vox = V();
    for (let y=0; y<=14; y++){
      const left = -5 - Math.floor(y * 0.07);
      const right = 5 + Math.floor(y * 0.07);
      const front = -3 + Math.floor(y * 0.03);
      const back = 3 + Math.floor(y * 0.07);
      fill(vox, left, left+1, y, y, 0, back, (x,yy,z)=>shade(KRAFT_D, x,yy,z,6));
      fill(vox, right-1, right, y, y, 0, back, (x,yy,z)=>shade(KRAFT_D, x,yy,z,6));
      if (y <= 9) fill(vox, left+2, right-2, y, y, front, front, (x,yy,z)=>shade(KRAFT_L, x,yy,z,6));
      if ((y & 1) === 0) fill(vox, left+2, right-2, y, y, back, back, (x,yy,z)=>shade((yy<4)?KRAFT_S:KRAFT_L, x,yy,z,5));
    }
    return vox;
  }
  function makeBow(){
    const vox = V();
    fill(vox,-1,1,4,7,-1,1,(x,y,z)=>shade((x&1)?RIBBON_D:RIBBON, x,y,z,7));
    for (const side of [-1,1]){
      for (let x=0; x<=6; x++) for (let y=3; y<=8; y++) for (let z=-3; z<=3; z++){
        const px = side*x;
        const e = ((x-3)*(x-3))/10 + ((y-5.5)*(y-5.5))/5 + (z*z)/8;
        if (e <= 1 && e >= 0.52) put(vox, px, y, z, shade((y>5)?RIBBON_L:RIBBON, px,y,z,7));
      }
    }
    for (const side of [-1,1]){
      for (let t=0; t<=8; t++){
        const x = side * (2 + Math.floor(t*0.18));
        const y = 3 - t;
        const z = side < 0 ? -1 + Math.floor(t*0.1) : 1 - Math.floor(t*0.1);
        fill(vox, x, x+side, y, y, z-1, z+1, (px,py,pz)=>shade((t>5)?RIBBON_D:RIBBON, px,py,pz,7));
      }
    }
    return vox;
  }

  const rose = makeRose();
  const tulip = makeTulip();
  const peony = makePeony();
  const lavender = makeLavender();
  const carnation = makeCarnation();
  const dahlia = makeDahlia();
  const ranunculus = makeRanunculus();
  const lisianthus = makeLisianthus();
  const frameA = makeFrame([
    { x0:4, z0:7, h:31, leanX:-5, leanZ:-1, nodes:[7,14,21,27], leaves:[{ at:8, dx:-1, dz:0, len:8, width:4 }, { at:15, dx:-1, dz:-1, len:7, width:3 }, { at:22, dx:0, dz:1, len:6, width:2 }] },
    { x0:8, z0:5, h:29, leanX:-3, leanZ:-2, nodes:[9,16,23], leaves:[{ at:11, dx:-1, dz:0, len:7, width:3 }, { at:18, dx:1, dz:-1, len:6, width:2 }] },
  ]);
  const frameB = makeFrame([
    { x0:5, z0:6, h:32, leanX:-1, leanZ:0, nodes:[8,15,23,29], leaves:[{ at:9, dx:-1, dz:1, len:8, width:4 }, { at:17, dx:1, dz:0, len:7, width:3 }] },
    { x0:9, z0:6, h:30, leanX:0, leanZ:1, nodes:[10,18,25], leaves:[{ at:12, dx:1, dz:1, len:7, width:3 }, { at:20, dx:-1, dz:0, len:6, width:2 }] },
  ]);
  const frameC = makeFrame([
    { x0:5, z0:5, h:31, leanX:3, leanZ:1, nodes:[8,16,24], leaves:[{ at:10, dx:1, dz:0, len:8, width:4 }, { at:17, dx:1, dz:1, len:7, width:3 }] },
    { x0:8, z0:4, h:29, leanX:5, leanZ:-1, nodes:[9,17,24], leaves:[{ at:11, dx:1, dz:-1, len:6, width:2 }, { at:18, dx:-1, dz:0, len:6, width:2 }] },
  ]);
  const frameD = makeFrame([
    { x0:6, z0:4, h:27, leanX:-1, leanZ:2, nodes:[8,15,22], leaves:[{ at:9, dx:-1, dz:1, len:7, width:3 }, { at:16, dx:1, dz:1, len:7, width:3 }] },
    { x0:8, z0:5, h:26, leanX:2, leanZ:2, nodes:[10,17,23], leaves:[{ at:12, dx:1, dz:1, len:6, width:2 }, { at:18, dx:-1, dz:1, len:6, width:2 }] },
  ]);

  const outerWrap = makeOuterWrap();
  const bottomWrap = makeBottomWrap();
  const bow = makeBow();

  const comps = [
    { name:'1 玫瑰', color:ROSE, vox:rose, vs:0.041, at:[-1.20,4.08,-0.36] },
    { name:'2 郁金香', color:TULIP_Y, vox:tulip, vs:0.043, at:[-0.18,4.26,0.08] },
    { name:'3 芍药', color:PEONY, vox:peony, vs:0.040, at:[-0.42,3.42,0.08] },
    { name:'4 薰衣草穗', color:LAV, vox:lavender, vs:0.038, at:[1.00,3.40,0.20] },
    { name:'5 康乃馨', color:CORAL, vox:carnation, vs:0.039, at:[-1.58,3.14,-0.62] },
    { name:'6 大丽花', color:ORANGE, vox:dahlia, vs:0.042, at:[0.54,2.88,-0.60] },
    { name:'7 洋牡丹', color:RAN, vox:ranunculus, vs:0.039, at:[-0.92,2.72,0.54] },
    { name:'8 洋桔梗', color:LISI, vox:lisianthus, vs:0.038, at:[0.70,3.18,0.60] },
    { name:'9 枝叶框架·左后', color:STEM, vox:frameA, vs:0.041, at:[-1.40,0.70,-0.62] },
    { name:'10 枝叶框架·中后', color:STEM, vox:frameB, vs:0.040, at:[-0.58,0.68,-0.28] },
    { name:'11 枝叶框架·右后', color:STEM, vox:frameC, vs:0.041, at:[0.18,0.70,-0.06] },
    { name:'12 枝叶框架·前束', color:STEM, vox:frameD, vs:0.039, at:[-0.06,0.62,0.34] },
    { name:'13 花束包裹', color:KRAFT, vox:outerWrap, vs:0.050, at:[-2.18,0.60,-1.58] },
    { name:'14 底层纸包裹', color:KRAFT_L, vox:bottomWrap, vs:0.045, at:[-0.82,0.02,-0.68] },
    { name:'15 蝴蝶结', color:RIBBON, vox:bow, vs:0.042, at:[-0.16,0.12,-0.96] },
  ].filter(c=>Object.keys(c.vox).length);

  // 先把全部组件均匀细分为 2× 网格，保持原有物理尺寸和装配关系；随后仅在花头内部、
  // 纸包折面和蝴蝶结厚度层补入细节体素，让模型达到精确 50000 体素而不显得臃肿。
  function refine2x(vox){
    const out = V();
    for (const key in vox){
      const [x,y,z] = parseKey(key), col = vox[key];
      for (let dx=0; dx<2; dx++) for (let dy=0; dy<2; dy++) for (let dz=0; dz<2; dz++) {
        put(out, x*2+dx, y*2+dy, z*2+dz, col);
      }
    }
    return out;
  }
  function addInteriorDetail(vox, amount, baseCol){
    if (!amount) return 0;
    let minx=Infinity,miny=Infinity,minz=Infinity,maxx=-Infinity,maxy=-Infinity,maxz=-Infinity;
    for (const key in vox){
      const [x,y,z] = parseKey(key);
      if (x<minx) minx=x; if (y<miny) miny=y; if (z<minz) minz=z;
      if (x>maxx) maxx=x; if (y>maxy) maxy=y; if (z>maxz) maxz=z;
    }
    const cx=(minx+maxx)/2, cy=(miny+maxy)/2, cz=(minz+maxz)/2;
    const dirs=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
    const candidates=[];
    for (let x=minx; x<=maxx; x++) for (let y=miny; y<=maxy; y++) for (let z=minz; z<=maxz; z++){
      const key=keyOf(x,y,z);
      if (vox[key]) continue;
      let touch=0;
      dirs.forEach(d=>{ if (vox[keyOf(x+d[0],y+d[1],z+d[2])]) touch++; });
      const r2=(x-cx)*(x-cx)+(y-cy)*(y-cy)+(z-cz)*(z-cz);
      candidates.push({x,y,z,touch,r2});
    }
    candidates.sort((a,b)=>b.touch-a.touch || a.r2-b.r2 || a.y-b.y || a.x-b.x || a.z-b.z);
    const take=Math.min(amount,candidates.length);
    for (let i=0; i<take; i++){
      const p=candidates[i];
      put(vox,p.x,p.y,p.z,shade(baseCol,p.x,p.y,p.z,4));
    }
    return take;
  }
  const detailBudget = [1000,800,2500,600,1600,1800,1400,1200,100,100,100,100,1000,250,178];
  let detailed = 0;
  comps.forEach((c,i)=>{
    c.vox = refine2x(c.vox);
    c.vs *= 0.5;
    detailed += addInteriorDetail(c.vox, detailBudget[i], c.color);
  });
  if (detailed !== 12728) throw new Error(`花束细节体素不足：${detailed}/12728`);
  comps.forEach(c=> c.vs *= sizeMul);


  let rawTotal = 0;
  comps.forEach(c=>{
    const b = bounds(c.vox), [ax,ay,az] = c.at;
    rawTotal += Object.keys(c.vox).length;
    createObject({
      name: c.name,
      colorName: c.color,
      layer: 0,
      voxelSize: c.vs,
      voxels: c.vox,
      pos: {
        x: ax * layoutScale - b.minx * c.vs + (off.x || 0),

        y: ay * layoutScale - b.miny * c.vs + (off.y || 0),
        z: az * layoutScale - b.minz * c.vs + (off.z || 0),
      },
      rotY: 0,
    });
  });

  orbit.target.set(0 + (off.x||0), 2.35 * layoutScale + (off.y||0), -0.02 * layoutScale + (off.z||0));
  orbit.radius = 26;
  orbit.phi = Math.PI * 0.33;
  updateCamera();
  refreshObjList(); refreshRightPanel(); refreshStats(); autoSave();
  return { count: comps.length, finalTotal: rawTotal, rawTotal, budget: 0 };
}

/* =========================================================
 * 蓝鲸预设（参考图的分件拼装完整模型，< 50,000 体素）
 *  7 类分件 + 眼睛气孔等细节件；模型整体薄壳中空，保留参考图的层次。
 *  每件使用不同 voxelSize，由可见表面正方体体素组成。
 * ========================================================= */
function buildWhalePreset(opts){
  opts = opts || {};
  const sizeMul = Math.max(0.3, opts.sizeMul || 2.6);
  const layoutScale = sizeMul / 2.6;
  const off = opts.posOffset || { x:0, y:0, z:0 };
  const NAVY = '#154b93', BLUE = '#2367b8', BLUE_L = '#3b82d0', DEEP = '#0e3267', TEAL = '#62a5c4';
  const BELLY = '#e7edf2', BELLY_S = '#c8d3de', BLACK = '#141820', WHITE = '#ffffff';
  const WATER = '#87e5f1', WATER_L = '#b9f5fb', WATER_T = '#5fb8c6';
  const V = () => ({});
  const put = (vox,x,y,z,c) => { vox[keyOf(x,y,z)] = c; };
  const fill = (vox,x0,x1,y0,y1,z0,z1,c) => {
    for(let x=x0;x<=x1;x++) for(let y=y0;y<=y1;y++) for(let z=z0;z<=z1;z++) put(vox,x,y,z,typeof c==='function'?c(x,y,z):c);
  };
  const shade = (c, x, y, z, amt) => shadeHex(c, ((x*3+y*5+z*7) & 1) ? (amt == null ? 5 : amt) : -(amt == null ? 5 : amt));
  // 只在物体外表面放置体素：内表面与"被同组件其它面遮住的内部"均不放，体素量大幅减少。
  function isOnShell(vox, x, y, z, ox, oy, oz){
    return !vox[keyOf(x+ox, y+oy, z+oz)];
  }
  // 椭球薄壳：仅在 6 个轴对齐方向至少有一侧是空时记录
  function shellEllipsoid(vox, cx, cy, cz, rx, ry, rz, col, xBias, zBias){
    for(let x=-rx;x<=rx;x++) for(let y=-ry;y<=ry;y++) for(let z=-rz;z<=rz;z++){
      const nx=(x-(xBias||0))/rx, ny=y/ry, nz=(z-(zBias||0))/rz, e=nx*nx+ny*ny+nz*nz;
      if(e>1) continue;
      const wx=x+cx, wy=y+cy, wz=z+cz;
      if (isOnShell(vox, wx, wy, wz, 1,0,0) || isOnShell(vox, wx, wy, wz, -1,0,0) ||
          isOnShell(vox, wx, wy, wz, 0,1,0) || isOnShell(vox, wx, wy, wz, 0,-1,0) ||
          isOnShell(vox, wx, wy, wz, 0,0,1) || isOnShell(vox, wx, wy, wz, 0,0,-1)){
        put(vox, wx, wy, wz, shade(col, x, y, z, 5));
      }
    }
  }
  // 长方体薄壳：6 个面单独铺设，避免内部填充
  function shellBox(vox, x0, x1, y0, y1, z0, z1, col, edgeOnly){
    for(let x=x0;x<=x1;x++) for(let y=y0;y<=y1;y++) for(let z=z0;z<=z1;z++){
      const onFace = (x===x0||x===x1||y===y0||y===y1||z===z0||z===z1);
      if (!onFace) continue;
      if (edgeOnly){
        const edge = (x===x0||x===x1) + (y===y0||y===y1) + (z===z0||z===z1);
        if (edge < 2) continue;
      }
      put(vox, x, y, z, shade(col, x, y, z, 5));
    }
  }
  function bounds(vox){
    let minx=Infinity,miny=Infinity,minz=Infinity,maxx=-Infinity,maxy=-Infinity,maxz=-Infinity;
    for(const k in vox){ const [x,y,z]=parseKey(k);
      if(x<minx)minx=x; if(y<miny)miny=y; if(z<minz)minz=z;
      if(x+1>maxx)maxx=x+1; if(y+1>maxy)maxy=y+1; if(z+1>maxz)maxz=z+1; }
    return {minx,miny,minz,maxx,maxy,maxz};
  }

  // 2a 躯干前段：参考图中的大块头部+前身，整体椭球+前面平直
  const torsoFront = V();
  shellEllipsoid(torsoFront, -6, 9, 0, 9, 7, 8, BLUE, -1.6, 0);
  for(let x=-15;x<=-11;x++) for(let y=5;y<=13;y++) for(let z=-7;z<=7;z++){
    const e=((x+12.5)*(x+12.5))/12+(y-9)*(y-9)/22+z*z/55;
    if(e<=1 && (y>=11 || Math.abs(z)>=6 || x<=-14)) put(torsoFront, x, y, z, shade(BLUE, x, y, z, 5));
  }
  // 蓝白渐变：下腹色更浅（参考图前躯下沿白色带）
  for (const k in torsoFront){
    const [x,y,z] = parseKey(k);
    if (y <= 5) torsoFront[k] = shade(TEAL, x, y, z, 4);
  }

  // 2b 躯干后段：中段到尾柄，颜色加深
  const torsoBack = V();
  shellEllipsoid(torsoBack, 4, 8, 0, 11, 7, 7, NAVY, 1.2, 0);
  for(let x=8;x<=14;x++) for(let y=6;y<=11;y++) for(let z=-6;z<=6;z++){
    const rr=Math.max(1, 6-(x-8)*0.45);
    if(Math.abs(z)<=rr && (y===6||y===11||Math.abs(z)>=rr-1||x===14)) put(torsoBack, x, y, z, shade(NAVY, x, y, z, 5));
  }
  for (const k in torsoBack){
    const [x,y,z] = parseKey(k);
    if (y <= 6) torsoBack[k] = shade(TEAL, x, y, z, 4);
  }

  // 1a 上颚：深蓝色顶壳+鼻根气孔区域
  const upperJaw = V();
  shellEllipsoid(upperJaw, -7, 16, 0, 7, 4, 6, DEEP, -1.0, 0);
  fill(upperJaw, -10, -3, 13, 16, -4, 4, (x,y,z)=>shade(DEEP, x, y, z, 5));
  // 气孔（黑色十字）
  fill(upperJaw, -8, -5, 16, 16, 1, 2, BLACK);
  fill(upperJaw, -7, -6, 16, 16, 0, 3, BLACK);

  // 1b 下颚：U 形壳+白色鲸须
  const lowerJaw = V();
  shellBox(lowerJaw, -10, 1, 0, 2, -6, 6, NAVY);
  for(let x=-9;x<=-1;x++) for(let y=3;y<=3;y++) for(let z=-4;z<=4;z++) put(lowerJaw, x, y, z, shade(BELLY, x, y, z, 4));
  // 白色鲸须（左右两排小方块）
  for(let x=-9;x<=0;x+=2){
    for(const z of [-4,4]) fill(lowerJaw, x, x+1, 3, 3, z, z, WHITE);
  }

  // 3 腹褶：白色竖纹，沿前后分层
  const belly = V();
  for(let band=0;band<7;band++){
    const y=band>>1, x0=-12+band, x1=6-band;
    const z0=-6+Math.floor(band/2), z1=6-Math.floor(band/2);
    for(let x=x0;x<=x1;x++) for(let z=z0;z<=z1;z++){
      if((x-x0)%3===0 || Math.abs(z)>=z1-1) put(belly, x, y, z, band%2?BELLY:BELLY_S);
    }
  }

  // 4 左右胸鳍：翼状薄壳（左+右两件，独立组件）
  function makePectoral(side){
    const vox = V();
    for(let x=0;x<=10;x++){
      const span=Math.max(1, 8-Math.floor(x*0.6));
      const h=Math.max(1, 4-Math.floor(x*0.28));
      for(let y=0;y<=h;y++) for(let z=0;z<=span;z++){
        if(y===0||y===h||z===span||x===10) put(vox, x, y, side*z, shade(BLUE_L, x, y, z, 5));
      }
    }
    return vox;
  }
  const finL = makePectoral(-1), finR = makePectoral(1);

  // 5 背鳍：深蓝色三角鳍
  const dorsal = V();
  for(let x=0;x<=7;x++) for(let y=0;y<=8-x;y++) for(let z=-2;z<=2;z++){
    if(y===8-x || Math.abs(z)===2 || x===0) put(dorsal, x, y, z, shade(DEEP, x, y, z, 5));
  }
  // 鳍尖浅色镶边
  for(let x=5;x<=7;x++) for(let y=8-x;y<=8-x;y++) for(let z=-2;z<=2;z++) put(dorsal, x, y, z, shade(BLUE_L, x, y, z, 4));

  // 6 尾部与尾鳍：柄 + 双尾叶（水平铺开）
  const tail = V();
  // 尾柄薄壳
  for(let x=0;x<=4;x++) for(let y=4;y<=7;y++) for(let z=-2;z<=2;z++){
    if (y===4||y===7||Math.abs(z)===2||x===0) put(tail, x, y, z, shade(NAVY, x, y, z, 5));
  }
  // 双尾叶：参考图为大块横向铺开
  for(const side of [-1,1]){
    for(let x=4;x<=15;x++){
      const span=Math.max(1, 7-Math.floor((x-4)*0.42));
      for(let y=2;y<=7;y++) for(let z=1;z<=span;z++){
        if(y===2||y===7||z===span||x===15) put(tail, x, y, side*z, shade(NAVY, x, y, z, 5));
      }
    }
    // 尾叶尖端青色
    for(let x=12;x<=15;x++) for(let y=2;y<=7;y++) for(let z=side<0?1:1;z<=Math.max(1, 7-Math.floor((x-4)*0.42));z++) put(tail, x, y, side*z, shade(TEAL, x, y, z, 4));
  }

  // 眼睛（左、右两件）
  function makeEye(){
    const vox = V();
    fill(vox, 0, 2, 0, 2, 0, 0, WHITE);
    put(vox, 1, 1, -1, BLACK); put(vox, 1, 1, 1, BLACK); put(vox, 1, 1, 0, BLACK);
    return vox;
  }
  const eyeL = makeEye(), eyeR = makeEye();

  // 7 透明水柱：竖柱+分叉喷花+飞散水滴
  const spout = V();
  for(let y=0;y<=23;y++){
    const r=y<16?1:(y<20?2:1);
    for(let x=-r;x<=r;x++) for(let z=-r;z<=r;z++) if(x*x+z*z<=r*r+0.2) put(spout, x, y, z, shade(y%3?WATER:WATER_L, x, y, z, 6));
  }
  for(const dir of [-1,1]){
    for(let t=0;t<=8;t++){
      const x=dir*(2+t), y=20+Math.floor(t*0.62), z=(t&1)?1:0;
      const w=Math.max(1, 3-Math.floor(t/3));
      fill(spout, x-w, x+w, y, y+1, z-1, z+1, shade(WATER, x, y, z, 6));
    }
  }
  [[-9,27,1],[8,28,-2],[-6,30,-2],[10,25,2],[-12,24,-1],[5,32,1]].forEach(([x,y,z])=>fill(spout, x, x+1, y, y+1, z, z+1, shade(WATER_L, x, y, z, 5)));
  // 中间高光柱
  for (let y = 0; y < 16; y++) put(spout, 0, y, 0, shade(WATER_T, 0, y, 0, 5));

  const comps = [
    { name:'1a 上颚（含气孔）', color:DEEP,   vox:upperJaw,   vs:0.052, at:[-3.60,1.85,-0.91] },
    { name:'1b 下颚（含鲸须）', color:NAVY,   vox:lowerJaw,   vs:0.050, at:[-3.52,0.94,-0.68] },
    { name:'2a 躯干前段',       color:BLUE,   vox:torsoFront, vs:0.058, at:[-3.15,0.98,-1.15] },
    { name:'2b 躯干后段',       color:NAVY,   vox:torsoBack,  vs:0.056, at:[-0.05,1.16,-1.00] },
    { name:'3 腹褶',            color:BELLY,  vox:belly,      vs:0.046, at:[-3.18,0.78,-0.55] },
    { name:'4 左胸鳍',          color:BLUE_L, vox:finL,       vs:0.050, at:[-1.98,1.02,-1.96] },
    { name:'4 右胸鳍',          color:BLUE_L, vox:finR,       vs:0.049, at:[-1.98,1.02, 1.58] },
    { name:'5 背鳍',            color:DEEP,   vox:dorsal,     vs:0.054, at:[ 0.22,2.42,-0.14] },
    { name:'6 尾部与尾鳍',      color:NAVY,   vox:tail,       vs:0.052, at:[ 1.38,1.30,-0.68] },
    { name:'左眼',              color:WHITE,  vox:eyeL,       vs:0.042, at:[-3.28,1.73,-1.38] },
    { name:'右眼',              color:WHITE,  vox:eyeR,       vs:0.041, at:[-3.28,1.73, 1.38] },
    { name:'7 透明水柱',        color:WATER,  vox:spout,      vs:0.040, at:[-1.77,2.66,-0.48] },
  ].filter(c=>Object.keys(c.vox).length);
  comps.forEach(c=>c.vs*=sizeMul);

  let rawTotal=0;
  comps.forEach(c=>{
    const b=bounds(c.vox), [ax,ay,az]=c.at;
    rawTotal+=Object.keys(c.vox).length;
    createObject({
      name:c.name, colorName:c.color, layer:0, voxelSize:c.vs, voxels:c.vox, rotY:0,
      pos:{x:ax*layoutScale-b.minx*c.vs+(off.x||0), y:ay*layoutScale-b.miny*c.vs+(off.y||0), z:az*layoutScale-b.minz*c.vs+(off.z||0)},
    });
  });
  if (rawTotal >= 50000) throw new Error(`鲸鱼预设超预算：${rawTotal}`);
  orbit.target.set(-0.25*layoutScale+(off.x||0),2.15*layoutScale+(off.y||0),off.z||0);
  orbit.radius=30; orbit.phi=Math.PI*0.34; updateCamera();
  refreshObjList(); refreshRightPanel(); refreshStats(); autoSave();
  return {count:comps.length, finalTotal:rawTotal, rawTotal, budget:0};
}








/* =========================================================
 * 珍珠奶茶预设（参考图分件拼装模型，8,000-20,000 体素）
 *  奶油、3 块冰块、樱桃、吸管、透明杯、液体层、珍珠层、托盘、阶梯底座和网格分件；
 *  每件 voxelSize 不同，杯体与冰块半透明，杯体/托盘采用薄壳。
 * ========================================================= */
function buildBubbleTeaPreset(opts){
  opts = opts || {};
  const sizeMul = Math.max(0.3, opts.sizeMul || 2.6);
  const layoutScale = sizeMul / 2.6;
  const off = opts.posOffset || {x:0,y:0,z:0};
  const CREAM='#f7f1e1', CREAM_D='#d8c9a9', CREAM_L='#fffaf0';
  const ICE='#e4f2fb', ICE_D='#aac7dc', ICE_L='#ffffff';
  const CHERRY='#d92d2f', CHERRY_D='#8e1b1d', STEM='#59432c';
  const STRAW='#cba778', STRAW_D='#87633a';
  const TEA='#c8a273', TEA_D='#9b7040', TEA_L='#ead7b6';
  const PEARL='#1b1b21', PEARL_D='#08080b', PEARL_L='#4a3930';
  const PLASTIC='#eff7fb', PLASTIC_D='#bdccd7', TRAY='#d8dce1', TRAY_D='#9ca2ab';
  const BASE='#b5b8be', BASE_D='#7b8089', GRID='#e7e9ed';
  const V=()=>({});
  const put=(v,x,y,z,c)=>{v[keyOf(x,y,z)]=c;};
  const shade=(c,x,y,z,n)=>shadeHex(c,((x*5+y*7+z*3)&1)?(n||4):-(n||4));
  const fill=(v,x0,x1,y0,y1,z0,z1,c)=>{for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++)for(let z=z0;z<=z1;z++)put(v,x,y,z,typeof c==='function'?c(x,y,z):c);};
  function bounds(v){let minx=Infinity,miny=Infinity,minz=Infinity,maxx=-Infinity,maxy=-Infinity,maxz=-Infinity;for(const k in v){const [x,y,z]=parseKey(k);minx=Math.min(minx,x);miny=Math.min(miny,y);minz=Math.min(minz,z);maxx=Math.max(maxx,x+1);maxy=Math.max(maxy,y+1);maxz=Math.max(maxz,z+1);}return{minx,miny,minz,maxx,maxy,maxz};}
  function ring(v,r,y,col,thick){for(let x=-r;x<=r;x++)for(let z=-r;z<=r;z++){const d=Math.sqrt(x*x+z*z);if(d<=r+.1&&d>=r-(thick||1))put(v,x,y,z,shade(col,x,y,z,3));}}
  function shellCup(v,r0,r1,h,col){
    for(let y=0;y<h;y++){const r=r0+(r1-r0)*(y/(h-1));const ri=Math.ceil(r);for(let x=-ri;x<=ri;x++)for(let z=-ri;z<=ri;z++){const d=Math.sqrt(x*x+z*z);if(d<=r+.1&&d>=r-1.05)put(v,x,y,z,shade(col,x,y,z,3));}}
    ring(v,Math.ceil(r1)+1,h-1,PLASTIC_D,1.2);ring(v,Math.ceil(r1)+1,h,PLASTIC_D,1.2);
    for(let x=-Math.ceil(r0);x<=Math.ceil(r0);x++)for(let z=-Math.ceil(r0);z<=Math.ceil(r0);z++)if(x*x+z*z<=r0*r0)put(v,x,0,z,shade(PLASTIC_D,x,0,z,3));
  }
  function addPearl(v,cx,cy,cz){for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++){const e=x*x+y*y+z*z;if(e>2.15)continue;put(v,cx+x,cy+y,cz+z,shade(e<.2?PEARL_D:(y>0?PEARL:PEARL_L),cx+x,cy+y,cz+z,3));}}

  // 1a 顶部奶油：圆顶、波纹和下垂奶油流苏
  const cream=V();
  for(let x=-10;x<=10;x++)for(let z=-10;z<=10;z++){const d=(x*x+z*z)/100;if(d>1)continue;const h=Math.max(1,Math.round(6*Math.sqrt(1-d)));for(let y=0;y<=h;y++)put(cream,x,y,z,shade(y===h?CREAM_L:(y<2?CREAM_D:CREAM),x,y,z,3));}
  for(let a=0;a<16;a++){const x=Math.round(Math.cos(a*Math.PI/8)*9),z=Math.round(Math.sin(a*Math.PI/8)*9),len=2+(a%3);for(let y=-len;y<=0;y++)put(cream,x,y,z,shade(CREAM_D,x,y,z,3));}
  for(let x=-8;x<=8;x+=2)for(let z=-5;z<=5;z++)put(cream,x,2,z,shade(CREAM_L,x,2,z,3));

  // 1b 三块半透明冰块
  function iceBlock(size){const v=V();for(let x=0;x<size;x++)for(let y=0;y<size;y++)for(let z=0;z<size;z++){if(x&&y&&z&&x<size-1&&y<size-1&&z<size-1)continue;put(v,x,y,z,shade((x===0||y===size-1||z===0)?ICE_L:ICE_D,x,y,z,3));}return v;}
  const iceA=iceBlock(4),iceB=iceBlock(4),iceC=iceBlock(4);

  // 1c 樱桃水果和果梗
  const cherry=V();
  for(let x=-3;x<=3;x++)for(let y=-2;y<=3;y++)for(let z=-3;z<=3;z++){const e=(x*x+z*z)/(8)+(y*y)/10;if(e<=1)put(cherry,x,y+3,z,shade(y>1?CHERRY:CHERRY_D,x,y,z,4));}
  for(let y=6;y<=10;y++)put(cherry,1,y,0,shade(STEM,1,y,0,3));put(cherry,2,10,0,STEM);

  // 2a 斜插条纹吸管
  const straw=V();
  for(let y=0;y<25;y++){const xx=Math.floor(y*.18);for(let z=-1;z<=1;z++){const col=(Math.floor(y/4)&1)?STRAW:STRAW_D;put(straw,xx,y,z,shade(col,xx,y,z,3));}}

  // 2b 透明杯薄壳 / 2c 液体层 / 2d 珍珠层
  const cup=V();shellCup(cup,12,11,33,PLASTIC);
  const liquid=V();
  for(let y=1;y<=23;y++){const r=10.8-y*.03;for(let x=-11;x<=11;x++)for(let z=-11;z<=11;z++)if(x*x+z*z<=r*r){const col=y>=21?TEA_L:(y<=2?TEA_D:TEA);put(liquid,x,y,z,shade(col,x,y,z,3));}}
  const pearls=V();
  const slots=[[-7,2,-5],[-4,2,-7],[0,2,-7],[4,2,-6],[7,2,-2],[-7,2,0],[-3,2,-1],[1,2,-2],[5,2,2],[-5,2,5],[-1,2,6],[3,2,6],[-4,5,-3],[0,5,-4],[4,5,-2],[-6,5,2],[-1,5,2],[3,5,3],[0,8,0]];
  slots.forEach(p=>addPearl(pearls,...p));

  // 3a 灰色方形阶梯底座 / 3b 圆托盘 / 3c 方格细纹
  const base=V();
  fill(base,-15,15,0,1,-15,15,(x,y,z)=>shade(y?BASE:BASE_D,x,y,z,3));
  for(let x=-15;x<=15;x++)for(let z=-15;z<=15;z++)if(Math.abs(x)===15||Math.abs(z)===15)put(base,x,2,z,shade(BASE_D,x,2,z,3));
  const tray=V();
  for(let y=0;y<=2;y++)ring(tray,14,y,y===2?TRAY:TRAY_D,1.25);
  for(let x=-12;x<=12;x++)for(let z=-12;z<=12;z++)if(x*x+z*z<=144&&x*x+z*z>=118)put(tray,x,1,z,shade(TRAY,x,1,z,3));
  const grid=V();for(let x=-12;x<=12;x+=3)for(let z=-12;z<=12;z+=3)put(grid,x,0,z,shade(GRID,x,0,z,2));

  const comps=[
    {name:'1a 顶部奶油',color:CREAM,vox:cream,vs:.041,at:[-1.15,5.82,-1.15],alpha:1},
    {name:'1b 冰块·左',color:ICE,vox:iceA,vs:.038,at:[-.88,6.18,-.38],alpha:.72},
    {name:'1b 冰块·中',color:ICE,vox:iceB,vs:.039,at:[-.10,6.30,-.34],alpha:.72},
    {name:'1b 冰块·右',color:ICE,vox:iceC,vs:.037,at:[-.45,6.23,.35],alpha:.72},
    {name:'1c 樱桃水果',color:CHERRY,vox:cherry,vs:.040,at:[.28,6.10,.32],alpha:1},
    {name:'2a 吸管',color:STRAW,vox:straw,vs:.040,at:[-.35,5.88,-.22],alpha:1},
    {name:'2b 透明杯体',color:PLASTIC,vox:cup,vs:.043,at:[-1.45,.72,-1.45],alpha:.20},
    {name:'2c 液体层',color:TEA,vox:liquid,vs:.042,at:[-1.28,.80,-1.28],alpha:.90},
    {name:'2d 珍珠层',color:PEARL,vox:pearls,vs:.037,at:[-1.05,.88,-1.05],alpha:1},
    {name:'3a 阶梯底座',color:BASE,vox:base,vs:.047,at:[-1.90,.06,-1.90],alpha:1},
    {name:'3b 圆形托盘',color:TRAY,vox:tray,vs:.045,at:[-1.72,.52,-1.72],alpha:1},
    {name:'3c 底座网格',color:GRID,vox:grid,vs:.039,at:[-1.45,.63,-1.45],alpha:.9},
  ];
  comps.forEach(c=>c.vs*=sizeMul);
  let rawTotal=0;
  comps.forEach(c=>{const b=bounds(c.vox),[ax,ay,az]=c.at;rawTotal+=Object.keys(c.vox).length;const voxels={};for(const k in c.vox){const d=decodeVoxel(c.vox[k]);voxels[k]=encodeVoxel(d.hex,d.shape||SHAPE_CUBE,d.dir||0,d.faces,d.mult||1,c.alpha,d.params);}createObject({name:c.name,colorName:c.color,layer:0,voxelSize:c.vs,voxels,pos:{x:ax*layoutScale-b.minx*c.vs+(off.x||0),y:ay*layoutScale-b.miny*c.vs+(off.y||0),z:az*layoutScale-b.minz*c.vs+(off.z||0)},rotY:0});});
  if(rawTotal<8000||rawTotal>20000)throw new Error(`珍珠奶茶体素数量异常：${rawTotal}`);
  orbit.target.set(-.15*layoutScale+(off.x||0),3.1*layoutScale+(off.y||0),-.1*layoutScale+(off.z||0));orbit.radius=28;orbit.phi=Math.PI*.34;updateCamera();
  refreshObjList();refreshRightPanel();refreshStats();autoSave();
  return {count:comps.length,finalTotal:rawTotal,rawTotal,budget:0};
}

/* =========================================================
 * 体素帆船预设（参考图分件拼装模型，8,000-20,000 体素）
 *  船体舱室、甲板、船首装饰与绳索、桅杆、主副船帆、旗、锚、船钟、舵、圆托盘底座分件；
 *  每件 voxelSize 不同，船体薄壳中空，尽量还原参考图的木质帆船外形。
 * ========================================================= */
function buildShipPreset(opts){
  opts = opts || {};
  const sizeMul = Math.max(0.3, opts.sizeMul || 2.6);
  const layoutScale = sizeMul / 2.6;
  const off = opts.posOffset || {x:0,y:0,z:0};
  const WOOD='#8a5a2f', WOOD_D='#633d1c', WOOD_L='#a9743f', WOOD_T='#754a24';
  const DECK='#b0824b', DECK_D='#8a6234', TRIM='#5a3818';
  const CANVAS='#e9e2cf', CANVAS_D='#cdc3a8', CANVAS_S='#f5f0e2';
  const ROPE='#c8a86e', METAL='#8b8f96', METAL_D='#5f636b', GOLD='#d8b148';
  const FLAG='#f2efe6', BASE='#c3c6cc', BASE_D='#9a9ea6';
  const V=()=>({});
  const put=(v,x,y,z,c)=>{v[keyOf(x,y,z)]=c;};
  const shade=(c,x,y,z,n)=>shadeHex(c,((x*5+y*7+z*3)&1)?(n||4):-(n||4));
  const fill=(v,x0,x1,y0,y1,z0,z1,c)=>{for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++)for(let z=z0;z<=z1;z++)put(v,x,y,z,typeof c==='function'?c(x,y,z):c);};
  function bounds(v){let minx=Infinity,miny=Infinity,minz=Infinity,maxx=-Infinity,maxy=-Infinity,maxz=-Infinity;for(const k in v){const [x,y,z]=parseKey(k);minx=Math.min(minx,x);miny=Math.min(miny,y);minz=Math.min(minz,z);maxx=Math.max(maxx,x+1);maxy=Math.max(maxy,y+1);maxz=Math.max(maxz,z+1);}return{minx,miny,minz,maxx,maxy,maxz};}

  // 2c 船体舱室（薄壳中空，船首尖、船尾方，参考图弧形木船身）
  const hull=V();
  const HL=44;          // 船体长度（x）
  for(let x=0;x<HL;x++){
    // 沿船长的半宽：船首(x大)收尖、船尾(x小)略收
    const t=x/(HL-1);
    const half=Math.round(2 + 6*Math.sin(Math.min(1,t*1.15)*Math.PI*0.92));
    const bowTaper=x>HL-8?Math.max(1,half-(x-(HL-8))):half;
    const w=Math.max(1,Math.min(half,bowTaper));
    // 船底深度（龙骨）：中段最深
    const depth=Math.round(4+5*Math.sin(t*Math.PI));
    for(let y=0;y<=depth;y++){
      for(let z=-w;z<=w;z++){
        const onHullSide=Math.abs(z)>=w-1;
        const onBottom=y===0 || y<=depth-Math.round(Math.sqrt(Math.max(0,w*w-z*z)));
        const onStern=x===0;
        const onGunwale=y>=depth-1;
        if(onHullSide||onBottom||onStern||onGunwale){
          const col=y>=depth-1?WOOD_L:(y<=1?WOOD_D:WOOD);
          put(hull,x,y+2,z,shade(col,x,y,z,4));
        }
      }
    }
  }
  // 舷侧木纹条
  for(let x=2;x<HL-2;x+=1){const t=x/(HL-1);const w=Math.round(2+6*Math.sin(Math.min(1,t*1.15)*Math.PI*0.92));for(const z of [-w,w]){put(hull,x,7,z,shade(WOOD_T,x,7,z,3));put(hull,x,9,z,shade(WOOD_T,x,9,z,3));}}

  // 2b 甲板结构（铺板 + 船舱楼 + 船尾楼 + 舷墙）
  const deck=V();
  for(let x=2;x<HL-3;x++){const t=x/(HL-1);const w=Math.max(1,Math.round(1+5*Math.sin(Math.min(1,t*1.15)*Math.PI*0.92)));for(let z=-w;z<=w;z++)put(deck,x,0,z,shade((x&1)?DECK:DECK_D,x,0,z,3));}
  // 船尾楼（甲板室，带门窗）
  for(let x=3;x<=13;x++)for(let y=1;y<=6;y++)for(let z=-5;z<=5;z++){
    if(Math.abs(z)===5||y===6||x===3||x===13){
      let col=WOOD; if(y===6)col=WOOD_L; if((x%3===0)&&y>1&&y<5&&Math.abs(z)===5)col=TRIM;
      put(deck,x,y,z,shade(col,x,y,z,4));
    }
  }
  // 舷墙（甲板四周矮墙）
  for(let x=2;x<HL-3;x++){const t=x/(HL-1);const w=Math.max(1,Math.round(1+5*Math.sin(Math.min(1,t*1.15)*Math.PI*0.92)));for(const z of [-w,w])for(let y=1;y<=2;y++)put(deck,x,y,z,shade(WOOD_D,x,y,z,3));}

  // 1b 船首装饰 + 斜桅（bowsprit）
  const prow=V();
  for(let x=0;x<=14;x++){const y=Math.round(x*0.28);put(prow,x,y,0,shade(WOOD_L,x,y,0,4));if(x<10){put(prow,x,y,-1,shade(WOOD,x,y,-1,3));put(prow,x,y,1,shade(WOOD,x,y,1,3));}}
  // 船首卷曲装饰
  for(let i=0;i<6;i++){const a=i*0.5;put(prow,13+Math.round(Math.cos(a)*2),4+Math.round(Math.sin(a)*2),0,shade(WOOD_D,i,i,0,3));}

  // 1a 桅杆组件（主桅 + 横桁）
  const mast=V();
  for(let y=0;y<=40;y++)fill(mast,-1,1,y,y,-1,1,shade(y>36?WOOD_L:WOOD,0,y,0,3));
  for(let z=-12;z<=12;z++)fill(mast,-1,1,30,30,z,z,shade(WOOD_D,0,30,z,3));  // 上横桁
  for(let z=-9;z<=9;z++)fill(mast,-1,1,16,16,z,z,shade(WOOD_D,0,16,z,3));    // 下横桁
  // 桅顶瞭望台
  for(let x=-2;x<=2;x++)for(let z=-2;z<=2;z++)if(Math.abs(x)===2||Math.abs(z)===2)put(mast,x,38,z,shade(WOOD_D,x,38,z,3));

  // 1a 主帆（大方帆，带鼓风弧度，双层布面加厚）
  const sailMain=V();
  for(let y=0;y<30;y++)for(let z=-13;z<=13;z++){
    const bulge=Math.round(Math.sin((z+13)/26*Math.PI)*2);
    const col=(y%6===0||Math.abs(z)>=12)?CANVAS_D:((y+z)&1?CANVAS:CANVAS_S);
    put(sailMain,bulge,y,z,shade(col,0,y,z,3));
    put(sailMain,bulge+1,y,z,shade(CANVAS_D,1,y,z,3));
  }
  // 副帆（船首三角帆，加大加厚）
  const sailJib=V();
  for(let y=0;y<26;y++){const w=Math.round((26-y)*0.62);for(let z=0;z<=w;z++){put(sailJib,0,y,z,shade((y&1)?CANVAS:CANVAS_S,0,y,z,3));put(sailJib,1,y,z,shade(CANVAS_D,1,y,z,3));}}

  // 旗帜
  const flag=V();
  for(let y=0;y<=4;y++)for(let z=0;z<=6-Math.abs(y-2);z++)put(flag,0,y,z,shade(FLAG,0,y,z,3));
  for(let y=-2;y<=5;y++)put(flag,0,y,-1,shade(WOOD_L,0,y,-1,3));

  // 1c 锚
  const anchor=V();
  fill(anchor,0,0,3,8,0,0,shade(METAL,0,5,0,3));
  fill(anchor,-3,3,2,2,0,0,shade(METAL_D,0,2,0,3));
  for(const s of [-1,1]){for(let i=0;i<=3;i++)put(anchor,s*(2+i),Math.max(0,2-i),0,shade(METAL,i,i,0,3));}
  put(anchor,0,9,0,shade(METAL_D,0,9,0,3));

  // 1c 船钟
  const bell=V();
  for(let x=-2;x<=2;x++)for(let z=-2;z<=2;z++)for(let y=0;y<=3;y++){const r=2-Math.floor(y*0.3);if(Math.abs(x)<=r&&Math.abs(z)<=r&&(Math.abs(x)===r||Math.abs(z)===r||y===3))put(bell,x,y,z,shade(GOLD,x,y,z,4));}
  put(bell,0,4,0,shade(GOLD,0,4,0,3));

  // 2d 舵组件
  const rudder=V();
  fill(rudder,0,1,0,10,-1,1,shade(WOOD_D,0,5,0,3));
  fill(rudder,2,6,4,7,0,0,shade(WOOD_L,4,5,0,3));   // 舵柄

  // 3a 圆形托盘底座
  const base=V();
  for(let y=0;y<=2;y++)for(let x=-20;x<=20;x++)for(let z=-14;z<=14;z++){const d=(x*x)/400+(z*z)/196;if(d>1)continue;const edge=d>=0.86;if(edge||y===0||y===2)put(base,x,y,z,shade(edge?BASE_D:BASE,x,y,z,3));}

  const comps=[
    {name:'2c 船体舱室',   color:WOOD,    vox:hull,     vs:.050, at:[-2.55,.60,-.62], alpha:1},
    {name:'2b 甲板结构',   color:DECK,    vox:deck,     vs:.048, at:[-2.35,1.30,-.55], alpha:1},
    {name:'1b 船首装饰',   color:WOOD_L,  vox:prow,     vs:.044, at:[ 1.70,1.35,-.05], alpha:1},
    {name:'2a 桅杆组件',   color:WOOD,    vox:mast,     vs:.046, at:[-.55,1.45,-.05], alpha:1},
    {name:'1a 主船帆',     color:CANVAS,  vox:sailMain, vs:.045, at:[-.75,3.05,-.55], alpha:1},
    {name:'1a 船首三角帆', color:CANVAS,  vox:sailJib,  vs:.042, at:[ .65,2.55,-.05], alpha:1},
    {name:'旗帜',          color:FLAG,    vox:flag,     vs:.038, at:[-.35,4.95,-.05], alpha:1},
    {name:'1c 锚',         color:METAL,   vox:anchor,   vs:.040, at:[-2.05,1.15,.62], alpha:1},
    {name:'1c 船钟',       color:GOLD,    vox:bell,     vs:.036, at:[-1.55,1.70,-.05], alpha:1},
    {name:'2d 舵组件',     color:WOOD_D,  vox:rudder,   vs:.044, at:[-2.65,.90,-.05], alpha:1},
    {name:'3a 圆形底座',   color:BASE,    vox:base,     vs:.052, at:[-2.55,.10,-.90], alpha:1},
  ];
  comps.forEach(c=>c.vs*=sizeMul);
  let rawTotal=0;
  comps.forEach(c=>{const b=bounds(c.vox),[ax,ay,az]=c.at;rawTotal+=Object.keys(c.vox).length;const voxels={};for(const k in c.vox){const d=decodeVoxel(c.vox[k]);voxels[k]=encodeVoxel(d.hex,d.shape||SHAPE_CUBE,d.dir||0,d.faces,d.mult||1,c.alpha,d.params);}createObject({name:c.name,colorName:c.color,layer:0,voxelSize:c.vs,voxels,pos:{x:ax*layoutScale-b.minx*c.vs+(off.x||0),y:ay*layoutScale-b.miny*c.vs+(off.y||0),z:az*layoutScale-b.minz*c.vs+(off.z||0)},rotY:0});});
  if(rawTotal<8000||rawTotal>20000)throw new Error(`帆船体素数量异常：${rawTotal}`);
  orbit.target.set(-.15*layoutScale+(off.x||0),2.6*layoutScale+(off.y||0),0);orbit.radius=32;orbit.phi=Math.PI*.34;updateCamera();
  refreshObjList();refreshRightPanel();refreshStats();autoSave();
  return {count:comps.length,finalTotal:rawTotal,rawTotal,budget:0};
}

/* =========================================================
 * 萌趣阶梯鲸预设（多视图参考图分件拼装模型，4,000-15,000 体素）
 *  身躯用「阶面(tread)/棱面(riser)」双色着色，天然呈现参考图中的同心阶梯纹路；
 *  尾鳍、左右鱼鳍、背鳍、十字水柱、双眼、鼻孔标记均为独立组件，各用不同 voxelSize。
 * ========================================================= */
function buildTerracedWhalePreset(opts){
  opts = opts || {};
  const sizeMul = Math.max(0.3, opts.sizeMul || 2.6);
  const layoutScale = sizeMul / 2.6;
  const off = opts.posOffset || { x:0, y:0, z:0 };
  const TREAD='#4a95c9', RISER='#2f6f9e', BELLY_T='#f3f6f6', BELLY_R='#d9e1e2';
  const FIN='#2a6690', SPOUT='#7fe3da', SPOUT_D='#54bcb2', DARK='#12151a';
  const V = () => ({});
  const put = (vox,x,y,z,c) => { vox[keyOf(x,y,z)] = c; };
  const fill = (vox,x0,x1,y0,y1,z0,z1,c) => { for(let x=x0;x<=x1;x++) for(let y=y0;y<=y1;y++) for(let z=z0;z<=z1;z++) put(vox,x,y,z,typeof c==='function'?c(x,y,z):c); };
  const shade = (c,x,y,z,amt) => shadeHex(c, ((x*5+y*7+z*3)&1) ? (amt==null?4:amt) : -(amt==null?4:amt));
  function bounds(vox){
    let minx=Infinity,miny=Infinity,minz=Infinity,maxx=-Infinity,maxy=-Infinity,maxz=-Infinity;
    for (const k in vox){ const [x,y,z]=parseKey(k);
      if (x<minx) minx=x; if (y<miny) miny=y; if (z<minz) minz=z;
      if (x+1>maxx) maxx=x+1; if (y+1>maxy) maxy=y+1; if (z+1>maxz) maxz=z+1; }
    return {minx,miny,minz,maxx,maxy,maxz};
  }

  // === 1 身躯：阶梯terraced椭球薄壳（约2.5格厚）；顶/底面(tread)浅色，侧棱面(riser)深色，
  //     天然形成参考图中的同心阶梯纹路；腹部(y偏下)改用白色 tread/riser，对应参考图白肚纹 ===
  const rx=12, ry=10, rz=11, bellyY=-3;
  const body = V();
  const inside = (x,y,z) => (x*x)/(rx*rx) + (y*y)/(ry*ry) + (z*z)/(rz*rz) <= 1.0000001;
  const innerRx=rx-2.5, innerRy=ry-2.5, innerRz=rz-2.5;
  const innerInside = (x,y,z) => (x*x)/(innerRx*innerRx) + (y*y)/(innerRy*innerRy) + (z*z)/(innerRz*innerRz) <= 1.0000001;
  for (let x=-rx; x<=rx; x++) for (let y=-ry; y<=ry; y++) for (let z=-rz; z<=rz; z++){
    if (!inside(x,y,z) || innerInside(x,y,z)) continue;
    const upEmpty = !inside(x,y+1,z);
    const sideEmpty = !inside(x+1,y,z) || !inside(x-1,y,z) || !inside(x,y,z+1) || !inside(x,y,z-1);
    const belly = y <= bellyY;
    const col = (sideEmpty && !upEmpty) ? (belly ? BELLY_R : RISER) : (belly ? BELLY_T : TREAD);
    put(body, x, y, z, shade(col, x, y, z, 3));
  }

  // === 2 尾鳍：扇形分叶，附着在身躯后端（局部 -x 方向），层叠边缘呼应身躯阶梯纹 ===
  const tail = V();
  for (let i=0; i<=10; i++){
    const t = i / 10;
    const y0 = Math.round(-5 + t*5), y1 = Math.round(3 + t*7);
    const zSpread = Math.round(3 + t*8);
    for (let y=y0; y<=y1; y++) for (let z=-zSpread; z<=zSpread; z++){
      if (Math.abs(z) < zSpread-1 && y>y0 && y<y1) continue;
      put(tail, -i, y, z, shade(RISER, -i, y, z, 3));
    }
  }

  // === 3 左右鱼鳍：小型扁平桨状鳍，贴在身躯前腹两侧 ===
  function makeFin(sign){
    const vox = V();
    for (let x=0; x<=4; x++) for (let y=-5; y<=0; y++) for (let z=0; z<=8; z++){
      put(vox, x, y, sign*z, shade(FIN, x, y, z, 3));
    }
    return vox;
  }
  const finR = makeFin(1), finL = makeFin(-1);

  // === 4 背鳍：小三角鳍，贴在身躯背部 ===
  const dorsal = V();
  for (let x=0; x<=4; x++) for (let y=0; y<=7; y++) for (let z=-3; z<=3; z++){
    if (y <= 7 - Math.abs(z)*1.6) put(dorsal, x, y, z, shade(RISER, x, y, z, 3));
  }

  // === 5 十字水柱：细杆 + 顶部十字花标，浅青色，立于头顶 ===
  const spout = V();
  for (let y=0; y<=10; y++) put(spout, 0, y, 0, shade(SPOUT, 0, y, 0, 3));
  for (let dx=-1; dx<=1; dx++) put(spout, dx, 8, 0, shade(SPOUT, dx, 8, 0, 3));
  for (let dy=7; dy<=10; dy++) put(spout, 0, dy, 1, shade(SPOUT_D, 0, dy, 1, 3));
  put(spout, 0, 11, 0, shade(SPOUT_D, 0, 11, 0, 3));

  // === 6 双眼：小方块深色眼睛 ===
  function makeEye(){ const vox=V(); fill(vox,0,1,0,1,0,0,DARK); return vox; }
  const eyeR = makeEye(), eyeL = makeEye();

  // === 7 鼻孔标记：头顶两枚小黑点 ===
  const blowhole = V();
  put(blowhole, 0, 0, -1, DARK); put(blowhole, 0, 0, 1, DARK);

  const comps = [
    { name:'1 身躯（阶梯纹）', color:TREAD,  vox:body,     vs:0.052,  at:[-0.650, 0.150, -0.598] },
    { name:'2 尾鳍',           color:RISER,  vox:tail,     vs:0.046,  at:[-1.156, 0.300, -0.529] },
    { name:'3a 右鱼鳍',        color:FIN,    vox:finR,     vs:0.038,  at:[ 0.050,-0.040,  0.598] },
    { name:'3b 左鱼鳍',        color:FIN,    vox:finL,     vs:0.0375, at:[ 0.050,-0.038, -0.898] },
    { name:'4 背鳍',           color:RISER,  vox:dorsal,   vs:0.048,  at:[ 0.000, 1.182, -0.168] },
    { name:'5 十字水柱',       color:SPOUT,  vox:spout,    vs:0.042,  at:[ 0.237, 1.192, -0.042] },
    { name:'6a 右眼',          color:DARK,   vox:eyeR,     vs:0.0395, at:[ 0.400, 0.720,  0.550] },
    { name:'6b 左眼',          color:DARK,   vox:eyeL,     vs:0.040,  at:[ 0.400, 0.720, -0.550] },
    { name:'7 鼻孔标记',       color:DARK,   vox:blowhole, vs:0.036,  at:[ 0.500, 1.200, -0.054] },
  ].filter(c=>Object.keys(c.vox).length);

  let rawTotal = 0;
  comps.forEach(c=>{
    const b=bounds(c.vox), [ax,ay,az]=c.at;
    rawTotal += Object.keys(c.vox).length;
    createObject({
      name:c.name, colorName:c.color, layer:0, voxelSize:c.vs, voxels:c.vox, rotY:0,
      pos:{
        x: ax*layoutScale - b.minx*c.vs + (off.x||0),
        y: ay*layoutScale - b.miny*c.vs + (off.y||0),
        z: az*layoutScale - b.minz*c.vs + (off.z||0),
      },
    });
  });
  if (rawTotal < 4000 || rawTotal > 15000) throw new Error(`萌趣阶梯鲸体素数量异常：${rawTotal}`);
  orbit.target.set(0*layoutScale+(off.x||0), 0.6*layoutScale+(off.y||0), 0+(off.z||0));
  orbit.radius = 22; orbit.phi = Math.PI*0.34; updateCamera();
  refreshObjList(); refreshRightPanel(); refreshStats(); autoSave();
  return { count:comps.length, finalTotal:rawTotal, rawTotal, budget:0 };
}

/* =========================================================
 * 内置几何体预设：全部由「正方体体素」堆叠而成（非参数化单体素）。

 * kind: cuboid|sphere|hemisphere|cylinder|halfcylinder|cone|pyramid|torus
 * params: 各几何体的尺寸（以"体素格数"为单位的整数分辨率），字段见下方 GEOM_STACK_DEFAULTS。
 * 每种几何体生成为一个独立物件；用 mergeUniformVoxelBlocks 合并同色块降网格数。
 * ========================================================= */
const GEOM_STACK_DEFAULTS = {
  // cuboid: 长 宽 高（格）
  cuboid:      { w:12, d:8,  h:6 },
  // sphere: 半径（格）
  sphere:      { r:8 },
  // hemisphere: 半径（格）——上半球，平切面朝下贴地
  hemisphere:  { r:9 },
  // cylinder: 半径 高度（格）
  cylinder:    { r:7,  h:12 },
  // halfcylinder: 半径 高度（格）——半圆截面（z≥0 半边），平切面朝 -z
  halfcylinder:{ r:8,  h:12 },
  // cone: 上半径 下半径 高度（格）——上半径 0 即圆锥（上半径在顶、下半径在底）
  cone:        { rt:0, rb:8, h:14 },
  // pyramid: 棱数 底半径 高度 顶部偏移(度)
  pyramid:     { n:4,  r:8,  h:14, off:0 },
  // torus: 内直径 外直径 高度（格）——躺平圆环（环平面水平 XZ、中轴 +Y）
  torus:       { innerD:8, outerD:18, h:6 },
  // ellipsoid: X/Y/Z 三个半轴（格）——三轴独立可调，用于表现椭球/长轴短轴不同的椭圆体
  ellipsoid:   { rx:8, ry:12, rz:8 },
};
const GEOM_STACK_COLORS = {
  cuboid:'#6cbcff', sphere:'#ff8ec7', hemisphere:'#ffd166', cylinder:'#7ad19a',
  halfcylinder:'#9b8cff', cone:'#ff9a4d', pyramid:'#4dd0e1', torus:'#f2c94c',
  ellipsoid:'#ff7aa8',
};
const GEOM_STACK_NAMES = {
  cuboid:'长方体', sphere:'球体', hemisphere:'半球体', cylinder:'圆柱体',
  halfcylinder:'半圆柱', cone:'圆台/圆锥', pyramid:'棱锥', torus:'圆环',
  ellipsoid:'椭球',
};

function buildGeomStackPreset(kind, params, opts){
  opts = opts || {};
  const sizeMul = Math.max(0.3, opts.sizeMul || 2.0);
  const off = opts.posOffset || { x:0, y:0, z:0 };
  // 体素世界边长：优先使用外部指定的 voxelSize，否则按 sizeMul 计算
  const hasCustomVox = opts.voxelSize > 0;
  const s = hasCustomVox ? opts.voxelSize : 0.12 * sizeMul;
  const def = GEOM_STACK_DEFAULTS[kind] || {};
  const p = Object.assign({}, def, params || {});
  // 几何参数（长/宽/高/半径/直径等）表示"固定的世界尺寸"——它们以基准体素大小
  // GEOM_REF_VOXEL(0.24) 下的格数给出。当用户把体素调小时，按 (0.24 / 体素大小) 放大
  // 实际格数：几何体整体尺寸保持不变，但被切分得更精细、体素更多（而不是把物体整体缩放）。
  // 棱数(n)、顶点角度偏移(off) 属于形状定义，不随体素大小换算。
  if (hasCustomVox){
    const GEOM_REF_VOXEL = 0.24;
    const factor = GEOM_REF_VOXEL / s;
    if (Math.abs(factor - 1) > 1e-6){
      const NO_SCALE = { n:true, off:true };
      for (const k in p){
        if (NO_SCALE[k]) continue;
        if (typeof p[k] === 'number') p[k] = p[k] * factor;
      }
    }
  }
  // 颜色：优先使用外部指定颜色，否则用该形状的默认色
  const baseCol = normHex(opts.color) || GEOM_STACK_COLORS[kind] || '#8fd0ff';
  const vox = {};
  const set = (x,y,z,c)=>{ vox[keyOf(x,y,z)] = c; };
  // 明暗微调，让堆叠体不至于纯平（也便于观察层次）
  const shade = (c, x, y, z)=> shadeHex(c, ((x+y+z)&1) ? 5 : -5);

  if (kind === 'cuboid'){
    const w = Math.max(1, Math.round(p.w)), d = Math.max(1, Math.round(p.d)), h = Math.max(1, Math.round(p.h));
    for (let x=0; x<w; x++) for (let y=0; y<h; y++) for (let z=0; z<d; z++) set(x,y,z, shade(baseCol,x,y,z));
  } else if (kind === 'sphere'){
    const r = Math.max(1, Math.round(p.r));
    for (let x=-r; x<=r; x++) for (let y=-r; y<=r; y++) for (let z=-r; z<=r; z++){
      if (x*x + y*y + z*z <= r*r) set(x, y+r, z, shade(baseCol,x,y,z));
    }
  } else if (kind === 'hemisphere'){
    const r = Math.max(1, Math.round(p.r));
    // 上半球：y≥0；平切面落在 y=0
    for (let x=-r; x<=r; x++) for (let y=0; y<=r; y++) for (let z=-r; z<=r; z++){
      if (x*x + y*y + z*z <= r*r) set(x, y, z, shade(baseCol,x,y,z));
    }
  } else if (kind === 'cylinder'){
    const r = Math.max(1, Math.round(p.r)), h = Math.max(1, Math.round(p.h));
    for (let x=-r; x<=r; x++) for (let z=-r; z<=r; z++){
      if (x*x + z*z > r*r) continue;
      for (let y=0; y<h; y++) set(x, y, z, shade(baseCol,x,y,z));
    }
  } else if (kind === 'halfcylinder'){
    const r = Math.max(1, Math.round(p.r)), h = Math.max(1, Math.round(p.h));
    // 半圆截面：保留 z≥0 半边；平切面在 z=0
    for (let x=-r; x<=r; x++) for (let z=0; z<=r; z++){
      if (x*x + z*z > r*r) continue;
      for (let y=0; y<h; y++) set(x, y, z, shade(baseCol,x,y,z));
    }
  } else if (kind === 'cone'){
    const rt = Math.max(0, Math.round(p.rt)), rb = Math.max(0, Math.round(p.rb)), h = Math.max(1, Math.round(p.h));
    for (let y=0; y<h; y++){
      const t = h > 1 ? y/(h-1) : 0;                 // 0=底 1=顶
      const rr = rb + (rt - rb) * t;                 // 该层半径（底 rb → 顶 rt）
      const ri = Math.max(0, Math.round(rr));
      for (let x=-ri; x<=ri; x++) for (let z=-ri; z<=ri; z++){
        if (x*x + z*z <= rr*rr + 0.001) set(x, y, z, shade(baseCol,x,y,z));
      }
    }
  } else if (kind === 'pyramid'){
    const n = Math.max(3, Math.round(p.n)), r = Math.max(1, Math.round(p.r)), h = Math.max(1, Math.round(p.h));
    const off2 = THREE.MathUtils.degToRad(p.off || 0);
    // 顶点水平偏移（随 off 角度沿 +X 偏移），底面 y=0、顶点 y=h-1
    const apexShift = Math.tan(Math.max(-1.4, Math.min(1.4, off2))) * h;
    // 用"点在正 n 边形内"判定逐层填充，层半径从底 r 线性收缩到 ~0
    const inPoly = (px, pz, rad)=>{
      if (rad <= 0.5) return (px*px + pz*pz) <= 0.75;
      const ang = Math.atan2(pz, px);
      const dist = Math.sqrt(px*px + pz*pz);
      // 正 n 边形外接半径 rad 的内接判定：到最近边的半径
      const seg = Math.PI / n;
      let a = ang % (2*seg); if (a < 0) a += 2*seg; a -= seg;
      const edgeR = rad * Math.cos(seg) / Math.max(1e-3, Math.cos(a));
      return dist <= edgeR + 0.5;
    };
    for (let y=0; y<h; y++){
      const t = h > 1 ? y/(h-1) : 0;
      const rad = r * (1 - t);
      const cx = apexShift * t;                       // 该层中心随高度偏移（沿 +X）
      const ci = Math.round(cx);
      const ri = Math.ceil(rad) + 1;
      // 以本层中心 ci 为原点判定多边形内部，再整体平移到 ci
      for (let x=-ri; x<=ri; x++) for (let z=-ri; z<=ri; z++){
        if (inPoly(x, z, rad)) set(x + ci, y, z, shade(baseCol, x, y, z));
      }
    }
  } else if (kind === 'torus'){
    const ri = Math.max(0, p.innerD/2), ro = Math.max(ri+1, p.outerD/2), h = Math.max(1, Math.round(p.h));
    const R = (ri + ro) / 2;                          // 环心半径
    const tube = (ro - ri) / 2;                       // 管截面半径
    const rout = Math.ceil(ro);
    for (let x=-rout; x<=rout; x++) for (let z=-rout; z<=rout; z++){
      const dist = Math.sqrt(x*x + z*z);
      if (dist < ri - 0.5 || dist > ro + 0.001) continue;   // 只保留环带
      // 竖直方向按管截面（横躺圆环，管沿 y 的厚度随离环心距离收敛）
      const dr = dist - R;
      const halfH = tube > 0 ? Math.sqrt(Math.max(0, tube*tube - dr*dr)) : h/2;
      const hh = Math.min(h/2, Math.round(halfH));
      for (let y=-hh; y<=hh; y++) set(x, y + Math.ceil(h/2), z, shade(baseCol,x,y,z));
    }
  } else if (kind === 'ellipsoid'){
    // 椭球：三半轴独立，(x/rx)²+(y/ry)²+(z/rz)²≤1；底部落地（y 平移 +ry）
    const rx = Math.max(1, Math.round(p.rx)), ry = Math.max(1, Math.round(p.ry)), rz = Math.max(1, Math.round(p.rz));
    for (let x=-rx; x<=rx; x++) for (let y=-ry; y<=ry; y++) for (let z=-rz; z<=rz; z++){
      if ((x*x)/(rx*rx) + (y*y)/(ry*ry) + (z*z)/(rz*rz) <= 1) set(x, y+ry, z, shade(baseCol,x,y,z));
    }
  } else {
    return { count:0, finalTotal:0, rawTotal:0, budget:0 };
  }

  // 计算包围盒 → 水平居中、底部落地
  let minx=Infinity,miny=Infinity,minz=Infinity,maxx=-Infinity,maxy=-Infinity,maxz=-Infinity;
  for (const k in vox){ const [x,y,z]=parseKey(k);
    if(x<minx)minx=x; if(y<miny)miny=y; if(z<minz)minz=z;
    if(x>maxx)maxx=x; if(y>maxy)maxy=y; if(z>maxz)maxz=z; }
  if (!isFinite(minx)) return { count:0, finalTotal:0, rawTotal:0, budget:0 };
  const pos = {
    x: -((minx+maxx+1)/2)*s + (off.x||0),
    y: -miny*s + (off.y||0),
    z: -((minz+maxz+1)/2)*s + (off.z||0),
  };
  const rawTotal = Object.keys(vox).length;
  // 体素越小格数越多，防止一次生成过多体素导致卡顿。
  if (rawTotal > 200000){
    toast('体素太小导致数量过多，请把体素大小调大一点');
    return { count:0, finalTotal:0, rawTotal, budget:0 };
  }
  const merged = mergeUniformVoxelBlocks(vox);
  createObject({
    name: GEOM_STACK_NAMES[kind] || '几何体',
    colorName: baseCol,
    layer: 0,
    voxelSize: s,
    voxels: merged,
    pos,
    rotY: 0,
  });

  const cy = ((maxy - miny) / 2) * s;
  orbit.target.set(off.x||0, cy + (off.y||0), off.z||0);
  orbit.radius = Math.max(14, (Math.max(maxx-minx, maxy-miny, maxz-minz) + 6) * s * 2.4);
  orbit.phi = Math.PI * 0.34;
  updateCamera();
  refreshObjList(); refreshRightPanel(); refreshStats(); autoSave();
  return { count:1, finalTotal: Object.keys(merged).length, rawTotal, budget:0 };
}

// ---- 组件包围盒 ----
function compBounds(voxels){
  let minx=Infinity,miny=Infinity,minz=Infinity,maxx=-Infinity,maxy=-Infinity,maxz=-Infinity;
  for(const k in voxels){ const [x,y,z]=parseKey(k); if(x<minx)minx=x; if(y<miny)miny=y; if(z<minz)minz=z; if(x>maxx)maxx=x; if(y>maxy)maxy=y; if(z>maxz)maxz=z; }
  return { minx,miny,minz,maxx,maxy,maxz };
}

// ---- 把一个组件沿最长轴从中位线均等二分 ----
function splitComponent(comp){
  const keys = Object.keys(comp.voxels);
  if (keys.length < 2) return [comp];
  const b = compBounds(comp.voxels);
  const ext = [b.maxx-b.minx, b.maxy-b.miny, b.maxz-b.minz];
  const axis = ext.indexOf(Math.max(...ext)); // 0=x,1=y,2=z
  const coords = keys.map(k=>parseKey(k)[axis]).sort((a,b)=>a-b);
  const mid = coords[Math.floor(coords.length/2)];
  const a={}, c={};
  keys.forEach(k=>{ const v=parseKey(k)[axis]; (v<mid?a:c)[k]=comp.voxels[k]; });
  if (!Object.keys(a).length || !Object.keys(c).length){
    const a2={}, c2={}; keys.forEach((k,i)=>{ (i<keys.length/2?a2:c2)[k]=comp.voxels[k]; });
    return [{ name:comp.name+'·A', color:comp.color, voxels:a2 }, { name:comp.name+'·B', color:comp.color, voxels:c2 }];
  }
  return [{ name:comp.name+'·A', color:comp.color, voxels:a }, { name:comp.name+'·B', color:comp.color, voxels:c }];
}

// ---- 把组件数量调整到目标件数：不够则拆最大块，过多则合并最小块 ----
function adjustToCount(comps, target){
  let list = comps.filter(c=>Object.keys(c.voxels).length);
  if (!list.length) return list;
  while (list.length > target){
    list.sort((a,b)=>Object.keys(a.voxels).length-Object.keys(b.voxels).length);
    const a=list.shift(), b=list.shift();
    const aBig = Object.keys(a.voxels).length >= Object.keys(b.voxels).length;
    list.push({ name:aBig?a.name:b.name, color:aBig?a.color:b.color, voxels:Object.assign({}, b.voxels, a.voxels) });
  }
  let guard=0;
  while (list.length < target && guard++ < 2000){
    list.sort((a,b)=>Object.keys(b.voxels).length-Object.keys(a.voxels).length);
    const biggest = list[0];
    if (Object.keys(biggest.voxels).length < 2) break;
    const parts = splitComponent(biggest);
    if (parts.length < 2) break;
    list.shift(); list.push(parts[0], parts[1]);
  }
  return list;
}

// ---- 把组件整数上采样 factor 倍（每个体素 -> factor³ 个小体素），用于更精细建模 ----
function upsampleComponents(comps, factor){
  if (factor <= 1) return comps;
  return comps.map(p=>{
    const out = {};
    for(const k in p.voxels){
      const [x,y,z] = parseKey(k); const c = p.voxels[k];
      for(let dx=0;dx<factor;dx++)for(let dy=0;dy<factor;dy++)for(let dz=0;dz<factor;dz++)
        out[keyOf(x*factor+dx, y*factor+dy, z*factor+dz)] = c;
    }
    return { name:p.name, color:p.color, voxels:out };
  });
}

// ---- 把单一物品的体素按颜色聚类成组件（用于自定义 LLM 返回结果）----
function aiClusterByColor(voxels){
  const groups = {};
  for(const k in voxels){ let v=voxels[k]; if(typeof v==='string' && v[0]!=='#') v='#'+v; const c=v||'#cccccc'; (groups[c]=groups[c]||{})[k]=c; }
  return Object.keys(groups).map((c,i)=>({ name:'部件'+(i+1), color:c, voxels:groups[c] }));
}

// ---- 整体包围盒最长边（体素数）----
function compsSpan(comps){
  let minx=Infinity,miny=Infinity,minz=Infinity,maxx=-Infinity,maxy=-Infinity,maxz=-Infinity;
  comps.forEach(p=>{ for(const k in p.voxels){ const [x,y,z]=parseKey(k); if(x<minx)minx=x; if(y<miny)miny=y; if(z<minz)minz=z; if(x>maxx)maxx=x; if(y>maxy)maxy=y; if(z>maxz)maxz=z; } });
  return { minx,miny,minz,maxx,maxy,maxz, span: Math.max(maxx-minx+1, maxy-miny+1, maxz-minz+1) };
}

// ---- 装配：把"形状(shapes)"按体素大小体素化后居中对齐人头中心 ----
// shapes：参数化形状数组；sizeMul：整体世界尺寸 ≈ sizeMul×头直径；voxelSize：体素世界大小（越小分辨率越高越精细）；aspect：图片形态比例；posOffset：相对人头中心的世界偏移；budget：体素总数预算（>0 时启用，按此总数匹配分辨率并保持整体大小）
function aiAssembleShapesAndPlace(shapes, count, baseHex, sizeMul, voxelSize, aspect, posOffset, budget){
  if (!shapes || !shapes.length){ toast('未能生成有效组件'); return; }
  voxelSize = Math.max(0.06, Math.min(1.0, voxelSize || 0.28));
  const off = posOffset || { x:0, y:0, z:0 };
  const anchor = aiHeadAnchor();
  const targetWorld = sizeMul * 2 * anchor.radius;   // 目标整体世界尺寸
  // 图片形态：把整体各轴比例交给体素化（长物体更长、扁物体更扁）
  const scaleXYZ = aspect || [1,1,1];
  let parts, res;
  if (budget > 0){
    // 预算模式：搜索使体素总数最接近 budget 的分辨率，再反算体素大小以保持整体世界尺寸
    const r = voxelizeToBudget(shapes, budget, scaleXYZ);
    parts = r.parts; res = r.res;
    voxelSize = Math.max(0.02, targetWorld / Math.max(1, res));
  } else {
    // 分辨率 = 世界尺寸 / 体素大小；体素越小 res 越大 -> SDF 采样越密 -> 形状越平滑精细
    res = Math.max(8, Math.min(72, Math.round(targetWorld / voxelSize)));
    parts = voxelizeShapes(shapes, res, scaleXYZ);
  }
  const rawTotal = totalVoxels(parts);
  // 按目标件数拆分/合并（在高分辨率下拆分更均匀）
  parts = adjustToCount(parts, count);
  if (!parts.length){ toast('未能生成有效组件'); return; }
  const b = compsSpan(parts);
  // 物品几何中心（体素坐标）；某体素世界中心 = pos + (coord+0.5)*s
  const cmx=(b.minx+b.maxx)/2, cmy=(b.miny+b.maxy)/2, cmz=(b.minz+b.maxz)/2;
  const pos = {
    x: anchor.center.x + off.x - (cmx+0.5)*voxelSize,
    y: anchor.center.y + off.y - (cmy+0.5)*voxelSize,
    z: anchor.center.z + off.z - (cmz+0.5)*voxelSize,
  };
  // 删除与人体（头/颈/身体）重合的体素
  parts = removeBodyOverlap(parts, pos, voxelSize);
  if (!parts.length){ toast('全部体素与人体重合，请调大物品大小或移动模特'); return; }
  // 按颜色相似度将各组件配色向代表色收敛
  applyColorSimilarity(parts, aiColorSim);
  parts.forEach((p,i)=>{
    createObject({
      name: parts.length===1 ? 'AI 物件' : `${p.name||'组件'} ${i+1}`,
      colorName: p.color || baseHex,
      layer: 0,
      voxelSize,
      // 贪心合并大面积同色小体素为大体素：同一物件内自动混合出现不同大小的体素，
      // 视觉完全不变，但大平面（如机身面板）体素条目数量大幅减少
      voxels: mergeUniformVoxelBlocks(p.voxels),
      pos: { x:pos.x, y:pos.y, z:pos.z },
      rotY: 0,
    });
    // 不自动生成螺丝，交由用户在编辑器内手动布点
  });
  refreshObjList(); refreshRightPanel(); refreshStats(); autoSave();
  return { rawTotal, finalTotal: totalVoxels(parts), count: parts.length, budget: budget || 0 };
}

// ---- 检查描述是否命中预设物品（非兜底球体）----
function aiHasPredefinedItem(text){
  const t = text || '';
  return /阶梯鲸|萌趣鲸|萌鲸|积木鲸|方块鲸|terraced ?whale|blocky ?whale|帆船|海盗船|木船|船只|轮船|大船|\bship\b|sailboat|sailing ?ship|pirate ?ship|boat|珍珠奶茶|奶茶|奶盖|bubble ?tea|pearl ?tea|boba|milk ?tea|礼盒|礼品盒|礼物盒|gift ?box|present ?box|鲸鱼|蓝鲸|鲸|whale|blue ?whale|花束|花卉花束|鲜花花束|bouquet|flower ?bouquet|voxel ?bouquet|卡车|货车|载货车|运输车|truck|lorry|cargo ?truck|pickup|留声机|唱机|唱片机|gramophone|phonograph|grammophon|蛋糕预设2|蛋糕2|分件蛋糕|cake2|蛋糕|生日蛋糕|双层蛋糕|cake|birthday ?cake|汉堡预设2|汉堡2|豪华汉堡|特制汉堡|burger2|hamburger2|汉堡|burger|hamburger|三明治|相机|照相机|camera|单反|旁轴|拍立得|胶片机|菲林|复古相机|电视|television|\bTV\b|\bCRT\b|黑白电视|monitor|显示器|红绿灯|交通灯|信号灯|traffic ?light|红黄绿灯|指挥灯|闹钟|马蹄钟|双铃钟|台钟|座钟|alarm ?clock|鱼缸|水族箱|水族缸|水草缸|fish ?tank|aquarium|小屋|房子|别墅|房屋|双层屋|voxel ?house|tiny ?house|cottage|cabin|树|tree|圣诞|金字塔|pyramid|爱心|心形|heart|心|球|圆|sphere|苹果|太阳|月|气球/i.test(t);
}


// ---- 将 LLM 返回的离散体素装配为物件（上采样 + 重合删除）----
function aiAssembleAndPlace(comps, count, baseHex, sizeMul, voxelSize, posOffset, budget){
  if (!comps || !comps.length){ toast('未能生成有效组件'); return; }
  voxelSize = Math.max(0.08, Math.min(1.0, voxelSize || 0.28));
  const off = posOffset || { x:0, y:0, z:0 };
  const anchor = aiHeadAnchor();
  const targetWorld = sizeMul * 2 * anchor.radius;
  const span0 = compsSpan(comps).span || 1;
  const base0 = totalVoxels(comps) || 1;
  let factor;
  if (budget > 0){
    // 预算模式：上采样为整数倍立方，选 factor 使 base0×factor³ 最接近 budget
    let best = 1, bestDiff = Infinity;
    for (let f = 1; f <= 8; f++){
      const diff = Math.abs(base0 * f * f * f - budget);
      if (diff < bestDiff){ bestDiff = diff; best = f; }
    }
    factor = best;
    // 反算体素大小以保持整体世界尺寸
    voxelSize = Math.max(0.02, targetWorld / Math.max(1, span0 * factor));
  } else {
    factor = Math.round(targetWorld / (voxelSize * span0));
    factor = Math.max(1, Math.min(6, factor));
  }
  let parts = upsampleComponents(comps, factor);
  const rawTotal = totalVoxels(parts);
  parts = adjustToCount(parts, count);
  if (!parts.length){ toast('未能生成有效组件'); return; }
  const b = compsSpan(parts);
  const cmx=(b.minx+b.maxx)/2, cmy=(b.miny+b.maxy)/2, cmz=(b.minz+b.maxz)/2;
  const pos = {
    x: anchor.center.x + off.x - (cmx+0.5)*voxelSize,
    y: anchor.center.y + off.y - (cmy+0.5)*voxelSize,
    z: anchor.center.z + off.z - (cmz+0.5)*voxelSize,
  };
  parts = removeBodyOverlap(parts, pos, voxelSize);
  if (!parts.length){ toast('全部体素与人体重合，请调大物品大小或移动模特'); return; }
  // 按颜色相似度将各组件配色向代表色收敛
  applyColorSimilarity(parts, aiColorSim);
  parts.forEach((p,i)=>{
    createObject({
      name: parts.length===1 ? 'AI 物件' : `${p.name||'组件'} ${i+1}`,
      colorName: p.color || baseHex,
      layer: 0,
      voxelSize,
      voxels: mergeUniformVoxelBlocks(p.voxels),
      pos: { x:pos.x, y:pos.y, z:pos.z },
      rotY: 0,
    });
  });
  refreshObjList(); refreshRightPanel(); refreshStats(); autoSave();
  return { rawTotal, finalTotal: totalVoxels(parts), count: parts.length, budget: budget || 0 };
}


// ---- 调用自定义 LLM 端点（约定返回体素 JSON）----
async function aiCallLLM(endpoint, desc, count, imageDataUrl){
  const prompt = `你是体素建模助手。根据描述生成"一个完整物品"的体素模型，物品由多种颜色的天然组件构成（例如汉堡=面包/肉饼/芝士/生菜）。仅返回 JSON：
{"voxels":{"x,y,z":"#rrggbb"}}
坐标为整数，整体不超过 16x16x16，不同组件用不同颜色区分（本地会按颜色拆成约 ${count} 个组件）。描述：${desc}`;
  const body = { prompt, description: desc, count, image: imageDataUrl || null };
  const res = await fetch(endpoint, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('接口返回 '+res.status);
  const json = await res.json();
  let data = json;
  if (json.choices && json.choices[0] && json.choices[0].message){
    const txt = json.choices[0].message.content;
    const m = txt.match(/\{[\s\S]*\}/);
    data = JSON.parse(m ? m[0] : txt);
  }
  // 兼容旧格式 {objects:[{voxels}]}
  if (!data.voxels && data.objects && data.objects[0] && data.objects[0].voxels) data = { voxels: data.objects[0].voxels };
  if (!data.voxels || !Object.keys(data.voxels).length) throw new Error('接口未返回 voxels');
  return data;
}

/* ---------------- AI 模态 UI 绑定 ---------------- */
(function setupAI(){
  const mask = $('ai-mask');
  if (!mask) return;
  const countEl = $('ai-count');
  const countVal = $('ai-count-val');
  const voxelEl = $('ai-voxel');
  const voxelVal = $('ai-voxel-val');
  const simEl = $('ai-similarity');
  const simVal = $('ai-similarity-val');
  const scaleEl = $('ai-scale');        // 整体大小（缩放）滑块
  const scaleVal = $('ai-scale-val');   // 整体大小数字框
  const posXEl = $('ai-pos-x'), posYEl = $('ai-pos-y'), posZEl = $('ai-pos-z'); // 位置偏移
  const budgetEl = $('ai-budget');      // 体素总数预算（0=不限制）
  const budgetPer = $('ai-budget-per'); // "每件约 N" 提示

  // 当前选中的预设物品（点击 chip 选择；生成时优先使用稳定的预设关键词）
  let aiSelected = '';
  const presetAliases = {
    '🐳 萌趣阶梯鲸': '阶梯鲸',
    '⛵ 体素帆船': '帆船',
    '🧋 珍珠奶茶': '珍珠奶茶',
    '🎁 分组件礼盒': '礼盒',

    '💐 分组件花束': '花束',

    '🐋 分组件蓝鲸': '蓝鲸',


    '🚚 货运卡车': '货运卡车',
    '🎂 双层生日蛋糕': '双层生日蛋糕',
    '🎂 蛋糕预设2(分件)': '蛋糕预设2',
    '🍔 汉堡预设1': '汉堡',
    '🍔 豪华汉堡2': '豪华汉堡',
    '🎼 留声机': '留声机',
    '📷 复古相机': '复古相机',
    '📺 复古电视机': '复古电视机',
    '⏰ 双铃闹钟': '双铃闹钟',
    '🚦 红绿灯': '红绿灯',
    '🐠 体素鱼缸': '体素鱼缸',
    '🏠 体素小屋': '体素小屋',
    '一棵圣诞树': '圣诞树',
  };
  const chips = Object.keys(presetAliases);
  const chipBox = $('ai-chips');
  if (chipBox) chips.forEach((c)=>{ const el=document.createElement('div'); el.className='ai-chip'; el.textContent=c;
    el.addEventListener('click',()=>{
      aiSelected = c;
      // 高亮当前选中的 chip
      chipBox.querySelectorAll('.ai-chip').forEach(x=>x.style.background='');
      el.style.background = 'rgba(122,79,255,.45)';
    });
    chipBox.appendChild(el);
  });

  function updateBudgetPer(){
    if (!budgetPer) return;
    const b = parseInt(budgetEl && budgetEl.value) || 0;
    const c = Math.max(1, parseInt(countEl && countEl.value) || 1);
    budgetPer.textContent = b > 0 ? Math.round(b / c) : '—';
  }
  if (countEl && countVal) countEl.addEventListener('input', ()=>{ countVal.textContent = countEl.value; updateBudgetPer(); });
  if (budgetEl) budgetEl.addEventListener('input', updateBudgetPer);
  updateBudgetPer();
  if (voxelEl && voxelVal) voxelEl.addEventListener('input', ()=> voxelVal.textContent = parseFloat(voxelEl.value).toFixed(2));
  if (simEl && simVal) simEl.addEventListener('input', ()=> simVal.textContent = simEl.value + '%');
  // 整体大小：滑块↔数字框双向同步（数字框可输入超出滑块范围的精确值）
  if (scaleEl && scaleVal){
    scaleEl.addEventListener('input', ()=> scaleVal.value = parseFloat(scaleEl.value));
    scaleVal.addEventListener('input', ()=>{ const v = parseFloat(scaleVal.value); if (isFinite(v)) scaleEl.value = v; });
  }
  function open(){
    mask.style.display='flex';
    // 每次打开清空上次的预设选择与高亮
    aiSelected = '';
    if (chipBox) chipBox.querySelectorAll('.ai-chip').forEach(x=>x.style.background='');
  }
  function close(){ mask.style.display='none'; }
  $('btn-ai').addEventListener('click', open);
  $('ai-cancel').addEventListener('click', close);
  mask.addEventListener('click', e=>{ if(e.target===mask) close(); });

  $('ai-generate').addEventListener('click', async ()=>{
    const desc = ((presetAliases[aiSelected] || aiSelected || '') + '').trim();
    const count = Math.max(5, Math.min(40, parseInt(countEl.value)||7));
    // 整体大小（缩放）：优先取数字框，回退滑块，默认 2.6；下限 0.1
    let sizeMul = parseFloat(scaleVal && scaleVal.value);
    if (!isFinite(sizeMul)) sizeMul = parseFloat(scaleEl && scaleEl.value);
    if (!isFinite(sizeMul)) sizeMul = 2.6;
    sizeMul = Math.max(0.1, sizeMul);
    // 位置偏移（相对人头中心，世界坐标）
    const posOffset = {
      x: parseFloat(posXEl && posXEl.value) || 0,
      y: parseFloat(posYEl && posYEl.value) || 0,
      z: parseFloat(posZEl && posZEl.value) || 0,
    };
    // 体素总数预算（0=不限制；上限保护防止体素爆炸）
    let budget = parseInt(budgetEl && budgetEl.value) || 0;
    if (budget > 0) budget = Math.max(count, Math.min(60000, budget));
    const voxelSize = parseFloat(voxelEl && voxelEl.value)||0.24;
    aiColorSim = (parseFloat(simEl && simEl.value) || 0) / 100;   // 颜色相似度 0..1
    if (!desc){ toast('请先选择一个预设物品'); return; }

    const baseHex = aiColorFromText(desc) || '#ffd166';
    const aspect = null;

    const btn = $('ai-generate'); btn.disabled = true; btn.textContent = '生成中…';
    try {
      let stat = null;
      // 预设物品（SDF 精细几何）
      if (!aiHasPredefinedItem(desc)){
        toast('未识别到预设物品类型，请从上方选择一个预设物品');
        btn.disabled=false; btn.textContent='生成'; return;
      }
      if (/礼盒|礼品盒|礼物盒|gift ?box|present ?box/i.test(desc)){
        // 礼盒：展示底座 / 盒体 / 丝带 / 倾斜盒盖 / 蝴蝶结 / 礼盒内物件全部分组件装配
        stat = buildGiftBoxPreset({ sizeMul, posOffset });
      } else if (/花束|花卉花束|鲜花花束|bouquet|flower ?bouquet|voxel ?bouquet/i.test(desc)){
        // 花束：8 个花头 + 4 个枝叶框架 + 花束包裹 / 底层纸包裹 / 蝴蝶结，全部分组件装配
        stat = buildBouquetPreset({ sizeMul, posOffset });
      } else if (/阶梯鲸|萌趣鲸|萌鲸|积木鲸|方块鲸|terraced ?whale|blocky ?whale/i.test(desc)){
        // 萌趣阶梯鲸：阶梯纹身躯、尾鳍、双鱼鳍、背鳍、十字水柱、双眼、鼻孔标记独立生成后装配
        stat = buildTerracedWhalePreset({ sizeMul, posOffset });
      } else if (/鲸鱼|蓝鲸|鲸|whale|blue ?whale/i.test(desc)){

        // 蓝鲸：水柱、头部上下颚、躯干、腹褶、双胸鳍、背鳍、尾鳍、眼睛和气孔独立生成后装配
        stat = buildWhalePreset({ sizeMul, posOffset });
      } else if (/珍珠奶茶|奶茶|奶盖|bubble ?tea|pearl ?tea|boba|milk ?tea/i.test(desc)){
        // 珍珠奶茶：奶油、冰块、樱桃、吸管、杯体、液体、珍珠、托盘、底座和网格独立装配
        stat = buildBubbleTeaPreset({ sizeMul, posOffset });
      } else if (/帆船|海盗船|木船|船只|轮船|大船|\bship\b|sailboat|sailing ?ship|pirate ?ship|boat/i.test(desc)){
        // 帆船：船体舱室 / 甲板 / 船首装饰 / 桅杆 / 主副帆 / 旗 / 锚 / 船钟 / 舵 / 底座独立装配
        stat = buildShipPreset({ sizeMul, posOffset });
      } else if (/卡车|货车|载货车|运输车|truck|lorry|cargo ?truck|pickup/i.test(desc)){


        // 货运卡车：分组件爆炸摆放，不同组件使用不同 voxelSize，含驾驶室/货箱/底盘/车轮/木箱
        stat = buildTruckPreset({ sizeMul, posOffset });
      } else if (/蛋糕预设2|蛋糕2|分件蛋糕|分件拼装|cake2/i.test(desc)){
        // 分件拼装蛋糕：不同 voxelSize 的独立组件装配为完整双层生日蛋糕，目标 4000-6000 体素
        stat = buildCakePreset2({ sizeMul, posOffset });
      } else if (/蛋糕|生日蛋糕|双层蛋糕|cake|birthday ?cake/i.test(desc)){
        // 默认蛋糕同样采用分件拼装：盘子、双层糕体、奶油、蜡烛、樱桃、彩糖、文字独立生成后装配
        stat = buildCakePreset2({ sizeMul, posOffset });
      } else if (/鱼缸|水族箱|水族缸|水草缸|fish ?tank|aquarium/i.test(desc)){

        // 鱼缸：直接装配 18 个组件（含半透明玻璃），不走 SDF/自动拆分
        stat = buildFishTankPreset({ sizeMul, posOffset });
      } else if (/小屋|房子|别墅|房屋|voxel ?house|tiny ?house|cottage|cabin/i.test(desc)){
        // 小屋：直接装配 21 个组件（屋顶 / 一二楼 / 家具 / 墙壁 / 玻璃）
        stat = buildHousePreset({ sizeMul, posOffset });
      } else {
        const shapes = aiBuildShapes(desc, baseHex);
        stat = aiAssembleShapesAndPlace(shapes, count, baseHex, sizeMul, voxelSize, aspect, posOffset, budget);
      }
      if (stat && budget > 0){
        const per = Math.round(stat.finalTotal / Math.max(1, stat.count));
        toast(`已生成「${desc||'图片物体'}」· 目标 ${budget} 体素 → 实际 ${stat.finalTotal} 个（${stat.count} 件，每件约 ${per}）`);
      } else if (stat){
        toast(`已生成「${desc||'图片物体'}」· ${stat.count} 个组件（共 ${stat.finalTotal} 体素）`);
      } else {
        toast(`已生成「${desc||'图片物体'}」`);
      }
      close();
    } catch(err){
      toast('生成失败：' + (err.message||err));
    } finally {
      btn.disabled = false; btn.textContent = '生成';
    }
  });
})();

/* ---------------- 体素几何预设面板绑定 ---------------- */
(function setupGeomStack(){
  const box = $('gstack-params');
  if (!box) return;
  let kind = 'cuboid';

  // 每个形状对应的参数输入项：{ 参数键: [range元素id, number元素id] }
  const inputs = {
    cuboid:      { w:['gs-cuboid-w','v-gs-cuboid-w'], d:['gs-cuboid-d','v-gs-cuboid-d'], h:['gs-cuboid-h','v-gs-cuboid-h'] },
    sphere:      { r:['gs-sphere-r','v-gs-sphere-r'] },
    hemisphere:  { r:['gs-hemisphere-r','v-gs-hemisphere-r'] },
    cylinder:    { r:['gs-cylinder-r','v-gs-cylinder-r'], h:['gs-cylinder-h','v-gs-cylinder-h'] },
    halfcylinder:{ r:['gs-halfcylinder-r','v-gs-halfcylinder-r'], h:['gs-halfcylinder-h','v-gs-halfcylinder-h'] },
    cone:        { rt:['gs-cone-rt','v-gs-cone-rt'], rb:['gs-cone-rb','v-gs-cone-rb'], h:['gs-cone-h','v-gs-cone-h'] },
    pyramid:     { n:['gs-pyramid-n','v-gs-pyramid-n'], r:['gs-pyramid-r','v-gs-pyramid-r'], h:['gs-pyramid-h','v-gs-pyramid-h'], off:['gs-pyramid-off','v-gs-pyramid-off'] },
    torus:       { innerD:['gs-torus-id','v-gs-torus-id'], outerD:['gs-torus-od','v-gs-torus-od'], h:['gs-torus-h','v-gs-torus-h'] },
    ellipsoid:   { rx:['gs-ellipsoid-rx','v-gs-ellipsoid-rx'], ry:['gs-ellipsoid-ry','v-gs-ellipsoid-ry'], rz:['gs-ellipsoid-rz','v-gs-ellipsoid-rz'] },
  };

  // range ↔ number 双向同步
  Object.values(inputs).forEach(group => {
    Object.values(group).forEach(([rid, nid]) => {
      const r = $(rid), n = $(nid);
      if (!r || !n) return;
      r.addEventListener('input', () => { n.value = r.value; });
      n.addEventListener('input', () => { const v = parseFloat(n.value); if (isFinite(v)) r.value = v; });
    });
  });

  // 颜色选择器 ↔ 文本框 双向同步
  const colorPick = $('gs-color'), colorText = $('v-gs-color');
  if (colorPick && colorText){
    colorPick.addEventListener('input', () => { colorText.value = colorPick.value; });
    colorText.addEventListener('input', () => {
      const v = normHex(colorText.value);
      if (v) colorPick.value = v;
    });
  }
  // 体素大小 range ↔ number 双向同步
  const vsRange = $('gs-voxel-size'), vsNum = $('v-gs-voxel-size');
  if (vsRange && vsNum){
    vsRange.addEventListener('input', () => { vsNum.value = vsRange.value; });
    vsNum.addEventListener('input', () => { const v = parseFloat(vsNum.value); if (isFinite(v)) vsRange.value = v; });
  }

  function showGroup(){
    box.querySelectorAll('.gsp-group').forEach(g => {
      g.style.display = (g.getAttribute('data-gsp') === kind) ? '' : 'none';
    });
  }

  // 形状按钮
  document.querySelectorAll('[data-gstack]').forEach(btn => {
    btn.addEventListener('click', () => {
      kind = btn.getAttribute('data-gstack');
      document.querySelectorAll('[data-gstack]').forEach(b => b.classList.toggle('active', b === btn));
      showGroup();
    });
  });
  showGroup();

  // 读取当前形状参数
  function readParams(){
    const group = inputs[kind] || {};
    const out = {};
    for (const key in group){
      const v = parseFloat($(group[key][1]).value);
      out[key] = isFinite(v) ? v : 0;
    }
    return out;
  }

  const genBtn = $('gs-generate');
  if (genBtn) genBtn.addEventListener('click', () => {
    if (validationPreview){ toast('验证预览中，暂不可编辑'); return; }
    const params = readParams();
    const color = colorPick ? colorPick.value : (colorText ? normHex(colorText.value) : null);
    const voxelSize = vsNum ? parseFloat(vsNum.value) : NaN;
    const stat = buildGeomStackPreset(kind, params, {
      sizeMul: 2.0,
      posOffset: { x:0, y:0, z:0 },
      color,
      voxelSize: (isFinite(voxelSize) && voxelSize > 0) ? voxelSize : 0,
    });
    if (stat && stat.finalTotal){
      toast(`已生成「${GEOM_STACK_NAMES[kind] || '几何体'}」· ${stat.rawTotal} 体素（合并为 ${stat.finalTotal} 块）`);
    } else {
      toast('参数无效，未能生成几何体');
    }
  });
})();

/* toast */
let toastTimer = null;
function toast(msg){ const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(()=>t.classList.remove('show'), 1400); }

/* =========================================================
 * 初始化
 * ========================================================= */
function seedDefault(){
  // 默认空物件：围绕人形模特进行雕刻创作（头部为禁放区）
  createObject({ name:'新物件', colorName: editor.voxelColor, layer:0, voxelSize: DEFAULT_VOXEL_SIZE });
  const nameEl = $('level-name');
  if (nameEl) nameEl.value = '';
  level.name = '我的雕塑关卡';
  currentCustomLevelId = null;
  refreshStats(); autoSave();
}

buildScrewPalette();
renderRecent();
const loadedByEditQuery = loadCustomLevelFromQuery();
if (!loadedByEditQuery && !loadFromStorage()) seedDefault();
renderMyCustomLevels();
refreshObjList(); refreshRightPanel(); syncPlaneIndicator();
applyMannequinXform(); syncMannequinControls();   // 初始化人形模特控件与显示
if (loadedByEditQuery) toast('已从我的自定义关卡加载，开始编辑吧');

/* ---------------- 渲染循环（带崩溃防护） ----------------
 * 关键改动：
 *  1) 打开系统取色器 / 页面切到后台 / WebGL 上下文丢失 时，暂停渲染循环，
 *     避免「取色对话框弹出的瞬间仍在满负荷渲染上千个体素网格」把标签页挤崩溃
 *     （用户反馈：一点取色就崩溃）。
 *  2) 渲染包 try/catch，单帧异常不再让整个循环连环报错导致卡死。
 *  3) 监听 webglcontextlost/restored，上下文丢失能自动恢复而不是硬崩。
 */
let renderPaused = false, _lastRenderAt = 0;
function animate(ts){
  requestAnimationFrame(animate);
  if (renderPaused || document.hidden) return;
  let voxels = 0;
  level.objects.forEach(o => { voxels += Number.isFinite(o._voxelCount) ? o._voxelCount : 0; });
  const minFrameMs = voxels >= 10000 ? 32 : 16;
  if (ts - _lastRenderAt < minFrameMs) return;
  _lastRenderAt = ts;
  try { renderer.render(scene, camera); } catch(e){ /* 单帧渲染异常忽略，避免连环崩溃 */ }
}
animate(0);


// 页面重新可见时确保恢复渲染
document.addEventListener('visibilitychange', () => { if (!document.hidden) renderPaused = false; });

// WebGL 上下文丢失/恢复处理：不再硬崩，能自动复原
renderer.domElement.addEventListener('webglcontextlost', e => {
  e.preventDefault();               // 允许后续 restored 事件触发
  renderPaused = true;
  toast('图形上下文暂时丢失，正在恢复…');
});
renderer.domElement.addEventListener('webglcontextrestored', () => {
  renderPaused = false;
  // 场景中的物件按数据重建，确保恢复后显示正常
  try { level.objects.forEach(o => buildObjectGroup(o)); } catch(_){}
});
