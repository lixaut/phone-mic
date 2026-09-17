class PCMOutputProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.received = 0;      // 收到的包数
    this.processCalls = 0;  // process被调用次数
    this.lastBeat = 0;
    this.port.onmessage = (e) => {
      if (e.data.buffer) {
        this.received++;
        const int16 = new Int16Array(e.data.buffer);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
          float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7FFF);
        }
        this.buffer.push(...float32);
        // 防止积压无限增长（>2秒丢旧数据）
        if (this.buffer.length > 96000) {
          this.buffer = this.buffer.slice(-48000);
        }
      }
    };
  }

  process(inputs, outputs, parameters) {
    this.processCalls++;
    // 每秒发一次心跳：process是否在跑、收到多少包、缓冲多少
    if (currentTime - this.lastBeat >= 1.0) {
      this.lastBeat = currentTime;
      this.port.postMessage({
        type: 'stat',
        time: currentTime,
        received: this.received,
        processCalls: this.processCalls,
        buffered: this.buffer.length
      });
    }

    const output = outputs[0];
    if (!output || !output[0]) return true;

    const channel = output[0];
    for (let i = 0; i < channel.length; i++) {
      channel[i] = this.buffer.length > 0 ? this.buffer.shift() : 0;
    }
    return true;
  }
}

registerProcessor('pcm-output', PCMOutputProcessor);
