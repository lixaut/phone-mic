// rtc.js — WebRTC 媒体通道（werift 实现，纯 JS 无原生编译）
// INPUT : 手机麦 → Opus(RTP) → 解码 PCM → audio-bridge → VB-CABLE
// OUTPUT: loopback.exe PCM → Opus(RTP) → 手机
// 信令复用现有 wss，JSON 消息路由到这里
const { RTCPeerConnection, MediaStreamTrack, RtpPacket } = require('werift');
const { EventEmitter } = require('events');

const MIC_CLOCK = 48000;   // INPUT 48kHz（与 audio-bridge 一致，免重采样）
const OUT_CLOCK = 48000;   // OUTPUT 48kHz 音乐优先
const PCM_CHUNK = 960;     // 与现有协议一致：20ms @48k mono

class RtcBridge extends EventEmitter {
  constructor(audioBridge) {
    super();
    this.audioBridge = audioBridge;
    // 每个客户端一套连接（简单场景：单手机）
    this.micPc = null;    // recvonly：收手机麦
    this.outPc = null;    // sendonly：发电脑声
    this.outTs = 0;
    this.outSeq = 1;
    this.initCodecs();
  }

  // 信令入口：server.js 把 rtc-* 消息转到这里
  async handleSignal(ws, msg) {
    try {
      if (msg.t === 'rtc-offer') {
        const mode = msg.mode; // "mic" | "out"
        const pc = new RTCPeerConnection();
        if (mode === 'mic') {
          this.micPc = pc;
          this.setupMicReceiver(pc, ws);
        } else {
          this.outPc = pc;
          this.setupOutSender(pc, ws);
        }
        await pc.setRemoteDescription(msg.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ t: 'rtc-answer', sdp: pc.localDescription, mode }));
        pc.connectionStateChange.subscribe((s) => {
          if (s === 'failed' || s === 'closed') {
            if (mode === 'mic' && this.micPc === pc) this.micPc = null;
            if (mode === 'out' && this.outPc === pc) this.outPc = null;
          }
        });
      } else if (msg.t === 'rtc-ice') {
        // werift 通过 setRemoteDescription 前的 addIceCandidate / 或内嵌 candidate 处理
        // 局域网 host candidates 已内嵌于 SDP，此处无需额外处理
      }
    } catch (e) {
      console.error('[rtc] signal error:', e.message);
    }
  }

  // ---------- INPUT: 收手机麦，解码为 PCM 喂 audio-bridge ----------
  setupMicReceiver(pc, ws) {
    pc.trackReceiver.onTrack.subscribe(async (track) => {
      track.onReceiveRtp.subscribe((rtp) => {
        // werift 收到的 RTP payload 为 Opus 包；借助浏览器端/AudioEngine 发送时
        // 均以 Opus 编码。此处用轻量 Opus 解码（depktize 后送 ffmpeg? 简化：
        // iOS 端 WEBRTC 发送即 Opus，werift 不自带解码器，用 node-opus）
        const pcm = this.decodeOpus(rtp.payload, MIC_CLOCK);
        if (pcm && this.audioBridge) this.audioBridge.write(pcm);
      });
      track.onReceiveRtp.once(() => {
        console.log('[rtc] mic track up — phone sending audio');
        this.emit('micup');
      });
    });
  }

  // ---------- OUTPUT: loopback PCM → Opus → 手机 ----------
  setupOutSender(pc, ws) {
    const track = new MediaStreamTrack({ kind: 'audio', codec: 'opus', clockRate: OUT_CLOCK });
    pc.addTrack(track);
    this.outTrack = track;
    pc.connectionStateChange.subscribe((s) => {
      if (s === 'connected') {
        console.log('[rtc] output track up — sending PC audio to phone');
        this.emit('outup');
      }
    });
  }

  // loopback stdout 的 PCM(16bit mono 48k) 喂进来
  writeOutgoingPcm(chunk) {
    if (!this.outTrack) return;
    // 按 20ms 分帧编码发送
    const bytesPerFrame = PCM_CHUNK * 2;
    for (let off = 0; off + bytesPerFrame <= chunk.length; off += bytesPerFrame) {
      const pcm = chunk.slice(off, off + bytesPerFrame);
      const opus = this.encodeOpus(pcm, OUT_CLOCK);
      if (opus) {
        this.outTrack.writeRtp({
          payload: opus,
          timestamp: this.outTs,
          sequenceNumber: this.outSeq++,
        });
        this.outTs += PCM_CHUNK;
      }
    }
  }

  // ---------- Opus 编解码 ----------
  // werift 不带编解码器，用 libopus 绑定（@discordjs/opus，预编译 Windows 可用）
  initCodecs() {
    try {
      const OpusEncoder = require('@discordjs/opus').OpusEncoder;
      this.enc48 = new OpusEncoder(OUT_CLOCK, 1);
      this.dec16 = new OpusEncoder(MIC_CLOCK, 1);
      this.enc48.applyEncoderCTL?.([4010, 2048]); // VOIP 模式（可选）
      console.log('[rtc] opus codecs ready');
      return true;
    } catch (e) {
      console.error('[rtc] @discordjs/opus unavailable:', e.message);
      return false;
    }
  }
  encodeOpus(pcm, clock) { return clock === OUT_CLOCK && this.enc48 ? this.enc48.encode(pcm) : null; }
  decodeOpus(opus, clock) {
    if (clock === MIC_CLOCK && this.dec16) {
      try { return this.dec16.decode(opus); } catch { return null; }
    }
    return null;
  }

  close() {
    try { this.micPc?.close(); } catch {}
    try { this.outPc?.close(); } catch {}
    this.micPc = this.outPc = null;
  }
}

module.exports = RtcBridge;
