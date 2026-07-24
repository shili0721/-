/*
 * vision.js — 图片识别模块
 * 通过「OpenAI 兼容」的多模态(视觉)接口，从星盘截图中提取出生信息。
 * 兼容 OpenAI / 通义千问 / 智谱GLM-4V / Moonshot 等遵循 Chat Completions 规范的服务。
 *
 * 说明：纯前端无法内置密钥，需用户在界面填写 baseURL / apiKey / model。
 *      若不配置，则使用手动输入表单（同样可精确计算）。
 */
(function (root) {
  'use strict';

  var SYS_PROMPT =
    '你是星盘图像信息提取助手。请仔细阅读用户上传的占星星盘截图，' +
    '只提取“出生信息”，包括：姓名、出生日期、出生时间、出生地点、经度、纬度、时区。' +
    '经纬度请转换为十进制度数（东经为正、西经为负；北纬为正、南纬为负）。' +
    '时区请转换为相对 GMT 的小时数（如东八区为 8）。' +
    '严格只输出一个 JSON 对象，不要任何解释或 Markdown 代码块，字段如下：\n' +
    '{"name":"","date":"YYYY-MM-DD","time":"HH:MM:SS","place":"",' +
    '"lon":114.05,"lat":22.52,"tzHours":8}\n' +
    '若某字段无法识别，姓名/地点用空字符串，数值字段用 null。';

  // 发送识别请求，返回 birthInfo 对象
  async function extractFromImage(dataUrl, cfg) {
    if (!cfg || !cfg.baseURL || !cfg.apiKey || !cfg.model) {
      throw new Error('未配置视觉接口（baseURL / apiKey / model）');
    }
    var url = cfg.baseURL.replace(/\/+$/, '') + '/chat/completions';
    var body = {
      model: cfg.model,
      temperature: 0,
      messages: [
        { role: 'system', content: SYS_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: '请从这张星盘图中提取出生信息，按要求只输出 JSON。' },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }
      ]
    };

    var resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.apiKey
      },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      var t = await resp.text();
      throw new Error('接口错误 ' + resp.status + '：' + t.slice(0, 300));
    }
    var data = await resp.json();
    var text = (data.choices && data.choices[0] && data.choices[0].message &&
      data.choices[0].message.content) || '';
    return parseBirthJSON(text);
  }

  // 从模型返回中解析 JSON（容错去除代码块）
  function parseBirthJSON(text) {
    var m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('未能从模型返回中解析出 JSON：' + text.slice(0, 200));
    var obj = JSON.parse(m[0]);
    return normalize(obj);
  }

  // 归一化为 AstroEngine 需要的 input 结构
  function normalize(obj) {
    var date = (obj.date || '').split('-');
    var time = (obj.time || '00:00:00').split(':');
    return {
      name: obj.name || '',
      place: obj.place || '',
      year: parseInt(date[0], 10),
      month: parseInt(date[1], 10),
      day: parseInt(date[2], 10),
      hour: parseInt(time[0], 10) || 0,
      minute: parseInt(time[1], 10) || 0,
      second: parseInt(time[2], 10) || 0,
      tzHours: obj.tzHours == null ? 8 : Number(obj.tzHours),
      lat: obj.lat == null ? null : Number(obj.lat),
      lon: obj.lon == null ? null : Number(obj.lon)
    };
  }

  root.AstroVision = { extractFromImage: extractFromImage, parseBirthJSON: parseBirthJSON };

})(typeof window !== 'undefined' ? window : globalThis);
