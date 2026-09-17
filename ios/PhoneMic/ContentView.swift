import SwiftUI
import AVFoundation

@main
struct PhoneMicApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // 后台保活：锁屏不断流（需在 Info.plist 声明 UIBackgroundModes=audio）
        try? AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .default, options: [.allowBluetooth, .defaultToSpeaker])
        try? AVAudioSession.sharedInstance().setActive(true)
        return true
    }
}

struct ContentView: View {
    @State private var serverURL = UserDefaults.standard.string(forKey: "serverURL") ?? "wss://192.168.1.100:3000"
    @State private var micOn = false
    @State private var outOn = false
    @State private var connected = false
    @State private var level: Float = 0

    private let ws = WSClient()
    private let audio = AudioEngine()
    private let rtc = RtcClient()

    var body: some View {
        VStack(spacing: 40) {
            Text(connected ? "Connected" : "Connecting...")
                .font(.footnote)
                .foregroundColor(connected ? .green : .gray)

            TextField("wss://192.168.1.100:3000", text: $serverURL)
                .textFieldStyle(.roundedBorder)
                .keyboardType(.URL)
                .autocorrectionDisabled()
                .padding(.horizontal)

            HStack(spacing: 60) {
                modeButton("INPUT", on: micOn) { toggleMic() }
                modeButton("OUTPUT", on: outOn) { toggleOut() }
            }

            // 电平条
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color(.systemGray5))
                    Capsule().fill(Color.green).frame(width: g.size.width * min(CGFloat(level) * 3, 1))
                }
            }
            .frame(width: 200, height: 6)
        }
        .onAppear { setupCallbacks(); ws.connect(to: serverURL) }
    }

    private func modeButton(_ label: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 8) {
                Circle()
                    .fill(on ? Color.red : Color(.systemGray4))
                    .frame(width: 80, height: 80)
                    .overlay(Text(label).font(.footnote).bold().foregroundColor(.white))
            }
        }
    }

    private func setupCallbacks() {
        ws.onStateChange = { c in connected = c }
        rtc.attachSignaling(ws)
        rtc.onStateChange = { mode, up in
            // WebRTC 媒体通道状态（可选 UI 展示），此处静默
            _ = (mode, up)
        }
        audio.micLevel = { l in DispatchQueue.main.async { level = l } }
        // 旧 ws 二进制路径保留作为回退（RTC 未就绪时仍可工作）
        audio.onMicFrame = { [weak ws] data in ws?.send(data) }
        ws.onBinary = { [weak audio] data in
            guard outOn else { return }
            audio?.enqueuePlayback(data: data)
        }
        // 服务端 rtc-answer 转发给 RtcClient
        ws.onText = { [weak rtc] text in
            guard let d = text.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  obj["t"] as? String == "rtc-answer" else { return }
            rtc?.handleAnswer(obj)
        }
        // 断线重连成功后补发当前开关状态（与浏览器版行为一致）
        ws.onStateChange = { [weak ws] c in
            connected = c
            if c {
                if micOn { ws?.send(text: "{\"type\":\"mic\",\"enabled\":true}") }
                if outOn { ws?.send(text: "{\"type\":\"output\",\"enabled\":true}") }
            }
        }
    }

    private func toggleMic() {
        micOn.toggle()
        if micOn {
            try? audio.startMic()   // 回退链路
            rtc.startMic()          // WebRTC 主链路（Opus/AEC/AGC）
        } else {
            audio.stopMic()
            rtc.stopMic()
        }
        ws.send(text: "{\"type\":\"mic\",\"enabled\":\(micOn)}")
        UserDefaults.standard.set(serverURL, forKey: "serverURL")
    }

    private func toggleOut() {
        outOn.toggle()
        if outOn {
            try? audio.startRenderer()  // 回退链路
            rtc.startOut()              // WebRTC 主链路
        } else {
            audio.stopRenderer()
            rtc.stopOut()
        }
        ws.send(text: "{\"type\":\"output\",\"enabled\":\(outOn)}")
        UserDefaults.standard.set(serverURL, forKey: "serverURL")
    }
}
