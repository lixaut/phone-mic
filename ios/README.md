# PhoneMic iOS 客户端

原生 Swift App，替代浏览器方案。双模式：INPUT（手机麦→PC）、OUTPUT（PC→手机/AirPods）。功耗更低、延迟更低、锁屏不断流。

## 前置条件

- Mac + Xcode 15+
- 免费 Apple ID（Xcode → Settings → Accounts 添加）
- iPhone 与 PC 同一局域网

## Xcode 工程搭建（3 分钟）

`.xcodeproj` 不入库，手动建一次即可：

1. Xcode → File → New → Project → **iOS App**
   - Product Name: `PhoneMic`
   - Interface: **SwiftUI**，Language: **Swift**
2. 删除自动生成的 `ContentView.swift`、`PhoneMicApp.swift`（用本目录文件替代）
3. 把本目录 `PhoneMic/` 下的 3 个文件拖入工程（勾选 Copy items if needed）
4. **Signing & Capabilities**：
   - Team 选你的 Apple ID（Personal Team）
   - Bundle Identifier 改成唯一值，如 `com.你的名字.phonemic`
5. **添加后台音频能力**：+ Capability → Background Modes → 勾选 **Audio, AirPlay, and Picture in Picture**
6. **权限声明**（Info.plist 或 Target → Info）：
   - `NSMicrophoneUsageDescription` = "用作电脑的无线麦克风"
   - `NSLocalNetworkUsageDescription` = "连接局域网内的电脑音频服务"
   - `NSAppTransportSecurity` → `NSAllowsArbitraryLoads` = YES（局域网 wss 自签需要）
7. iPhone 连 Mac，选为目标设备，Run

> 免费签名 7 天过期：到期后连 Mac 再点一次 Run，App 数据不丢。

## 协议（与 server.js 完全一致，服务端零改动）

- WebSocket（wss），文本帧 = JSON 控制消息，二进制帧 = 16bit mono LE PCM
- 控制消息：`{"type":"mic","enabled":true}` / `{"type":"output","enabled":true}`
- 采样 48kHz 单声道，20ms/帧（960 样本）

## 使用

1. PC 上 `npm start` 启动服务
2. App 里填 `wss://<PC局域网IP>:3000`（首次连接后自动记住）
3. INPUT = 手机当麦克风；OUTPUT = PC 声音推到手机（耳机接手机听）
4. 锁屏可继续使用（后台音频模式）

## 已知限制

- 自签证书在 App 内直接信任（仅限局域网，勿用于公网）
- 免费 Apple ID 最多 3 个签名 App、7 天过期
