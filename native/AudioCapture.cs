using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

class AudioCapture
{
    static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
    static readonly Guid IID_IAudioSessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
    static readonly Guid IID_IAudioSessionControl2 = new Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d");
    static readonly Guid IID_IMMDeviceEnumerator = new Guid("A95664D2-9614-4F35-A746-DE8DB63617E6");
    static readonly Guid CLSID_MMDeviceEnumerator = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");

    const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    const uint AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = 0x80000000;
    const uint AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000;
    const uint AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
    const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
    static volatile bool capturing = false;

    // ======== P/Invoke ========
    [DllImport("gdi32.dll")]
    static extern int D3DKMTSetProcessSchedulingPriorityClass(IntPtr hProcess, int priorityClass);
    [DllImport("gdi32.dll")]
    static extern int D3DKMTGetProcessSchedulingPriorityClass(IntPtr hProcess, out int priorityClass);
    [DllImport("winmm.dll")]
    static extern uint timeBeginPeriod(uint uPeriod);
    [DllImport("ole32.dll")]
    static extern int CoInitializeEx(IntPtr pvReserved, uint dwCoInit);
    [DllImport("ole32.dll")]
    static extern void CoUninitialize();
    [DllImport("ole32.dll")]
    static extern int CoCreateInstance(
        [MarshalAs(UnmanagedType.LPStruct)] Guid rclsid, IntPtr pUnkOuter, uint dwClsContext,
        [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IntPtr ppv);
    [DllImport("Mmdevapi.dll", PreserveSig = true)]
    static extern int ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
        [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
        IntPtr activationParams, IntPtr completionHandler, out IntPtr activationOperation);

    // ======== Structures ========
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

    // ======== Managed COM Interfaces ========
    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr audioSessionGuid);
        [PreserveSig] int GetBufferSize(out uint numBufferFrames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint numPaddingFrames);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
        [PreserveSig] int GetMixFormat(out IntPtr deviceFormat);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr eventHandle);
        [PreserveSig] int GetService([MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IntPtr service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint numFramesAvailable, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint numFramesRead);
        [PreserveSig] int GetNextPacketSize(out uint numFramesInNextPacket);
    }

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceCompletionHandler
    {
        void ActivateCompleted(IntPtr activateOperation);
    }

    [ComImport, Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAgileObject { }

    // ======== Completion Handler ========
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int GetActivateResultDelegate(IntPtr self, out int activateResult, out IntPtr activatedInterface);

    [ComVisible(true)]
    class ActivationHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public ManualResetEvent CompletionEvent = new ManualResetEvent(false);
        public IntPtr AudioClientPtr;
        public int HResult = unchecked((int)0x80004005);

        public void ActivateCompleted(IntPtr activateOperation)
        {
            try
            {
                IntPtr vt = Marshal.ReadIntPtr(activateOperation);
                var getResult = Marshal.GetDelegateForFunctionPointer<GetActivateResultDelegate>(Marshal.ReadIntPtr(vt, 3 * IntPtr.Size));
                int hr;
                IntPtr iface;
                int callHr = getResult(activateOperation, out hr, out iface);
                if (callHr == 0) { HResult = hr; AudioClientPtr = iface; }
                else { HResult = callHr; }
            }
            catch {}
            finally { CompletionEvent.Set(); }
        }
    }

    // ======== Vtable helpers (only for IMMDevice* which have no managed interface) ========
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int GetDefaultAudioEndpointDelegate(IntPtr self, int dataFlow, int role, out IntPtr device);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int ActivateDelegate(IntPtr self, [MarshalAs(UnmanagedType.LPStruct)] Guid iid, uint clsCtx, IntPtr p, out IntPtr iface);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int GetSessionEnumeratorDelegate(IntPtr self, out IntPtr enumerator);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int GetCountDelegate(IntPtr self, out int count);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int GetSessionDelegate(IntPtr self, int index, out IntPtr session);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int GetProcessIdDelegate(IntPtr self, out uint pid);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int GetStateDelegate(IntPtr self, out int state);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int QueryInterfaceDelegate(IntPtr self, ref Guid riid, out IntPtr ppv);

    static T V<T>(IntPtr obj, int index) where T : class
    {
        IntPtr vt = Marshal.ReadIntPtr(obj);
        return Marshal.GetDelegateForFunctionPointer<T>(Marshal.ReadIntPtr(vt, index * IntPtr.Size));
    }

    static IntPtr GetDefaultDevice()
    {
        IntPtr enumerator;
        CoCreateInstance(CLSID_MMDeviceEnumerator, IntPtr.Zero, 23, IID_IMMDeviceEnumerator, out enumerator);
        IntPtr device;
        V<GetDefaultAudioEndpointDelegate>(enumerator, 4)(enumerator, 0, 0, out device);
        Marshal.Release(enumerator);
        return device;
    }

    static IAudioClient ActivateAudioClientOnDevice(IntPtr device)
    {
        IntPtr ptr;
        V<ActivateDelegate>(device, 3)(device, IID_IAudioClient, 23, IntPtr.Zero, out ptr);
        return (IAudioClient)Marshal.GetObjectForIUnknown(ptr);
    }

    // ======== List Sessions ========
    static void ListAudioSessions()
    {
        CoInitializeEx(IntPtr.Zero, 0);
        try
        {
            IntPtr device = GetDefaultDevice();
            IntPtr sessionManager;
            V<ActivateDelegate>(device, 3)(device, IID_IAudioSessionManager2, 23, IntPtr.Zero, out sessionManager);

            IntPtr sessionEnum;
            V<GetSessionEnumeratorDelegate>(sessionManager, 5)(sessionManager, out sessionEnum);

            int count;
            V<GetCountDelegate>(sessionEnum, 3)(sessionEnum, out count);

            var sessions = new List<string>();
            Guid iid = IID_IAudioSessionControl2;

            for (int i = 0; i < count; i++)
            {
                IntPtr sc;
                V<GetSessionDelegate>(sessionEnum, 4)(sessionEnum, i, out sc);
                IntPtr sc2;
                if (V<QueryInterfaceDelegate>(sc, 0)(sc, ref iid, out sc2) == 0)
                {
                    uint pid;
                    V<GetProcessIdDelegate>(sc2, 14)(sc2, out pid);
                    int state;
                    V<GetStateDelegate>(sc, 3)(sc, out state);
                    if (pid != 0)
                    {
                        string name = "unknown";
                        try { name = Process.GetProcessById((int)pid).ProcessName; } catch {}
                        sessions.Add("{\"pid\":" + pid + ",\"name\":\"" + Esc(name) + "\",\"state\":\"" + (state == 1 ? "active" : "inactive") + "\"}");
                    }
                    Marshal.Release(sc2);
                }
                Marshal.Release(sc);
            }
            WriteJson("{\"sessions\":[" + string.Join(",", sessions) + "]}");
            Marshal.Release(sessionEnum);
            Marshal.Release(sessionManager);
            Marshal.Release(device);
        }
        finally { CoUninitialize(); }
    }

    // ======== System Audio Loopback ========
    static void CaptureSystemAudio()
    {
        CoInitializeEx(IntPtr.Zero, 0);
        try
        {
            IntPtr device = GetDefaultDevice();
            IAudioClient ac = ActivateAudioClientOnDevice(device);

            IntPtr formatPtr;
            ac.GetMixFormat(out formatPtr);
            var fmt = Marshal.PtrToStructure<WAVEFORMATEX>(formatPtr);

            AutoResetEvent evt;
            int hr = InitializeClient(ac, formatPtr, out evt);
            if (hr != 0) { WriteJson("{\"error\":\"Initialize loopback failed: 0x" + hr.ToString("X8") + "\"}"); return; }

            IntPtr ccPtr;
            ac.GetService(IID_IAudioCaptureClient, out ccPtr);
            var cc = (IAudioCaptureClient)Marshal.GetObjectForIUnknown(ccPtr);

            ac.Start();

            WriteJson("{\"started\":true,\"sampleRate\":" + fmt.nSamplesPerSec + ",\"channels\":" + fmt.nChannels + ",\"bitsPerSample\":" + fmt.wBitsPerSample + ",\"mode\":\"system\"}");

            CaptureLoop(cc, fmt, evt);
            ac.Stop();
            Marshal.Release(device);
        }
        finally { CoUninitialize(); }
    }

    // ======== Process Audio Loopback ========
    static void CaptureProcessAudio(uint targetPid)
    {
        CoInitializeEx(IntPtr.Zero, 0);
        try
        {
            // Build AUDIOCLIENT_ACTIVATION_PARAMS
            // Layout: [int ActivationType=1][uint PID][int Mode=0] = 12 bytes
            IntPtr paramsPtr = Marshal.AllocHGlobal(12);
            Marshal.WriteInt32(paramsPtr, 0, 1);  // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
            Marshal.WriteInt32(paramsPtr, 4, (int)targetPid);
            Marshal.WriteInt32(paramsPtr, 8, 0);  // PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE

            // Build PROPVARIANT VT_BLOB (24 bytes on x64)
            IntPtr propVarPtr = Marshal.AllocHGlobal(24);
            for (int i = 0; i < 24; i++) Marshal.WriteByte(propVarPtr, i, 0);
            Marshal.WriteInt16(propVarPtr, 0, 0x0041); // VT_BLOB
            Marshal.WriteInt32(propVarPtr, 8, 12);      // blob.cbSize
            Marshal.WriteIntPtr(propVarPtr, 16, paramsPtr); // blob.pBlobData

            var handler = new ActivationHandler();
            var pin = GCHandle.Alloc(handler);
            IntPtr handlerPtr = Marshal.GetComInterfaceForObject(handler, typeof(IActivateAudioInterfaceCompletionHandler));

            IntPtr asyncOp;
            int hr = ActivateAudioInterfaceAsync("VAD\\Process_Loopback", IID_IAudioClient, propVarPtr, handlerPtr, out asyncOp);

            if (hr != 0)
            {
                Marshal.Release(handlerPtr); pin.Free();
                Marshal.FreeHGlobal(paramsPtr); Marshal.FreeHGlobal(propVarPtr);
                WriteJson("{\"error\":\"ActivateAudioInterfaceAsync failed: 0x" + hr.ToString("X8") + "\"}");
                return;
            }

            if (!handler.CompletionEvent.WaitOne(10000))
            {
                Marshal.Release(handlerPtr); pin.Free();
                WriteJson("{\"error\":\"Activation timed out\"}");
                return;
            }
            Marshal.Release(handlerPtr);

            if (handler.HResult != 0 || handler.AudioClientPtr == IntPtr.Zero)
            {
                pin.Free();
                WriteJson("{\"error\":\"Process loopback result: 0x" + handler.HResult.ToString("X8") + "\"}");
                return;
            }

            // QI for IAudioClient and wrap in managed interface
            Guid iidAC = IID_IAudioClient;
            IntPtr acPtr;
            hr = Marshal.QueryInterface(handler.AudioClientPtr, ref iidAC, out acPtr);
            Marshal.Release(handler.AudioClientPtr);
            pin.Free();
            if (hr != 0) { WriteJson("{\"error\":\"QI IAudioClient: 0x" + hr.ToString("X8") + "\"}"); return; }

            IAudioClient ac = (IAudioClient)Marshal.GetObjectForIUnknown(acPtr);
            Marshal.Release(acPtr);

            // Get format from system device (process loopback doesn't support GetMixFormat)
            IntPtr sysDevice = GetDefaultDevice();
            IAudioClient sysAc = ActivateAudioClientOnDevice(sysDevice);
            IntPtr formatPtr;
            sysAc.GetMixFormat(out formatPtr);
            var fmt = Marshal.PtrToStructure<WAVEFORMATEX>(formatPtr);
            Marshal.ReleaseComObject(sysAc);
            Marshal.Release(sysDevice);

            AutoResetEvent evt;
            hr = InitializeClient(ac, formatPtr, out evt);
            if (hr != 0) { WriteJson("{\"error\":\"Initialize failed: 0x" + hr.ToString("X8") + "\"}"); return; }

            IntPtr ccPtr;
            ac.GetService(IID_IAudioCaptureClient, out ccPtr);
            var cc = (IAudioCaptureClient)Marshal.GetObjectForIUnknown(ccPtr);

            ac.Start();

            WriteJson("{\"started\":true,\"sampleRate\":" + fmt.nSamplesPerSec + ",\"channels\":" + fmt.nChannels + ",\"bitsPerSample\":" + fmt.wBitsPerSample + ",\"mode\":\"process\",\"pid\":" + targetPid + "}");

            CaptureLoop(cc, fmt, evt);
            ac.Stop();
            Marshal.FreeHGlobal(paramsPtr);
            Marshal.FreeHGlobal(propVarPtr);
        }
        finally { CoUninitialize(); }
    }

    // Event-driven when supported; falls back to polling if the event flag is rejected
    static int InitializeClient(IAudioClient ac, IntPtr formatPtr, out AutoResetEvent evt)
    {
        evt = null;
        int hr = ac.Initialize(0, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 200000, 0, formatPtr, IntPtr.Zero);
        if (hr == 0)
        {
            var e = new AutoResetEvent(false);
            if (ac.SetEventHandle(e.SafeWaitHandle.DangerousGetHandle()) == 0) evt = e;
            return 0;
        }
        return ac.Initialize(0, AUDCLNT_STREAMFLAGS_LOOPBACK, 200000, 0, formatPtr, IntPtr.Zero);
    }

    // ======== Capture Loop ========
    static void CaptureLoop(IAudioCaptureClient cc, WAVEFORMATEX fmt, AutoResetEvent evt)
    {
        capturing = true;
        timeBeginPeriod(1);
        var binaryOut = Console.OpenStandardOutput();
        byte[] buf = new byte[4 + 4096];

        while (capturing)
        {
            // Timeout keeps the loop alive even if the device never signals the event
            if (evt != null) evt.WaitOne(10); else Thread.Sleep(2);

            uint packetSize;
            if (cc.GetNextPacketSize(out packetSize) != 0) break;

            while (packetSize > 0 && capturing)
            {
                IntPtr data; uint numFrames, flags; ulong dp, qp;
                int hr = cc.GetBuffer(out data, out numFrames, out flags, out dp, out qp);
                if (hr != 0) break;

                int bytes = (int)(numFrames * fmt.nBlockAlign);
                if (bytes > 0)
                {
                    if (buf.Length < 4 + bytes) buf = new byte[4 + bytes];
                    buf[0] = (byte)bytes; buf[1] = (byte)(bytes >> 8);
                    buf[2] = (byte)(bytes >> 16); buf[3] = (byte)(bytes >> 24);
                    if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) Array.Clear(buf, 4, bytes);
                    else Marshal.Copy(data, buf, 4, bytes);
                    try { binaryOut.Write(buf, 0, 4 + bytes); }
                    catch { capturing = false; }
                }

                cc.ReleaseBuffer(numFrames);
                if (cc.GetNextPacketSize(out packetSize) != 0) { capturing = false; break; }
            }
        }
    }

    // Same approach as OBS: a full-screen game otherwise starves capture/encode of GPU time
    static void SetGpuPriority(string[] args)
    {
        int cls = int.Parse(args[args.Length - 1]);
        var results = new List<string>();
        for (int i = 1; i < args.Length - 1; i++)
        {
            int pid = int.Parse(args[i]);
            try
            {
                using (var p = Process.GetProcessById(pid))
                {
                    int status = D3DKMTSetProcessSchedulingPriorityClass(p.Handle, cls);
                    int now;
                    D3DKMTGetProcessSchedulingPriorityClass(p.Handle, out now);
                    results.Add("{\"pid\":" + pid + ",\"status\":" + status + ",\"class\":" + now + "}");
                }
            }
            catch (Exception ex)
            {
                results.Add("{\"pid\":" + pid + ",\"error\":\"" + Esc(ex.Message) + "\"}");
            }
        }
        WriteJson("{\"gpuPriority\":[" + string.Join(",", results) + "]}");
    }

    static void WriteJson(string json) { Console.Error.WriteLine(json); Console.Error.Flush(); }
    static string Esc(string s) { return s.Replace("\\", "\\\\").Replace("\"", "\\\""); }

    static void Main(string[] args)
    {
        if (args.Length == 0) { Console.Error.WriteLine("Usage: AudioCapture.exe list | capture <pid> | capture-system"); Environment.Exit(1); }

        try
        {
            if (args[0] == "list") { ListAudioSessions(); return; }
            if (args[0] == "gpu-priority" && args.Length > 2) { SetGpuPriority(args); return; }

            var stdinThread = new Thread(() => {
                try { while (true) { string l = Console.In.ReadLine(); if (l == null || l.Trim() == "stop") { capturing = false; break; } } }
                catch { capturing = false; }
            });
            stdinThread.IsBackground = true;
            stdinThread.Start();

            if (args[0] == "capture" && args.Length > 1)
                CaptureProcessAudio(uint.Parse(args[1]));
            else if (args[0] == "capture-system")
                CaptureSystemAudio();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("{\"error\":\"" + Esc(ex.Message) + "\"}");
            Environment.Exit(1);
        }
    }
}
