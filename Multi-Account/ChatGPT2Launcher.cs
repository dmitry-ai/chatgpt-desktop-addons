using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class ChatGPT2Launcher {
    [DllImport("iphlpapi.dll", SetLastError = true)]
    public static extern uint GetExtendedTcpTable(
        IntPtr pTcpTable, ref int dwOutBufLen, bool sort,
        int ipVersion, TCP_TABLE_CLASS tblClass, uint reserved);

    public enum TCP_TABLE_CLASS {
        TCP_TABLE_BASIC_LISTENER,
        TCP_TABLE_BASIC_CONNECTIONS,
        TCP_TABLE_BASIC_ALL,
        TCP_TABLE_OWNER_PID_LISTENER,
        TCP_TABLE_OWNER_PID_CONNECTIONS,
        TCP_TABLE_OWNER_PID_ALL,
        TCP_TABLE_OWNER_MODULE_LISTENER,
        TCP_TABLE_OWNER_MODULE_CONNECTIONS,
        TCP_TABLE_OWNER_MODULE_ALL
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MIB_TCPROW_OWNER_PID {
        public uint state;
        public uint localAddr;
        public byte localPort1;
        public byte localPort2;
        public byte localPort3;
        public byte localPort4;
        public uint remoteAddr;
        public byte remotePort1;
        public byte remotePort2;
        public byte remotePort3;
        public byte remotePort4;
        public int owningPid;

        public ushort LocalPort {
            get { return (ushort)((localPort1 << 8) | localPort2); }
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcess(
        string lpApplicationName,
        string lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetThreadDesktop(IntPtr hDesktop);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseDesktop(IntPtr hDesktop);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern bool SetWindowText(IntPtr hWnd, string lpString);

    [DllImport("user32.dll")]
    public static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr hWnd, uint Msg, UIntPtr wParam, IntPtr lParam,
        uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern IntPtr LoadImage(
        IntPtr hInst, string lpszName, uint uType,
        int cxDesired, int cyDesired, uint fuLoad);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("shell32.dll", SetLastError = true)]
    public static extern int SHGetPropertyStoreForWindow(
        IntPtr hwnd, ref Guid riid, out IPropertyStore ppv);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left, Top, Right, Bottom;
        public int Width { get { return Right - Left; } }
        public int Height { get { return Bottom - Top; } }
    }

    public const uint WM_GETICON = 0x007F;
    public const uint WM_SETICON = 0x0080;
    public const uint ICON_SMALL = 0;
    public const uint ICON_BIG = 1;
    public const uint IMAGE_ICON = 1;
    public const uint LR_LOADFROMFILE = 0x0010;
    public const uint SMTO_ABORTIFHUNG = 0x0002;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOZORDER = 0x0004;
    public const uint SWP_FRAMECHANGED = 0x0020;
    public const int SW_RESTORE = 9;
    public const int SW_SHOW = 5;
    public const uint GENERIC_ALL = 0x10000000;
    public const int CDP_PORT_C2 = 9224;

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    public struct PROPERTYKEY {
        public Guid fmtid;
        public uint pid;
        public PROPERTYKEY(Guid guid, uint id) {
            fmtid = guid;
            pid = id;
        }
    }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    public struct PROPVARIANT {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(2)] public ushort wReserved1;
        [FieldOffset(4)] public ushort wReserved2;
        [FieldOffset(6)] public ushort wReserved3;
        [FieldOffset(8)] public IntPtr pwszVal;
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore {
        int GetCount(out uint cProps);
        int GetAt(uint iProp, out PROPERTYKEY pkey);
        int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
        int SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
        int Commit();
    }

    private static IntPtr s_hDesktop = IntPtr.Zero;

    public static void InitDesktop() {
        if (s_hDesktop == IntPtr.Zero) {
            try {
                s_hDesktop = OpenDesktop("Default", 0, false, GENERIC_ALL);
                if (s_hDesktop != IntPtr.Zero) {
                    bool ok = SetThreadDesktop(s_hDesktop);
                    Log(string.Format("InitDesktop attached (handle=0x{0:X}, success={1})", s_hDesktop.ToInt64(), ok));
                }
            } catch { }
        }
    }

    private static readonly PROPERTYKEY PKEY_AppUserModel_ID =
        new PROPERTYKEY(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);

    private static readonly PROPERTYKEY PKEY_AppUserModel_RelaunchIconResource =
        new PROPERTYKEY(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 3);

    private static string logPath = "";

    public static void Log(string msg) {
        try {
            string line = string.Format("[{0:yyyy-MM-dd HH:mm:ss.fff}] {1}", DateTime.Now, msg);
            File.AppendAllText(logPath, line + Environment.NewLine);
        } catch { }
    }

    public static int GetPidForPort(int port) {
        int buffSize = 0;
        GetExtendedTcpTable(IntPtr.Zero, ref buffSize, true, 2, TCP_TABLE_CLASS.TCP_TABLE_OWNER_PID_ALL, 0);
        if (buffSize <= 0) return 0;
        IntPtr buffTable = Marshal.AllocHGlobal(buffSize);
        try {
            if (GetExtendedTcpTable(buffTable, ref buffSize, true, 2, TCP_TABLE_CLASS.TCP_TABLE_OWNER_PID_ALL, 0) == 0) {
                int entries = Marshal.ReadInt32(buffTable);
                IntPtr rowPtr = (IntPtr)((long)buffTable + 4);
                int rowSize = Marshal.SizeOf(typeof(MIB_TCPROW_OWNER_PID));
                for (int i = 0; i < entries; i++) {
                    var row = (MIB_TCPROW_OWNER_PID)Marshal.PtrToStructure(rowPtr, typeof(MIB_TCPROW_OWNER_PID));
                    if (row.LocalPort == port) {
                        return row.owningPid;
                    }
                    rowPtr = (IntPtr)((long)rowPtr + rowSize);
                }
            }
        } catch { } finally {
            Marshal.FreeHGlobal(buffTable);
        }
        return 0;
    }

    private static IntPtr WaitForWindow(int pid, int timeoutMs) {
        int elapsed = 0;
        while (elapsed < timeoutMs) {
            var hwnds = FindVisibleWindowsForProcess(pid);
            if (hwnds.Count > 0) return hwnds[0];
            Thread.Sleep(40);
            elapsed += 40;
        }
        return IntPtr.Zero;
    }

    [STAThread]
    public static void Main(string[] args) {
        var sw = Stopwatch.StartNew();
        string appDir = AppDomain.CurrentDomain.BaseDirectory;
        logPath = Path.Combine(appDir, "launcher.log");
        Log("=== ChatGPT2Launcher invoked ===");
        InitDesktop();

        string profileDir = @"C:\Users\dfedi\AppData\Roaming\Codex-Profile2";
        string icoPath = Path.Combine(appDir, "ChatGPT2.ico");
        string appId = "OpenAI.Codex.Profile2";
        string aliasExe = @"C:\Users\dfedi\AppData\Local\Microsoft\WindowsApps\ChatGPT2.exe";

        bool createdNew;
        Mutex mutex = null;
        try {
            mutex = new Mutex(true, @"Local\ChatGPT2Launcher_SingleInstance_Mutex", out createdNew);
        } catch (AbandonedMutexException) {
            createdNew = true;
        }

        if (!createdNew) {
            InitDesktop();
            int pid = GetPidForPort(CDP_PORT_C2);
            if (pid != 0) {
                var hwnds = FindVisibleWindowsForProcess(pid);
                if (hwnds.Count > 0) {
                    ActivateHwnd(hwnds[0]);
                    Log(string.Format("Secondary click activated existing window in {0} ms (PID: {1}, HWND: 0x{2:X}).",
                        sw.ElapsedMilliseconds, pid, hwnds[0].ToInt64()));
                    if (mutex != null) mutex.Close();
                    return;
                }
            }

            // No window yet. Wait up to 10 seconds for primary launch to display its window.
            Log("Secondary click: waiting for window to appear from primary launch...");
            for (int i = 0; i < 200; i++) {
                Thread.Sleep(50);
                if (pid == 0) pid = GetPidForPort(CDP_PORT_C2);
                if (pid != 0) {
                    var hwnds = FindVisibleWindowsForProcess(pid);
                    if (hwnds.Count > 0) {
                        ActivateHwnd(hwnds[0]);
                        Log(string.Format("Secondary click caught newly created window in {0} ms (PID: {1}, HWND: 0x{2:X}).",
                            sw.ElapsedMilliseconds, pid, hwnds[0].ToInt64()));
                        if (mutex != null) mutex.Close();
                        return;
                    }
                }
            }

            // Primary launch timed out without any window. Clean up zombie and take ownership.
            Log("Secondary click: Primary launch timed out with 0 windows. Cleaning up...");
            if (pid != 0) {
                KillProcessTree(pid);
            }
            KillOtherLaunchers();
            Thread.Sleep(150);

            if (mutex != null) {
                try { mutex.Close(); } catch { }
            }
            try {
                mutex = new Mutex(true, @"Local\ChatGPT2Launcher_SingleInstance_Mutex", out createdNew);
            } catch (AbandonedMutexException) {
                createdNew = true;
            }
        }

        // Primary supervisor instance
        int existingPid = GetPidForPort(CDP_PORT_C2);
        if (existingPid != 0) {
            var visibleHwnds = FindVisibleWindowsForProcess(existingPid);
            if (visibleHwnds.Count > 0) {
                Log(string.Format("Found active C2 PID {0} with window in {1} ms.", existingPid, sw.ElapsedMilliseconds));
                RunSupervisor(existingPid, visibleHwnds[0], icoPath, appId);
                if (mutex != null) {
                    try { mutex.ReleaseMutex(); } catch { }
                    mutex.Close();
                }
                return;
            } else {
                Log(string.Format("Found headless zombie C2 PID {0}. Terminating to free lockfile...", existingPid));
                KillProcessTree(existingPid);
                Thread.Sleep(200);
            }
        }

        if (!Directory.Exists(profileDir)) {
            Directory.CreateDirectory(profileDir);
        }

        // Cold Launch
        Log("Launching ChatGPT2.exe (Cold Start)...");
        LaunchProcess(aliasExe, profileDir);

        int targetPid = 0;
        IntPtr targetHwnd = IntPtr.Zero;

        for (int i = 0; i < 250; i++) {
            Thread.Sleep(40);
            if (targetPid == 0) {
                targetPid = GetPidForPort(CDP_PORT_C2);
            }
            if (targetPid != 0) {
                targetHwnd = WaitForWindow(targetPid, 80);
                if (targetHwnd != IntPtr.Zero) break;
            }
        }

        sw.Stop();
        Log(string.Format("ChatGPT2 window ready in {0} ms (PID: {1}, HWND: 0x{2:X})",
            sw.ElapsedMilliseconds, targetPid, targetHwnd.ToInt64()));

        if (targetPid != 0) {
            RunSupervisor(targetPid, targetHwnd, icoPath, appId);
        }

        if (mutex != null) {
            try { mutex.ReleaseMutex(); } catch { }
            mutex.Close();
        }

        Log("=== ChatGPT2Launcher supervisor exited cleanly ===");
    }

    private static void LaunchProcess(string aliasExe, string profileDir) {
        try {
            var si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            si.lpDesktop = @"WinSta0\Default";

            PROCESS_INFORMATION pi;
            string cmd = string.Format("cmd.exe /c start \"\" \"{0}\" --remote-debugging-port={1}", aliasExe, CDP_PORT_C2);

            Environment.SetEnvironmentVariable("CODEX_HOME", profileDir);
            Environment.SetEnvironmentVariable("CODEX_ELECTRON_USER_DATA_PATH", profileDir);

            if (CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out pi)) {
                CloseHandle(pi.hProcess);
                CloseHandle(pi.hThread);
            } else {
                var psi = new ProcessStartInfo();
                psi.FileName = "cmd.exe";
                psi.Arguments = "/c start \"\" \"" + aliasExe + "\" --remote-debugging-port=" + CDP_PORT_C2;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                psi.EnvironmentVariables["CODEX_HOME"] = profileDir;
                psi.EnvironmentVariables["CODEX_ELECTRON_USER_DATA_PATH"] = profileDir;
                Process.Start(psi);
            }
        } catch (Exception ex) {
            Log("LaunchProcess error: " + ex.Message);
        }
    }

    private static void ActivateHwnd(IntPtr hwnd) {
        if (hwnd == IntPtr.Zero) return;
        try {
            InitDesktop();
            IntPtr fg = GetForegroundWindow();
            uint fgThread = 0;
            if (fg != IntPtr.Zero) {
                GetWindowThreadProcessId(fg, out fgThread);
            }
            uint curThread = GetCurrentThreadId();

            if (fgThread != 0 && fgThread != curThread) {
                AttachThreadInput(curThread, fgThread, true);
            }

            RECT r;
            GetWindowRect(hwnd, out r);
            bool isChromiumMinimized = (r.Left <= -10000 && r.Top <= -10000);

            if (IsIconic(hwnd) || isChromiumMinimized) {
                ShowWindow(hwnd, SW_RESTORE);
            } else {
                ShowWindow(hwnd, SW_SHOW);
            }
            BringWindowToTop(hwnd);
            SetForegroundWindow(hwnd);

            if (fgThread != 0 && fgThread != curThread) {
                AttachThreadInput(curThread, fgThread, false);
            }

            Log(string.Format("ForceForeground activated window HWND 0x{0:X}", hwnd.ToInt64()));
        } catch { }
    }

    private static void RunSupervisor(int targetPid, IntPtr initialHwnd, string icoPath, string appId) {
        InitDesktop();

        IntPtr hBig = LoadImage(IntPtr.Zero, icoPath, IMAGE_ICON, 32, 32, LR_LOADFROMFILE);
        IntPtr hSmall = LoadImage(IntPtr.Zero, icoPath, IMAGE_ICON, 16, 16, LR_LOADFROMFILE);
        ulong expSmVal = (ulong)(hSmall.ToInt64() & 0xFFFFFFFFL);
        Log(string.Format("Supervisor initialized: hBig=0x{0:X}, hSmall=0x{1:X}", hBig.ToInt64(), hSmall.ToInt64()));

        bool hadVisibleWindow = false;

        if (initialHwnd != IntPtr.Zero) {
            ApplyWindowProperties(initialHwnd, hBig, hSmall, icoPath, appId);
            ActivateHwnd(initialHwnd);
            hadVisibleWindow = true;
        }

        int cycle = 0;
        while (true) {
            try {
                Process p = Process.GetProcessById(targetPid);
                if (p.HasExited) {
                    Log("Target PID has exited.");
                    break;
                }
            } catch {
                Log("Target PID not found.");
                break;
            }

            var visibleHwnds = FindVisibleWindowsForProcess(targetPid);
            if (visibleHwnds.Count > 0) {
                hadVisibleWindow = true;

                foreach (var hwnd in visibleHwnds) {
                    UIntPtr curSm;
                    SendMessageTimeout(hwnd, WM_GETICON, (UIntPtr)ICON_SMALL, IntPtr.Zero, SMTO_ABORTIFHUNG, 500, out curSm);
                    ulong curSmVal = curSm.ToUInt64() & 0xFFFFFFFFL;

                    // If icon does not match our basketball icon, reapply immediately
                    if (curSmVal != expSmVal) {
                        Log(string.Format("Detected icon reset on HWND 0x{0:X} (current=0x{1:X}, expected=0x{2:X}). Restoring basketball icon...",
                            hwnd.ToInt64(), curSmVal, expSmVal));
                        ApplyWindowProperties(hwnd, hBig, hSmall, icoPath, appId);
                    } else if (cycle % 10 == 0) {
                        // Periodic reinforcement of window title if Chromium reset it to "ChatGPT"
                        var sb = new StringBuilder(256);
                        GetWindowText(hwnd, sb, 256);
                        if (sb.ToString() == "ChatGPT") {
                            SetWindowText(hwnd, "ChatGPT 2");
                        }
                    }
                }
            } else {
                if (hadVisibleWindow) {
                    Thread.Sleep(2000);
                    var recheck = FindVisibleWindowsForProcess(targetPid);
                    if (recheck.Count == 0) {
                        Log("User closed C2 window. Cleaning up process tree and releasing mutex.");
                        KillProcessTree(targetPid);
                        break;
                    }
                }
            }

            cycle++;
            Thread.Sleep(500);
        }
    }

    private static void ApplyWindowProperties(IntPtr hwnd, IntPtr hBig, IntPtr hSmall, string icoPath, string appId) {
        try {
            UIntPtr res;
            SendMessageTimeout(hwnd, WM_SETICON, (UIntPtr)ICON_BIG, hBig, SMTO_ABORTIFHUNG, 2000, out res);
            SendMessageTimeout(hwnd, WM_SETICON, (UIntPtr)ICON_SMALL, hSmall, SMTO_ABORTIFHUNG, 2000, out res);

            SetWindowText(hwnd, "ChatGPT 2");

            Guid guid = typeof(IPropertyStore).GUID;
            IPropertyStore store;
            int hr = SHGetPropertyStoreForWindow(hwnd, ref guid, out store);
            if (hr == 0 && store != null) {
                PROPVARIANT pvAppId = new PROPVARIANT();
                pvAppId.vt = 31; // VT_LPWSTR
                pvAppId.pwszVal = Marshal.StringToCoTaskMemUni(appId);
                PROPERTYKEY keyAppId = PKEY_AppUserModel_ID;
                store.SetValue(ref keyAppId, ref pvAppId);

                PROPVARIANT pvIcon = new PROPVARIANT();
                pvIcon.vt = 31; // VT_LPWSTR
                pvIcon.pwszVal = Marshal.StringToCoTaskMemUni(icoPath + ",0");
                PROPERTYKEY keyIcon = PKEY_AppUserModel_RelaunchIconResource;
                store.SetValue(ref keyIcon, ref pvIcon);

                store.Commit();
                Marshal.ReleaseComObject(store);
            }

            SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
            Log(string.Format("Basketball icon and properties enforced on HWND 0x{0:X}", hwnd.ToInt64()));
        } catch (Exception ex) {
            Log("ApplyWindowProperties error: " + ex.Message);
        }
    }

    private static List<IntPtr> FindVisibleWindowsForProcess(int pid) {
        var list = new List<IntPtr>();
        EnumWindowsProc proc = (hWnd, lParam) => {
            uint windowPid;
            GetWindowThreadProcessId(hWnd, out windowPid);
            if (windowPid == (uint)pid) {
                var sbClass = new StringBuilder(256);
                GetClassName(hWnd, sbClass, 256);
                string cls = sbClass.ToString();
                if (cls.StartsWith("Chrome_WidgetWin_1")) {
                    if (IsWindowVisible(hWnd)) {
                        RECT r;
                        GetWindowRect(hWnd, out r);
                        bool isChromiumMinimized = (r.Left <= -10000 && r.Top <= -10000);
                        if (isChromiumMinimized || IsIconic(hWnd) || (r.Width > 200 && r.Height > 200)) {
                            list.Add(hWnd);
                        }
                    }
                }
            }
            return true;
        };

        try {
            EnumWindows(proc, IntPtr.Zero);
            if (list.Count > 0) return list;

            IntPtr hDesk = OpenDesktop("Default", 0, false, GENERIC_ALL);
            if (hDesk != IntPtr.Zero) {
                EnumDesktopWindows(hDesk, proc, IntPtr.Zero);
                CloseDesktop(hDesk);
            }
        } catch { }
        return list;
    }

    private static void KillOtherLaunchers() {
        int currentPid = Process.GetCurrentProcess().Id;
        foreach (var p in Process.GetProcessesByName("ChatGPT2Launcher")) {
            if (p.Id != currentPid) {
                try { p.Kill(); } catch { }
            }
        }
    }

    private static void KillProcessTree(int rootPid) {
        try {
            var psi = new ProcessStartInfo();
            psi.FileName = "taskkill.exe";
            psi.Arguments = string.Format("/PID {0} /T /F", rootPid);
            psi.CreateNoWindow = true;
            psi.UseShellExecute = false;
            var proc = Process.Start(psi);
            proc.WaitForExit(3000);
        } catch { }
    }
}
