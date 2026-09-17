/* ============================================================
 * js/main.js — 应用主入口与 UI 控制
 * 职责：
 *   1. 加载顺序：先初始化各功能模块，再建 WebSocket 连接
 *   2. INPUT/OUTPUT 按钮点击 → 调用 audio.js 开/关对应链路
 *   3. 连接状态 UI（顶栏圆点/文字）统一从这里更新
 *   4. 调试日志面板：连点连接状态 5 次切换显隐
 *
 * 模块间通信约定：全部通过 window.PhoneMic 命名空间
 *   - 状态：PhoneMic.micOn / outOn / ws / outQueue / analyser
 *   - 方法：PhoneMic.send(obj) / setConnState(connected)
 *           ensureMic/ensureOutput/cleanup（audio.js）
 *           setupWave（waveform.js）/ setWakeLock（wakelock.js）
 * ============================================================ */

(function () {
  'use strict';

  // 全局命名空间与共享状态（各模块读写）
  window.PhoneMic = window.PhoneMic || {};
  var P = window.PhoneMic;
  P.micOn = false;   // INPUT 开关状态
  P.outOn = false;   // OUTPUT 开关状态

  var statusText = null; // 顶栏连接文字
  var connEl = null;     // 顶栏连接区（含圆点）
  var micBtn = null, outBtn = null;
  var dbgEl = null;      // 调试日志面板
  var dbgVisible = false;

  /* ---------- 调试日志（默认只进 console；面板可见时同步到 DOM） ---------- */
  P.log = function (m, force) {
    console.log('[phone-mic] ' + m);
    if (!dbgVisible && !force) return; // 面板隐藏时只记录关键事件
    var line = document.createElement('div');
    line.textContent = new Date().toLocaleTimeString() + ' ' + m;
    dbgEl.appendChild(line);
    dbgEl.scrollTop = dbgEl.scrollHeight;
    while (dbgEl.childNodes.length > 80) dbgEl.removeChild(dbgEl.firstChild);
  };

  /** 更新顶栏连接状态 UI（connection.js 在 onopen/onclose/onerror 时调用） */
  P.setConnState = function (connected) {
    statusText.textContent = connected ? 'Connected' : 'Disconnected';
    connEl.classList.toggle('on', connected);
  };

  /* ---------- INPUT 按钮：开/关麦克风采集 ---------- */
  function onMicBtn() {
    return async function () {
      try {
        if (!P.micOn) { await P.ensureMic(); P.micOn = true; }
        else { P.micOn = false; }
        micBtn.classList.toggle('on', P.micOn);
        P.send({ type: 'mic', enabled: P.micOn });
        P.cleanup();
      } catch (e) {
        P.log('mic error: ' + e.message);
        statusText.textContent = 'Mic error: ' + e.message;
        connEl.classList.remove('on');
      }
    };
  }

  /* ---------- OUTPUT 按钮：开/关电脑声音播放 ---------- */
  function onOutBtn() {
    return async function () {
      try {
        if (!P.outOn) { await P.ensureOutput(); P.outOn = true; }
        else { P.outOn = false; }
        outBtn.classList.toggle('on', P.outOn);
        P.send({ type: 'output', enabled: P.outOn });
        P.cleanup();
      } catch (e) {
        P.log('output error: ' + e.message);
        statusText.textContent = 'Output error: ' + e.message;
        connEl.classList.remove('on');
      }
    };
  }

  /* ---------- 调试面板：连点连接状态 5 次切换 ---------- */
  function bindDebugToggle() {
    var tapCount = 0, tapTimer = 0;
    connEl.addEventListener('click', function () {
      tapCount++;
      clearTimeout(tapTimer);
      tapTimer = setTimeout(function () { tapCount = 0; }, 1500);
      if (tapCount >= 5) {
        tapCount = 0;
        dbgVisible = !dbgVisible;
        dbgEl.style.display = dbgVisible ? 'block' : 'none';
      }
    });
  }

  /* ---------- 启动 ---------- */
  document.addEventListener('DOMContentLoaded', function () {
    statusText = document.getElementById('statusText');
    connEl = document.getElementById('conn');
    micBtn = document.getElementById('micBtn');
    outBtn = document.getElementById('outBtn');
    dbgEl = document.getElementById('dbglog');

    bindDebugToggle();
    micBtn.onclick = onMicBtn();
    outBtn.onclick = onOutBtn();

    // 各功能模块初始化（脚本加载顺序保证 PhoneMic 已就绪）
    P.initWaveform();   // 波形：页面加载即显示静音线段
    P.initWakeLock();   // 常亮：默认开启

    // 建立 WebSocket 连接（connection.js）
    P.connectWS();
  });
})();
