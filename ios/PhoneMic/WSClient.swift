import Foundation

/// WebSocket 客户端：连接 PC server.js，处理 wss 自签证书信任
/// 协议与浏览器版一致：文本=JSON 控制消息，二进制=PCM(16bit mono LE)
final class WSClient: NSObject, URLSessionWebSocketDelegate {
    var onText: ((String) -> Void)?
    var onBinary: ((Data) -> Void)?
    var onStateChange: ((Bool) -> Void)?  // connected

    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    private var url: URL?
    private(set) var connected = false
    private var reconnectDelay: TimeInterval = 2.0

    override init() {
        super.init()
        session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    }

    func connect(to urlString: String) {
        guard let u = URL(string: urlString) else { return }
        url = u
        task = session.webSocketTask(with: u)
        task?.resume()
        receiveLoop()
    }

    func disconnect() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        setConnected(false)
    }

    func send(_ data: Data) {
        task?.send(.data(data)) { [weak self] _ in
            if let e = self?.lastError() { _ = e }  // 错误时靠 delegate 断线重连
        }
    }

    func send(text: String) {
        task?.send(.string(text)) { _ in }
    }

    private func lastError() -> Error? { nil }  // 占位：send 失败由 receive 超时/代理感知

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let msg):
                switch msg {
                case .string(let s): self.onText?(s)
                case .data(let d): self.onBinary?(d)
                @unknown default: break
                }
                self.receiveLoop()
            case .failure:
                self.setConnected(false)
                self.scheduleReconnect()
            }
        }
    }

    private func scheduleReconnect() {
        guard let url else { return }
        DispatchQueue.global().asyncAfter(deadline: .now() + reconnectDelay) { [weak self] in
            guard let self, !self.connected else { return }
            self.connect(to: url.absoluteString)
        }
    }

    private func setConnected(_ c: Bool) {
        guard connected != c else { return }
        connected = c
        DispatchQueue.main.async { self.onStateChange?(c) }
    }

    // MARK: 自签证书信任（局域网 wss 必需）
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           let trust = challenge.protectionSpace.serverTrust {
            // 信任任何证书：仅限局域网自签场景，不用于公网
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol: String?) {
        setConnected(true)
        receiveLoop()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        setConnected(false)
        scheduleReconnect()
    }
}
