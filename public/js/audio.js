/* ============================================================
 * js/audio.js — 音频采集与播放（ScriptProcessor 方案）
 * 职责：
 *   1. INPUT ：麦克风采集 → 音质处理链 → 20ms PCM 帧上传
 *   2. OUTPUT：下载 PCM → 积压治理 → 扬声器播放
 *   3. 共享一个 AudioContext，双模式独立开关
 *
 * 采集处理链（实测调优的音质配置）：
 *   mic → 浏览器NS/AGC(getUserMedia) → 高通100Hz → 压缩器 → 增益1.6 → 发送
 *   注：echoCancellation 必须关 —— 本场景无回声，开启会导致声音卡顿
 *
 * 播放积压治理：
 *   >6000 样本(125ms) 丢最旧数据；>2500(50ms) 每轮多消费 1 个逐步追平
 *
 * 对外暴露：window.PhoneMic.ensureMic/ensureOutput/cleanup 等
 * ============================================================ */

(function () {
  'use strict';

  var audioCtx = null;      // 共享 AudioContext（48kHz）
  var stream = null;        // getUserMedia 媒体流（麦克风）
  var workletNode = null;   // ScriptProcessor 采集节点
  var outputNode = null;    // ScriptProcessor 播放节点

  /** 取共享 AudioContext（首次调用时创建，恢复被系统挂起的上下文） */
  async function ensureCtx() {
    if (!audioCtx) audioCtx = new AudioContext({ sampleRate: 48000 });
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    return audioCtx;
  }

  /* ================= INPUT：麦克风采集 ================= */

  /** 开启麦克风采集并持续上传 20ms/960样本 的 PCM 帧 */
  async function ensureMic() {
    if (workletNode) return; // 幂等：已开启
    PhoneMic.log('ensureMic: creating AudioContext...');
    await ensureCtx();
    PhoneMic.log('requesting mic permission...');
    // NS/AGC 开启去杂音；AEC 必须关（无回声场景，开了会卡顿）
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, sampleRate: 48000, channelCount: 1 }
    });
    PhoneMic.log('mic permission granted');
    var src = audioCtx.createMediaStreamSource(stream);

    // --- 音质处理链 ---
    // 高通100Hz：去手握摩擦/桌面震动的低频杂音
    var hp = audioCtx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 100; hp.Q.value = 0.7;
    // 温和压缩器：远近场音量均衡（激进参数会放大处理痕迹）
    var comp = audioCtx.createDynamicsCompressor();
    comp.threshold.value = -32; comp.knee.value = 20; comp.ratio.value = 3;
    comp.attack.value = 0.01; comp.release.value = 0.25;
    // 发送增益：人声电平抬升
    var gain = audioCtx.createGain(); gain.gain.value = 1.6;
    src.connect(hp); hp.connect(comp); comp.connect(gain);

    // 波形可视化接入（处理后的信号）
    PhoneMic.setupWave();
    gain.connect(PhoneMic.analyser);

    // --- ScriptProcessor 采集（兼容性优于 AudioWorklet，实测可靠） ---
    workletNode = audioCtx.createScriptProcessor(4096, 1, 1);
    var pcmBuf = [];
    workletNode.onaudioprocess = function (ev) {
      var inp = ev.inputBuffer.getChannelData(0);
      // 攒满 960 样本(20ms) 打包为 Int16 上传，与服务端协议对齐
      for (var i = 0; i < inp.length; i++) pcmBuf.push(inp[i]);
      while (pcmBuf.length >= 960) {
        var chunk = pcmBuf.splice(0, 960);
        var pcm16 = new Int16Array(960);
        for (var j = 0; j < 960; j++) {
          var s = Math.max(-1, Math.min(1, chunk[j]));
          pcm16[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        if (PhoneMic.ws && PhoneMic.ws.readyState === 1) PhoneMic.ws.send(pcm16.buffer);
      }
    };
    var srcSink = audioCtx.createGain();
    gain.connect(srcSink); srcSink.connect(workletNode);
    // 必须连到 destination 才会被拉流处理；零增益避免回声
    var silent = audioCtx.createGain(); silent.gain.value = 0;
    workletNode.connect(silent); silent.connect(audioCtx.destination);
    PhoneMic.log('mic input connected (ScriptProcessor)');
  }

  /* ================= OUTPUT：扬声器播放 ================= */

  /** 开启播放：收到的 PCM 入队 → ScriptProcessor 消费出声 */
  async function ensureOutput() {
    if (outputNode) return; // 幂等
    PhoneMic.log('ensureOutput: creating AudioContext...');
    await ensureCtx();
    PhoneMic.log('ensureOutput: AudioContext state=' + audioCtx.state);
    // 2048@48kHz ≈ 43ms 固有延迟（4096 为 85ms）
    outputNode = audioCtx.createScriptProcessor(2048, 0, 1);
    outputNode.onaudioprocess = function (ev) {
      var out = ev.outputBuffer.getChannelData(0);
      var q = PhoneMic.outQueue;
      // 积压治理：>6000样本(125ms) 丢最旧的；>2500(50ms) 每轮多消费1个追平
      if (q.length > 6000) { q.splice(0, q.length - 6000); }
      var skip = q.length > 2500 ? 1 : 0;
      for (var i = 0; i < out.length; i++) {
        out[i] = q.length > 0 ? q.shift() : 0;
      }
      while (skip-- > 0 && q.length > 2500) { q.shift(); }
    };
    outputNode.connect(audioCtx.destination);
    // ScriptProcessor 需要一条返回路径才被拉流（静音输入保活）
    var silent = audioCtx.createGain(); silent.gain.value = 0;
    var sink = audioCtx.createGain();
    silent.connect(sink); sink.connect(outputNode);
    // 波形可视化接入（播放信号）
    PhoneMic.setupWave();
    if (PhoneMic.analyser) outputNode.connect(PhoneMic.analyser);
    PhoneMic.log('ScriptProcessor output created');
    playTestTone(); // 自检音
  }

  /** 自检音：短促低音量"哔"声，验证手机播放链路是否正常 */
  function playTestTone() {
    PhoneMic.log('playing test tone...');
    var osc = audioCtx.createOscillator();
    var g = audioCtx.createGain();
    osc.frequency.value = 440;
    g.gain.value = 0.1; // 轻柔，不刺耳
    osc.connect(g); g.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.6);
    PhoneMic.log('test tone done - if you heard a beep, phone audio works');
  }

  /* ================= 生命周期 ================= */

  /**
   * 关闭未使用的音频资源：双开关全关时释放整个 AudioContext；
   * 仅关麦克风时只停媒体流（播放可能仍在用 ctx）
   */
  function cleanup() {
    if (!PhoneMic.micOn && !PhoneMic.outOn) {
      PhoneMic.log('cleanup: closing AudioContext');
      if (audioCtx) { audioCtx.close(); audioCtx = null; }
      if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
      workletNode = null;
      outputNode = null;
      PhoneMic.analyser = null; // 波形回到待机
    } else if (!PhoneMic.micOn && workletNode) {
      if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
      workletNode = null;
      if (!PhoneMic.outOn) PhoneMic.analyser = null;
    }
  }

  // 全局命名空间挂载
  window.PhoneMic = window.PhoneMic || {};
  window.PhoneMic.ensureMic = ensureMic;
  window.PhoneMic.ensureOutput = ensureOutput;
  window.PhoneMic.cleanup = cleanup;
  Object.defineProperty(window.PhoneMic, 'audioCtx', { get: function () { return audioCtx; } });
  Object.defineProperty(window.PhoneMic, 'outputNode', { get: function () { return outputNode; } });
})();
