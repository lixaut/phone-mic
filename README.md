# Phone Mic

将 iPhone 作为电脑的无线麦克风。

## 工作原理

```
iPhone (Safari) ──WebSocket──> Node.js Server ──WASAPI──> VB-CABLE ──> 其他软件
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 安装虚拟声卡

下载并安装 [VB-CABLE](https://vb-audio.com/Cable/)

安装后重启电脑。

### 3. 生成证书

```bash
npm run gen-cert
```

### 4. 启动服务

```bash
npm start
```

### 5. 手机连接

1. 确保 iPhone 和电脑在同一局域网
2. 打开 Safari，访问终端显示的地址（如 `https://192.168.1.100:3000`）
3. 接受证书警告（点击"高级" → "继续访问"）
4. 点击麦克风按钮开始录音

### 6. 在电脑软件中使用

在软件（OBS、Zoom、Teams 等）的音频输入设备中选择：
- **CABLE Input (VB-Audio Virtual Cable)**

## 音频参数

| 参数 | 值 |
|------|-----|
| 采样率 | 48kHz |
| 位深 | 16-bit |
| 声道 | 单声道 |
| 编码 | 原始 PCM |
| 延迟 | ~10-30ms (LAN) |

## 故障排除

### 找不到麦克风
- 确保使用 HTTPS（Safari 要求）
- 确保页面已获得麦克风权限

### 没有声音
- 检查 VB-CABLE 是否正确安装
- 在 Windows 声音设置中确认 "CABLE Input" 存在
- 检查软件输入设备是否选择了 VB-CABLE

### 证书问题
- iPhone Safari 会显示证书警告
- 点击"高级" → "继续访问" 即可
- 也可安装 [mkcert](https://github.com/FiloSottile/mkcert) 生成可信证书

## 备选方案（无 VB-CABLE）

如果没有安装 VB-CABLE，音频会保存为 WAV 文件。

## 许可

MIT
