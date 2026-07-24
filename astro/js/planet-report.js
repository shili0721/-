/*
 * planet-report.js — 本命盘「行星状态报告」生成器
 * 依赖：AstroEngine（astro-engine.js）+ 全局 Astronomy（astronomy.browser.js）
 *
 * 报告维度对齐职业分析报告实际用到的行星内容：
 *   四轴(ASC/MC/DSC/IC) · 命主星(上升守护) · 行星落座/度数/宫位 ·
 *   逆行 · 尊贵状态(庙旺陷弱/三分/界/面/外来) · 昼夜得时(in/out of sect) ·
 *   临界度数(29°岐度 / 紧要度数) · 焦伤/核心/日光束下 · 互容/接纳 · 与月交点合相
 *
 * 分宫制：默认阿卡比特制(Alcabitius，宫神星默认)，可选 Placidus。
 */
(function () {
  'use strict';

  var D2R = Math.PI / 180, R2D = 180 / Math.PI;
  function norm360(x) { x = x % 360; return x < 0 ? x + 360 : x; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // 星座守护（庙主），index = 星座 0..11
  var RULERS = ['mars', 'venus', 'mercury', 'moon', 'sun', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'saturn', 'jupiter'];
  var SIGNS = ['白羊', '金牛', '双子', '巨蟹', '狮子', '处女', '天秤', '天蝎', '射手', '摩羯', '水瓶', '双鱼'];
  var KEY_CN = { sun: '太阳', moon: '月亮', mercury: '水星', venus: '金星', mars: '火星', jupiter: '木星', saturn: '土星', uranus: '天王星', neptune: '海王星', pluto: '冥王星' };
  var KEY_GLYPH = { sun: '☉', moon: '☽', mercury: '☿', venus: '♀', mars: '♂', jupiter: '♃', saturn: '♄', uranus: '♅', neptune: '♆', pluto: '♇' };

  // 昼夜派系
  var DIURNAL = { sun: 1, jupiter: 1, saturn: 1 };
  var NOCTURNAL = { moon: 1, venus: 1, mars: 1 };

  // ===== 阿卡比特制宫头（半弧三分法，以赤经等分上升点的昼/夜半弧）=====
  function alcabitiusCusps(ramcDeg, epsDeg, latDeg, ascLon, mcLon) {
    var epsR = epsDeg * D2R, phiR = latDeg * D2R;
    var ramc = norm360(ramcDeg);

    // 上升点黄经 -> 赤纬
    var ascR = ascLon * D2R;
    var decAsc = Math.asin(Math.sin(epsR) * Math.sin(ascR));
    // 上升差 AD
    var t = Math.tan(phiR) * Math.tan(decAsc);
    if (t > 1) t = 1; if (t < -1) t = -1;
    var AD = Math.asin(t) * R2D;
    var SDA = 90 + AD; // 上升点半昼弧（赤经度）
    var SNA = 90 - AD; // 上升点半夜弧

    // 由某赤经(度)求其在黄道上的交点黄经(度)
    function lonFromRA(ra) {
      var raR = norm360(ra) * D2R;
      var lon = Math.atan2(Math.sin(raR), Math.cos(raR) * Math.cos(epsR)) * R2D;
      return norm360(lon);
    }

    var c = {};
    c[10] = norm360(mcLon);
    c[11] = lonFromRA(ramc + SDA / 3);
    c[12] = lonFromRA(ramc + 2 * SDA / 3);
    c[1] = norm360(ascLon);
    c[2] = lonFromRA(ramc + SDA + SNA / 3);
    c[3] = lonFromRA(ramc + SDA + 2 * SNA / 3);
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

  // ===== 临界度数 =====
  // 岐度(anaretic)：29°；紧要度数(critical degrees)：按三态
  function criticalTags(sign, degWithin) {
    var tags = [];
    var d = Math.floor(degWithin);
    if (d === 29) tags.push('29° 岐度 (anaretic)');
    var modality = sign % 3; // 0 启动 / 1 固定 / 2 变动
    var crit = modality === 0 ? [0, 13, 26] : modality === 1 ? [8, 9, 21, 22] : [4, 17];
    if (crit.indexOf(d) >= 0) {
      var mn = modality === 0 ? '启动' : modality === 1 ? '固定' : '变动';
      tags.push('紧要度数 (' + mn + '星座)');
    }
    return tags;
  }

  // ===== in / out of sect =====
  function sectStatus(key, dayChart, orient) {
    if (key === 'sun') return { label: dayChart ? '昼主星·得时' : '昼主星', ok: dayChart };
    if (key === 'moon') return { label: dayChart ? '夜主星' : '夜主星·得时', ok: !dayChart };
    if (DIURNAL[key]) return dayChart ? { label: '得时 (in sect)', ok: true } : { label: '失时 (out of sect)', ok: false };
    if (NOCTURNAL[key]) return !dayChart ? { label: '得时 (in sect)', ok: true } : { label: '失时 (out of sect)', ok: false };
    if (key === 'mercury') {
      // 水星：晨星(东出)偏昼、昏星(西入)偏夜
      var oriental = orient && orient.indexOf('东出') >= 0;
      var ok = (dayChart && oriental) || (!dayChart && !oriental);
      return { label: ok ? '得时 (in sect)' : '失时 (out of sect)', ok: ok };
    }
    return null;
  }

  function degWithin(lon) { return norm360(lon) - Math.floor(norm360(lon) / 30) * 30; }
  function fmtWithin(lon) {
    var w = degWithin(lon);
    var d = Math.floor(w);
    var m = Math.round((w - d) * 60);
    if (m === 60) { m = 0; d += 1; }
    return d + '°' + pad2(m) + "'";
  }

  // ===== 生成报告数据 =====
  function build(input) {
    var chart = window.AstroEngine.computeChart(input);

    // 分宫制
    var cuspsLon;
    if (input.houseSystem === 'Alcabitius') {
      cuspsLon = alcabitiusCusps(chart.axes.ramc, chart.axes.obliquity, input.lat, chart.axes.ascLon, chart.axes.mcLon);
    } else {
      cuspsLon = chart.cuspsLon;
    }
    // 用选定分宫制重算落宫
    chart.planets.forEach(function (p) { p.house = houseOf(p.lon, cuspsLon); });
    chart.nodes.north.house = houseOf(chart.nodes.north.lon, cuspsLon);
    chart.nodes.south.house = houseOf(chart.nodes.south.lon, cuspsLon);

    var dig = chart.dignities;
    var dayChart = dig.sect.indexOf('日间') >= 0;

    // 命主星
    var ascSign = chart.axes.asc.sign;
    var rulerKey = RULERS[ascSign];

    // 每颗行星的 dignities 数据按 key 索引
    var digByKey = {};
    dig.planets.forEach(function (x) { digByKey[x.key] = x; });

    // 与月交点合相（黄经 8° 内）
    var nodeHits = [];
    chart.planets.forEach(function (p) {
      [chart.nodes.north, chart.nodes.south].forEach(function (nd) {
        var sep = Math.abs(((p.lon - nd.lon + 540) % 360) - 180);
        if (sep <= 8) nodeHits.push({ p: p.cn, glyph: p.glyph, node: nd.cn, nodeGlyph: nd.glyph, orb: sep });
      });
    });

    // 组装每颗行星卡片数据
    var cards = chart.planets.map(function (p) {
      var dd = digByKey[p.key] || {};
      var tags = { dig: [], deb: [], other: [], crit: [], recep: [] };

      (dd.dignities || []).forEach(function (s) { tags.dig.push(s); });
      (dd.debilities || []).forEach(function (s) { tags.deb.push(s); });
      if (dd.peregrine) tags.deb.push('外来/无根 (Peregrine)');

      if (p.retro) tags.other.push({ t: 'retro', s: '逆行 Rx' });
      if (dd.sunPhase) tags.other.push({ t: dd.sunPhase.indexOf('核心') >= 0 ? 'dig' : 'deb', s: dd.sunPhase });

      // in/out of sect（仅古典七星）
      var sect = null;
      if (dd.classical) {
        sect = sectStatus(p.key, dayChart, dd.orient);
      }

      // 临界度数
      var crit = criticalTags(p.pos.sign, degWithin(p.lon));

      // 被接纳/互容（从引擎 oneWay / mutual 提取与本行星相关的）
      var receptions = [];
      dig.mutual.forEach(function (m) {
        if (m.a === p.cn || m.b === p.cn) {
          var other = m.a === p.cn ? m.b : m.a;
          receptions.push(m.kind + '：与' + other);
        }
      });
      dig.oneWay.forEach(function (o) {
        if (o.fromCn === p.cn) receptions.push('被' + o.byCn + '接纳(' + o.types.join('+') + ')');
      });

      return {
        key: p.key, cn: p.cn, glyph: p.glyph,
        signCn: p.pos.signCn, within: fmtWithin(p.lon), house: p.house,
        retro: p.retro, isRuler: p.key === rulerKey,
        tags: tags, sect: sect, crit: crit, receptions: receptions,
        score: dd.score, orient: dd.orient
      };
    });

    return {
      chart: chart, input: input,
      houseSystem: input.houseSystem,
      dayChart: dayChart, sectText: dig.sect,
      ascSign: SIGNS[ascSign], rulerKey: rulerKey,
      rulerCard: cards.filter(function (c) { return c.key === rulerKey; })[0],
      cards: cards, mutual: dig.mutual, oneWay: dig.oneWay, nodeHits: nodeHits
    };
  }

  // ===== 渲染 =====
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

  // 汇总单颗行星的所有状态标签（纯文字用）
  function collectLabels(c) {
    var labels = [];
    c.tags.dig.forEach(function (x) { labels.push(x); });
    c.tags.deb.forEach(function (x) { labels.push(x); });
    c.tags.other.forEach(function (o) { labels.push(o.s); });
    if (c.sect) labels.push(c.sect.label);
    c.crit.forEach(function (x) { labels.push(x); });
    if (c.orient) labels.push(c.orient);
    c.receptions.forEach(function (x) { labels.push(x); });
    return labels;
  }

  // ===== 生成纯文字版报告（可直接复制）=====
  function buildPlainText(data) {
    var ax = data.chart.axes;
    var name = data.input.name || '本命盘';
    var L = [];
    var line = '────────────────────────────';

    L.push('【' + name + ' · 本命盘行星状态报告】');
    L.push('分宫制：' + data.houseSystem + '　|　' + data.sectText);
    if (data.input.year) {
      L.push('出生：' + data.input.year + '-' + pad2(data.input.month) + '-' + pad2(data.input.day) +
        ' ' + pad2(data.input.hour) + ':' + pad2(data.input.minute) +
        '　GMT' + (data.input.tzHours >= 0 ? '+' : '') + data.input.tzHours);
    }
    if (data.input.lon != null && data.input.lat != null) {
      L.push('地点：' + (data.input.place ? data.input.place + '　' : '') +
        '经 ' + data.input.lon + '　纬 ' + data.input.lat);
    }
    L.push('');

    L.push('■ 四轴');
    L.push('上升 ASC：' + ax.asc.signCn + ' ' + fmtWithin(ax.ascLon));
    L.push('天顶 MC ：' + ax.mc.signCn + ' ' + fmtWithin(ax.mcLon));
    L.push('下降 DSC：' + ax.des.signCn + ' ' + fmtWithin(ax.desLon));
    L.push('天底 IC ：' + ax.ic.signCn + ' ' + fmtWithin(ax.icLon));
    L.push('');

    var rc = data.rulerCard;
    if (rc) {
      L.push('■ 命主星（上升守护）');
      L.push(rc.glyph + ' ' + rc.cn + '（' + data.ascSign + '座守护）落 ' +
        rc.signCn + ' ' + rc.within + '，第 ' + rc.house + ' 宫' +
        (rc.sect ? '，' + rc.sect.label : ''));
      var rl = collectLabels(rc);
      if (rl.length) L.push('　状态：' + rl.join('、'));
      L.push('');
    }

    L.push('■ 十大行星状态');
    L.push(line);
    data.cards.forEach(function (c) {
      var head = c.glyph + ' ' + c.cn + (c.isRuler ? '（命主星）' : '') +
        '　' + c.signCn + ' ' + c.within +
        '　第 ' + c.house + ' 宫' +
        (typeof c.score === 'number' ? '　尊贵分 ' + (c.score > 0 ? '+' : '') + c.score : '');
      L.push(head);
      var labels = collectLabels(c);
      if (labels.length) L.push('　状态：' + labels.join('、'));
      L.push(line);
    });
    L.push('');

    if (data.mutual.length || data.oneWay.length) {
      L.push('■ 互容 / 接纳结构');
      data.mutual.forEach(function (m) { L.push('· 【' + m.kind + '】' + m.detail); });
      var shown = {};
      data.oneWay.forEach(function (o) {
        var id = o.fromCn + '>' + o.byCn;
        if (shown[id]) return; shown[id] = 1;
        L.push('· ' + o.fromCn + ' 被 ' + o.byCn + ' 接纳（' + o.types.join('+') + '）');
      });
      L.push('');
    }

    if (data.nodeHits.length) {
      L.push('■ 与月交点合相');
      data.nodeHits.forEach(function (n) {
        L.push('· ' + n.p + ' 合 ' + n.node + '（容许 ' + n.orb.toFixed(1) + '°）');
      });
      L.push('');
    }

    L.push('———— 回归黄道 / ' + data.houseSystem + ' · 与宫神星排盘一致 ————');
    return L.join('\n');
  }

  function render(data) {
    var ax = data.chart.axes;
    var name = data.input.name || '本命盘';
    var h = '';

    // 概览
    h += '<div class="toolbar"><h2 style="margin:0">' + esc(name) + ' · 行星状态</h2>' +
      '<span class="small">' + esc(data.houseSystem) + ' · ' + esc(data.sectText) + '</span></div>';

    h += '<div class="sumgrid">' +
      stat('上升 ASC', ax.asc.signCn + ' ' + fmtWithin(ax.ascLon)) +
      stat('天顶 MC', ax.mc.signCn + ' ' + fmtWithin(ax.mcLon)) +
      stat('下降 DSC', ax.des.signCn + ' ' + fmtWithin(ax.desLon)) +
      stat('天底 IC', ax.ic.signCn + ' ' + fmtWithin(ax.icLon)) +
      '</div>';

    // 命主星
    var rc = data.rulerCard;
    if (rc) {
      h += '<div class="block"><h3>命主星（上升守护）</h3>' +
        '<div class="rowline"><span><b>' + rc.glyph + ' ' + rc.cn + '</b>（' + data.ascSign + '座守护）</span>' +
        '<span>落 <b>' + rc.signCn + ' ' + rc.within + '</b></span>' +
        '<span>第 <b>' + rc.house + '</b> 宫</span>' +
        (rc.sect ? '<span>' + rc.sect.label + '</span>' : '') +
        '</div>' +
        '<div class="small" style="margin-top:6px">命主星代表命主的核心能量与生命动力指向，其落座/落宫是全盘的"发动机"方向。</div>' +
        '</div>';
    }

    // 行星卡片
    h += '<div class="pcards">';
    data.cards.forEach(function (c) { h += planetCard(c); });
    h += '</div>';

    // 互容 / 接纳
    if (data.mutual.length || data.oneWay.length) {
      h += '<div class="block"><h3>互容 / 接纳结构</h3><ul class="recl">';
      data.mutual.forEach(function (m) {
        h += '<li><b>' + m.kind + '</b>：' + esc(m.detail) + '</li>';
      });
      // 单向接纳去重（不含已在互容中的）
      var shown = {};
      data.oneWay.forEach(function (o) {
        var id = o.fromCn + '>' + o.byCn;
        if (shown[id]) return; shown[id] = 1;
        h += '<li>' + esc(o.fromCn) + ' 被 ' + esc(o.byCn) + ' 接纳（' + o.types.join('+') + '）</li>';
      });
      h += '</ul></div>';
    }

    // 与月交点
    if (data.nodeHits.length) {
      h += '<div class="block"><h3>与月交点合相</h3><ul class="recl">';
      data.nodeHits.forEach(function (n) {
        h += '<li>' + n.glyph + ' ' + esc(n.p) + ' 合 ' + n.nodeGlyph + ' ' + esc(n.node) +
          '（容许 ' + n.orb.toFixed(1) + '°）</li>';
      });
      h += '</ul></div>';
    }

    // 纯文字版（可直接复制）
    var plain = buildPlainText(data);
    h += '<div class="block"><div class="toolbar">' +
      '<h3 style="margin:0">纯文字版 · 可直接复制</h3>' +
      '<button id="btnCopy" class="ghost" type="button" style="width:auto;margin:0;padding:7px 18px">复制全文</button>' +
      '</div>' +
      '<textarea id="plainText" readonly ' +
      'style="width:100%;min-height:360px;resize:vertical;border-radius:12px;border:1px solid var(--line);' +
      'background:#0d0f1e;color:#d7dbf2;font-family:ui-monospace,Consolas,\'Courier New\',monospace;' +
      'font-size:13px;line-height:1.7;padding:14px 16px;outline:none;white-space:pre;">' +
      esc(plain) + '</textarea>' +
      '<div class="small" style="margin-top:8px">点击「复制全文」一键复制，或在文本框内手动选择复制。</div>' +
      '</div>';

    return h;
  }

  function stat(k, v) {
    return '<div class="stat"><div class="k">' + k + '</div><div class="v">' + esc(v) + '</div></div>';
  }

  function planetCard(c) {
    var s = '<div class="pcard">';
    if (c.isRuler) s += '<span class="ruler-badge">命主星</span>';
    s += '<div class="head"><span class="glyph">' + c.glyph + '</span>' +
      '<span class="nm">' + c.cn + '</span>' +
      '<span class="pos">' + c.signCn + ' ' + c.within + '</span></div>';
    s += '<div class="house">第 ' + c.house + ' 宫' +
      (typeof c.score === 'number' ? ' · 尊贵分 ' + (c.score > 0 ? '+' : '') + c.score : '') + '</div>';

    s += '<div class="tags">';
    c.tags.dig.forEach(function (t) { s += tag('dig', t); });
    c.tags.deb.forEach(function (t) { s += tag('deb', t); });
    c.tags.other.forEach(function (o) { s += tag(o.t === 'retro' ? 'retro' : o.t, o.s); });
    if (c.sect) s += tag('sect', c.sect.label);
    c.crit.forEach(function (t) { s += tag('crit', t); });
    c.receptions.forEach(function (t) { s += tag('recep', t); });
    if (c.orient) s += tag('', c.orient);
    s += '</div>';
    s += '</div>';
    return s;
  }
  function tag(cls, txt) { return '<span class="tag ' + cls + '">' + esc(txt) + '</span>'; }

  // ===== 交互 =====
  function $(id) { return document.getElementById(id); }

  function readInput() {
    var d = $('date').value, t = $('time').value;
    if (!d) throw new Error('请填写出生日期');
    if (!t) throw new Error('请填写出生时间');
    var lat = parseFloat($('lat').value), lon = parseFloat($('lon').value);
    if (isNaN(lat) || isNaN(lon)) throw new Error('请填写经纬度（十进制）');
    var dp = d.split('-'), tp = t.split(':');
    return {
      name: $('name').value.trim(),
      year: +dp[0], month: +dp[1], day: +dp[2],
      hour: +tp[0], minute: +tp[1], second: +(tp[2] || 0),
      tzHours: parseFloat($('tz').value) || 0,
      lat: lat, lon: lon,
      houseSystem: $('house').value
    };
  }

  function generate() {
    $('err').textContent = '';
    try {
      var input = readInput();
      var data = build(input);
      $('result').innerHTML = render(data);
      $('ph').style.display = 'none';
      $('result').style.display = 'block';
      bindCopy();
    } catch (e) {
      $('err').textContent = '⚠ ' + (e.message || e);
    }
  }

  function bindCopy() {
    var btn = $('btnCopy'), ta = $('plainText');
    if (!btn || !ta) return;
    btn.addEventListener('click', function () {
      var text = ta.value;
      function done() {
        var old = btn.textContent;
        btn.textContent = '✓ 已复制';
        setTimeout(function () { btn.textContent = old; }, 1600);
      }
      function fallback() {
        ta.focus(); ta.select();
        try { document.execCommand('copy'); done(); }
        catch (e) { btn.textContent = '请手动复制'; }
        window.getSelection().removeAllRanges();
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback);
      } else {
        fallback();
      }
    });
  }

  function loadSample() {
    $('name').value = '王昭幻';
    $('date').value = '2006-07-21';
    $('time').value = '23:00';
    $('tz').value = '8';
    $('place').value = '东营市';
    $('lon').value = '118.65';
    $('lat').value = '37.4167';
    $('house').value = 'Alcabitius';
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('btnGen').addEventListener('click', generate);
    $('btnSample').addEventListener('click', function () { loadSample(); generate(); });
  });
})();
