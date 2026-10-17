using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;

public static class WindowsRestart {
    [StructLayout(LayoutKind.Sequential)]
    public struct UniqueProcess { public int Id; public System.Runtime.InteropServices.ComTypes.FILETIME Started; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessInfo {
        public UniqueProcess Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string Name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string Service;
        public int Type; public uint Status, Session;
        [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
    }
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmStartSession(out uint session, int flags, StringBuilder key);
    [DllImport("rstrtmgr.dll")]
    private static extern int RmEndSession(uint session);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmRegisterResources(uint session, uint files, string[] names,
        uint processes, UniqueProcess[] apps, uint services, string[] serviceNames);
    [DllImport("rstrtmgr.dll")]
    private static extern int RmGetList(uint session, out uint needed, ref uint count,
        [In, Out] ProcessInfo[] info, ref uint reasons);
    [DllImport("rstrtmgr.dll")]
    private static extern int RmShutdown(uint session, uint flags, IntPtr callback);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetApplicationRestartSettings(IntPtr process, StringBuilder command,
        ref uint length, out uint flags);

    private static void Check(int result) { if (result != 0) throw new Win32Exception(result); }
    public static bool IsRegistered(Process process) {
        uint length = 2048, flags;
        return GetApplicationRestartSettings(process.Handle, new StringBuilder((int)length), ref length, out flags) == 0;
    }
    public static void Shutdown(Process process) {
        // A pinned process handle and its start time protect against PID reuse.
        IntPtr handle = process.Handle;
        if (process.HasExited) throw new InvalidOperationException("The target already exited.");
        if (!IsRegistered(process)) throw new InvalidOperationException("The target is not registered for Windows restart.");
        long started = process.StartTime.ToUniversalTime().ToFileTimeUtc();
        var target = new UniqueProcess { Id = process.Id, Started = new System.Runtime.InteropServices.ComTypes.FILETIME {
            dwLowDateTime = unchecked((int)started), dwHighDateTime = unchecked((int)(started >> 32)) } };
        uint session;
        Check(RmStartSession(out session, 0, new StringBuilder(33)));
        try {
            Check(RmRegisterResources(session, 0, null, 1, new[] { target }, 0, null));
            uint needed, count = 1, reasons = 0;
            var affected = new ProcessInfo[1];
            Check(RmGetList(session, out needed, ref count, affected, ref reasons));
            if (count != 1 || affected[0].Process.Id != process.Id ||
                affected[0].Process.Started.dwLowDateTime != target.Started.dwLowDateTime ||
                affected[0].Process.Started.dwHighDateTime != target.Started.dwHighDateTime)
                throw new InvalidOperationException("Restart Manager selected an unexpected process set.");
            // RmShutdownOnlyRegistered; deliberately omit RmForceShutdown.
            Check(RmShutdown(session, 0x10, IntPtr.Zero));
            if (!process.WaitForExit(15000)) throw new TimeoutException("The app did not agree to a graceful shutdown.");
        } finally { RmEndSession(session); }
    }
}

public sealed class C1ProcessInfo {
    public int Pid;
    public string StartTicks, StartedAt, Package;
    public bool HasDebugPort, RestartRegistered;
}

public static class C1Runtime {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder name);

    public static int Launch(bool activateExisting) {
        CodexPackage package = CodexPackage.Resolve(null);
        using (Process existing = Find(package)) {
            if (existing != null) {
                if (!HasPort(existing.Id)) throw new InvalidOperationException(
                    "C1 is already open without its UI connection. Fully exit C1 once, then open the C1 shortcut.");
                if (activateExisting) Activate();
                return existing.Id;
            }
        }
        int pid = Activate();
        using (Process process = Process.GetProcessById(pid)) {
            IntPtr pinned = process.Handle;
            if (!CodexPackage.Owns(process)) throw new InvalidOperationException("The C1 process has an unexpected package identity.");
            if (!HasPort(process.Id)) throw new InvalidOperationException("C1 launched without its UI connection.");
            return process.Id;
        }
    }
    public static int[] PackageProcesses() {
        var result = new System.Collections.Generic.List<int>();
        foreach (Process process in Process.GetProcesses()) using (process) {
            try { if (!process.HasExited && CodexPackage.Owns(process)) result.Add(process.Id); }
            catch (Win32Exception) { } // Other users' protected system processes.
            catch (InvalidOperationException) { } // Exited during the snapshot.
        }
        return result.ToArray();
    }
    private static string FirstArgument(string command) {
        command = (command ?? "").TrimStart();
        if (command.StartsWith("\"")) {
            int end = command.IndexOf('"', 1);
            return end < 0 ? "" : command.Substring(1, end - 1);
        }
        int space = command.IndexOf(' ');
        return space < 0 ? command : command.Substring(0, space);
    }
    private static Process Find(CodexPackage package) {
        Process found = null;
        string executableName = Path.GetFileName(package.Executable).Replace("'", "''");
        try {
            using (var search = new ManagementObjectSearcher("SELECT ProcessId, CommandLine, ExecutablePath FROM Win32_Process WHERE Name='" + executableName + "'"))
            using (var results = search.Get()) {
                foreach (ManagementObject item in results) using (item) {
                    string command = item["CommandLine"] as string;
                    string image = item["ExecutablePath"] as string;
                    // C2's AppExecLink has a different first argument, even though
                    // Windows reports the same physical image for both profiles.
                    if (string.IsNullOrEmpty(image) || !string.Equals(FirstArgument(command), image, StringComparison.OrdinalIgnoreCase) ||
                        command.Contains("--type=") || command.Contains("--remote-debugging-port=9224") ||
                        command.Contains("--user-data-dir=")) continue;
                    Process candidate = null;
                    try {
                        candidate = Process.GetProcessById(Convert.ToInt32(item["ProcessId"]));
                        IntPtr pinned = candidate.Handle;
                        if (candidate.HasExited || !CodexPackage.Owns(candidate)) continue;
                        if (found != null) throw new InvalidOperationException("More than one canonical C1 process is running.");
                        found = candidate; candidate = null;
                    } catch (ArgumentException) { } // Exited between the snapshot and opening its handle.
                    finally { if (candidate != null) candidate.Dispose(); }
                }
            }
            return found;
        } catch { if (found != null) found.Dispose(); throw; }
    }
    private static bool HasPort(int pid) {
        using (var search = new ManagementObjectSearcher("SELECT CommandLine FROM Win32_Process WHERE ProcessId=" + pid))
        using (var results = search.Get()) foreach (ManagementObject row in results) using (row) {
            return System.Text.RegularExpressions.Regex.IsMatch(row["CommandLine"] as string ?? "", @"(?:^|\s)--remote-debugging-port(?:=|\s+)9223(?:\s|$)");
        }
        throw new InvalidOperationException("C1 exited during inspection.");
    }
    public static C1ProcessInfo Probe() {
        CodexPackage package = CodexPackage.Resolve(null);
        using (Process process = Find(package)) {
            if (process == null) return null;
            DateTime started = process.StartTime.ToUniversalTime();
            uint length = 512;
            var identity = new StringBuilder((int)length);
            int identityResult = GetPackageFullName(process.Handle, ref length, identity);
            if (identityResult != 0) throw new Win32Exception(identityResult, "Cannot read C1's running package identity.");
            return new C1ProcessInfo { Pid = process.Id, StartTicks = started.Ticks.ToString(), StartedAt = started.ToString("o"),
                Package = identity.ToString(), HasDebugPort = HasPort(process.Id), RestartRegistered = WindowsRestart.IsRegistered(process) };
        }
    }
    public static int Recover(int expectedPid, string expectedStartTicks) {
        using (Process process = Find(CodexPackage.Resolve(null))) {
            if (process == null || process.Id != expectedPid || process.StartTime.ToUniversalTime().Ticks.ToString() != expectedStartTicks)
                throw new InvalidOperationException("C1 changed since the recovery decision; no process was closed.");
            if (HasPort(process.Id)) throw new InvalidOperationException("C1 already has its UI port; no restart is needed.");
            WindowsRestart.Shutdown(process);
        }
        return Launch(false);
    }
    public static int Activate() {
        var manager = (IApplicationActivationManager)new ApplicationActivationManager();
        try {
            uint pid;
            int result = manager.ActivateApplication(CodexPackage.Resolve(null).AppUserModelId, "--remote-debugging-port=9223", 2, out pid);
            if (result < 0) Marshal.ThrowExceptionForHR(result);
            return checked((int)pid);
        } finally { Marshal.ReleaseComObject(manager); }
    }
    [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    private class ApplicationActivationManager { }
    [ComImport, Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IApplicationActivationManager {
        [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint processId);
        [PreserveSig] int ActivateForFile(string appId, IntPtr items, string verb, out uint processId);
        [PreserveSig] int ActivateForProtocol(string appId, IntPtr items, out uint processId);
    }
}
