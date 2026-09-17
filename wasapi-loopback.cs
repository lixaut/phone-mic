using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

class WasapiLoopback
{
    [DllImport("ole32.dll")]
    static extern int CoInitializeEx(IntPtr pvReserved, int dwCoInit);

    [DllImport("ole32.dll")]
    static extern int CoCreateInstance(ref Guid rclsid, IntPtr pUnkOuter, int dwClsContext, ref Guid riid, out IntPtr ppv);

    [DllImport("ole32.dll")]
    static extern void CoTaskMemFree(IntPtr pv);

    [DllImport("oleaut32.dll")]
    static extern int VariantClear(IntPtr pvarg);

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    // PROPVARIANT for empty activation params
    [StructLayout(LayoutKind.Sequential)]
    struct PROPVARIANT
    {
        public ushort vt;
        public ushort wReserved1;
        public ushort wReserved2;
        public ushort wReserved3;
        public long val;
    }

    const int CLSCTX_ALL = 23;
    const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    const int AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = unchecked((int)0x80000000);
    const int VT_EMPTY = 0;

    static void VTableMemCpy(IntPtr dest, IntPtr src, int count)
    {
        for (int i = 0; i < count; i++)
            Marshal.WriteByte(dest, i, Marshal.ReadByte(src, i));
    }

    static int Main()
    {
        CoInitializeEx(IntPtr.Zero, 2);

        // Create MMDeviceEnumerator
        Guid clsid = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
        Guid iidEnum = new Guid("A95664D2-9614-4F35-A746-DE8DB63617E6");
        IntPtr pEnum;
        int hr = CoCreateInstance(ref clsid, IntPtr.Zero, CLSCTX_ALL, ref iidEnum, out pEnum);
        if (hr != 0 || pEnum == IntPtr.Zero) { Console.Error.WriteLine("ERROR: CoCreateInstance: 0x" + hr.ToString("X8")); return 1; }
        Console.Error.WriteLine("OK: enumerator");

        // Get default audio endpoint via vtable[4]
        IntPtr fnEnum4 = Marshal.ReadIntPtr(Marshal.ReadIntPtr(pEnum), 4 * IntPtr.Size);
        IntPtr pDevice;
        {
            GCHandle hThis = GCHandle.Alloc(pEnum, GCHandleType.Normal);
            IntPtr pThis = Marshal.ReadIntPtr(pEnum);
            // Actually we need to pass pEnum as this
        }

        // Let's use a simpler approach - just use delegate from function pointer
        GetDefaultAudioEndpointDelegate fnGetDefault = (GetDefaultAudioEndpointDelegate)Marshal.GetDelegateForFunctionPointer(
            Marshal.ReadIntPtr(Marshal.ReadIntPtr(pEnum), 4 * IntPtr.Size),
            typeof(GetDefaultAudioEndpointDelegate));
        hr = fnGetDefault(pEnum, 0, 0, out pDevice);
        Marshal.Release(pEnum);
        if (hr != 0 || pDevice == IntPtr.Zero) { Console.Error.WriteLine("ERROR: GetDefaultAudioEndpoint: 0x" + hr.ToString("X8")); return 1; }
        Console.Error.WriteLine("OK: default device");

        // Get device name for debugging (via IPropertyStore)
        // Skip for now, just proceed

        // Activate IAudioClient via vtable[3]
        ActivateDelegate fnActivate = (ActivateDelegate)Marshal.GetDelegateForFunctionPointer(
            Marshal.ReadIntPtr(Marshal.ReadIntPtr(pDevice), 3 * IntPtr.Size),
            typeof(ActivateDelegate));

        Guid iidAC = new Guid("1CB9AD4C-DBFA-473A-AEE7-8FB0AE59ED86");
        IntPtr pAC;
        hr = fnActivate(pDevice, ref iidAC, CLSCTX_ALL, IntPtr.Zero, out pAC);
        if (hr != 0 || pAC == IntPtr.Zero) { Console.Error.WriteLine("ERROR: Activate: 0x" + hr.ToString("X8")); return 1; }
        Marshal.Release(pDevice);
        Console.Error.WriteLine("OK: IAudioClient");

        // GetMixFormat via vtable[8]
        GetMixFormatDelegate fnGetMix = (GetMixFormatDelegate)Marshal.GetDelegateForFunctionPointer(
            Marshal.ReadIntPtr(Marshal.ReadIntPtr(pAC), 8 * IntPtr.Size),
            typeof(GetMixFormatDelegate));
        IntPtr pMixFmt;
        hr = fnGetMix(pAC, out pMixFmt);
        if (hr != 0) { Console.Error.WriteLine("ERROR: GetMixFormat: 0x" + hr.ToString("X8")); Marshal.Release(pAC); return 1; }

        WAVEFORMATEX fmt = (WAVEFORMATEX)Marshal.PtrToStructure(pMixFmt, typeof(WAVEFORMATEX));
        CoTaskMemFree(pMixFmt);
        Console.Error.WriteLine(fmt.nChannels + "ch " + fmt.nSamplesPerSec + "Hz " + fmt.wBitsPerSample + "bit tag=" + fmt.wFormatTag);

        // Initialize with loopback via vtable[3]
        InitializeDelegate fnInit = (InitializeDelegate)Marshal.GetDelegateForFunctionPointer(
            Marshal.ReadIntPtr(Marshal.ReadIntPtr(pAC), 3 * IntPtr.Size),
            typeof(InitializeDelegate));

        Guid sessionGuid = Guid.Empty;
        // PROPVARIANT empty = default
        PROPVARIANT empty = new PROPVARIANT();
        empty.vt = VT_EMPTY;
        IntPtr pEmpty = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(PROPVARIANT)));
        Marshal.StructureToPtr(empty, pEmpty, false);

        hr = fnInit(pAC, 0, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, 10000000, 0, pEmpty, ref sessionGuid);
        if (hr != 0)
        {
            sessionGuid = Guid.Empty;
            hr = fnInit(pAC, 0, AUDCLNT_STREAMFLAGS_LOOPBACK, 10000000, 0, pEmpty, ref sessionGuid);
            if (hr != 0) { Console.Error.WriteLine("ERROR: Initialize: 0x" + hr.ToString("X8")); Marshal.FreeHGlobal(pEmpty); Marshal.Release(pAC); return 1; }
        }
        Marshal.FreeHGlobal(pEmpty);
        Console.Error.WriteLine("OK: initialized");

        // GetService(IAudioCaptureClient) via vtable[9]
        GetServiceDelegate fnGetService = (GetServiceDelegate)Marshal.GetDelegateForFunctionPointer(
            Marshal.ReadIntPtr(Marshal.ReadIntPtr(pAC), 9 * IntPtr.Size),
            typeof(GetServiceDelegate));
        Guid iidCC = new Guid("C8ADBD64-E7ED-4293-92BA-1430F47DA3A8");
        IntPtr pCC;
        hr = fnGetService(pAC, ref iidCC, out pCC);
        if (hr != 0 || pCC == IntPtr.Zero) { Console.Error.WriteLine("ERROR: GetService: 0x" + hr.ToString("X8")); Marshal.Release(pAC); return 1; }
        Console.Error.WriteLine("OK: capture client");

        // Start via vtable[10]
        VoidDelegate fnStart = (VoidDelegate)Marshal.GetDelegateForFunctionPointer(
            Marshal.ReadIntPtr(Marshal.ReadIntPtr(pAC), 10 * IntPtr.Size),
            typeof(VoidDelegate));
        hr = fnStart(pAC);
        if (hr != 0) { Console.Error.WriteLine("ERROR: Start: 0x" + hr.ToString("X8")); Marshal.Release(pCC); Marshal.Release(pAC); return 1; }

        // GetNextPacketSize via vtable[4]
        UIntOutDelegate fnPacketSize = (UIntOutDelegate)Marshal.GetDelegateForFunctionPointer(
            Marshal.ReadIntPtr(Marshal.ReadIntPtr(pCC), 4 * IntPtr.Size),
            typeof(UIntOutDelegate));

        // GetBuffer via vtable[3]
        GetBufferDelegate fnGetBuffer = (GetBufferDelegate)Marshal.GetDelegateForFunctionPointer(
            Marshal.ReadIntPtr(Marshal.ReadIntPtr(pCC), 3 * IntPtr.Size),
            typeof(GetBufferDelegate));

        // ReleaseBuffer via vtable[5]
        UIntVoidDelegate fnReleaseBuffer = (UIntVoidDelegate)Marshal.GetDelegateForFunctionPointer(
            Marshal.ReadIntPtr(Marshal.ReadIntPtr(pCC), 5 * IntPtr.Size),
            typeof(UIntVoidDelegate));

        Console.Error.WriteLine("WASAPI loopback streaming...");
        Stream stdout = Console.OpenStandardOutput();

        while (true)
        {
            uint packetSize;
            hr = fnPacketSize(pCC, out packetSize);
            if (hr != 0) break;

            if (packetSize > 0)
            {
                IntPtr dataPtr;
                uint numFrames, flags, devPos, qpcPos;
                hr = fnGetBuffer(pCC, out dataPtr, out numFrames, out flags, out devPos, out qpcPos);
                if (hr != 0) continue;

                int totalBytes = (int)(numFrames * fmt.nBlockAlign);
                byte[] rawData = new byte[totalBytes];
                Marshal.Copy(dataPtr, rawData, 0, totalBytes);
                fnReleaseBuffer(pCC, numFrames);

                byte[] ob = ToMono(rawData, fmt.nChannels, fmt.wBitsPerSample, (int)numFrames);
                if (ob != null) stdout.Write(ob, 0, ob.Length);
            }
            else
            {
                Thread.Sleep(1);
            }
        }

        VoidDelegate fnStop = (VoidDelegate)Marshal.GetDelegateForFunctionPointer(
            Marshal.ReadIntPtr(Marshal.ReadIntPtr(pAC), 11 * IntPtr.Size),
            typeof(VoidDelegate));
        fnStop(pAC);
        Marshal.Release(pCC);
        Marshal.Release(pAC);
        Console.Error.WriteLine("Stopped.");
        return 0;
    }

    // Delegate types for COM methods (stdcall)
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int GetDefaultAudioEndpointDelegate(IntPtr _this, int dataFlow, int role, out IntPtr ppEndpoint);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int ActivateDelegate(IntPtr _this, ref Guid iid, int dwClsCtx, IntPtr pActivationParams, out IntPtr ppInterface);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int GetMixFormatDelegate(IntPtr _this, out IntPtr ppDeviceFormat);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int InitializeDelegate(IntPtr _this, int shareMode, int streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr pFormat, ref Guid audioSessionGuid);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int GetServiceDelegate(IntPtr _this, ref Guid riid, out IntPtr ppv);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int VoidDelegate(IntPtr _this);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int UIntOutDelegate(IntPtr _this, out uint val);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int GetBufferDelegate(IntPtr _this, out IntPtr ppData, out uint numFramesToRead, out uint dwFlags, out uint devPosition, out uint qpcPosition);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int UIntVoidDelegate(IntPtr _this, uint val);

    static byte[] ToMono(byte[] raw, int ch, int bps, int fc)
    {
        if (ch == 2 && bps == 16)
        {
            byte[] ob = new byte[fc * 2];
            for (int i = 0; i < fc; i++)
            {
                short l = BitConverter.ToInt16(raw, i * 4);
                short r = BitConverter.ToInt16(raw, i * 4 + 2);
                short m = (short)((l + r) / 2);
                ob[i * 2] = (byte)(m & 0xFF);
                ob[i * 2 + 1] = (byte)((m >> 8) & 0xFF);
            }
            return ob;
        }
        if (ch == 1 && bps == 16) return raw;
        if (bps == 32)
        {
            byte[] ob = new byte[fc * 2];
            int bpf = ch * 4;
            for (int i = 0; i < fc; i++)
            {
                float sum = 0;
                for (int c = 0; c < ch; c++)
                    sum += BitConverter.ToSingle(raw, i * bpf + c * 4);
                float m = Math.Max(-1f, Math.Min(1f, sum / ch));
                short s = (short)(m < 0 ? m * 0x8000 : m * 0x7FFF);
                ob[i * 2] = (byte)(s & 0xFF);
                ob[i * 2 + 1] = (byte)((s >> 8) & 0xFF);
            }
            return ob;
        }
        return null;
    }
}
