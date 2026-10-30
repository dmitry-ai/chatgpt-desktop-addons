using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Xml;
using System.Xml.Linq;
using Microsoft.Win32;

public sealed class CodexPackage {
    public const string Family = "OpenAI.Codex_2p2nqsd0c76g0";
    private const int InsufficientBuffer = 122;
    private const int NoPackage = 15700;
    public string FullName;
    public string Root;
    public Version Version;
    public string ApplicationId;
    public string Executable;
    public string AppUserModelId { get { return Family + "!" + ApplicationId; } }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_BASIC_INFORMATION {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetPackagesByPackageFamily(string family, ref uint count,
        IntPtr names, ref uint bufferLength, IntPtr buffer);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetPackagePathByFullName(string fullName, ref uint length, StringBuilder path);
    [DllImport("kernelbase.dll", CharSet = CharSet.Unicode)]
    private static extern int GetStagedPackagePathByFullName(string packageFullName, ref uint pathLength, StringBuilder path);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetPackageFamilyName(IntPtr process, ref uint length, StringBuilder family);
    [DllImport("kernelbase.dll", CharSet = CharSet.Unicode)]
    private static extern int GetPackageStatus(string packageFullName, out uint status);
    [DllImport("kernelbase.dll", CharSet = CharSet.Unicode)]
    private static extern int GetPackageStatusForUser(IntPtr userSid, string packageFullName, out uint status);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(IntPtr hProcess, int dwFlags, StringBuilder lpExeName, ref int lpdwSize);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr processHandle, int processInformationClass,
        ref PROCESS_BASIC_INFORMATION processInformation, int processInformationLength, out int returnLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(IntPtr hProcess, IntPtr lpBaseAddress,
        byte[] lpBuffer, int dwSize, out IntPtr lpNumberOfBytesRead);

    public static List<CodexPackage> Installed() {
        // Public Windows package registration API; no private registry layout.
        for (int attempt = 0; attempt < 3; attempt++) {
            uint count = 0, length = 0;
            int rc = GetPackagesByPackageFamily(Family, ref count, IntPtr.Zero, ref length, IntPtr.Zero);
            if (rc == 0 && count == 0) return new List<CodexPackage>();
            if (rc != InsufficientBuffer) throw new Win32Exception(rc, "Cannot enumerate registered Codex packages.");
            IntPtr names = Marshal.AllocHGlobal(checked((int)count * IntPtr.Size));
            IntPtr buffer = Marshal.AllocHGlobal(checked((int)length * 2));
            try {
                rc = GetPackagesByPackageFamily(Family, ref count, names, ref length, buffer);
                if (rc == InsufficientBuffer) continue; // Store changed registration between calls.
                if (rc != 0) throw new Win32Exception(rc, "Cannot enumerate registered Codex packages.");
                var result = new List<CodexPackage>();
                for (int i = 0; i < count; i++) {
                    string fullName = Marshal.PtrToStringUni(Marshal.ReadIntPtr(names, i * IntPtr.Size));
                    uint pathLength = 0;
                    rc = GetPackagePathByFullName(fullName, ref pathLength, null);
                    if (rc == NoPackage || rc == 2 || rc == 3) continue;
                    if (rc != InsufficientBuffer) throw new Win32Exception(rc, "Cannot locate package " + fullName);
                    var path = new StringBuilder(checked((int)pathLength));
                    rc = GetPackagePathByFullName(fullName, ref pathLength, path);
                    if (rc == NoPackage || rc == 2 || rc == 3) continue;
                    if (rc != 0) throw new Win32Exception(rc, "Cannot locate package " + fullName);
                    Version version;
                    string[] parts = fullName.Split('_');
                    if (parts.Length < 2 || !Version.TryParse(parts[1], out version)) {
                        throw new InvalidDataException("Invalid registered package identity: " + fullName);
                    }
                    result.Add(new CodexPackage { FullName = fullName, Root = path.ToString(), Version = version });
                }
                return result;
            } finally {
                Marshal.FreeHGlobal(buffer);
                Marshal.FreeHGlobal(names);
            }
        }
        throw new IOException("Codex registration kept changing during the update. Try again shortly.");
    }

    public static List<CodexPackage> Staged() {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        string[] registryPaths = new[] {
            @"SOFTWARE\Microsoft\Windows\CurrentVersion\AppModel\StateRepository\Cache\Package\Index\PackageFullName",
            @"SOFTWARE\Microsoft\Windows\CurrentVersion\AppModel\StateChange\PackageList",
            @"SOFTWARE\Microsoft\Windows\CurrentVersion\Appx\AppxAllUserStore\Applications",
            @"SOFTWARE\Microsoft\Windows\CurrentVersion\Appx\AppxAllUserStore\Staged",
            @"SOFTWARE\Microsoft\Windows\CurrentVersion\Appx\AppxAllUserStore\S-1-5-18"
        };
        foreach (string regPath in registryPaths) {
            try {
                using (RegistryKey key = Registry.LocalMachine.OpenSubKey(regPath, false)) {
                    if (key == null) continue;
                    foreach (string subName in key.GetSubKeyNames()) {
                        if (subName.StartsWith("OpenAI.Codex_", StringComparison.OrdinalIgnoreCase) &&
                            subName.EndsWith("__2p2nqsd0c76g0", StringComparison.OrdinalIgnoreCase)) {
                            names.Add(subName);
                        }
                    }
                }
            } catch { }
        }
        try {
            string windowsApps = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "WindowsApps");
            if (Directory.Exists(windowsApps)) {
                foreach (string dir in Directory.GetDirectories(windowsApps, "OpenAI.Codex_*__2p2nqsd0c76g0")) {
                    string name = Path.GetFileName(dir);
                    if (!string.IsNullOrEmpty(name)) names.Add(name);
                }
            }
        } catch { }
        var result = new List<CodexPackage>();
        foreach (string fullName in names) {
            uint pathLength = 0;
            int rc = GetStagedPackagePathByFullName(fullName, ref pathLength, null);
            if (rc != InsufficientBuffer || pathLength == 0) continue;
            var path = new StringBuilder(checked((int)pathLength));
            rc = GetStagedPackagePathByFullName(fullName, ref pathLength, path);
            if (rc != 0) continue;
            string root = path.ToString();
            if (string.IsNullOrEmpty(root) || !Directory.Exists(root)) continue;
            Version version;
            string[] parts = fullName.Split('_');
            if (parts.Length < 2 || !Version.TryParse(parts[1], out version)) continue;
            result.Add(new CodexPackage { FullName = fullName, Root = root, Version = version });
        }
        return result.OrderByDescending(p => p.Version).ToList();
    }

    public static List<CodexPackage> Available() {
        var byName = new Dictionary<string, CodexPackage>(StringComparer.OrdinalIgnoreCase);
        foreach (CodexPackage pkg in Installed()) byName[pkg.FullName] = pkg;
        foreach (CodexPackage pkg in Staged()) {
            if (!byName.ContainsKey(pkg.FullName)) byName[pkg.FullName] = pkg;
        }
        return byName.Values.OrderByDescending(p => p.Version).ToList();
    }

    public static CodexPackage Resolve(Action<string> log) { return Select(Installed(), log); }

    public static List<CodexPackage> SelectCandidates(IEnumerable<CodexPackage> candidates, Action<string> log) {
        var list = new List<CodexPackage>();
        foreach (CodexPackage candidate in candidates.OrderByDescending(p => p.Version)) {
            try {
                list.Add(ReadManifest(candidate));
            } catch (IOException ex) {
                if (log != null) log("Package unavailable: " + candidate.FullName + ": " + ex.Message);
            } catch (XmlException ex) {
                if (log != null) log("Invalid package manifest: " + candidate.FullName + ": " + ex.Message);
            }
        }
        return list;
    }

    public static CodexPackage Select(IEnumerable<CodexPackage> candidates, Action<string> log) {
        var list = SelectCandidates(candidates, log);
        if (list.Count > 0) return list[0];
        throw new FileNotFoundException("No registered Codex package has a valid desktop application and executable.");
    }

    public static CodexPackage ReadManifest(CodexPackage package) {
        var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null };
        XDocument doc;
        using (var reader = XmlReader.Create(Path.Combine(package.Root, "AppxManifest.xml"), settings)) {
            doc = XDocument.Load(reader);
        }
        XNamespace ns = "http://schemas.microsoft.com/appx/manifest/foundation/windows10";
        var applications = doc.Root == null ? null : doc.Root.Element(ns + "Applications");
        if (applications == null) throw new InvalidDataException("Manifest has no Applications element.");
        var visible = applications.Elements(ns + "Application").Where(app =>
            app.Elements().Any(el => el.Name.LocalName == "VisualElements" &&
                !string.Equals((string)el.Attribute("AppListEntry"), "none", StringComparison.OrdinalIgnoreCase))).ToList();
        if (visible.Count != 1) throw new InvalidDataException("Manifest must identify exactly one visible desktop application.");
        string id = (string)visible[0].Attribute("Id");
        string relative = (string)visible[0].Attribute("Executable");
        if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(relative) || Path.IsPathRooted(relative)) {
            throw new InvalidDataException("Manifest has an invalid application ID or executable path.");
        }
        string root = Path.GetFullPath(package.Root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        string exe = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
        if (!exe.StartsWith(root, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(Path.GetExtension(exe), ".exe", StringComparison.OrdinalIgnoreCase)) {
            throw new InvalidDataException("Manifest executable escapes the package or is not an executable.");
        }
        if (!File.Exists(exe)) throw new FileNotFoundException("Manifest executable is missing: " + exe);
        return new CodexPackage {
            FullName = package.FullName, Root = root, Version = package.Version,
            ApplicationId = id, Executable = exe
        };
    }

    public static bool Owns(Process process) {
        if (process == null) return false;
        IntPtr handle = OpenProcess(0x1000, false, process.Id);
        bool close = handle != IntPtr.Zero;
        if (!close) handle = process.Handle;
        try {
            uint length = 0;
            int rc = GetPackageFamilyName(handle, ref length, null);
            if (rc == NoPackage) return false;
            if (rc != InsufficientBuffer) throw new Win32Exception(rc, "Cannot verify process package identity.");
            var family = new StringBuilder(checked((int)length));
            rc = GetPackageFamilyName(handle, ref length, family);
            if (rc != 0) throw new Win32Exception(rc, "Cannot verify process package identity.");
            return string.Equals(family.ToString(), Family, StringComparison.Ordinal);
        } finally {
            if (close) CloseHandle(handle);
        }
    }

    public static bool OwnsProcessId(int pid) {
        if (pid <= 4) return false;
        IntPtr handle = OpenProcess(0x1000, false, pid);
        if (handle == IntPtr.Zero) return false;
        try {
            uint length = 0;
            int rc = GetPackageFamilyName(handle, ref length, null);
            if (rc != InsufficientBuffer || length == 0) return false;
            var family = new StringBuilder(checked((int)length));
            return GetPackageFamilyName(handle, ref length, family) == 0 &&
                string.Equals(family.ToString(), Family, StringComparison.Ordinal);
        } finally {
            CloseHandle(handle);
        }
    }

    public static bool NeedsRegistration(string fullName) {
        if (string.IsNullOrEmpty(fullName)) return false;
        bool registeredForUser = Installed().Any(p => string.Equals(p.FullName, fullName, StringComparison.OrdinalIgnoreCase));
        if (!registeredForUser) return true;
        uint userStatus = 0, machineStatus = 0;
        int rcUser = GetPackageStatusForUser(IntPtr.Zero, fullName, out userStatus);
        int rcMachine = GetPackageStatus(fullName, out machineStatus);
        return (rcUser == 0 && userStatus != 0) || (rcMachine == 0 && machineStatus != 0);
    }

    public static int[] RunningUiProcesses() {
        var result = new List<int>();
        foreach (Process process in Process.GetProcesses()) using (process) {
            try {
                if (process.Id <= 4 || process.SessionId == 0) continue;
                if (string.Equals(process.ProcessName, "codex-windows-sandbox-service", StringComparison.OrdinalIgnoreCase)) continue;
                if (OwnsProcessId(process.Id) && !process.HasExited) result.Add(process.Id);
            }
            catch (Win32Exception) { }
            catch (InvalidOperationException) { }
        }
        return result.ToArray();
    }

    public static string ReadProcessExecutablePath(int pid) {
        if (pid <= 4) return null;
        IntPtr h = OpenProcess(0x1000, false, pid);
        if (h == IntPtr.Zero) return null;
        try {
            int capacity = 1024;
            var sb = new StringBuilder(capacity);
            return QueryFullProcessImageName(h, 0, sb, ref capacity) ? sb.ToString(0, capacity) : null;
        } catch {
            return null;
        } finally {
            CloseHandle(h);
        }
    }

    public static int GetParentProcessId(int pid) {
        if (pid <= 4) return 0;
        IntPtr h = OpenProcess(0x1000, false, pid);
        if (h == IntPtr.Zero) h = OpenProcess(0x0400, false, pid);
        if (h == IntPtr.Zero) return 0;
        try {
            var pbi = new PROCESS_BASIC_INFORMATION();
            int retLen;
            if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out retLen) != 0) return 0;
            return pbi.InheritedFromUniqueProcessId.ToInt32();
        } catch {
            return 0;
        } finally {
            CloseHandle(h);
        }
    }

    public static string ReadProcessCommandLine(int pid) {
        if (IntPtr.Size != 8 || pid <= 4) return null;
        IntPtr h = OpenProcess(0x1010, false, pid);
        if (h == IntPtr.Zero) h = OpenProcess(0x0410, false, pid);
        if (h == IntPtr.Zero) return null;
        try {
            var pbi = new PROCESS_BASIC_INFORMATION();
            int retLen;
            if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out retLen) != 0 || pbi.PebBaseAddress == IntPtr.Zero)
                return null;
            byte[] ptrBuf = new byte[8];
            IntPtr read;
            if (!ReadProcessMemory(h, (IntPtr)(pbi.PebBaseAddress.ToInt64() + 0x20), ptrBuf, 8, out read)) return null;
            IntPtr procParams = (IntPtr)BitConverter.ToInt64(ptrBuf, 0);
            if (procParams == IntPtr.Zero) return null;
            byte[] cmdHeader = new byte[16];
            if (!ReadProcessMemory(h, (IntPtr)(procParams.ToInt64() + 0x70), cmdHeader, 16, out read)) return null;
            ushort byteLen = BitConverter.ToUInt16(cmdHeader, 0);
            IntPtr cmdPtr = (IntPtr)BitConverter.ToInt64(cmdHeader, 8);
            if (byteLen == 0) return "";
            if (cmdPtr == IntPtr.Zero) return null;
            byte[] cmdBuf = new byte[byteLen];
            if (!ReadProcessMemory(h, cmdPtr, cmdBuf, byteLen, out read)) return null;
            return Encoding.Unicode.GetString(cmdBuf);
        } catch {
            return null;
        } finally {
            CloseHandle(h);
        }
    }

    public static Dictionary<string, string> ReadProcessEnvironment(int pid) {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (IntPtr.Size != 8 || pid <= 4) return result;
        IntPtr h = OpenProcess(0x1010, false, pid);
        if (h == IntPtr.Zero) h = OpenProcess(0x0410, false, pid);
        if (h == IntPtr.Zero) return result;
        try {
            var pbi = new PROCESS_BASIC_INFORMATION();
            int retLen;
            if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out retLen) != 0 || pbi.PebBaseAddress == IntPtr.Zero)
                return result;
            byte[] ptrBuf = new byte[8];
            IntPtr read;
            if (!ReadProcessMemory(h, (IntPtr)(pbi.PebBaseAddress.ToInt64() + 0x20), ptrBuf, 8, out read)) return result;
            IntPtr procParams = (IntPtr)BitConverter.ToInt64(ptrBuf, 0);
            if (procParams == IntPtr.Zero) return result;
            if (!ReadProcessMemory(h, (IntPtr)(procParams.ToInt64() + 0x80), ptrBuf, 8, out read)) return result;
            IntPtr envPtr = (IntPtr)BitConverter.ToInt64(ptrBuf, 0);
            if (!ReadProcessMemory(h, (IntPtr)(procParams.ToInt64() + 0x3F0), ptrBuf, 8, out read)) return result;
            ulong envSize = BitConverter.ToUInt64(ptrBuf, 0);
            if (envPtr == IntPtr.Zero || envSize == 0 || envSize > 1048576) return result;
            byte[] envBuf = new byte[(int)envSize];
            if (!ReadProcessMemory(h, envPtr, envBuf, envBuf.Length, out read)) return result;
            string envText = Encoding.Unicode.GetString(envBuf);
            foreach (string entry in envText.Split('\0')) {
                if (string.IsNullOrEmpty(entry)) continue;
                int eq = entry.IndexOf('=');
                if (eq <= 0) continue;
                result[entry.Substring(0, eq)] = entry.Substring(eq + 1);
            }
        } catch {
        } finally {
            CloseHandle(h);
        }
        return result;
    }

    private static bool IsHelperOrTestProcess(string processName) {
        if (string.IsNullOrEmpty(processName)) return false;
        return string.Equals(processName, "ChatGPT2Launcher", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(processName, "LauncherTests", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(processName, "RecoveryNativeTests", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(processName, "AliasActivationRegression", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(processName, "SupervisorRegression", StringComparison.OrdinalIgnoreCase);
    }

    public static List<int> FindOrphanProcesses(string filterC2Profile, bool c1Only) {
        var pids = new List<int>();
        int selfPid = Process.GetCurrentProcess().Id;
        var uiPids = new HashSet<int>(RunningUiProcesses());
        foreach (Process p in Process.GetProcesses()) using (p) {
            try {
                if (p.Id <= 4 || p.Id == selfPid || uiPids.Contains(p.Id)) continue;
                if (IsHelperOrTestProcess(p.ProcessName)) continue;
                var env = ReadProcessEnvironment(p.Id);
                if (env.Count == 0) continue;
                string family;
                bool hasFamily = env.TryGetValue("CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY", out family) &&
                                 string.Equals(family, Family, StringComparison.OrdinalIgnoreCase);
                string originator;
                bool hasOriginator = env.TryGetValue("CODEX_INTERNAL_ORIGINATOR_OVERRIDE", out originator) &&
                                     string.Equals(originator, "Codex Desktop", StringComparison.OrdinalIgnoreCase);
                string c2DataPath;
                bool hasC2Profile = env.TryGetValue("CODEX_ELECTRON_USER_DATA_PATH", out c2DataPath) &&
                                    !string.IsNullOrEmpty(c2DataPath);
                if (!hasFamily && !hasOriginator && !hasC2Profile) continue;
                if (c1Only) {
                    if (!hasC2Profile && (hasFamily || hasOriginator)) pids.Add(p.Id);
                } else if (!string.IsNullOrEmpty(filterC2Profile)) {
                    if (hasC2Profile && string.Equals(
                        Path.GetFullPath(c2DataPath).TrimEnd(Path.DirectorySeparatorChar),
                        Path.GetFullPath(filterC2Profile).TrimEnd(Path.DirectorySeparatorChar),
                        StringComparison.OrdinalIgnoreCase)) {
                        pids.Add(p.Id);
                    }
                } else {
                    pids.Add(p.Id);
                }
            } catch { }
        }
        return pids;
    }

    public static void StopProcesses(IEnumerable<int> pids, Action<string> log) {
        var handles = new List<Process>();
        try {
            foreach (int pid in pids) {
                Process p = null;
                try {
                    p = Process.GetProcessById(pid);
                    IntPtr h = p.Handle;
                    if (!p.HasExited) {
                        if (log != null) log("Stopping orphaned Codex container process PID " + pid + " (" + p.ProcessName + ").");
                        TerminateProcess(h, 0);
                        handles.Add(p);
                        p = null;
                    }
                } catch {
                } finally {
                    if (p != null) p.Dispose();
                }
            }
            var wait = Stopwatch.StartNew();
            foreach (Process p in handles) {
                try {
                    int rem = Math.Max(0, 3000 - (int)wait.ElapsedMilliseconds);
                    p.WaitForExit(rem);
                } catch { }
            }
        } finally {
            foreach (Process p in handles) p.Dispose();
        }
    }

    public static void StopOrphanContainerProcesses(Action<string> log) {
        if (RunningUiProcesses().Length > 0) return;
        List<int> orphans = FindOrphanProcesses(null, false);
        if (orphans.Count > 0) StopProcesses(orphans, log);
    }

    public static bool EnsureLatestRegistered(Action<string> log) {
        var available = SelectCandidates(Available(), log);
        if (available.Count == 0) return false;
        return EnsureRegistered(available[0], log);
    }

    public static bool EnsureRegistered(CodexPackage package, Action<string> log) {
        var available = SelectCandidates(Available(), log);
        if (available.Count > 0 && (package == null || available[0].Version > package.Version)) {
            package = available[0];
        }
        if (package == null || string.IsNullOrEmpty(package.FullName)) return false;
        if (!NeedsRegistration(package.FullName)) return true;
        if (RunningUiProcesses().Length > 0) {
            if (log != null) log("Package " + package.FullName + " requires registration, but a Codex UI instance is currently open.");
            return false;
        }
        string manifest = Path.Combine(package.Root, "AppxManifest.xml");
        if (!File.Exists(manifest)) return false;
        string ps = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
            @"WindowsPowerShell\v1.0\powershell.exe");
        string escaped = manifest.Replace("'", "''");
        string cmd = "$ErrorActionPreference = 'Stop'; " +
                     "$ProgressPreference = 'SilentlyContinue'; " +
                     "Add-AppxPackage -Register '" + escaped + "' -DisableDevelopmentMode -ForceApplicationShutdown -ForceUpdateFromAnyVersion";
        string encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(cmd));
        for (int attempt = 1; attempt <= 3; attempt++) {
            if (RunningUiProcesses().Length > 0) return false;
            StopOrphanContainerProcesses(log);
            if (log != null) log("Completing Windows registration for " + package.FullName + (attempt > 1 ? " (attempt " + attempt + ")" : "") + "...");
            var psi = new ProcessStartInfo(ps, "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + encoded) {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardError = true
            };
            using (Process proc = Process.Start(psi)) {
                string stderr = proc.StandardError.ReadToEnd();
                if (!proc.WaitForExit(60000)) {
                    try { proc.Kill(); } catch { }
                    if (log != null) log("Registration timed out for " + package.FullName);
                    return false;
                }
                if (proc.ExitCode != 0 && log != null && !string.IsNullOrEmpty(stderr)) {
                    log("Registration warning for " + package.FullName + ": " + stderr.Trim());
                }
            }
            if (!NeedsRegistration(package.FullName)) {
                if (log != null) log("Registration status for " + package.FullName + ": OK");
                return true;
            }
            if (attempt < 3) System.Threading.Thread.Sleep(1000);
        }
        bool ready = !NeedsRegistration(package.FullName);
        if (log != null) log("Registration status for " + package.FullName + ": " + (ready ? "OK" : "still pending"));
        return ready;
    }
}
