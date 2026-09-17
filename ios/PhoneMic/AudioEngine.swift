import Foundation
import AVFoundation

/// 双模式音频引擎：
/// - mic 模式：AVAudioEngine inputTap 采集 → Int16 PCM 20ms 帧 → WebSocket
/// - output 模式：WebSocket 收 PCM 帧 → 环形缓冲 → playerNode 播放
final class AudioEngine {
    static let sampleRate: Double = 48000
    static let frameSamples = 960  // 20ms @48kHz，与服务端协议一致

    private let engine = AVAudioEngine()
    private let playerNode = AVAudioPlayerNode()
    private var playerFormat: AVAudioFormat!
    private var inputFormat: AVAudioFormat!

    // 播放环形缓冲（服务端为 16bit mono PCM）
    private var playQueue = [Int16]()
    private let playQueueLock = NSLock()
    private var rendererActive = false

    // 采集回调中攒样本凑 20ms 帧
    private var captureBuf: [Float] = []

    var onMicFrame: ((Data) -> Void)?
    var micLevel: ((Float) -> Void)?  // RMS 0~1，驱动 UI 电平条

    func startMic() throws {
        let input = engine.inputNode
        inputFormat = input.outputFormat(forBus: 0)
        // 统一重采样到 48kHz mono，浏览器版协议一致
        let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Self.sampleRate, channels: 1, interleaved: false)!
        input.installTap(onBus: 0, bufferSize: 1024, format: target) { [weak self] buffer, _ in
            self?.handleCapture(buffer)
        }
        engine.prepare()
        try engine.start()
    }

    func stopMic() {
        engine.inputNode.removeTap(onBus: 0)
        if engine.isRunning && !rendererActive { engine.stop() }
        captureBuf.removeAll()
    }

    private func handleCapture(_ buffer: AVAudioPCMBuffer) {
        guard let channel = buffer.floatChannelData?[0] else { return }
        let n = Int(buffer.frameLength)
        let samples = UnsafeBufferPointer(start: channel, count: n)
        captureBuf.append(contentsOf: samples)
        // RMS 电平
        var sum: Float = 0
        for s in samples { sum += s * s }
        micLevel?(sqrt(sum / Float(max(n, 1))))
        // 凑满 960 样本(20ms)发一帧
        while captureBuf.count >= Self.frameSamples {
            let frame = Array(captureBuf[0..<Self.frameSamples])
            captureBuf.removeFirst(Self.frameSamples)
            onMicFrame?(Self.floatsToInt16Data(frame))
        }
    }

    static func floatsToInt16Data(_ floats: [Float]) -> Data {
        var int16s = [Int16](repeating: 0, count: floats.count)
        for (i, f) in floats.enumerated() {
            let clamped = max(-1.0, min(1.0, f))
            int16s[i] = clamped < 0 ? Int16(clamped * 32768.0) : Int16(clamped * 32767.0)
        }
        return int16s.withUnsafeBufferPointer { Data(buffer: $0) }
    }

    // MARK: - 播放（PC → iPhone → AirPods）

    func startRenderer() throws {
        guard !rendererActive else { return }
        let output = engine.outputNode
        playerFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Self.sampleRate, channels: 1, interleaved: false)!
        engine.attach(playerNode)
        engine.connect(playerNode, to: output, format: playerFormat)
        engine.prepare()
        try engine.start()
        playerNode.play()
        rendererActive = true
    }

    func stopRenderer() {
        guard rendererActive else { return }
        playerNode.stop()
        engine.stop()
        engine.detach(playerNode)
        rendererActive = false
        playQueueLock.lock(); playQueue.removeAll(); playQueueLock.unlock()
    }

    /// 收到服务端 PCM(16bit mono LE) 帧
    func enqueuePlayback(data: Data) {
        guard rendererActive, data.count >= 2 else { return }
        let count = data.count / 2
        var int16s = [Int16](repeating: 0, count: count)
        data.withUnsafeBytes { raw in
            for i in 0..<count {
                int16s[i] = raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self)
            }
        }
        playQueueLock.lock()
        playQueue.append(contentsOf: int16s)
        // 积压治理（与浏览器版同策略）：>6000 样本(125ms) 丢最旧的
        if playQueue.count > 6000 {
            playQueue.removeFirst(playQueue.count - 6000)
        }
        let buffered = playQueue.count
        playQueueLock.unlock()
        scheduleRender(available: buffered)
    }

    /// 按需拉取渲染（积压>2500 时每帧多消费 1 样本追赶）
    private func scheduleRender(available: Int) {
        let chunk = 2048
        let skip = available > 2500 ? 1 : 0
        playQueueLock.lock()
        if skip > 0 && playQueue.count > 2500 { playQueue.removeFirst(skip) }
        guard playQueue.count >= chunk else { playQueueLock.unlock(); return }
        let take = Array(playQueue[0..<chunk])
        playQueue.removeFirst(chunk)
        playQueueLock.unlock()

        guard let format = playerFormat else { return }
        let frameCount = AVAudioFrameCount(chunk)
        guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else { return }
        buf.frameLength = frameCount
        if let dst = buf.floatChannelData?[0] {
            for i in 0..<chunk {
                dst[i] = Float(take[i]) / 32768.0
            }
        }
        // overlaps 调度保证连续播放；缓冲耗尽时 scheduleBuffer 不排队，静音
        playerNode.scheduleBuffer(buf) { [weak self] in
            guard let self else { return }
            self.playQueueLock.lock()
            let remaining = self.playQueue.count
            self.playQueueLock.unlock()
            if remaining > 0 { self.scheduleRender(available: remaining) }
        }
    }
}
