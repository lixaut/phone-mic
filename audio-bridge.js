const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const BLOCK_ALIGN = CHANNELS * BITS_PER_SAMPLE / 8;

class AudioBridge {
  constructor() {
    this.process = null;
    this.buffer = Buffer.alloc(0);
    this.isClosed = false;
    this.writeCount = 0;
    this.open();
  }

  open() {
    const exePath = path.join(__dirname, 'audio-player.exe');

    if (!fs.existsSync(exePath)) {
      console.error('[audio-player] exe not found:', exePath);
      return;
    }

    this.process = spawn(exePath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stderr.on('data', (data) => {
      console.error('[audio-player]', data.toString().trim());
    });

    this.process.on('close', (code) => {
      console.log('[audio-player] exited with code', code);
      this.process = null;
    });

    this.process.on('error', (err) => {
      console.error('[audio-player] spawn error:', err.message);
      this.process = null;
    });
  }

  write(pcmData) {
    if (this.isClosed || !this.process) return;

    const buf = Buffer.isBuffer(pcmData) ? pcmData : Buffer.from(pcmData);
    this.buffer = Buffer.concat([this.buffer, buf]);

    const blockSize = SAMPLE_RATE * BLOCK_ALIGN * 20 / 1000;
    while (this.buffer.length >= blockSize) {
      const chunk = this.buffer.slice(0, blockSize);
      this.buffer = this.buffer.slice(blockSize);

      if (this.process && !this.process.killed) {
        this.process.stdin.write(chunk, (err) => {
          if (err && !this.isClosed) {
            console.error('[audio-player] write error:', err.message);
            // 管道写失败说明子进程死了，自动重建
            this.restart();
          }
        });
      }
    }
  }

  // 重建播放进程（自愈）
  restart() {
    console.log('[audio-bridge] restarting audio-player...');
    if (this.process) {
      try { this.process.kill(); } catch (e) {}
      this.process = null;
    }
    this.buffer = Buffer.alloc(0);
    this.open();
  }

  flush() {
    if (this.buffer.length > 0 && this.process && !this.process.killed) {
      this.process.stdin.write(this.buffer);
      this.buffer = Buffer.alloc(0);
    }
  }

  close() {
    this.isClosed = true;
    if (this.process) {
      this.flush();
      this.process.stdin.end();
      this.process = null;
    }
  }
}

module.exports = new AudioBridge();
