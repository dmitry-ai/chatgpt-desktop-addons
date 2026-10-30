using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Linq;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;

public static class C2Process {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo {
        public int cb;
        public string reserved, desktop, title;
        public int x, y, xSize, ySize, xChars, yChars, fill, flags;
        public short show, reservedBytes;
        public IntPtr reservedPointer, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo {
        public IntPtr process, thread;
        public int pid, threadId;
    }
    [DllImport("kernel32.dll", EntryPoint = "CreateProcessW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string executable, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory,
        ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    public static string FirstArgument(string command) {
        command = (command ?? "").TrimStart();
        if (command.StartsWith("\"", StringComparison.Ordinal)) {
            int end = command.IndexOf('"', 1);
            return end < 0 ? "" : command.Substring(1, end - 1);
        }
        int space = command.IndexOf(' ');
        return space < 0 ? command : command.Substring(0, space);
    }

    public static Process FindExisting(string alias, int debugPort) {
        Process found = null;
        try {
            foreach (int pid in CodexPackage.RunningUiProcesses()) {
                string command = CodexPackage.ReadProcessCommandLine(pid);
                if (string.IsNullOrEmpty(command) ||
                    !string.Equals(FirstArgument(command), alias, StringComparison.OrdinalIgnoreCase) ||
                    !command.Split(' ').Contains("--remote-debugging-port=" + debugPort)) continue;
                Process candidate = null;
                try {
                    candidate = Process.GetProcessById(pid);
                    // Pin the OS process object: a recycled PID can never be our target.
                    IntPtr pinned = candidate.Handle;
                    if (candidate.HasExited || !CodexPackage.Owns(candidate)) { candidate.Dispose(); continue; }
                    if (found != null) throw new InvalidOperationException("More than one verified C2 instance is running.");
                    found = candidate;
                    candidate = null;
                } catch (ArgumentException) {
                    // Candidate exited between snapshot and opening its handle.
                } catch (InvalidOperationException) {
                    if (candidate != null && candidate.HasExited) continue;
                    throw;
                } catch (Win32Exception) {
                    if (candidate != null && candidate.HasExited) continue;
                    throw;
                } finally {
                    if (candidate != null) candidate.Dispose();
                }
            }
            return found;
        } catch {
            if (found != null) found.Dispose();
            throw;
        }
    }

    private static ProcessInfo CreateChild(string alias, string profile, string workingDirectory, int debugPort) {
        var values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (System.Collections.DictionaryEntry item in Environment.GetEnvironmentVariables()) {
            values[(string)item.Key] = (string)item.Value;
        }
        values["CODEX_HOME"] = profile;
        values["CODEX_ELECTRON_USER_DATA_PATH"] = profile;
        // C1 manages the shared MSIX installation. A second updater in C2
        // races over the same prepared package and leaves a redundant update button.
        values["CODEX_SPARKLE_ENABLED"] = "false";
        var block = new StringBuilder();
        foreach (var pair in values) block.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
        block.Append('\0');
        IntPtr environment = Marshal.StringToHGlobalUni(block.ToString());
        var startup = new StartupInfo {
            cb = Marshal.SizeOf(typeof(StartupInfo)), desktop = @"WinSta0\Default", flags = 1, show = 1
        };
        var command = new StringBuilder("\"" + alias + "\" --remote-debugging-port=" + debugPort);
        ProcessInfo info;
        try {
            if (!CreateProcess(alias, command, IntPtr.Zero, IntPtr.Zero, false, 0x400,
                environment, workingDirectory, ref startup, out info)) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot start the Codex execution alias.");
            }
            return info;
        } finally {
            Marshal.FreeHGlobal(environment);
        }
    }

    public static Process Start(string alias, string profile, string workingDirectory, int debugPort) {
        ProcessInfo info = CreateChild(alias, profile, workingDirectory, debugPort);
        try {
            var process = Process.GetProcessById(info.pid);
            try {
                IntPtr pinned = process.Handle;
                return process;
            } catch {
                process.Dispose();
                throw;
            }
        } finally {
            CloseHandle(info.thread);
            CloseHandle(info.process);
        }
    }

    public static void RequestActivation(string alias, string profile, string workingDirectory, int debugPort) {
        // The second instance may exit immediately after notifying the existing app.
        // Do not attempt to adopt that short-lived process as a new C2 instance.
        ProcessInfo info = CreateChild(alias, profile, workingDirectory, debugPort);
        CloseHandle(info.thread);
        CloseHandle(info.process);
    }

    public static void StopOwnedTree(Process root, Action<string> log) {
        // Hold actual process handles and validate parentage; never taskkill by port/PID.
        if (root.HasExited) return;
        string c2Profile = null;
        var rootEnv = CodexPackage.ReadProcessEnvironment(root.Id);
        rootEnv.TryGetValue("CODEX_ELECTRON_USER_DATA_PATH", out c2Profile);
        var owned = new List<Process> { root };
        var seen = new HashSet<int> { root.Id };
        try {
            for (int i = 0; i < owned.Count; i++) {
                Process parent = owned[i];
                if (parent.HasExited) continue;
                DateTime parentStart = parent.StartTime.ToUniversalTime();
                foreach (Process snapshot in Process.GetProcesses()) {
                    int pid;
                    using (snapshot) { pid = snapshot.Id; }
                    if (pid <= 4 || seen.Contains(pid)) continue;
                    if (CodexPackage.GetParentProcessId(pid) != parent.Id) continue;
                    Process child = null;
                    try {
                        child = Process.GetProcessById(pid);
                        IntPtr pinned = child.Handle;
                        if (child.HasExited || child.StartTime.ToUniversalTime() < parentStart) continue;
                        if (CodexPackage.GetParentProcessId(child.Id) != parent.Id) continue;
                        owned.Add(child);
                        seen.Add(pid);
                        child = null;
                    } catch (ArgumentException) {
                        // Child exited before we opened it.
                    } catch (InvalidOperationException) {
                        if (child == null || !child.HasExited) throw;
                    } catch (Win32Exception) {
                        if (child == null || !child.HasExited) throw;
                    } finally {
                        if (child != null) child.Dispose();
                    }
                }
            }
            for (int i = owned.Count - 1; i >= 0; i--) {
                if (!owned[i].HasExited && !TerminateProcess(owned[i].Handle, 0)) {
                    int error = Marshal.GetLastWin32Error();
                    if (!owned[i].HasExited) throw new Win32Exception(error, "Cannot stop an owned C2 process.");
                }
            }
            var wait = Stopwatch.StartNew();
            foreach (Process process in owned) {
                int remaining = Math.Max(0, 5000 - (int)wait.ElapsedMilliseconds);
                if (!process.WaitForExit(remaining)) throw new TimeoutException("An owned C2 process did not exit after termination.");
            }
            if (!string.IsNullOrEmpty(c2Profile)) {
                var orphans = CodexPackage.FindOrphanProcesses(c2Profile, false);
                if (orphans.Count > 0) CodexPackage.StopProcesses(orphans, log);
            }
            if (log != null) log("Stopped the verified C2 process tree.");
        } finally {
            for (int i = 1; i < owned.Count; i++) owned[i].Dispose();
        }
    }
}
