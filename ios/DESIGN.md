# WebRTC + Opus 升级架构设计（master-ios）

## 目标

- 端到端延迟：~100ms → 30-50ms
- 手机功耗：流量降 50 倍（Opus），无线电解耦
- 弱网：jitter buffer / PLC / 丢包补偿由 WebRTC 栈处理
- 浏览器版（main 分支）不受影响，server 双栈兼容

## 总体架构

```
iPhone (Swift)
├─ INPUT:  AVAudioEngine(16kHz tap) → Opus track ─┐
│           (RTCPeerConnection sendonly)           │ WebRTC (SRTP/UDP)
├─ OUTPUT: RTCPeerConnection recvonly ←── Opus ───┤
│           → AVAudioEngine playerNode (48kHz)     │
└─ 信令: WebSocket (wss://pc:3000/signal)          ▼
                                       Node server (wrtc)
                                       ├─ 信令: offer/answer/ICE 转发
                                       ├─ INPUT:  收 Opus → 解码 PCM → audio-bridge → VB-CABLE
                                       └─ OUTPUT: loopback.exe PCM → Opus 编码 → 发流
```

## 信令协议（复用现有 wss 通道）

- JSON 消息（文本帧）：
  - `{"t":"rtc-offer","sdp":...,"mode":"mic"|"out"}`
  - `{"t":"rtc-answer","sdp":...}`
  - `{"t":"rtc-ice","candidate":...}`
  - `{"t":"rtc-up","mode":...}` 媒体通道就绪，此后停用该方向的 ws 二进制流
- 现有 `{"type":"mic"/"output"}` 控制消息保留，作为模式开关（触发建连/关流）

## 双速率策略

- INPUT（麦克风）：16kHz 单声道 Opus，语音优先（DTX 开启进一步省电）
- OUTPUT（听声）：48kHz 立体声 Opus ~96kbps（音乐音质优先）
- iOS 端两个 PeerConnection（sendonly / recvonly）独立建立、独立开关

## 服务端改动（server.js + 新增 rtc.js）

1. `wrtc` 依赖（node-webrtc）：作为 Peer 端点，收发音轨
2. INPUT 路径：远端音轨 → Opus 解码（wrtc 输出即为 PCM 帧）→ `audioBridge.write()`（audio-bridge/audio-player 完全不动）
3. OUTPUT 路径：`loopback.exe` stdout PCM → 本地 Opus 编码 track → 发给手机（`audio-player.exe` 不动；loopback.exe 不动）
4. 信令：现有 wss 上加 JSON 路由；浏览器旧客户端不发 rtc 消息，自动走旧 ws 媒体路径
5. 兼容开关：客户端 Offer 里带 `rtc=1` 标记，服务端据此选择路径

## iOS 端改动

1. 引入 WebRTC.framework（Google 官方稳定版 `stasel/WebRTC` SPM 包）
2. `RTCPeerConnection` ×2（send/recv），信令走现有 WSClient（JSON 部分复用）
3. 采集：`RTCAudioSession`/`RTCPeerConnectionFactory` 音轨接管麦克风（WebRTC 自带 AEC/AGC，比手搓链路更好），16k 发送
4. 播放：远端音轨自动渲染到 `RTCAudioSession`（48k，路由 AirPods）
5. `AudioEngine.swift` 保留但降级为浏览器回退模式（开关切换），默认走 RTC

## 关键风险与对策

| 风险 | 对策 |
|---|---|
| node-webrtc 在 Windows 上预编译可用性 | 先装依赖验证（任务#4），失败则 PC 端改用 `ffmpeg`+`gstreamer` 或走纯 UDP 自定义栈 |
| 局域网 ICE 直连失败（AP 隔离） | 信令里交换 host candidate，禁用 STUN（局域网无需） |
| WebRTC.framework 体积 ~40MB | 仅本机安装，无分发诉求，可接受 |

## 实施顺序

1. `npm i wrtc` 验证 Windows 可用性（阻塞项，先行）
2. rtc.js + server.js 信令与媒体路径
3. iOS SPM 引入 WebRTC、替换媒体层
4. 双端联调：先 INPUT 后 OUTPUT
5. 回退开关验证（浏览器版仍走旧路径）
