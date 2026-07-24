/*
 * wheel.js — 用 Canvas 绘制本命盘轮盘（星座环 / 宫位 / 行星 / 相位线）
 */
(function (root) {
  'use strict';

  var SIGN_GLYPH = ['♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓'];
  var ELEM_COLOR = ['#ff6b6b', '#c9a227', '#4fd1a5', '#5b8def']; // 火 土 风 水（按星座序循环）
  var ASPECT_COLOR = {
    conjunction: '#e8eaf6', sextile: '#4fd1a5', square: '#ff6b8a',
    trine: '#5b8def', opposition: '#ffb454'
  };

  function draw(canvasId, chart) {
    var cv = document.getElementById(canvasId);
    if (!cv) return;
    var ctx = cv.getContext('2d');
    var W = cv.width, H = cv.height;
    var cx = W / 2, cy = H / 2;
    var rOuter = Math.min(W, H) / 2 - 8;
    var rSign = rOuter - 34;   // 星座环内界
    var rHouse = rSign - 8;    // 宫位环
    var rPlanet = rSign - 46;  // 行星摆放半径
    var rAspect = rHouse - 60; // 相位线所在内圆

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#12152a';
    ctx.fillRect(0, 0, W, H);

    var ascLon = chart.axes.ascLon;
    // 黄经 -> 屏幕角(弧度)，ASC 在左侧(9点)，黄经增大向下(逆时针占星方向)
    function ang(lon) { return (180 + (lon - ascLon)) * Math.PI / 180; }
    function pt(lon, r) {
      var a = ang(lon);
      return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
    }

    // 外圈 & 星座环 & 内圈
    [rOuter, rSign, rHouse].forEach(function (r) {
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI);
      ctx.strokeStyle = '#3a3f6b'; ctx.lineWidth = 1.2; ctx.stroke();
    });

    // 12 星座分区
    for (var s = 0; s < 12; s++) {
      var lonStart = s * 30;
      var p1 = pt(lonStart, rSign), p2 = pt(lonStart, rOuter);
      ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]);
      ctx.strokeStyle = '#3a3f6b'; ctx.lineWidth = 1; ctx.stroke();
      // 星座符号
      var mid = pt(lonStart + 15, (rSign + rOuter) / 2);
      ctx.fillStyle = ELEM_COLOR[s % 4];
      ctx.font = '18px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(SIGN_GLYPH[s], mid[0], mid[1]);
    }

    // 宫位线
    chart.cuspsLon.forEach(function (clon, i) {
      var a = pt(clon, 0), b = pt(clon, rHouse);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(b[0], b[1]);
      var axis = (i === 0 || i === 3 || i === 6 || i === 9);
      ctx.strokeStyle = axis ? '#7c6cff' : '#2c3157';
      ctx.lineWidth = axis ? 2 : 0.8;
      ctx.stroke();
      // 宫号
      var mid2 = pt(clon + 3, rAspect - 14);
      ctx.fillStyle = '#6b719e'; ctx.font = '11px sans-serif';
      ctx.fillText(String(i + 1), mid2[0], mid2[1]);
    });

    // 四轴标注
    var axisLabels = [['ASC', ascLon], ['MC', chart.axes.mcLon], ['DES', chart.axes.desLon], ['IC', chart.axes.icLon]];
    axisLabels.forEach(function (al) {
      var p = pt(al[1], rOuter + 0);
      var lp = pt(al[1], rOuter - 16);
      ctx.fillStyle = '#7c6cff'; ctx.font = 'bold 11px sans-serif';
      ctx.fillText(al[0], lp[0], lp[1]);
    });

    // 相位线（画在内圆）
    chart.aspects.forEach(function (asp) {
      var a = pt(asp.a.lon, rAspect), b = pt(asp.b.lon, rAspect);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      ctx.strokeStyle = ASPECT_COLOR[asp.aspect.key] || '#555';
      ctx.globalAlpha = 0.5; ctx.lineWidth = asp.exact ? 2 : 1;
      ctx.stroke(); ctx.globalAlpha = 1;
    });

    // 行星（简单防重叠：同区间微调半径）
    var used = [];
    chart.planets.forEach(function (p) {
      var r = rPlanet;
      // 若与已放置行星黄经过近，则外移
      used.forEach(function (u) {
        if (Math.abs(root.AstroEngine.norm180(u - p.lon)) < 7) r -= 20;
      });
      used.push(p.lon);
      var pos = pt(p.lon, r);
      // 指示点
      var dot = pt(p.lon, rHouse - 4);
      ctx.beginPath(); ctx.arc(dot[0], dot[1], 2, 0, 2 * Math.PI);
      ctx.fillStyle = p.retro ? '#ff6b8a' : '#ffb454'; ctx.fill();
      // 符号
      ctx.fillStyle = p.retro ? '#ff6b8a' : '#e8eaf6';
      ctx.font = '17px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(p.glyph, pos[0], pos[1]);
      if (p.retro) {
        ctx.font = '9px sans-serif'; ctx.fillStyle = '#ff6b8a';
        ctx.fillText('R', pos[0] + 11, pos[1] + 9);
      }
    });

    // 中心点
    ctx.beginPath(); ctx.arc(cx, cy, 3, 0, 2 * Math.PI);
    ctx.fillStyle = '#7c6cff'; ctx.fill();
  }

  root.AstroWheel = { draw: draw };
})(typeof window !== 'undefined' ? window : globalThis);
