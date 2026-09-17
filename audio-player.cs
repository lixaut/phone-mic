using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

class AudioPlayer
{
    const int WAVE_FORMAT_PCM = 0x0001;
    const int SAMPLE_RATE = 48000;
    const int CHANNELS = 1;
    const int BITS_PER_SAMPLE = 16;
    const int BLOCK_ALIGN = CHANNELS * BITS_PER_SAMPLE / 8;
    const int BUFFER_SIZE = 960 * BLOCK_ALIGN;
    const int NUM_BUFFERS = 8;

    [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
    static extern uint waveOutGetNumDevs();

    [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
    static extern int waveOutGetDevCapsW(uint uDeviceID, IntPtr pCaps, uint cbCaps);

    [DllImport("winmm.dll")]
    static extern int waveOutOpen(out IntPtr hWaveOut, uint uDeviceID, IntPtr pFormat,
        int dwCallback, int dwCallbackInstance, int fdwOpen);

    [DllImport("winmm.dll")]
    static extern int waveOutClose(IntPtr hWaveOut);

    [DllImport("winmm.dll")]
    static extern int waveOutPrepareHeader(IntPtr hWaveOut, IntPtr pWaveHdr, uint cbWh);

    [DllImport("winmm.dll")]
    static extern int waveOutUnprepareHeader(IntPtr hWaveOut, IntPtr pWaveHdr, uint cbWh);

    [DllImport("winmm.dll")]
    static extern int waveOutWrite(IntPtr hWaveOut, IntPtr pWaveHdr, uint cbWh);

    [DllImport("winmm.dll")]
    static extern int waveOutReset(IntPtr hWaveOut);

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEHDR
    {
        public IntPtr lpData;
        public uint dwBufferLength;
        public uint dwBytesRecorded;
        public uint dwUser;
        public uint dwFlags;
        public uint dwLoops;
        public IntPtr lpNext;
        public uint reserved;
    }

    static string GetDeviceName(uint index)
    {
        uint size = 256;
        IntPtr caps = Marshal.AllocHGlobal((int)size);
        try
        {
            int result = waveOutGetDevCapsW(index, caps, size);
            if (result != 0) return null;

            // wMid (2 bytes) + wPid (2 bytes) + vDriverVersion (4 bytes) = offset 8
            // szPname starts at offset 8, 32 Unicode chars = 64 bytes
            byte[] buffer = new byte[size];
            Marshal.Copy(caps, buffer, 0, (int)size);

            // Read device name: 32 Unicode chars starting at offset 8
            char[] chars = new char[32];
            for (int i = 0; i < 32; i++)
            {
                int byteOffset = 8 + i * 2;
                ushort ch = BitConverter.ToUInt16(buffer, byteOffset);
                if (ch == 0) break;
                chars[i] = (char)ch;
            }
            return new string(chars).TrimEnd('\0');
        }
        finally
        {
            Marshal.FreeHGlobal(caps);
        }
    }

    static int FindVBCable()
    {
        uint numDevs = waveOutGetNumDevs();
        Console.Error.WriteLine("Found " + numDevs + " audio output devices");

        for (uint i = 0; i < numDevs; i++)
        {
            string name = GetDeviceName(i);
            Console.Error.WriteLine("  [" + i + "] " + (name ?? "(null)"));
            if (name != null && name.ToLower().Contains("cable"))
            {
                Console.Error.WriteLine("  -> Found VB-CABLE at index " + i);
                return (int)i;
            }
        }
        return -1;
    }

    // 关闭设备并重新打开，返回新的句柄
    static IntPtr Restart(IntPtr oldHandle, int deviceIndex, IntPtr[] headers, IntPtr[] buffers)
    {
        try { waveOutReset(oldHandle); } catch { }
        for (int i = 0; i < headers.Length; i++)
        {
            try { waveOutUnprepareHeader(oldHandle, headers[i], (uint)Marshal.SizeOf(typeof(WAVEHDR))); } catch { }
        }
        try { waveOutClose(oldHandle); } catch { }

        IntPtr format = Marshal.AllocHGlobal(18);
        Marshal.WriteInt16(format, 0, WAVE_FORMAT_PCM);
        Marshal.WriteInt16(format, 2, CHANNELS);
        Marshal.WriteInt32(format, 4, SAMPLE_RATE);
        Marshal.WriteInt32(format, 8, SAMPLE_RATE * BLOCK_ALIGN);
        Marshal.WriteInt16(format, 12, BLOCK_ALIGN);
        Marshal.WriteInt16(format, 14, BITS_PER_SAMPLE);
        Marshal.WriteInt16(format, 16, 0);

        IntPtr h;
        int hr = waveOutOpen(out h, (uint)deviceIndex, format, 0, 0, 0);
        Marshal.FreeHGlobal(format);
        if (hr != 0) throw new Exception("waveOutOpen failed: " + hr);
        Console.Error.WriteLine("[audio-player] device reopened OK");
        return h;
    }

    static void Main()
    {
        int deviceIndex = FindVBCable();
        if (deviceIndex < 0)
        {
            Console.Error.WriteLine("ERROR: VB-CABLE not found. Install from https://vb-audio.com/Cable/");
            Environment.Exit(1);
        }

        IntPtr format = Marshal.AllocHGlobal(18);
        Marshal.WriteInt16(format, 0, WAVE_FORMAT_PCM);
        Marshal.WriteInt16(format, 2, CHANNELS);
        Marshal.WriteInt32(format, 4, SAMPLE_RATE);
        Marshal.WriteInt32(format, 8, SAMPLE_RATE * BLOCK_ALIGN);
        Marshal.WriteInt16(format, 12, BLOCK_ALIGN);
        Marshal.WriteInt16(format, 14, BITS_PER_SAMPLE);
        Marshal.WriteInt16(format, 16, 0);

        IntPtr hWaveOut;
        int openResult = waveOutOpen(out hWaveOut, (uint)deviceIndex, format, 0, 0, 0);
        Marshal.FreeHGlobal(format);

        if (openResult != 0)
        {
            Console.Error.WriteLine("ERROR: waveOutOpen failed: " + openResult);
            Environment.Exit(1);
        }

        Console.Error.WriteLine("Audio device opened. Streaming...");

        IntPtr[] headers = new IntPtr[NUM_BUFFERS];
        IntPtr[] buffers = new IntPtr[NUM_BUFFERS];
        for (int i = 0; i < NUM_BUFFERS; i++)
        {
            headers[i] = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WAVEHDR)));
            buffers[i] = Marshal.AllocHGlobal(BUFFER_SIZE);
        }

        Stream stdin = Console.OpenStandardInput();
        byte[] readBuf = new byte[BUFFER_SIZE];
        int readLen = 0;
        int bufIndex = 0;
        long totalIn = 0;
        var lastData = DateTime.Now;
        var lastLog = DateTime.MinValue;
        bool[] doneMask = new bool[NUM_BUFFERS];

        while (true)
        {
            // 带超时的填充读：凑满一个buffer再播，同时报告活跃状态
            while (readLen < BUFFER_SIZE)
            {
                int avail = stdin.Read(readBuf, readLen, BUFFER_SIZE - readLen);
                if (avail <= 0) { readLen = -1; break; }
                readLen += avail;
                totalIn += avail;
                lastData = DateTime.Now;
            }
            if (readLen < 0) break; // stdin closed

            Marshal.Copy(readBuf, 0, buffers[bufIndex], readLen);

            WAVEHDR hdr = new WAVEHDR();
            hdr.lpData = buffers[bufIndex];
            hdr.dwBufferLength = (uint)readLen;
            hdr.dwFlags = 0;
            hdr.dwLoops = 0;

            Marshal.StructureToPtr(hdr, headers[bufIndex], false);
            int prep = waveOutPrepareHeader(hWaveOut, headers[bufIndex], (uint)Marshal.SizeOf(typeof(WAVEHDR)));
            int wr = waveOutWrite(hWaveOut, headers[bufIndex], (uint)Marshal.SizeOf(typeof(WAVEHDR)));
            if (prep != 0 || wr != 0)
            {
                Console.Error.WriteLine("[audio-player] waveOut Prepare=" + prep + " Write=" + wr + " (failed, restarting...)");
                try { hWaveOut = Restart(hWaveOut, deviceIndex, headers, buffers); }
                catch (Exception ex) { Console.Error.WriteLine("[audio-player] restart failed: " + ex.Message); }
                bufIndex = 0;
                continue;
            }
            // 上一轮用过的 buffer 已播完，清理其 header（flags 会累积导致后续 write 失败）
            int prev = (bufIndex + NUM_BUFFERS - 1) % NUM_BUFFERS;
            if (doneMask[prev]) { waveOutUnprepareHeader(hWaveOut, headers[prev], (uint)Marshal.SizeOf(typeof(WAVEHDR))); doneMask[prev] = false; }
            doneMask[bufIndex] = true;

            bufIndex = (bufIndex + 1) % NUM_BUFFERS;
            readLen = 0;

            // 每60秒报告一次心跳，方便确认进程存活
            if ((DateTime.Now - lastLog).TotalSeconds >= 60)
            {
                lastLog = DateTime.Now;
                Console.Error.WriteLine("[audio-player] streaming, totalIn=" + totalIn);
            }
        }

        waveOutReset(hWaveOut);
        for (int i = 0; i < NUM_BUFFERS; i++)
        {
            waveOutUnprepareHeader(hWaveOut, headers[i], (uint)Marshal.SizeOf(typeof(WAVEHDR)));
            Marshal.FreeHGlobal(headers[i]);
            Marshal.FreeHGlobal(buffers[i]);
        }
        waveOutClose(hWaveOut);
        Console.Error.WriteLine("Audio device closed.");
    }
}
