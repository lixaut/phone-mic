/* ============================================================
 * js/connection.js — WebSocket 连接管理
 * 职责：
 *   1. 建立与 PC 服务端的 wss 连接（自动重连）
 *   2. 文本帧 = JSON 控制消息路由；二进制帧 = PCM 音频 → 播放队列
 *   3. 连接状态变化 → 顶栏圆点/文字；断线重连后补发当前开关状态
 * 协议约定（与 server.js 一致）：
 *   - 发送 {"type":"mic","enabled":bool}    开关手机麦克风
 *   - 发送 {"type":"output","enabled":bool} 开关电脑声音推流
 *   - 收到二进制 = 16bit mono LE PCM（48kHz）
 * 对外暴露：window.PhoneMic.connectWS() / send(obj) / ws
 * ============================================================ */

(function () {
  'use strict';

  var ws = null;
  var outQueue = []; // 播放待播队列（波形/音频模块通过 PhoneMic.outQueue 访问）

  /** 建立 WebSocket 连接（含自动重连） */
  function connectWS() {
    // 页面是 https 服务，必须用 wss（自签证书在 iOS 上已受信任）
    var p = location.protocol === 'https:' ? 'wss:' : 'ws:';
    PhoneMic.log('connecting to ' + p + '//' + location.host, true);
    ws = new WebSocket(p + '//' + location.host);
    ws.binaryType = 'arraybuffer';

    ws.onopen = function () {
      PhoneMic.log('ws connected', true);
      PhoneMic.setConnState(true);
      // 重连后补发当前开关状态，否则服务端不会恢复 mic/loopback
      if (PhoneMic.micOn) send({ type: 'mic', enabled: true });
      if (PhoneMic.outOn) send({ type: 'output', enabled: true });
    };

    ws.onmessage = function (e) {
      if (e.data instanceof ArrayBuffer) {
        // 二进制帧 = PCM 音频，仅输出模式开启时入队
        if (PhoneMic.outOn && PhoneMic.outputNode) {
          var int16 = new Int16Array(e.data);
          for (var i = 0; i < int16.length; i++) { outQueue.push(int16[i] / 32768); }
          if (outQueue.length > 6000) { outQueue = outQueue.slice(-6000); } // 防积压
        }
      }
    };

    // 断线 2 秒后自动重连
    ws.onclose = function () {
      PhoneMic.log('ws closed', true);
      PhoneMic.setConnState(false);
      setTimeout(connectWS, 2000);
    };
    ws.onerror = function () {
      PhoneMic.log('ws error', true);
      PhoneMic.setConnState(false);
    };
  }

  /** 发送 JSON 控制消息（文本帧） */
  function send(m) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(m));
  }

  // 全局命名空间挂载
  window.PhoneMic = window.PhoneMic || {};
  window.PhoneMic.connectWS = connectWS;
  window.PhoneMic.send = send;
  window.PhoneMic.outQueue = outQueue;
  Object.defineProperty(window.PhoneMic, 'ws', { get: function () { return ws; } });
})();
