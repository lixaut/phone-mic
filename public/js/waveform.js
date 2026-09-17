/* ============================================================
 * js/waveform.js — 实时波形可视化（Canvas 2D）
 * 职责：
 *   1. 页面加载即渲染静音波形（一排短横线段），无需先开麦克风
 *   2. 音频链路建立后，用 AnalyserNode 时域数据画 64 根镜像竖条
 * 视觉规格（黑白灰基调）：
 *   - 静音：短横线段（与波宽同宽）
 *   - 有声：居中镜像竖条，白 45% 透明度，柔和低对比
 * 平滑策略（三重，解决"太敏感/闪烁"问题）：
 *   1. Analyser smoothingTimeConstant=0.92（帧间平滑）
 *   2. 绘制限流 ~20fps（rAF 内按时间戳跳帧）
 *   3. 段内取均值 + EMA 指数平滑（系数 0.25，消除毛刺）
 * 对比度增强：a → (a×1.8)^0.8 非线性拉伸，小声放大、大声饱和，
 *   使有声/静音视觉差异显著
 * 对外暴露：window.PhoneMic.setupWave()（audio.js 在链路建立时调用）
 * ============================================================ */

(function () {
  'use strict';

  var cv = null;        // 波形 canvas
  var ctx2d = null;     // 绘制上下文
  var rafId = 0;        // 动画帧句柄（防重复启动）
  var lastDraw = 0;     // 上次绘制时间戳（帧率限流用）
  var ema = null;       // 各竖条的 EMA 平滑振幅

  var BARS = 64;        // 竖条数量：低密度防摩尔纹
  var FRAME_MS = 50;    // 绘制间隔 ≈20fps
  var EMA_K = 0.25;     // EMA 系数：帧间平滑

  /** 初始化 Analyser 并启动渲染循环（幂等；由 audio.js 在链路建立时调用） */
  function setupWave() {
    if (PhoneMic.analyser || !PhoneMic.audioCtx) return;
    var analyser = PhoneMic.audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.92;
    PhoneMic.analyser = analyser;
    startLoop();
  }

  /** 启动 requestAnimationFrame 渲染循环（幂等） */
  function startLoop() {
    if (rafId) return;
    var dpr = window.devicePixelRatio || 1;
    lastDraw = 0;
    ema = new Float32Array(BARS);

    function draw() {
      rafId = requestAnimationFrame(draw);
      // 帧率限流：~20fps，降低闪烁与功耗
      var now = performance.now();
      if (now - lastDraw < FRAME_MS) return;
      lastDraw = now;

      // 画布尺寸跟随窗口（含高分屏 dpr 缩放）
      var w = cv.clientWidth, h = cv.clientHeight;
      if (cv.width !== w * dpr || cv.height !== h * dpr) {
        cv.width = w * dpr; cv.height = h * dpr;
      }
      ctx2d = cv.getContext('2d');
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx2d.clearRect(0, 0, w, h); // 透明背景，与页面底色融合

      // 取当前时域数据（未开音频时 buf 为 null → 全部画静音线段）
      var buf = null, n = 0;
      if (PhoneMic.analyser) {
        buf = new Uint8Array(PhoneMic.analyser.fftSize);
        PhoneMic.analyser.getByteTimeDomainData(buf);
        n = buf.length;
      }

      var seg = Math.floor(n / BARS) || 1;
      var colW = w / BARS;
      var barW = Math.max(2, colW * 0.45);
      var halfBars = BARS / 2;

      for (var b = 0; b < BARS; b++) {
        var x = b * colW + colW / 2;
        // 中心→两边渐变因子：1=中心，0=边缘
        var pos = 1 - Math.abs(b - halfBars) / halfBars;
        var opacity = 0.8 * pos;                  // 透明度：中心80% → 边缘0%
        var heightK = 0.1 + 2.9 * pos;           // 高度系数：中心3.0 → 边缘0.1

        // 段内均值（比峰值稳，不毛躁）
        var sum = 0;
        if (buf) {
          for (var i = b * seg; i < (b + 1) * seg && i < n; i++) {
            sum += Math.abs(buf[i] - 128);
          }
        }
        var a = (sum / seg) / 128;
        // EMA 时域平滑
        var prev = ema[b];
        a = prev + (a - prev) * EMA_K;
        ema[b] = a;

        if (a < 0.02) {
          // 静音：短横线段（与波宽同宽）
          ctx2d.fillStyle = 'rgba(255,255,255,' + (opacity * 0.35) + ')';
          ctx2d.fillRect(x - barW / 2, h / 2 - 0.75, barW, 1.5);
        } else {
          // 有声：居中镜像竖条
          var bh = Math.max(3, a * h * 0.48 * heightK);
          ctx2d.fillStyle = 'rgba(255,255,255,' + opacity + ')';
          ctx2d.fillRect(x - barW / 2, h / 2 - bh, barW, bh * 2);
        }
      }
    }
    draw();
  }

  /** 模块初始化：获取 canvas 元素并启动静音渲染 */
  function init() {
    cv = document.getElementById('wave');
    startLoop(); // 页面加载即显示静音波形
  }

  // 全局命名空间挂载
  window.PhoneMic = window.PhoneMic || {};
  window.PhoneMic.setupWave = setupWave;
  window.PhoneMic.initWaveform = init;
  Object.defineProperty(window.PhoneMic, 'analyser', {
    get: function () { return this._analyser || null; },
    set: function (v) { this._analyser = v; }
  });
})();
