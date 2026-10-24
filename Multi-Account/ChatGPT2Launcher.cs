using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class ChatGPT2Launcher {
    [DllImport("user32.dll", EntryPoint = "OpenDesktopW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);

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
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hWnd, uint command);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

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
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_FRAMECHANGED = 0x0020;
    public const int SW_RESTORE = 9;
    public const int SW_SHOW = 5;
    public const uint DESKTOP_ACCESS = 0x00C1;
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
        [PreserveSig] int GetCount(out uint cProps);
        [PreserveSig] int GetAt(uint iProp, out PROPERTYKEY pkey);
        [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
        [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
        [PreserveSig] int Commit();
    }


    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyIcon(IntPtr icon);
    [DllImport("user32.dll", EntryPoint = "MessageBoxW", CharSet = CharSet.Unicode)]
    private static extern int MessageBox(IntPtr owner, string text, string title, uint type);

    private const string MutexName = @"Local\ChatGPT2Launcher_SingleInstance_Mutex";
    private const string ActivationName = @"Local\Codex.Profile2.Activate";
    private static IntPtr s_hDesktop;
    private static string logPath;
    private static readonly PROPERTYKEY AppIdKey =
        new PROPERTYKEY(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);
    private static readonly PROPERTYKEY IconKey =
        new PROPERTYKEY(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 3);

    public static void Log(string message) {
        if (logPath == null) return;
        bool owned = false;
        using (var mutex = new Mutex(false, @"Local\Codex.Profile2.Log")) {
            try {
                try { owned = mutex.WaitOne(1000); }
                catch (AbandonedMutexException) { owned = true; }
                if (!owned) { Trace.TraceError(message); return; }
                File.AppendAllText(logPath, string.Format("[{0:yyyy-MM-dd HH:mm:ss.fff}] {1}\r\n", DateTime.Now, message));
            } catch (IOException ex) {
                Trace.TraceError("Launcher log failed: " + ex.Message);
            } catch (UnauthorizedAccessException ex) {
                Trace.TraceError("Launcher log failed: " + ex.Message);
            } finally {
                if (owned) mutex.ReleaseMutex();
            }
        }
    }

    [STAThread]
    public static int Main(string[] args) {
        string appDir = AppDomain.CurrentDomain.BaseDirectory;
        string profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Codex-Profile2");
        logPath = Path.Combine(profile, "launcher.log");
        string alias = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            @"Microsoft\WindowsApps\ChatGPT2.exe");
        bool diagnostic = args.Length == 1 && args[0] == "--repair-alias";
        Log("=== ChatGPT2Launcher invoked ===");
        bool owned = false;
        using (var mutex = new Mutex(false, MutexName)) {
            try {
                if (args.Length > 0 && !diagnostic) throw new ArgumentException("Supported option: --repair-alias");
                if (diagnostic) { RepairAlias(alias); return 0; }
                try { owned = mutex.WaitOne(0); }
                catch (AbandonedMutexException) { owned = true; }
                if (!owned) {
                    SignalActivation();
                    Log("Existing supervisor notified; no second application was launched.");
                    return 0;
                }
                using (var activation = new EventWaitHandle(false, EventResetMode.AutoReset, ActivationName)) {
                    s_hDesktop = OpenDesktop("Default", 0, false, DESKTOP_ACCESS);
                    if (s_hDesktop == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot open the interactive desktop.");
                    Directory.CreateDirectory(profile);
                    Process existing = C2Process.FindExisting(alias, CDP_PORT_C2);
                    using (Process target = existing ?? Launch(alias, profile)) {
                        if (!CodexPackage.Owns(target)) throw new InvalidOperationException("The launched process is not a Codex package.");
                        if (existing != null) {
                            RequestApplicationWindow(alias, profile);
                            Log("Existing C2 activation requested through the application.");
                        }
                        var timer = Stopwatch.StartNew();
                        IntPtr window = IntPtr.Zero;
                        while (timer.ElapsedMilliseconds < 30000) {
                            if (target.HasExited) throw new InvalidOperationException("Codex exited before creating its window (exit code " + target.ExitCode + ").");
                            var windows = FindVisibleWindowsForProcess(target.Id, s_hDesktop);
                            if (windows.Count > 0) { window = windows[0]; break; }
                            Thread.Sleep(100);
                        }
                        if (window == IntPtr.Zero) throw new TimeoutException("Codex did not create its window within 30 seconds.");
                        Log(string.Format("C2 ready (PID: {0}, HWND: 0x{1:X}, window wait: {2} ms).", target.Id, window.ToInt64(), timer.ElapsedMilliseconds));
                        RunSupervisor(target, window, Path.Combine(appDir, "ChatGPT2.ico"), activation,
                            s_hDesktop, () => RequestApplicationWindow(alias, profile));
                    }
                }
                Log("=== C2 supervisor exited cleanly ===");
                return 0;
            } catch (Exception ex) {
                Log("ERROR: " + ex);
                if (!diagnostic) MessageBox(IntPtr.Zero,
                    "Не удалось открыть второй профиль Codex.\n\n" + ex.Message + "\n\nЖурнал: " + logPath,
                    "Codex — C2", 0x10);
                return 1;
            } finally {
                if (s_hDesktop != IntPtr.Zero) { CloseDesktop(s_hDesktop); s_hDesktop = IntPtr.Zero; }
                if (owned) mutex.ReleaseMutex();
            }
        }
    }

    private static void SignalActivation() {
        for (int i = 0; i < 40; i++) {
            try {
                using (var activation = EventWaitHandle.OpenExisting(ActivationName)) { activation.Set(); return; }
            } catch (WaitHandleCannotBeOpenedException) {
                Thread.Sleep(50); // Primary supervisor is creating the event.
            }
        }
        throw new TimeoutException("The existing C2 supervisor is not responding.");
    }

    private static bool IsTransientPackageError(int win32Error, int hresult) {
        return win32Error == 2 || win32Error == 3 || win32Error == 5 ||
               win32Error == 15600 || win32Error == 15602 || win32Error == 15618 || win32Error == 15631 ||
               hresult == unchecked((int)0x80004005) ||
               hresult == unchecked((int)0x80073D02) ||
               hresult == unchecked((int)0x80073D0F) ||
               hresult == unchecked((int)0x800700E9);
    }

    private static CodexPackage RepairAlias(string alias) {
        CodexPackage package = CodexPackage.Resolve(Log);
        if (CodexPackage.NeedsRegistration(package.FullName)) {
            CodexPackage.EnsureRegistered(package, Log);
        }
        bool changed = AppExecLink.Ensure(alias, CodexPackage.Family, package.AppUserModelId, package.Executable);
        Log(string.Format("Execution alias {0}: {1}; app ID: {2}.",
            changed ? "repaired" : "verified", package.Executable, package.AppUserModelId));
        return package;
    }

    private static Process Launch(string alias, string profile) {
        var candidates = CodexPackage.SelectCandidates(CodexPackage.Installed(), Log);
        if (candidates.Count == 0)
            throw new FileNotFoundException("No registered Codex package has a valid desktop application and executable.");

        Exception lastException = null;
        for (int i = 0; i < candidates.Count; i++) {
            CodexPackage package = candidates[i];
            bool isLastCandidate = (i == candidates.Count - 1);
            for (int attempt = 1; attempt <= 3; attempt++) {
                try {
                    if (CodexPackage.NeedsRegistration(package.FullName)) {
                        CodexPackage.EnsureRegistered(package, Log);
                    }
                    bool changed = AppExecLink.Ensure(alias, CodexPackage.Family, package.AppUserModelId, package.Executable);
                    Log(string.Format("Execution alias {0}: {1}; app ID: {2}.",
                        changed ? "repaired" : "verified", package.Executable, package.AppUserModelId));
                    return C2Process.Start(alias, profile, Path.GetDirectoryName(package.Executable), CDP_PORT_C2);
                } catch (FileNotFoundException ex) {
                    lastException = ex;
                    if (attempt == 3 || isLastCandidate) break;
                    Log("Package candidate " + package.FullName + " not found; retry " + attempt + ": " + ex.Message);
                    Thread.Sleep(1000);
                } catch (Win32Exception ex) {
                    lastException = ex;
                    Log(string.Format("Package candidate {0} launch failed (Win32 {1} / HRESULT 0x{2:X}): {3}",
                        package.FullName, ex.NativeErrorCode, ex.ErrorCode, ex.Message));
                    if (attempt < 3 && IsTransientPackageError(ex.NativeErrorCode, ex.ErrorCode)) {
                        CodexPackage.EnsureRegistered(package, Log);
                        Log("Package launch may be updating; retry " + attempt);
                        Thread.Sleep(1500);
                        continue;
                    }
                    if (!isLastCandidate) {
                        Log("Falling back to next available installed package candidate: " + candidates[i + 1].FullName);
                    }
                    break;
                }
            }
        }
        throw lastException ?? new InvalidOperationException("Failed to launch any installed Codex package.");
    }

    private static void RequestApplicationWindow(string alias, string profile) {
        CodexPackage package = RepairAlias(alias);
        C2Process.RequestActivation(alias, profile, Path.GetDirectoryName(package.Executable), CDP_PORT_C2);
    }

    internal static void RunSupervisor(Process target, IntPtr window, string iconPath,
        EventWaitHandle activation, IntPtr desktop, Action requestApplicationWindow) {
        IntPtr big = LoadImage(IntPtr.Zero, iconPath, IMAGE_ICON, 32, 32, LR_LOADFROMFILE);
        IntPtr small = LoadImage(IntPtr.Zero, iconPath, IMAGE_ICON, 16, 16, LR_LOADFROMFILE);
        try {
            if (big == IntPtr.Zero || small == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot load the C2 icon.");
            ApplyWindowProperties(window, big, small, iconPath);
            // A recreated window (destroyed old HWND) is not process termination,
            // but hiding a live main window to the system tray (X button) exits C2.
            bool waitingForWindow = false;
            var styled = new HashSet<IntPtr> { window };
            int cycle = 0;
            while (!target.HasExited) {
                bool activate = activation.WaitOne(500);
                if (activate && !target.HasExited) {
                    // Visibility of the HWND does not imply visibility of the
                    // app's WebContents. Only Codex can restore both together.
                    requestApplicationWindow();
                    Log("C2 activation forwarded to the application.");
                }
                var windows = FindVisibleWindowsForProcess(target.Id, desktop);
                if (windows.Count == 0) {
                    bool hiddenToTray = false;
                    foreach (IntPtr hwnd in styled) {
                        if (IsWindow(hwnd) && !IsWindowVisible(hwnd) && !IsIconic(hwnd)) {
                            hiddenToTray = true;
                            break;
                        }
                    }
                    if (hiddenToTray) {
                        var exitWait = Stopwatch.StartNew();
                        while (!target.HasExited && exitWait.ElapsedMilliseconds < 1500) {
                            if (FindVisibleWindowsForProcess(target.Id, desktop).Count > 0) {
                                hiddenToTray = false;
                                break;
                            }
                            Thread.Sleep(100);
                        }
                        if (hiddenToTray) {
                            if (!target.HasExited) {
                                Log("C2 window was closed to tray; stopping the C2 process tree.");
                                C2Process.StopOwnedTree(target, Log);
                            }
                            break;
                        }
                        continue;
                    }
                    if (!waitingForWindow) {
                        Log("C2 has no visible main window; waiting for replacement window.");
                        waitingForWindow = true;
                    }
                    continue;
                }
                if (waitingForWindow) Log("C2 main window is visible again.");
                waitingForWindow = false;
                foreach (IntPtr hwnd in windows) {
                    UIntPtr current;
                    IntPtr result = SendMessageTimeout(hwnd, WM_GETICON, (UIntPtr)ICON_SMALL, IntPtr.Zero, SMTO_ABORTIFHUNG, 500, out current);
                    if (!styled.Contains(hwnd) || (result != IntPtr.Zero &&
                        (current.ToUInt64() & 0xFFFFFFFFL) != ((ulong)small.ToInt64() & 0xFFFFFFFFL))) {
                        ApplyWindowProperties(hwnd, big, small, iconPath);
                        styled.Add(hwnd);
                    } else if (cycle % 10 == 0) {
                        var title = new StringBuilder(256);
                        GetWindowText(hwnd, title, title.Capacity);
                        if (title.ToString() != "ChatGPT 2") SetWindowText(hwnd, "ChatGPT 2");
                    }
                }
                cycle++;
            }
            Log("C2 application exited.");
        } finally {
            if (small != IntPtr.Zero) DestroyIcon(small);
            if (big != IntPtr.Zero) DestroyIcon(big);
        }
    }

    private static void SetStringProperty(IPropertyStore store, PROPERTYKEY key, string value) {
        var variant = new PROPVARIANT { vt = 31, pwszVal = Marshal.StringToCoTaskMemUni(value) };
        try { Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref variant)); }
        finally { Marshal.FreeCoTaskMem(variant.pwszVal); }
    }

    private static void ApplyWindowProperties(IntPtr window, IntPtr big, IntPtr small, string iconPath) {
        IPropertyStore store = null;
        try {
            Guid guid = typeof(IPropertyStore).GUID;
            Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(window, ref guid, out store));
            SetStringProperty(store, AppIdKey, "OpenAI.Codex.Profile2");
            SetStringProperty(store, IconKey, iconPath + ",0");
            Marshal.ThrowExceptionForHR(store.Commit());
            UIntPtr ignored;
            SendMessageTimeout(window, WM_SETICON, (UIntPtr)ICON_BIG, big, SMTO_ABORTIFHUNG, 1000, out ignored);
            SendMessageTimeout(window, WM_SETICON, (UIntPtr)ICON_SMALL, small, SMTO_ABORTIFHUNG, 1000, out ignored);
            SetWindowText(window, "ChatGPT 2");
            SetWindowPos(window, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
            Log(string.Format("C2 icon and grouping applied (HWND: 0x{0:X}).", window.ToInt64()));
        } catch (COMException ex) {
            Log("Window property update failed: " + ex.Message);
        } finally {
            if (store != null) Marshal.ReleaseComObject(store);
        }
    }

    private static List<IntPtr> FindVisibleWindowsForProcess(int pid, IntPtr desktop) {
        var result = new List<IntPtr>();
        EnumWindowsProc callback = (window, data) => {
            uint windowPid;
            GetWindowThreadProcessId(window, out windowPid);
            if (windowPid != (uint)pid || !IsWindowVisible(window)) return true;
            // Main top-level window, independent of the shell's window class name.
            IntPtr owner = GetWindow(window, 4); // GW_OWNER
            if (owner != IntPtr.Zero && IsWindowVisible(owner)) return true;
            RECT rect;
            if (GetWindowRect(window, out rect) &&
                (IsIconic(window) || (rect.Left <= -10000 && rect.Top <= -10000) || (rect.Width > 200 && rect.Height > 200))) result.Add(window);
            return true;
        };
        if (!EnumDesktopWindows(desktop, callback, IntPtr.Zero)) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot enumerate C2 windows.");
        }
        return result;
    }
}
