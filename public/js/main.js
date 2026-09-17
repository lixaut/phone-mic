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
    if (!dbgVisible && !force) return;
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

  /** 常亮同步：任一开启→常亮开；全关→常亮关 */
  function syncWakeLock() {
    P.setWakeLock(P.micOn || P.outOn);
  }

  /* ---------- INPUT 按钮：开/关麦克风采集 ---------- */
  function onMicBtn() {
    return async function () {
      try {
        if (!P.micOn) { await P.ensureMic(); P.micOn = true; }
        else { P.micOn = false; }
        micBtn.classList.toggle('on', P.micOn);
        P.send({ type: 'mic', enabled: P.micOn });
        P.cleanup();
        syncWakeLock();
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
        syncWakeLock();
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

  /* ---------- 下拉刷新：整个页面下移 + 指示器露出 ---------- */
  function bindPullRefresh() {
    var content = document.getElementById('pageContent');
    var indicator = document.getElementById('pullIndicator');
    var pullText = indicator.querySelector('.pull-text');
    var pullIcon = indicator.querySelector('.pull-icon');
    var waveArea = document.getElementById('waveArea');
    var startY = 0, dy = 0, pulling = false, threshold = 100;
    var currentY = 0, currentO = 0, currentR = 0;

    // 对数阻尼：越拉越涩，手感自然
    function damp(x) { return x <= 0 ? 0 : 120 * Math.log(1 + x / 120); }

    function apply(y, o, r) {
      currentY = y; currentO = o; currentR = r;
      content.style.transform = 'translateY(' + y + 'px)';
      indicator.style.opacity = o;
      pullIcon.style.transform = 'rotate(' + r + 'deg)';
    }

    // 弹回：ease-out-expo（快起慢停）
    function snapBack(fromY, fromO, fromR) {
      var startTime = performance.now();
      var duration = 500;
      function tick(now) {
        var t = Math.min((now - startTime) / duration, 1);
        // ease-out-expo: 1 - 2^(-10t)
        var ease = 1 - Math.pow(2, -10 * t);
        apply(fromY * (1 - ease), fromO * (1 - ease), fromR * (1 - ease));
        if (t < 1) requestAnimationFrame(tick);
        else { apply(0, 0, 0); content.style.transform = ''; }
      }
      requestAnimationFrame(tick);
    }

    waveArea.addEventListener('touchstart', function (e) {
      if (window.scrollY > 0) return;
      startY = e.touches[0].clientY;
      dy = 0;
      pulling = true;
      indicator.classList.remove('refreshing');
      content.style.transition = 'none';
    }, { passive: true });

    waveArea.addEventListener('touchmove', function (e) {
      if (!pulling) return;
      var delta = e.touches[0].clientY - startY;
      if (delta <= 0) { dy = 0; apply(0, 0, 0); return; }
      dy = delta;
      var move = damp(dy);
      var progress = Math.min(dy / threshold, 1);
      var rotation = progress * 270;
      apply(move, Math.min(1, progress * 1.5), rotation);
      pullText.textContent = progress >= 1 ? '松手刷新' : '下拉刷新';
    }, { passive: true });

    // 通用 ease-out-expo 动画
    function animateTo(fromY, fromO, fromR, toY, toO, toR, dur, cb) {
      var startTime = performance.now();
      function tick(now) {
        var t = Math.min((now - startTime) / dur, 1);
        var ease = 1 - Math.pow(2, -10 * t);
        apply(
          fromY + (toY - fromY) * ease,
          fromO + (toO - fromO) * ease,
          fromR + (toR - fromR) * ease
        );
        if (t < 1) requestAnimationFrame(tick);
        else if (cb) cb();
      }
      requestAnimationFrame(tick);
    }

    waveArea.addEventListener('touchend', function () {
      if (!pulling) return;
      pulling = false;
      var progress = Math.min(dy / threshold, 1);

      if (progress >= 1) {
        var fromY = currentY, fromO = currentO, fromR = currentR;
        var halfY = fromY * 0.5, halfO = fromO * 0.5;

        // 第一段：回弹到 50%，文字露出
        animateTo(fromY, fromO, fromR, halfY, halfO, 0, 350, function () {
          indicator.classList.add('refreshing');
          pullText.textContent = '刷新中...';
          // 第二段：刷新完成 → 显示成功 → 渐隐
          setTimeout(function () {
            indicator.classList.remove('refreshing');
            pullText.textContent = '刷新成功';
            // 渐隐文字
            animateTo(halfY, halfO, 0, halfY, 0, 0, 300, function () {
              // 第三段：文字消失后回弹归零
              setTimeout(function () {
                animateTo(halfY, 0, 0, 0, 0, 0, 450, function () {
                  apply(0, 0, 0);
                  content.style.transform = '';
                });
              }, 50);
            });
          }, 800);
        });
      } else {
        snapBack(currentY, currentO, currentR);
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
    bindPullRefresh();
    micBtn.onclick = onMicBtn();
    outBtn.onclick = onOutBtn();

    // 各功能模块初始化（脚本加载顺序保证 PhoneMic 已就绪）
    P.initWaveform();   // 波形：页面加载即显示静音线段
    P.initWakeLock();   // 常亮：绑定按钮事件（默认关，由 INPUT/OUTPUT 联动）

    // 建立 WebSocket 连接（connection.js）
    P.connectWS();
  });
})();
