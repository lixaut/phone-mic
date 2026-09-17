using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

class LoopbackCapture
{
    const int WAVE_FORMAT_PCM = 0x0001;
    const int SAMPLE_RATE = 48000;
    const int CAP_CHANNELS = 2;
    const int BITS_PER_SAMPLE = 16;
    const int CAP_BLOCK_ALIGN = CAP_CHANNELS * BITS_PER_SAMPLE / 8;
    const int BUFFER_SIZE = 960 * CAP_BLOCK_ALIGN;
    const int CBWH = 48;
    const int NUM_BUFFERS = 8;
    const int WIM_DATA = 0x3C0;

    delegate void WaveInProc(IntPtr hwi, int uMsg, int dwInstance, IntPtr dwParam1, IntPtr dwParam2);

    [DllImport("winmm.dll")] static extern int waveInGetNumDevs();
    [DllImport("winmm.dll", CharSet=CharSet.Unicode)] static extern int waveInGetDevCapsW(int uDeviceID, IntPtr pCaps, int cbCaps);
    [DllImport("winmm.dll")] static extern int waveInOpen(out IntPtr phwi, int uDeviceID, IntPtr pwfx, WaveInProc cb, int dwCallbackInstance, int fdwOpen);
    [DllImport("winmm.dll")] static extern int waveInClose(IntPtr hwi);
    [DllImport("winmm.dll")] static extern int waveInPrepareHeader(IntPtr hwi, IntPtr pwh, int cbwh);
    [DllImport("winmm.dll")] static extern int waveInAddBuffer(IntPtr hwi, IntPtr pwh, int cbwh);
    [DllImport("winmm.dll")] static extern int waveInStart(IntPtr hwi);
    [DllImport("winmm.dll")] static extern int waveInReset(IntPtr hwi);

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

    static IntPtr hWaveIn;
    static IntPtr[] hdrPtrs = new IntPtr[NUM_BUFFERS];
    static IntPtr[] dataPtrs = new IntPtr[NUM_BUFFERS];
    static IntPtr[] userData = new IntPtr[NUM_BUFFERS]; // hdrPtr -> dataPtr mapping
    static Stream stdoutStream;
    static long totalBytes = 0;
    static WaveInProc callbackProc;

    static void CaptureCallback(IntPtr hwi, int msg, int inst, IntPtr p1, IntPtr p2)
    {
        if (msg != WIM_DATA) return;
        WAVEHDR hdr = (WAVEHDR)Marshal.PtrToStructure(p1, typeof(WAVEHDR));
        int recorded = (int)hdr.dwBytesRecorded;
        if (recorded > 0)
        {
            byte[] rawBuf = new byte[recorded];
            Marshal.Copy(hdr.lpData, rawBuf, 0, recorded);

            // stereo -> mono mixdown
            int stereoFrames = recorded / CAP_BLOCK_ALIGN;
            byte[] outBuf = new byte[stereoFrames * 2];
            for (int f = 0; f < stereoFrames; f++)
            {
                int l = BitConverter.ToInt16(rawBuf, f * 4);
                int r = BitConverter.ToInt16(rawBuf, f * 4 + 2);
                short mix = (short)((l + r) / 2);
                outBuf[f * 2] = (byte)(mix & 0xFF);
                outBuf[f * 2 + 1] = (byte)((mix >> 8) & 0xFF);
            }
            try
            {
                stdoutStream.Write(outBuf, 0, outBuf.Length);
                stdoutStream.Flush();
                totalBytes += outBuf.Length;
            }
            catch { Environment.Exit(0); }
        }
        // requeue this buffer
        waveInAddBuffer(hWaveIn, p1, CBWH);
    }

    static int FindCableOutput()
    {
        int numDevs = waveInGetNumDevs();
        Console.Error.WriteLine("Found " + numDevs + " input devices");
        IntPtr caps = Marshal.AllocHGlobal(256);
        int target = -1;

        for (int i = 0; i < numDevs; i++)
        {
            waveInGetDevCapsW(i, caps, 256);
            byte[] buf = new byte[256];
            Marshal.Copy(caps, buf, 0, 256);
            char[] chars = new char[32];
            for (int j = 0; j < 32; j++)
            {
                ushort ch = BitConverter.ToUInt16(buf, 8 + j * 2);
                if (ch == 0) break;
                chars[j] = (char)ch;
            }
            string name = new string(chars).TrimEnd('\0');
            Console.Error.WriteLine("  [" + i + "] " + name);
            if (name.ToLower().Contains("cable output"))
            {
                target = i;
                Console.Error.WriteLine("  -> Found VB-CABLE Output");
            }
        }
        Marshal.FreeHGlobal(caps);
        return target;
    }

    static void Main()
    {
        int devIdx = FindCableOutput();
        if (devIdx < 0)
        {
            Console.Error.WriteLine("ERROR: VB-CABLE Output not found");
            Environment.Exit(1);
        }

        IntPtr fmt = Marshal.AllocHGlobal(18);
        Marshal.WriteInt16(fmt, 0, WAVE_FORMAT_PCM);
        Marshal.WriteInt16(fmt, 2, (short)CAP_CHANNELS);
        Marshal.WriteInt32(fmt, 4, SAMPLE_RATE);
        Marshal.WriteInt32(fmt, 8, SAMPLE_RATE * CAP_BLOCK_ALIGN);
        Marshal.WriteInt16(fmt, 12, (short)CAP_BLOCK_ALIGN);
        Marshal.WriteInt16(fmt, 14, (short)BITS_PER_SAMPLE);
        Marshal.WriteInt16(fmt, 16, 0);

        callbackProc = CaptureCallback;
        // CALLBACK_FUNCTION (0x00030000) — polling dwFlags doesn't work with VB-CABLE
        int hr = waveInOpen(out hWaveIn, devIdx, fmt, callbackProc, 0, 0x00030000);
        Marshal.FreeHGlobal(fmt);
        if (hr != 0) { Console.Error.WriteLine("waveInOpen failed: " + hr); return; }

        Console.Error.WriteLine("VB-CABLE Output opened (callback mode). Streaming...");

        stdoutStream = Console.OpenStandardOutput();
        for (int i = 0; i < NUM_BUFFERS; i++)
        {
            dataPtrs[i] = Marshal.AllocHGlobal(BUFFER_SIZE);
            hdrPtrs[i] = Marshal.AllocHGlobal(CBWH);

            WAVEHDR hdr = new WAVEHDR();
            hdr.lpData = dataPtrs[i];
            hdr.dwBufferLength = (uint)BUFFER_SIZE;
            Marshal.StructureToPtr(hdr, hdrPtrs[i], false);
            waveInPrepareHeader(hWaveIn, hdrPtrs[i], CBWH);
            waveInAddBuffer(hWaveIn, hdrPtrs[i], CBWH);
        }

        hr = waveInStart(hWaveIn);
        if (hr != 0) { Console.Error.WriteLine("waveInStart failed: " + hr); return; }

        // keep alive; report stats periodically
        while (true)
        {
            Thread.Sleep(5000);
            Console.Error.WriteLine("[loopback] totalMonoBytes=" + totalBytes);
        }
    }
}
