/*
 * app.js — 界面逻辑
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var lastChart = null;
  var currentImageDataUrl = null;

  var SAMPLE = {
    name: '刘☆秀', place: '深圳市',
    date: '2005-08-06', time: '12:00:00', tz: 8,
    lon: 114 + 3 / 60, lat: 22 + 31 / 60, houseSystem: 'Placidus'
  };

  // ---------- 表单 <-> 数据 ----------
  function fillForm(d) {
    $('name').value = d.name || '';
    $('place').value = d.place || '';
    if (d.date) $('date').value = d.date;
    if (d.time) $('time').value = d.time;
    $('tz').value = (d.tz != null ? d.tz : (d.tzHours != null ? d.tzHours : 8));
    if (d.lon != null) $('lon').value = round4(d.lon);
    if (d.lat != null) $('lat').value = round4(d.lat);
  }
  function round4(x) { return Math.round(x * 10000) / 10000; }

  function readForm() {
    var date = ($('date').value || '').split('-');
    var time = ($('time').value || '00:00:00').split(':');
    var inp = {
      name: $('name').value.trim(),
      place: $('place').value.trim(),
      year: parseInt(date[0], 10),
      month: parseInt(date[1], 10),
      day: parseInt(date[2], 10),
      hour: parseInt(time[0], 10) || 0,
      minute: parseInt(time[1], 10) || 0,
      second: parseInt(time[2], 10) || 0,
      tzHours: parseFloat($('tz').value),
      lon: parseFloat($('lon').value),
      lat: parseFloat($('lat').value),
      houseSystem: $('houseSystem').value
    };
    return inp;
  }

  function validate(inp) {
    if (!inp.year || !inp.month || !inp.day) return '请填写出生日期';
    if (isNaN(inp.tzHours)) return '请填写时区';
    if (isNaN(inp.lon) || isNaN(inp.lat)) return '请填写经纬度（十进制度数）';
    return null;
  }

  // ---------- 生成 ----------
  function generate() {
    var inp = readForm();
    var err = validate(inp);
    if (err) { setStatus(err, 'err'); switchTab('report'); $('report').textContent = '⚠ ' + err; return; }
    try {
      lastChart = window.AstroEngine.computeChart(inp);
      renderAll(lastChart);
      setStatus('已生成', 'ok');
    } catch (e) {
      $('report').textContent = '计算出错：' + e.message;
      console.error(e);
    }
  }

  function renderAll(chart) {
    $('report').textContent = window.AstroReport.toText(chart);
    renderTables(chart);
    try { window.AstroWheel.draw('wheel', chart); } catch (e) { console.error(e); }
  }

  function renderTables(chart) {
    var R = window.AstroReport;
    var html = '';
    // 四轴
    html += '<h2>四轴</h2><table><tr><th>轴点</th><th>位置</th></tr>';
    [['ASC', chart.axes.asc], ['MC', chart.axes.mc], ['DES', chart.axes.des], ['IC', chart.axes.ic]]
      .forEach(function (a) { html += '<tr><td class="name">' + a[0] + '</td><td>' + R.dm(a[1].lon) + '</td></tr>'; });
    html += '</table>';

    // 行星
    html += '<h2 style="margin-top:16px">行星位置</h2><table>' +
      '<tr><th>行星</th><th>星座度数</th><th>宫位</th><th>状态</th><th>速度(°/日)</th></tr>';
    chart.planets.forEach(function (p) {
      html += '<tr><td class="name">' + p.glyph + ' ' + p.cn + '</td>' +
        '<td>' + R.dm(p.lon) + '</td>' +
        '<td>第' + p.house + '宫</td>' +
        '<td class="' + (p.retro ? 'retro' : '') + '">' + (p.retro ? '逆行 Rx' : '顺行') + '</td>' +
        '<td>' + p.speed.toFixed(3) + '</td></tr>';
    });
    html += '</table>';

    // 相位
    html += '<h2 style="margin-top:16px">托勒密相位（' + chart.aspects.length + '）</h2><table>' +
      '<tr><th>星体A</th><th>相位</th><th>星体B</th><th>精确度(orb)</th><th>出/入</th></tr>';
    chart.aspects.forEach(function (a) {
      html += '<tr><td>' + a.a.cn + '</td>' +
        '<td>' + a.aspect.glyph + ' ' + a.aspect.cn + '</td>' +
        '<td>' + a.b.cn + '</td>' +
        '<td>' + R.orbDm(a.orb) + (a.exact ? ' ★' : '') + '</td>' +
        '<td class="' + (a.status === 'applying' ? 'apply' : 'separ') + '">' +
        (a.status === 'applying' ? '入相位 ⤴' : '出相位 ⤵') + '</td></tr>';
    });
    html += '</table>';

    // 特能（总结）
    var dg = chart.dignities;
    html += '<h2 style="margin-top:16px">特能（总结）' +
      '<span class="small" style="font-weight:400"> · ' + dg.sect + '</span></h2>';
    if (dg.mutual.length) {
      html += '<h3 style="margin-top:8px">互容 / 互溶</h3>' +
        '<table><tr><th>类型</th><th>说明</th></tr>';
      dg.mutual.forEach(function (r) {
        html += '<tr><td class="name">' + r.kind + '</td><td>' + r.detail + '</td></tr>';
      });
      html += '</table>';
    }
    if (dg.oneWay.length) {
      html += '<h3 style="margin-top:8px">容纳 / 接收</h3>' +
        '<table><tr><th>行星</th><th>被…接纳</th><th>尊贵</th></tr>';
      dg.oneWay.forEach(function (r) {
        html += '<tr><td class="name">' + r.fromGlyph + ' ' + r.fromCn + '</td>' +
          '<td>' + r.byGlyph + ' ' + r.byCn + '</td>' +
          '<td>' + r.types.join(' + ') + '</td></tr>';
      });
      html += '</table>';
    }
    if (dg.specials.length) {
      html += '<h3 style="margin-top:8px">行星特殊状态</h3>' +
        '<table><tr><th>行星</th><th>状态</th></tr>';
      dg.specials.forEach(function (s) {
        html += '<tr><td class="name">' + s.glyph + ' ' + s.cn + '</td><td>' + s.tags.join(' · ') + '</td></tr>';
      });
      html += '</table>';
    }
    if (chart.nodes) {
      var nd = chart.nodes;
      html += '<h3 style="margin-top:8px">月交点（平交点）</h3>' +
        '<table><tr><th>交点</th><th>星座度数</th><th>宫位</th></tr>';
      [nd.north, nd.south].forEach(function (n) {
        html += '<tr><td class="name">' + n.glyph + ' ' + n.cn + '</td>' +
          '<td>' + R.dm(n.lon) + '</td>' +
          '<td>第' + n.house + '宫</td></tr>';
      });
      html += '</table>';
    }
    if (!dg.mutual.length && !dg.oneWay.length && !dg.specials.length) {
      html += '<p class="small">（未检测到容纳 / 接收或特殊状态）</p>';
    }

    // 行星尊贵状态（单独列出）
    html += '<h2 style="margin-top:16px">行星尊贵状态</h2>';
    html += '<table><tr><th>行星</th><th>星座</th><th>尊贵</th><th>无力</th><th>总分</th></tr>';
    dg.planets.forEach(function (it) {
      var dign = !it.classical
        ? '<span class="small">现代行星</span>'
        : (it.peregrine ? '<span class="small">外来 / 无根 (Peregrine)</span>' : (it.dignities.join('<br>') || '—'));
      var deb = it.classical ? (it.debilities.join('<br>') || '—') : '—';
      html += '<tr><td class="name">' + it.glyph + ' ' + it.cn + '</td>' +
        '<td>' + it.signCn + '座</td>' +
        '<td>' + dign + '</td>' +
        '<td>' + deb + '</td>' +
        '<td>' + (it.classical ? (it.score >= 0 ? '+' : '') + it.score : '—') + '</td></tr>';
    });
    html += '</table>';
    $('tables').innerHTML = html;
  }

  // ---------- 图片识别 ----------
  function saveCfg() {
    localStorage.setItem('astro_vision_cfg', JSON.stringify({
      baseURL: $('apiBase').value.trim(),
      apiKey: $('apiKey').value.trim(),
      model: $('apiModel').value.trim()
    }));
  }
  function loadCfg() {
    try {
      var c = JSON.parse(localStorage.getItem('astro_vision_cfg') || '{}');
      $('apiBase').value = c.baseURL || '';
      $('apiKey').value = c.apiKey || '';
      $('apiModel').value = c.model || '';
    } catch (e) { }
  }
  function getCfg() {
    return { baseURL: $('apiBase').value.trim(), apiKey: $('apiKey').value.trim(), model: $('apiModel').value.trim() };
  }

  function handleFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      currentImageDataUrl = e.target.result;
      $('preview').src = currentImageDataUrl;
      $('preview').style.display = 'block';
      $('dropHint').style.display = 'none';
      setStatus('图片已载入，点击「识别图片并生成」', '');
    };
    reader.readAsDataURL(file);
  }

  async function recognize() {
    if (!currentImageDataUrl) { setStatus('请先上传星盘图片', 'err'); return; }
    var cfg = getCfg();
    if (!cfg.baseURL || !cfg.apiKey || !cfg.model) {
      setStatus('未配置视觉接口。请在「视觉接口设置」中填写，或改用下方手动输入。', 'err');
      return;
    }
    saveCfg();
    setStatus('正在识别图片…', '');
    try {
      var info = await window.AstroVision.extractFromImage(currentImageDataUrl, cfg);
      fillForm({
        name: info.name, place: info.place,
        date: [info.year, pad(info.month), pad(info.day)].join('-'),
        time: [pad(info.hour), pad(info.minute), pad(info.second)].join(':'),
        tz: info.tzHours, lon: info.lon, lat: info.lat
      });
      setStatus('识别完成，正在计算…', 'ok');
      generate();
    } catch (e) {
      setStatus('识别失败：' + e.message, 'err');
      console.error(e);
    }
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function setStatus(msg, cls) {
    var el = $('visionStatus');
    el.textContent = msg;
    el.className = 'status ' + (cls || '');
  }

  // ---------- Tabs ----------
  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.tab === name);
    });
    document.querySelectorAll('.tabpage').forEach(function (p) {
      p.classList.toggle('active', p.id === 'page-' + name);
    });
    if (name === 'wheel' && lastChart) { try { window.AstroWheel.draw('wheel', lastChart); } catch (e) { } }
  }

  // ---------- 绑定 ----------
  function init() {
    loadCfg();
    fillForm(SAMPLE);

    $('drop').addEventListener('click', function () { $('file').click(); });
    $('file').addEventListener('change', function (e) { handleFile(e.target.files[0]); });
    ['dragover', 'dragenter'].forEach(function (ev) {
      $('drop').addEventListener(ev, function (e) { e.preventDefault(); $('drop').classList.add('hover'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      $('drop').addEventListener(ev, function (e) { e.preventDefault(); $('drop').classList.remove('hover'); });
    });
    $('drop').addEventListener('drop', function (e) {
      if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });

    $('btnRecognize').addEventListener('click', recognize);
    $('btnCompute').addEventListener('click', generate);
    $('btnSample').addEventListener('click', function () { fillForm(SAMPLE); generate(); });
    $('btnCopy').addEventListener('click', function () {
      navigator.clipboard.writeText($('report').textContent).then(function () {
        setStatus('已复制到剪贴板', 'ok');
      });
    });
    document.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () { switchTab(t.dataset.tab); });
    });
    ['apiBase', 'apiKey', 'apiModel'].forEach(function (id) {
      $(id).addEventListener('change', saveCfg);
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
