/*
 * report.js — 将 AstroEngine 计算结果格式化为用户要求的文本模板
 */
(function (root) {
  'use strict';

  // d°mm′ 形式（省略秒，四舍五入到分）
  function dm(lon) {
    var s = Math.floor(root.AstroEngine.norm360(lon) / 30);
    var within = root.AstroEngine.norm360(lon) - s * 30;
    var deg = Math.floor(within);
    var min = Math.round((within - deg) * 60);
    if (min === 60) { min = 0; deg += 1; }
    var SIGNS = root.AstroEngine.SIGNS;
    return SIGNS[s] + '座 ' + deg + '°' + (min < 10 ? '0' : '') + min + '′';
  }

  function orbDm(orb) {
    var deg = Math.floor(orb);
    var min = Math.round((orb - deg) * 60);
    if (min === 60) { min = 0; deg += 1; }
    return deg + '°' + (min < 10 ? '0' : '') + min + '′';
  }

  function fmtLat(lat) {
    var dir = lat >= 0 ? '北纬' : '南纬';
    var a = Math.abs(lat), d = Math.floor(a), m = Math.round((a - d) * 60);
    return dir + d + '°' + (m < 10 ? '0' : '') + m + '′';
  }
  function fmtLon(lon) {
    var dir = lon >= 0 ? '东经' : '西经';
    var a = Math.abs(lon), d = Math.floor(a), m = Math.round((a - d) * 60);
    return dir + d + '°' + (m < 10 ? '0' : '') + m + '′';
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  var HOUSE_SYS_CN = {
    Placidus: 'Placidus（普拉西德制 / 四分宫）',
    WholeSign: 'Whole Sign（整宫制）',
    Equal: 'Equal（等宫制）'
  };

  // 生成纯文本报告（严格对应用户模板）
  function toText(chart) {
    var inp = chart.input;
    var L = [];
    L.push('出生信息：');
    L.push('姓名：' + (inp.name || '（未提供）'));
    L.push('日期：' + inp.year + '-' + pad(inp.month) + '-' + pad(inp.day));
    L.push('时间：' + pad(inp.hour) + ':' + pad(inp.minute) + ':' + pad(inp.second || 0) +
      '（时区 GMT' + (inp.tzHours >= 0 ? '+' : '') + inp.tzHours + '）');
    L.push('地点：' + (inp.place || '') + '（' + fmtLon(inp.lon) + '，' + fmtLat(inp.lat) + '）');
    L.push('分宫制：' + (HOUSE_SYS_CN[inp.houseSystem] || inp.houseSystem || 'Placidus'));
    L.push('');
    L.push('四轴：');
    L.push('ASC：' + dm(chart.axes.asc.lon));
    L.push('MC：' + dm(chart.axes.mc.lon));
    L.push('DES：' + dm(chart.axes.des.lon));
    L.push('IC：' + dm(chart.axes.ic.lon));
    L.push('');
    L.push('行星位置（确认是否逆行）：');
    chart.planets.forEach(function (p) {
      L.push(p.cn + '：' + dm(p.lon) + (p.retro ? '（逆行 Rx）' : '') + '  · 第' + p.house + '宫');
    });
    L.push('');
    L.push('托勒密相位（全部列出，含精确度数，出/入相位）：');
    if (!chart.aspects.length) L.push('（无主要相位）');
    chart.aspects.forEach(function (a) {
      L.push(a.a.cn + ' ' + a.aspect.cn + ' ' + a.b.cn +
        '  ' + orbDm(a.orb) + '  ' + (a.status === 'applying' ? '入相位' : '出相位') +
        (a.exact ? '（精确）' : ''));
    });
    L.push('');
    L.push('特能（总结）：');
    var dg = chart.dignities;
    L.push('星盘昼夜：' + dg.sect);
    if (dg.mutual.length) {
      L.push('互容 / 互溶：');
      dg.mutual.forEach(function (r) { L.push('· ' + r.kind + '：' + r.detail); });
    }
    if (dg.oneWay.length) {
      L.push('容纳 / 接收：');
      dg.oneWay.forEach(function (r) { L.push('· ' + r.detail); });
    }
    if (dg.specials.length) {
      L.push('行星特殊状态：');
      dg.specials.forEach(function (s) { L.push('· ' + s.cn + '：' + s.tags.join(' · ')); });
    }
    if (chart.nodes) {
      var nd = chart.nodes;
      L.push('月交点（平交点）：');
      L.push('· ' + nd.north.glyph + ' ' + nd.north.cn + '：' + dm(nd.north.lon) + '  · 第' + nd.north.house + '宫');
      L.push('· ' + nd.south.glyph + ' ' + nd.south.cn + '：' + dm(nd.south.lon) + '  · 第' + nd.south.house + '宫');
    }
    L.push('');
    L.push('行星尊贵状态（完整传统尊贵）：');
    dg.planets.forEach(function (it) {
      var body = [];
      if (!it.classical) {
        body.push('现代行星（不列入传统尊贵体系）');
      } else if (it.peregrine) {
        body.push('无本质尊贵（外来 / 无根 Peregrine）');
      } else {
        if (it.dignities.length) body.push('尊贵：' + it.dignities.join('、'));
        if (it.debilities.length) body.push('无力：' + it.debilities.join('、'));
      }
      var tail = it.classical ? ('  — 总分 ' + (it.score >= 0 ? '+' : '') + it.score) : '';
      L.push('· ' + it.cn + '（' + it.signCn + '座）：' + body.join('；') + tail);
    });
    return L.join('\n');
  }

  root.AstroReport = {
    toText: toText, dm: dm, orbDm: orbDm, fmtLat: fmtLat, fmtLon: fmtLon,
    HOUSE_SYS_CN: HOUSE_SYS_CN
  };

})(typeof window !== 'undefined' ? window : globalThis);
