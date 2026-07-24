/*
 * astro-engine.js — 本命星盘计算引擎（纯前端）
 * 依赖：astronomy-engine（全局 Astronomy），提供精确星历。
 * 计算：行星地心黄经/逆行、四轴(ASC/MC/DES/IC)、Placidus 宫位、
 *       托勒密相位(精确度数、出/入相位)、特能(完整传统尊贵体系)。
 *
 * 采用回归黄道(tropical)、当日真黄道(ECT)，与主流占星软件一致。
 */
(function (root) {
  'use strict';

  var D2R = Math.PI / 180, R2D = 180 / Math.PI;

  // 十二星座（中文/英文/符号）
  var SIGNS = ['白羊', '金牛', '双子', '巨蟹', '狮子', '处女', '天秤', '天蝎', '射手', '摩羯', '水瓶', '双鱼'];
  var SIGNS_EN = ['Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo', 'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'];
  var SIGN_GLYPH = ['♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓'];

  // 行星定义（顺序即输出顺序）
  var BODIES = [
    { key: 'sun', cn: '太阳', glyph: '☉', body: 'Sun' },
    { key: 'moon', cn: '月亮', glyph: '☽', body: 'Moon' },
    { key: 'mercury', cn: '水星', glyph: '☿', body: 'Mercury' },
    { key: 'venus', cn: '金星', glyph: '♀', body: 'Venus' },
    { key: 'mars', cn: '火星', glyph: '♂', body: 'Mars' },
    { key: 'jupiter', cn: '木星', glyph: '♃', body: 'Jupiter' },
    { key: 'saturn', cn: '土星', glyph: '♄', body: 'Saturn' },
    { key: 'uranus', cn: '天王星', glyph: '♅', body: 'Uranus' },
    { key: 'neptune', cn: '海王星', glyph: '♆', body: 'Neptune' },
    { key: 'pluto', cn: '冥王星', glyph: '♇', body: 'Pluto' }
  ];

  // 托勒密相位（主相位）— 采用传统命名：合 / 六合 / 刑克 / 拱 / 对冲
  var ASPECTS = [
    { key: 'conjunction', cn: '合相', glyph: '☌', angle: 0 },
    { key: 'sextile', cn: '六合', glyph: '⚹', angle: 60 },
    { key: 'square', cn: '刑克', glyph: '□', angle: 90 },
    { key: 'trine', cn: '拱相位', glyph: '△', angle: 120 },
    { key: 'opposition', cn: '对冲', glyph: '☍', angle: 180 }
  ];

  // 默认容许度（orb）。日月参与时适当放宽，尽量完整列出成立的相位。
  var DEFAULT_ORBS = { conjunction: 10, sextile: 6, square: 8, trine: 9, opposition: 10 };
  var LUMINARY_BONUS = 2; // 太阳/月亮参与时额外放宽

  function norm360(x) { x = x % 360; return x < 0 ? x + 360 : x; }
  function norm180(x) { x = norm360(x); return x > 180 ? x - 360 : x; } // -> (-180,180]

  // 黄经 -> {sign(0..11), deg(0..29), min, sec, text}
  function toSign(lon) {
    lon = norm360(lon);
    var s = Math.floor(lon / 30);
    var within = lon - s * 30;
    var deg = Math.floor(within);
    var mfloat = (within - deg) * 60;
    var min = Math.floor(mfloat);
    var sec = Math.round((mfloat - min) * 60);
    if (sec === 60) { sec = 0; min += 1; }
    if (min === 60) { min = 0; deg += 1; }
    return {
      sign: s, signCn: SIGNS[s], signEn: SIGNS_EN[s], glyph: SIGN_GLYPH[s],
      deg: deg, min: min, sec: sec, lon: lon,
      text: SIGNS[s] + ' ' + deg + '°' + pad2(min) + "'" + pad2(sec) + '"'
    };
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // 把「度」格式化为 d°mm'ss"
  function fmtDeg(x) {
    var sign = x < 0 ? '-' : '';
    x = Math.abs(x);
    var d = Math.floor(x);
    var mf = (x - d) * 60;
    var m = Math.floor(mf);
    var s = Math.round((mf - m) * 60);
    if (s === 60) { s = 0; m += 1; }
    if (m === 60) { m = 0; d += 1; }
    return sign + d + '°' + pad2(m) + "'" + pad2(s) + '"';
  }

  // 生成 UTC Date：本地时间 + 时区偏移(小时，东区为正)
  function toUTCDate(y, mo, d, h, mi, s, tzHours) {
    var ms = Date.UTC(y, mo - 1, d, h, mi, s || 0);
    return new Date(ms - tzHours * 3600 * 1000);
  }

  // 当日真黄赤交角(度)
  function trueObliquity(date) {
    return Astronomy.e_tilt(Astronomy.MakeTime(date)).tobl;
  }

  // 某天体地心黄经(度, ECT 当日真黄道)
  function eclipticLon(bodyName, date) {
    if (bodyName === 'Moon') {
      return norm360(Astronomy.EclipticGeoMoon(date).lon);
    }
    var gv = Astronomy.GeoVector(Astronomy.Body[bodyName], date, true);
    var ecl = Astronomy.Ecliptic(gv);
    return norm360(ecl.elon);
  }

  // 黄经日速度(度/日)，中心差分
  function lonSpeed(bodyName, date) {
    var h = 0.02; // 日
    var d1 = new Date(date.getTime() - h * 86400000);
    var d2 = new Date(date.getTime() + h * 86400000);
    var l1 = eclipticLon(bodyName, d1);
    var l2 = eclipticLon(bodyName, d2);
    var diff = norm180(l2 - l1);
    return diff / (2 * h);
  }

  // 月球平交点（Mean Lunar Node）北交点黄经（度，tropical）
  // 公式：Meeus，Ω = 125.04452 − 1934.136261·T + 0.0020708·T² + T³/450000
  function meanLunarNode(date) {
    var T = Astronomy.MakeTime(date).tt / 36525; // 儒略世纪（TT，自 J2000）
    var om = 125.04452 - 1934.136261 * T + 0.0020708 * T * T + (T * T * T) / 450000;
    return norm360(om);
  }

  // 四轴：ASC / MC / DES / IC
  function computeAxes(date, latDeg, lonEastDeg) {
    var gast = Astronomy.SiderealTime(date); // 小时
    var ramc = norm360(gast * 15 + lonEastDeg); // 度
    var eps = trueObliquity(date);
    var ramcR = ramc * D2R, epsR = eps * D2R, phiR = latDeg * D2R;

    // MC 黄经
    var mc = norm360(Math.atan2(Math.sin(ramcR), Math.cos(ramcR) * Math.cos(epsR)) * R2D);
    // ASC 黄经
    var asc = norm360(Math.atan2(
      Math.cos(ramcR),
      -(Math.sin(ramcR) * Math.cos(epsR) + Math.tan(phiR) * Math.sin(epsR))
    ) * R2D);
    // 分支修正：ASC 应在 MC 逆时针方向 0~180 之间
    if (norm360(asc - mc) > 180) asc = norm360(asc + 180);

    return {
      ramc: ramc, eps: eps,
      asc: asc, mc: mc, des: norm360(asc + 180), ic: norm360(mc + 180)
    };
  }

  // Placidus 中间宫位（11,12,2,3），半弧迭代法；返回 12 宫头黄经
  function placidusCusps(ramcDeg, epsDeg, latDeg, ascLon, mcLon) {
    var epsR = epsDeg * D2R, phi = latDeg * D2R;
    var ramcD = norm360(ramcDeg); // 度

    // 由赤经(度)求黄经(度)
    function raToLon(alphaDeg) {
      var aR = alphaDeg * D2R;
      return norm360(Math.atan2(Math.sin(aR), Math.cos(aR) * Math.cos(epsR)) * R2D);
    }

    // 迭代求宫头黄经：house ∈ {11,12,2,3}
    // 条件（以 MC 上中天为 HA=0，向东为负）：
    //   c11: α = RAMC + (1/3)(90+AD)
    //   c12: α = RAMC + (2/3)(90+AD)
    //   c2 : α = RAMC + (90+AD) + (1/3)(90-AD)
    //   c3 : α = RAMC + (90+AD) + (2/3)(90-AD)
    function cuspRA(house) {
      var alpha = ramcD + (house === 11 ? 30 : house === 12 ? 60 : house === 2 ? 120 : 150);
      for (var i = 0; i < 80; i++) {
        var lonR = raToLon(alpha) * D2R;
        var decl = Math.asin(Math.sin(epsR) * Math.sin(lonR));
        var t = Math.tan(decl) * Math.tan(phi);
        if (t > 1) t = 1; if (t < -1) t = -1;
        var AD = Math.asin(t) * R2D; // 上升差(度)
        var alphaNew;
        if (house === 11) alphaNew = ramcD + (1 / 3) * (90 + AD);
        else if (house === 12) alphaNew = ramcD + (2 / 3) * (90 + AD);
        else if (house === 2) alphaNew = ramcD + (90 + AD) + (1 / 3) * (90 - AD);
        else alphaNew = ramcD + (90 + AD) + (2 / 3) * (90 - AD);
        if (Math.abs(alphaNew - alpha) < 1e-9) { alpha = alphaNew; break; }
        alpha = alphaNew;
      }
      return raToLon(alpha);
    }

    var c = {};
    c[10] = mcLon;
    c[1] = ascLon;
    c[11] = cuspRA(11);
    c[12] = cuspRA(12);
    c[2] = cuspRA(2);
    c[3] = cuspRA(3);
    c[4] = norm360(mcLon + 180);
    c[5] = norm360(c[11] + 180);
    c[6] = norm360(c[12] + 180);
    c[7] = norm360(ascLon + 180);
    c[8] = norm360(c[2] + 180);
    c[9] = norm360(c[3] + 180);
    var arr = [];
    for (var h = 1; h <= 12; h++) arr.push(c[h]);
    return arr;
  }

  // 判断某黄经落在第几宫
  function houseOf(lon, cusps) {
    lon = norm360(lon);
    for (var i = 0; i < 12; i++) {
      var a = cusps[i], b = cusps[(i + 1) % 12];
      var span = norm360(b - a);
      var off = norm360(lon - a);
      if (off < span) return i + 1;
    }
    return 1;
  }

  // 出/入相位判定
  function applyingStatus(lonA, spdA, lonB, spdB, exactAngle) {
    var dt = 0.02;
    function orbDist(a, b) { return Math.abs(Math.abs(norm180(a - b)) - exactAngle); }
    var cur = orbDist(lonA, lonB);
    var fut = orbDist(lonA + spdA * dt, lonB + spdB * dt);
    return fut < cur ? 'applying' : 'separating';
  }

  // 计算相位表
  function computeAspects(planets) {
    var list = [];
    for (var i = 0; i < planets.length; i++) {
      for (var j = i + 1; j < planets.length; j++) {
        var A = planets[i], B = planets[j];
        var sep = Math.abs(norm180(A.lon - B.lon)); // 0..180
        // 取该对行星最贴近的成立相位（不遗漏任何在容许度内的相位）
        var best = null;
        for (var k = 0; k < ASPECTS.length; k++) {
          var asp = ASPECTS[k];
          var orbAllow = DEFAULT_ORBS[asp.key];
          if (A.key === 'sun' || A.key === 'moon' || B.key === 'sun' || B.key === 'moon') {
            orbAllow += LUMINARY_BONUS;
          }
          var orb = Math.abs(sep - asp.angle);
          if (orb <= orbAllow && (!best || orb < best.orb)) {
            best = { aspect: asp, orb: orb };
          }
        }
        if (best) {
          var status = applyingStatus(A.lon, A.speed, B.lon, B.speed, best.aspect.angle);
          list.push({
            a: A, b: B, aspect: best.aspect, orb: best.orb, sep: sep,
            status: status, // applying / separating
            exact: best.orb < 0.0167 // 1' 内视为精确
          });
        }
      }
    }
    list.sort(function (x, y) { return x.orb - y.orb; });
    return list;
  }

  // ===== 完整传统尊贵体系（Essential Dignities）数据表 =====
  // 星座庙主（Domicile / Rulership），index = 星座 0..11
  var RULERS = ['mars', 'venus', 'mercury', 'moon', 'sun', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'saturn', 'jupiter'];
  // 曜升/旺（Exaltation），index = 星座；null 表示该星座无旺主
  var EXALT_SIGN = ['sun', 'moon', null, 'jupiter', null, 'mercury', 'saturn', null, null, 'mars', null, 'venus'];
  // 三分主（Triplicity，Lilly/托勒密两分制），index = 元素 (sign % 4)：0火 1土 2风 3水
  var TRIPLICITY = [
    { day: 'sun', night: 'jupiter' },     // 火：白羊/狮子/射手
    { day: 'venus', night: 'moon' },      // 土：金牛/处女/摩羯
    { day: 'saturn', night: 'mercury' },  // 风：双子/天秤/水瓶
    { day: 'mars', night: 'mars' }        // 水：巨蟹/天蝎/双鱼
  ];
  // 界主（Egyptian Terms/Bounds）：每星座 5 段 [行星, 结束度数]
  var TERMS = [
    [['jupiter', 6], ['venus', 12], ['mercury', 20], ['mars', 25], ['saturn', 30]],       // 白羊
    [['venus', 8], ['mercury', 14], ['jupiter', 22], ['saturn', 27], ['mars', 30]],        // 金牛
    [['mercury', 6], ['jupiter', 12], ['venus', 17], ['mars', 24], ['saturn', 30]],        // 双子
    [['mars', 7], ['venus', 13], ['mercury', 19], ['jupiter', 26], ['saturn', 30]],        // 巨蟹
    [['jupiter', 6], ['venus', 11], ['saturn', 18], ['mercury', 24], ['mars', 30]],        // 狮子
    [['mercury', 7], ['venus', 17], ['jupiter', 21], ['mars', 28], ['saturn', 30]],        // 处女
    [['saturn', 6], ['mercury', 14], ['jupiter', 21], ['venus', 28], ['mars', 30]],        // 天秤
    [['mars', 7], ['venus', 11], ['mercury', 19], ['jupiter', 24], ['saturn', 30]],        // 天蝎
    [['jupiter', 12], ['venus', 17], ['mercury', 21], ['saturn', 26], ['mars', 30]],       // 射手
    [['mercury', 7], ['jupiter', 14], ['venus', 22], ['saturn', 26], ['mars', 30]],        // 摩羯
    [['mercury', 7], ['venus', 13], ['jupiter', 20], ['mars', 26], ['saturn', 30]],        // 水瓶
    [['venus', 12], ['jupiter', 16], ['mercury', 19], ['mars', 28], ['saturn', 30]]        // 双鱼
  ];
  // 面主（Faces/Decans，迦勒底次序，自白羊一面=火星起），36 面循环
  var FACE_SEQ = ['mars', 'sun', 'venus', 'mercury', 'moon', 'saturn', 'jupiter'];

  // 七颗古典行星（享有传统尊贵体系）
  var CLASSICAL = { sun: 1, moon: 1, mercury: 1, venus: 1, mars: 1, jupiter: 1, saturn: 1 };
  var LUMINARY = { sun: 1, moon: 1 };
  var DIGNITY_LABEL = { domicile: '庙', exalt: '旺', triplicity: '三分', term: '界', face: '面' };

  function termRulerOf(sign, deg) {
    var t = TERMS[sign];
    for (var i = 0; i < t.length; i++) { if (deg < t[i][1]) return t[i][0]; }
    return t[t.length - 1][0];
  }
  function faceRulerOf(sign, deg) {
    var idx = sign * 3 + Math.floor(deg / 10);
    return FACE_SEQ[idx % 7];
  }

  // 特能：计算每颗行星的传统尊贵状态 + 互容/互溶 + 焦伤/日光/核心 + 东出西入 + 逆行
  function computeDignities(planets) {
    var byName = {};
    planets.forEach(function (p) { byName[p.key] = p; });
    var sun = byName['sun'];
    // 昼夜盘（sect）：太阳在地平线上（第 7~12 宫）为日间盘
    var dayChart = !!(sun && sun.house >= 7 && sun.house <= 12);

    var out = planets.map(function (p) {
      var s = p.pos.sign;
      var deg = norm360(p.lon) - s * 30; // 星座内度数 0..30
      var item = {
        key: p.key, cn: p.cn, glyph: p.glyph, signCn: SIGNS[s],
        classical: !!CLASSICAL[p.key],
        retro: p.retro,
        dignities: [], debilities: [], score: 0, peregrine: false,
        rulers: null, sunPhase: null, orient: null
      };

      // 焦伤 / 日光束下 / 核心（相对太阳的黄经距）
      if (p.key !== 'sun' && sun) {
        var dsun = Math.abs(norm180(p.lon - sun.lon));
        if (dsun <= 0.2833) item.sunPhase = '核心 (Cazimi)';          // 17′ 内
        else if (dsun <= 8.5) item.sunPhase = '焦伤 (Combust)';        // 8°30′ 内
        else if (dsun <= 15) item.sunPhase = '日光束下 (Under Beams)'; // 15° 内
      }
      // 东出（晨星）/ 西入（昏星）：非日月
      if (!LUMINARY[p.key] && sun) {
        var rel = norm180(p.lon - sun.lon);
        item.orient = rel < 0 ? '东出（晨星）' : '西入（昏星）';
      }

      if (item.classical) {
        var dom = RULERS[s], exa = EXALT_SIGN[s];
        var det = RULERS[(s + 6) % 12], fal = EXALT_SIGN[(s + 6) % 12];
        var tri = TRIPLICITY[s % 4];
        var triR = dayChart ? tri.day : tri.night;
        var termR = termRulerOf(s, deg);
        var faceR = faceRulerOf(s, deg);
        item.rulers = { domicile: dom, exalt: exa, triplicity: triR, term: termR, face: faceR };

        if (dom === p.key) { item.dignities.push('入庙 (Domicile) +5'); item.score += 5; }
        if (exa === p.key) { item.dignities.push('曜升/旺 (Exaltation) +4'); item.score += 4; }
        if (triR === p.key) { item.dignities.push('三分主 (Triplicity) +3'); item.score += 3; }
        if (termR === p.key) { item.dignities.push('界主 (Term) +2'); item.score += 2; }
        if (faceR === p.key) { item.dignities.push('面主 (Face) +1'); item.score += 1; }
        if (det === p.key) { item.debilities.push('落陷 (Detriment) −5'); item.score -= 5; }
        if (fal === p.key) { item.debilities.push('落弱 (Fall) −4'); item.score -= 4; }

        if (!item.dignities.length && !item.debilities.length) {
          item.peregrine = true; item.score -= 5; // 外来/无根 Peregrine
        }
      }
      return item;
    });

    // ===== 容纳 / 接收（Reception）=====
    var cls = out.filter(function (x) { return x.classical; });
    var byKey = {};
    cls.forEach(function (x) { byKey[x.key] = x; });
    var ORDER = ['domicile', 'exalt', 'triplicity', 'term', 'face'];

    // 每颗古典行星「被谁容纳」：它落在哪些行星的尊贵位置上
    cls.forEach(function (A) {
      var map = {}; // rulerKey -> [尊贵类型]
      ORDER.forEach(function (t) {
        var r = A.rulers[t];
        if (r && r !== A.key && byKey[r]) { (map[r] = map[r] || []).push(t); }
      });
      A.receivedBy = Object.keys(map).map(function (rk) {
        return { by: rk, types: map[rk] };
      });
    });

    // 单向接收 + 互容 / 互溶
    var oneWay = [];
    var mutual = [];
    var mutualSeen = {};
    function labels(types) { return types.map(function (t) { return DIGNITY_LABEL[t]; }); }
    function hasStrong(types) { return types.indexOf('domicile') >= 0 || types.indexOf('exalt') >= 0; }

    cls.forEach(function (A) {
      A.receivedBy.forEach(function (rec) {
        var B = byKey[rec.by];
        oneWay.push({
          fromCn: A.cn, fromGlyph: A.glyph,
          byCn: B.cn, byGlyph: B.glyph,
          types: labels(rec.types),
          detail: A.cn + ' 被 ' + B.cn + ' 接纳（' + labels(rec.types).join('+') + '）'
        });
        // 反向是否也成立 -> 互容 / 互溶
        var back = (B.receivedBy || []).filter(function (r2) { return r2.by === A.key; })[0];
        if (back) {
          var id = [A.key, B.key].sort().join('|');
          if (!mutualSeen[id]) {
            mutualSeen[id] = 1;
            var major = hasStrong(rec.types) && hasStrong(back.types);
            mutual.push({
              a: A.cn, b: B.cn,
              kind: major ? '互容' : '互溶',
              detail: A.cn + '（' + A.signCn + '·' + B.cn + '之' + labels(rec.types).join('+') + '）⇄ ' +
                B.cn + '（' + B.signCn + '·' + A.cn + '之' + labels(back.types).join('+') + '）'
            });
          }
        }
      });
    });

    // 行星特殊状态：焦伤 / 核心 / 日光束下 / 逆行 / 东出西入
    var specials = [];
    out.forEach(function (it) {
      var tags = [];
      if (it.sunPhase) tags.push(it.sunPhase);
      if (it.retro) tags.push('逆行 Rx');
      if (it.orient) tags.push(it.orient);
      if (tags.length) specials.push({ cn: it.cn, glyph: it.glyph, tags: tags });
    });

    return {
      sect: dayChart ? '日间盘 (Day)' : '夜间盘 (Night)',
      planets: out,
      mutual: mutual,
      oneWay: oneWay,
      specials: specials
    };
  }

  // 主入口：计算完整星盘
  function computeChart(input) {
    // input: {name, year, month, day, hour, minute, second, tzHours, lat, lon, houseSystem}
    var date = toUTCDate(input.year, input.month, input.day, input.hour, input.minute, input.second || 0, input.tzHours);

    var axes = computeAxes(date, input.lat, input.lon);
    var cusps = placidusCusps(axes.ramc, axes.eps, input.lat, axes.asc, axes.mc);

    var planets = BODIES.map(function (b) {
      var lon = eclipticLon(b.body, date);
      var speed = lonSpeed(b.body, date);
      return {
        key: b.key, cn: b.cn, glyph: b.glyph, body: b.body,
        lon: lon, speed: speed,
        retro: (b.body !== 'Sun' && b.body !== 'Moon') && speed < 0,
        pos: toSign(lon),
        house: houseOf(lon, cusps)
      };
    });

    var aspects = computeAspects(planets);
    var dignities = computeDignities(planets);

    // 月交点（平交点）：北交点 ☊ / 南交点 ☋
    var northLon = meanLunarNode(date);
    var southLon = norm360(northLon + 180);
    var nodes = {
      north: { glyph: '☊', cn: '北交点', lon: northLon, pos: toSign(northLon), house: houseOf(northLon, cusps) },
      south: { glyph: '☋', cn: '南交点', lon: southLon, pos: toSign(southLon), house: houseOf(southLon, cusps) }
    };

    return {
      input: input,
      utc: date,
      axes: {
        asc: toSign(axes.asc), mc: toSign(axes.mc),
        des: toSign(axes.des), ic: toSign(axes.ic),
        ascLon: axes.asc, mcLon: axes.mc, desLon: axes.des, icLon: axes.ic,
        obliquity: axes.eps, ramc: axes.ramc
      },
      cusps: cusps.map(toSign),
      cuspsLon: cusps,
      planets: planets,
      aspects: aspects,
      dignities: dignities,
      nodes: nodes
    };
  }

  var AstroEngine = {
    computeChart: computeChart,
    toSign: toSign,
    fmtDeg: fmtDeg,
    norm360: norm360,
    norm180: norm180,
    SIGNS: SIGNS, SIGNS_EN: SIGNS_EN, SIGN_GLYPH: SIGN_GLYPH,
    BODIES: BODIES, ASPECTS: ASPECTS
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = AstroEngine;
  root.AstroEngine = AstroEngine;

})(typeof window !== 'undefined' ? window : globalThis);
