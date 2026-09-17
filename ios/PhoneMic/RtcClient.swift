import Foundation
import WebRTC

/// WebRTC 媒体客户端（werift 服务端对应）
/// - mic  模式：sendonly，发送麦克风 Opus 音轨（WebRTC 栈自带 AEC/AGC/NS）
/// - out  模式：recvonly，接收电脑声音音轨自动渲染（48kHz，路由 AirPods）
/// 信令复用 WSClient 的 JSON 通道
final class RtcClient: NSObject, RTCPeerConnectionDelegate {
    private var factory: RTCPeerConnectionFactory!
    private var micPc: RTCPeerConnection?
    private var outPc: RTCPeerConnection?
    private var localAudioTrack: RTCAudioTrack?
    private weak var ws: WSClient?

    var onStateChange: ((String, Bool) -> Void)?  // (mode, up)

    override init() {
        super.init()
        let enc = RTCDefaultVideoEncoderFactory()
        let dec = RTCDefaultVideoDecoderFactory()
        factory = RTCPeerConnectionFactory(encoderFactory: enc, decoderFactory: dec)
    }

    func attachSignaling(_ ws: WSClient) {
        self.ws = ws
    }

    private func config() -> RTCConfiguration {
        let cfg = RTCConfiguration()
        // 局域网直连：host candidate 即可，无需 STUN
        cfg.iceServers = []
        cfg.sdpSemantics = .unifiedPlan
        return cfg
    }

    private func constraints(mandatory: [String: String]) -> RTCMediaConstraints {
        RTCMediaConstraints(mandatoryConstraints: mandatory, optionalConstraints: nil)
    }

    // MARK: - INPUT（手机麦 → PC）

    func startMic() {
        guard micPc == nil else { return }
        let pc = factory.peerConnection(with: config(), constraints: constraints(mandatory: [:]), delegate: self)
        micPc = pc
        // WebRTC 音频源自带 AEC/AGC/NS，默认采集
        let source = factory.audioSource(with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
        let track = factory.audioTrack(with: source, trackId: "mic0")
        localAudioTrack = track
        pc.add(track, streamIds: ["mic"])
        makeOffer(pc: pc, mode: "mic")
    }

    func stopMic() {
        micPc?.close()
        micPc = nil
        localAudioTrack = nil
        onStateChange?("mic", false)
    }

    // MARK: - OUTPUT（PC → 手机）

    func startOut() {
        guard outPc == nil else { return }
        let pc = factory.peerConnection(with: config(), constraints: constraints(mandatory: [:]), delegate: self)
        outPc = pc
        // recvonly：仅接收，渲染由 RTCAudioSession 自动路由（AirPods）
        let recvTransceiver = pc.addTransceiver(of: .audio, direction: .recvOnly)
        _ = recvTransceiver
        makeOffer(pc: pc, mode: "out")
    }

    func stopOut() {
        outPc?.close()
        outPc = nil
        onStateChange?("out", false)
    }

    private func makeOffer(pc: RTCPeerConnection, mode: String) {
        let offerConstraints = constraints(mandatory: ["OfferToReceiveAudio": mode == "out" ? "true" : "false"])
        pc.offer(for: offerConstraints) { [weak self] sdp, err in
            guard let self, let sdp else { return }
            pc.setLocalDescription(sdp) { _ in
                self.ws?.send(text: Self.json(["t": "rtc-offer", "mode": mode, "sdp": sdp.sdp]))
            }
        }
    }

    // MARK: - 信令回调（由 ContentView 转发）

    func handleAnswer(_ dict: [String: Any]) {
        guard let mode = dict["mode"] as? String,
              let sdp = dict["sdp"] as? String else { return }
        let desc = RTCSessionDescription(type: .answer, sdp: sdp)
        let pc = mode == "mic" ? micPc : outPc
        pc?.setRemoteDescription(desc) { _ in }
    }

    private static func json(_ dict: [String: Any]) -> String {
        guard let d = try? JSONSerialization.data(withJSONObject: dict),
              let s = String(data: d, encoding: .utf8) else { return "{}" }
        return s
    }

    // MARK: - RTCPeerConnectionDelegate（仅关键回调）

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        let mode = peerConnection === micPc ? "mic" : "out"
        switch newState {
        case .connected, .completed:
            onStateChange?(mode, true)
        case .failed, .disconnected, .closed:
            onStateChange?(mode, false)
        default: break
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        // 局域网 host candidate 已内嵌 SDP；候选补充仍上报（无害）
        ws?.send(text: Self.json(["t": "rtc-ice",
                                  "candidate": ["candidate": candidate.sdp, "sdpMid": candidate.sdpMid ?? "", "sdpMLineIndex": candidate.sdpMLineIndex]]))
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
