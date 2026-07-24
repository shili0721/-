/* =========================================================
 * 共享人形模特（展示半身像）
 * - 结构：头 + 颈 + 胸肩（半身像，无手/无臂）
 * - 提供给 游戏(index.html) 与 两个编辑器(sculpt.js / editor.js) 复用
 * - 头部为「禁止放置体素」区域：通过 getHeadWorldSphere() 暴露头部世界球
 * - 全身共用一个材质实例，便于整体调节透明度（游戏中侧面/底部旋转渐隐）
 *
 * 坐标约定：group 原点在底座中心（y=0 为底面，向上生长），便于直接坐在地面上。
 * ========================================================= */
(function () {
  if (!window.THREE) return;
  const THREE = window.THREE;

  function createMannequin(opts) {
    opts = opts || {};
    const color = opts.color != null ? opts.color : 0xe3e7f1;
    const opacity = opts.opacity != null ? opts.opacity : 1.0;
    const solid = opacity >= 0.9;

    const group = new THREE.Group();
    group.name = 'mannequin';

    // 整体竖直偏移：让「下颚（头部底端）」落在 group 原点 y=0
    // 头中心 5.45 − 头部竖直半径(1.2 × 1.18=1.416) ≈ 4.034
    const JAW_Y = 5.45 - 1.2 * 1.18;

    // 全身共用材质（统一调透明度）
    const mat = new THREE.MeshStandardMaterial({
      color: color,
      roughness: 0.58,
      metalness: 0.06,
      transparent: true,
      opacity: opacity,
      depthWrite: solid,
    });
    group.userData.material = mat;

    // ---- 胸肩 / 躯干（旋转体：底部平盘 → 肩部最宽 → 收到颈根开口） ----
    const profile = [
      [0.02, 0.00],
      [1.50, 0.00],   // 底面平盘
      [1.66, 0.42],
      [2.02, 1.05],
      [2.38, 1.85],   // 肩部最宽
      [2.30, 2.18],
      [1.55, 2.62],
      [0.80, 3.05],
      [0.56, 3.40],   // 颈根开口
    ].map(p => new THREE.Vector2(p[0], p[1]));
    const torso = new THREE.Mesh(new THREE.LatheGeometry(profile, 48), mat);
    torso.position.y = -JAW_Y;
    torso.scale.z = 0.70;        // 前后压扁，更像半身像
    torso.castShadow = solid;
    group.add(torso);

    // ---- 颈 ----
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.58, 1.1, 24), mat);
    neck.position.y = 3.8 - JAW_Y;
    neck.scale.z = 0.86;
    neck.castShadow = solid;
    group.add(neck);

    // ---- 头（蛋形椭球，无五官） ----
    const head = new THREE.Mesh(new THREE.SphereGeometry(1.2, 32, 24), mat);
    head.position.y = 5.45 - JAW_Y;
    head.scale.set(0.92, 1.18, 0.82);
    head.castShadow = solid;
    head.name = 'mannequin-head';
    group.add(head);

    // ---- 头部禁放区域（世界球） ----
    const HEAD_BASE_RADIUS = 1.2 * 1.18 * 1.12; // 取头部最大半径并留余量
    group.userData.headMesh = head;
    group.userData.getHeadWorldSphere = function () {
      const center = head.getWorldPosition(new THREE.Vector3());
      const ws = group.getWorldScale(new THREE.Vector3());
      const radius = HEAD_BASE_RADIUS * Math.max(ws.x, ws.y, ws.z);
      return { center, radius };
    };

    // ---- 全身禁放区域：精确判断某世界点是否落在人体（头 + 颈 + 躯干）内部 ----
    // 逐部位把世界点转到各 mesh 的局部空间（worldToLocal 已抵消该 mesh 的缩放），
    // 再按其原始几何（椭球 / 圆柱 / 旋转体 profile）判断是否在内。
    // margin：>1 放大禁区（更保守，删更多），<1 收缩。默认 1.0 为几何精确边界。
    const NECK_H = 1.1, NECK_RT = 0.5, NECK_RB = 0.58; // 颈：高度与上/下半径
    group.userData.bodyBlocks = function (worldPoint, margin) {
      margin = margin != null ? margin : 1.0;
      const p = worldPoint;
      // 头（椭球，几何半径 1.2）
      {
        const lp = head.worldToLocal(p.clone());
        if (lp.length() <= 1.2 * margin) return true;
      }
      // 颈（圆柱，半径随高度线性：顶 0.5 → 底 0.58）
      {
        const lp = neck.worldToLocal(p.clone());
        const hy = NECK_H / 2;
        if (Math.abs(lp.y) <= hy * margin) {
          const t = (hy - lp.y) / NECK_H;               // 顶=0，底=1
          const r = (NECK_RT + (NECK_RB - NECK_RT) * t) * margin;
          if (Math.hypot(lp.x, lp.z) <= r) return true;
        }
      }
      // 躯干（旋转体 profile：[半径, 高度]，线性插值出该高度处半径）
      {
        const lp = torso.worldToLocal(p.clone());
        const yMin = profile[0].y, yMax = profile[profile.length - 1].y;
        if (lp.y >= yMin && lp.y <= yMax) {
          let r = 0;
          for (let i = 0; i < profile.length - 1; i++) {
            const a = profile[i], b = profile[i + 1];
            if (lp.y >= a.y && lp.y <= b.y) {
              const tt = (b.y === a.y) ? 0 : (lp.y - a.y) / (b.y - a.y);
              r = a.x + (b.x - a.x) * tt;
              break;
            }
          }
          if (Math.hypot(lp.x, lp.z) <= r * margin) return true;
        }
      }
      return false;
    };

    // 设置整体透明度（游戏渐隐用）
    group.userData.setOpacity = function (op) {
      mat.opacity = op;
      mat.depthWrite = op > 0.9;
    };

    return group;
  }

  window.createMannequin = createMannequin;
})();
