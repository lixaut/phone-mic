Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class Loopback {
    [DllImport("ole32.dll")]
    public static extern int CoInitializeEx(IntPtr pvReserved, int dwCoInit);

    [DllImport("ole32.dll")]
    public static extern int CoCreateInstance(ref Guid rclsid, IntPtr pUnkOuter, int dwClsContext, ref Guid riid, out IntPtr ppv);

    [DllImport("winmm.dll")]
    public static extern int waveOutGetNumDevs();

    [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
    public static extern int waveOutGetDevCapsW(int uDeviceID, IntPtr pCaps, int cbCaps);

    [DllImport("winmm.dll")]
    public static extern int waveOutOpen(out IntPtr hWaveOut, int uDeviceID, IntPtr pFormat, int dwCallback, int dwCallbackInstance, int fdwOpen);

    [DllImport("winmm.dll")]
    public static extern int waveOutClose(IntPtr hWaveOut);

    [DllImport("winmm.dll")]
    public static extern int waveOutPrepareHeader(IntPtr hWaveOut, IntPtr pWaveHdr, int cbWh);

    [DllImport("winmm.dll")]
    public static extern int waveOutUnprepareHeader(IntPtr hWaveOut, IntPtr pWaveHdr, int cbWh);

    [DllImport("winmm.dll")]
    public static extern int waveOutWrite(IntPtr hWaveOut, IntPtr pWaveHdr, int cbWh);

    [DllImport("winmm.dll")]
    public static extern int waveOutReset(IntPtr hWaveOut);
}
"@ -ErrorAction SilentlyContinue

$SampleRate = 48000
$Channels = 1
$BitsPerSample = 16
$BlockAlign = $Channels * $BitsPerSample / 8
$BufferSize = 960 * $BlockAlign

Write-Host "Loopback output to VB-CABLE..."

$numDevs = [Loopback]::waveOutGetNumDevs()
Write-Host "Found $numDevs output devices"

$capsPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(256)
$targetIdx = -1

for ($i = 0; $i -lt $numDevs; $i++) {
    [Loopback]::waveOutGetDevCapsW($i, $capsPtr, 256) | Out-Null
    $name = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($capsPtr + 8, 32)
    Write-Host "  [$i] $name"
    if ($name -like "*CABLE*") {
        $targetIdx = $i
        Write-Host "  -> VB-CABLE found"
    }
}
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($capsPtr)

if ($targetIdx -lt 0) {
    Write-Host "ERROR: VB-CABLE not found"
    exit 1
}

$formatPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(18)
[System.Runtime.InteropServices.Marshal]::WriteInt16($formatPtr, 0, 1)
[System.Runtime.InteropServices.Marshal]::WriteInt16($formatPtr, 2, $Channels)
[System.Runtime.InteropServices.Marshal]::WriteInt32($formatPtr, 4, $SampleRate)
[System.Runtime.InteropServices.Marshal]::WriteInt32($formatPtr, 8, $SampleRate * $BlockAlign)
[System.Runtime.InteropServices.Marshal]::WriteInt16($formatPtr, 12, $BlockAlign)
[System.Runtime.InteropServices.Marshal]::WriteInt16($formatPtr, 14, $BitsPerSample)
[System.Runtime.InteropServices.Marshal]::WriteInt16($formatPtr, 16, 0)

$hWaveOut = [IntPtr]::Zero
$result = [Loopback]::waveOutOpen([ref]$hWaveOut, $targetIdx, $formatPtr, 0, 0, 0)
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($formatPtr)

if ($result -ne 0) {
    Write-Host "ERROR: waveOutOpen failed: $result"
    exit 1
}

Write-Host "Device opened. Reading PCM from stdin..."

$stdin = [System.Console]::OpenStandardInput()
$hdrSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][System.Byte[]](0)) * 48
$buffer = New-Object byte[] $BufferSize

while ($true) {
    $bytesRead = $stdin.Read($buffer, 0, $BufferSize)
    if ($bytesRead -le 0) { break }

    $dataPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytesRead)
    [System.Runtime.InteropServices.Marshal]::Copy($buffer, 0, $dataPtr, $bytesRead)

    $hdr = New-Object byte[] 48
    [System.Runtime.InteropServices.Marshal]::WriteIntPtr([ref]$hdr, 0, $dataPtr)
    [System.Runtime.InteropServices.Marshal]::WriteInt32([ref]$hdr, 8, $bytesRead)

    $hdrPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(48)
    [System.Runtime.InteropServices.Marshal]::Copy($hdr, 0, $hdrPtr, 48)

    [Loopback]::waveOutPrepareHeader($hWaveOut, $hdrPtr, 48) | Out-Null
    [Loopback]::waveOutWrite($hWaveOut, $hdrPtr, 48) | Out-Null
}

[Loopback]::waveOutReset($hWaveOut)
[Loopback]::waveOutClose($hWaveOut)
Write-Host "Done."
