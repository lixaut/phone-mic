const https = require('https');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const os = require('os');

const PORT = 3000;
const CERT_DIR = path.join(__dirname, 'cert');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

let server;
try {
  const cert = fs.readFileSync(path.join(CERT_DIR, 'cert.pem'));
  const key = fs.readFileSync(path.join(CERT_DIR, 'key.pem'));
  server = https.createServer({ cert, key }, app);
} catch (e) {
  console.error('Certificate not found. Run: npm run gen-cert');
  process.exit(1);
}

// perMessageDeflate 关闭：PCM 二进制流压缩无收益，纯耗 CPU 且增加延迟
const wss = new WebSocketServer({ server, perMessageDeflate: false });

let audioBridge = null;
try {
  audioBridge = require('./audio-bridge');
  console.log('Audio bridge loaded (VB-CABLE)');
} catch (e) {
  console.warn('Audio bridge not available:', e.message);
}

let loopbackProc = null;
let loopbackWs = null;
let loopbackDataCount = 0;
let loopbackLastLog = 0;
let loopbackWsWarned = false;
let loopbackHasSound = false;

// WebRTC 媒体通道（iOS 客户端用；浏览器旧客户端自动走 ws 路径）
let rtcBridge = null;
try {
  const RtcBridge = require('./rtc');
  rtcBridge = new RtcBridge(audioBridge);
  console.log('[rtc] WebRTC bridge ready (werift + opus)');
} catch (e) {
  console.warn('[rtc] WebRTC bridge unavailable:', e.message);
}

function startLoopback(ws) {
  if (loopbackProc) {
    // 进程还在跑但可能绑的是旧连接，重新绑定到当前 ws
    console.log('[loopback] already running, rebinding to new client');
    loopbackWs = ws;
    return;
  }
  console.log('[loopback] Starting...');

  const exePath = path.join(__dirname, 'loopback.exe');
  if (!fs.existsSync(exePath)) {
    console.error('[loopback] exe not found:', exePath);
    return;
  }

  loopbackWs = ws;
  loopbackDataCount = 0;
  loopbackLastLog = 0;
  loopbackWsWarned = false;
  loopbackHasSound = false;
  loopbackProc = spawn(exePath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  loopbackProc.stderr.on('data', (d) => console.error('[loopback:stderr]', d.toString().trim()));
  loopbackProc.on('error', (e) => { console.error('[loopback] spawn error:', e.message); loopbackProc = null; loopbackWs = null; });
  loopbackProc.on('close', (code) => { console.log('[loopback] exited code=' + code + ' totalDataBytes=' + loopbackDataCount); loopbackProc = null; loopbackWs = null; });
  loopbackProc.stdout.on('data', (data) => {
    loopbackDataCount += data.length;
    // WebRTC 路径：PCM 编码为 Opus 发给 iOS 客户端
    if (rtcBridge) rtcBridge.writeOutgoingPcm(data);
    // 检测CABLE里是否真的有声音（全0=电脑没把声音输出到CABLE Input）
    for (let i = 0; i < data.length - 1; i += 2) {
      if (data[i] !== 0 || data[i + 1] !== 0) { loopbackHasSound = true; break; }
    }
    const now = Date.now();
    if (!loopbackLastLog || now - loopbackLastLog > 60000) {
      loopbackLastLog = now;
      console.log('[loopback] streaming, total=' + loopbackDataCount + ' bytes, hasSound=' + loopbackHasSound +
        (loopbackHasSound ? '' : '  <<< CABLE silent: set PC output device to "CABLE Input"!'));
    }
    if (loopbackWs && loopbackWs.readyState === 1) {
      loopbackWs.send(data);
    } else if (!loopbackWsWarned) {
      loopbackWsWarned = true;
      console.log('[loopback:ws] client not ready, state=' + (loopbackWs ? loopbackWs.readyState : 'null'));
    }
  });
  loopbackProc.on('exit', (code, signal) => {
    console.log('[loopback] process exited code=' + code + ' signal=' + signal);
    loopbackProc = null;
    loopbackWs = null;
  });
}

function stopLoopback() {
  if (loopbackProc) {
    console.log('[loopback] stopping... total=' + loopbackDataCount + ' bytes');
    loopbackProc.kill();
    loopbackProc = null;
    loopbackWs = null;
  }
}

wss.on('connection', (ws) => {
  console.log('[ws] client connected');
  let micEnabled = false;
  let outEnabled = false;
  let msgCount = 0;
  let micVoiceCount = 0;
  let micHadVoice = false;      // 上一轮是否检测到声音（用于状态变化日志）
  let micSilentSince = 0;       // 开始持续无声的时间

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      msgCount++;
      // 检测麦克风数据是否真的有声音（Int16 PCM，全0=静音）
      let hasLevel = false;
      for (let i = 0; i < data.length - 1; i += 2) {
        const s = data.readInt16LE(i);
        if (s > 300 || s < -300) { hasLevel = true; break; } // 阈值≈噪声底
      }
      const now = Date.now();
      if (hasLevel) {
        micVoiceCount++;
        micSilentSince = 0;
        if (!micHadVoice) {
          micHadVoice = true;
          console.log('[mic] PHONE MIC HAS SOUND (pkts=' + msgCount + ')');
        }
      } else if (micHadVoice) {
        if (!micSilentSince) micSilentSince = now;
        if (now - micSilentSince > 10000) {
          micHadVoice = false;
          console.log('[mic] mic data ALL SILENT for 10s (check phone mic permission / level)');
        }
      }
      if (micEnabled && audioBridge) {
        audioBridge.write(data);
      }
      return;
    }
    const text = data.toString();
    try {
      const msg = JSON.parse(text);
      // WebRTC 信令消息转发给 rtcBridge
      if (rtcBridge && msg.t && String(msg.t).startsWith('rtc-')) {
        rtcBridge.handleSignal(ws, msg);
        return;
      }
      if (msg.type === 'mic') {
        micEnabled = msg.enabled;
        console.log('[ws] Input (mic):', micEnabled ? 'ON' : 'OFF');
      } else if (msg.type === 'output') {
        outEnabled = msg.enabled;
        console.log('[ws] Output (loopback):', outEnabled ? 'ON' : 'OFF');
        if (outEnabled) startLoopback(ws);
        else stopLoopback();
      }
    } catch (e) {
      console.error('[ws] parse error:', e.message);
    }
  });

  ws.on('close', (code, reason) => {
    console.log('[ws] client disconnected code=' + code + ' reason=' + (reason || 'none'));
    if (loopbackWs === ws) stopLoopback();
    if (audioBridge) audioBridge.flush();
  });

  ws.on('error', (e) => {
    console.error('[ws] error:', e.message);
  });
});

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('\n========================================');
  console.log('Phone Mic Server: https://' + ip + ':' + PORT);
  console.log('========================================\n');
});

process.on('SIGINT', () => {
  stopLoopback();
  if (audioBridge) audioBridge.close();
  process.exit(0);
});
