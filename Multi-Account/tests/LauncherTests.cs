using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class LauncherTests {
    private static int passed;
    private static string workspace;
    private static void Assert(bool condition, string message) {
        if (!condition) throw new Exception(message);
    }
    private static void Test(string name, Action action) {
        action();
        Console.WriteLine("PASS " + name);
        passed++;
    }
    private static void Reject<T>(Action action) where T : Exception {
        try { action(); } catch (T) { return; }
        throw new Exception("Expected rejection: " + typeof(T).Name);
    }
    private static CodexPackage Package(string name, string version, string relative, string id, string extra) {
        string root = Path.Combine(workspace, name);
        Directory.CreateDirectory(root);
        string executable = Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar));
        if (executable.StartsWith(root, StringComparison.OrdinalIgnoreCase)) {
            Directory.CreateDirectory(Path.GetDirectoryName(executable));
            File.WriteAllBytes(executable, new byte[] { 0 });
        }
        File.WriteAllText(Path.Combine(root, "AppxManifest.xml"),
            "<Package xmlns=\"http://schemas.microsoft.com/appx/manifest/foundation/windows10\" xmlns:uap=\"http://schemas.microsoft.com/appx/manifest/uap/windows10\">" +
            "<Applications><Application Id=\"" + id + "\" Executable=\"" + relative + "\"><uap:VisualElements DisplayName=\"Codex\"/></Application>" +
            extra + "</Applications></Package>");
        return new CodexPackage { FullName = name, Root = root, Version = new Version(version) };
    }
    private static string Alias(string name) { return Path.Combine(workspace, name + ".exe"); }

    private static void CoreTests() {
        CodexPackage current = null;
        Test("discover current package via Windows API and read its manifest", () => {
            current = CodexPackage.Resolve(Console.WriteLine);
            Assert(File.Exists(current.Executable), "Registered executable missing.");
            Assert(current.AppUserModelId.StartsWith(CodexPackage.Family + "!"), "Wrong application identity.");
            Console.WriteLine("CURRENT " + current.FullName + " | " + current.Executable);
        });
        Test("read primary desktop application and exclude hidden command runner", () => {
            string hidden = "<Application Id=\"Runner\" Executable=\"runner.exe\"><uap:VisualElements AppListEntry=\"none\"/></Application>";
            var package = Package("primary", "1.0.0.0", "app/ChatGPT.exe", "App", hidden);
            var found = CodexPackage.ReadManifest(package);
            Assert(found.ApplicationId == "App", "Selected hidden application.");
        });
        Test("update may rename both executable and application ID", () => {
            var before = Package("rename-before", "1.0.0.0", "app/ChatGPT.exe", "App", "");
            var after = Package("rename-after", "2.0.0.0", "desktop/NewCodex.exe", "NewDesktopId", "");
            var found = CodexPackage.Select(new[] { before, after }, null);
            Assert(found.ApplicationId == "NewDesktopId" && found.Executable.EndsWith("NewCodex.exe"), "Rename was hard-coded.");
        });
        Test("choose versions numerically rather than lexicographically", () => {
            var nine = Package("v9", "26.9.0.0", "app/A.exe", "A", "");
            var ten = Package("v10", "26.10.0.0", "app/B.exe", "B", "");
            Assert(CodexPackage.Select(new[] { ten, nine }, null).ApplicationId == "B", "Incorrect version order.");
        });
        Test("skip incomplete package while a valid registered package remains", () => {
            var valid = Package("available", "1.0.0.0", "app/App.exe", "Desktop", "");
            var incomplete = Package("incomplete", "2.0.0.0", "app/App.exe", "Missing", "");
            File.Delete(Path.Combine(incomplete.Root, "app", "App.exe"));
            Assert(CodexPackage.Select(new[] { incomplete, valid }, null).ApplicationId == "Desktop", "Missing target selected.");
        });
        Test("missing installation reports failure", () => {
            Reject<FileNotFoundException>(() => CodexPackage.Select(new CodexPackage[0], null));
        });
        Test("ambiguous visible applications fail explicitly", () => {
            var ambiguous = Package("ambiguous", "1.0.0.0", "app/App.exe", "First",
                "<Application Id=\"Second\" Executable=\"app/App.exe\"><uap:VisualElements/></Application>");
            Reject<InvalidDataException>(() => CodexPackage.ReadManifest(ambiguous));
        });
        Test("manifest cannot escape the package directory", () => {
            var escape = Package("escape", "1.0.0.0", "../outside.exe", "App", "");
            Reject<InvalidDataException>(() => CodexPackage.ReadManifest(escape));
        });
        Test("missing alias is created and validated by reading NTFS metadata", () => {
            string path = Alias("created");
            Assert(AppExecLink.Read(path) == null, "Test alias already exists.");
            Assert(AppExecLink.Ensure(path, CodexPackage.Family, current.AppUserModelId, current.Executable), "Alias was not created.");
            Assert(AppExecLink.Read(path)[2] == current.Executable, "Alias target not persisted.");
        });
        Test("unchanged alias is not rewritten", () => {
            string path = Alias("created");
            Assert(!AppExecLink.Ensure(path, CodexPackage.Family, current.AppUserModelId, current.Executable), "Unnecessary rewrite.");
        });
        Test("obsolete alias is repaired after old package directory disappears", () => {
            string path = Alias("stale");
            string missing = Path.Combine(workspace, "deleted-old-version", "app", "ChatGPT.exe");
            AppExecLink.Ensure(path, CodexPackage.Family, CodexPackage.Family + "!OldApp", missing);
            Assert(AppExecLink.Read(path)[2] == missing, "Stale alias setup failed.");
            AppExecLink.Ensure(path, CodexPackage.Family, current.AppUserModelId, current.Executable);
            string[] repaired = AppExecLink.Read(path);
            Assert(repaired[1] == current.AppUserModelId && repaired[2] == current.Executable, "Stale alias did not recover.");
        });
        Test("missing alias can be recreated after deletion", () => {
            string path = Alias("created");
            File.Delete(path);
            Assert(AppExecLink.Ensure(path, CodexPackage.Family, current.AppUserModelId, current.Executable), "Deleted alias did not recover.");
        });
        Test("unrelated regular file is preserved", () => {
            string path = Alias("regular");
            File.WriteAllText(path, "preserve this file");
            Reject<System.ComponentModel.Win32Exception>(() => AppExecLink.Ensure(path, CodexPackage.Family, current.AppUserModelId, current.Executable));
            Assert(File.ReadAllText(path) == "preserve this file", "Regular file was overwritten.");
        });
        Test("alias belonging to another package is preserved", () => {
            string path = Alias("foreign");
            AppExecLink.Ensure(path, "Other.Package_family", "Other.Package_family!App", current.Executable);
            Reject<InvalidDataException>(() => AppExecLink.Ensure(path, CodexPackage.Family, current.AppUserModelId, current.Executable));
            Assert(AppExecLink.Read(path)[0] == "Other.Package_family", "Foreign alias was overwritten.");
        });
        Test("quoted command parsing handles spaces and leading whitespace", () => {
            Assert(C2Process.FirstArgument("  \"C:\\User Space\\ChatGPT2.exe\" --x") == @"C:\User Space\ChatGPT2.exe", "Quoted path was not parsed.");
            Assert(C2Process.FirstArgument("\"unterminated") == "", "Malformed command accepted.");
            Assert(C2Process.FirstArgument("simple.exe --x") == "simple.exe", "Unquoted path was not parsed.");
        });
        Test("package identity check rejects unrelated process", () => {
            using (var self = Process.GetCurrentProcess()) Assert(!CodexPackage.Owns(self), "Test harness mistaken for Codex.");
        });
    }

    private static void RuntimeTest() {
        Test("direct alias launch gets real PID, isolates profile and leaves parent environment intact", () => {
            CodexPackage package = CodexPackage.Resolve(Console.WriteLine);
            string alias = Alias("runtime");
            string profile = Path.Combine(workspace, "runtime-profile");
            Directory.CreateDirectory(profile);
            AppExecLink.Ensure(alias, CodexPackage.Family, package.AppUserModelId, package.Executable);
            string beforeHome = Environment.GetEnvironmentVariable("CODEX_HOME");
            string beforeData = Environment.GetEnvironmentVariable("CODEX_ELECTRON_USER_DATA_PATH");
            Process process = null;
            IntPtr desktop = ChatGPT2Launcher.OpenDesktop("Default", 0, false, ChatGPT2Launcher.DESKTOP_ACCESS);
            Assert(desktop != IntPtr.Zero, "Cannot inspect default desktop.");
            try {
                process = C2Process.Start(alias, profile, Path.GetDirectoryName(package.Executable), 19224);
                Assert(CodexPackage.Owns(process), "Direct launch returned the wrong process.");
                Assert(Environment.GetEnvironmentVariable("CODEX_HOME") == beforeHome, "Parent CODEX_HOME was changed.");
                Assert(Environment.GetEnvironmentVariable("CODEX_ELECTRON_USER_DATA_PATH") == beforeData, "Parent profile was changed.");
                var timer = Stopwatch.StartNew();
                bool visible = false;
                ChatGPT2Launcher.EnumWindowsProc callback = (window, ignored) => {
                    uint pid;
                    ChatGPT2Launcher.GetWindowThreadProcessId(window, out pid);
                    ChatGPT2Launcher.RECT rect;
                    if (pid == (uint)process.Id && ChatGPT2Launcher.IsWindowVisible(window) &&
                        ChatGPT2Launcher.GetWindowRect(window, out rect) &&
                        rect.Width > 200 && rect.Height > 200) visible = true;
                    return true;
                };
                while (timer.ElapsedMilliseconds < 30000 && !visible) {
                    Assert(!process.HasExited, "Directly launched application exited prematurely.");
                    ChatGPT2Launcher.EnumDesktopWindows(desktop, callback, IntPtr.Zero);
                    Thread.Sleep(100);
                }
                Assert(visible, "Isolated app did not create a window.");
                using (var recovered = C2Process.FindExisting(alias, 19224)) {
                    Assert(recovered != null && recovered.Id == process.Id, "Could not recover verified instance.");
                }
                Assert(Directory.GetFileSystemEntries(profile).Length > 0, "Isolated profile remained empty.");
                Console.WriteLine("RUNTIME PID=" + process.Id + ", window wait=" + timer.ElapsedMilliseconds + " ms");
            } finally {
                ChatGPT2Launcher.CloseDesktop(desktop);
                if (process != null) {
                    try { C2Process.StopOwnedTree(process, Console.WriteLine); }
                    finally { process.Dispose(); }
                }
            }
        });
    }

    public static int Main(string[] args) {
        workspace = Path.Combine(Path.GetTempPath(), "CodexC2Tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workspace);
        try {
            CoreTests();
            if (args.Contains("--runtime")) RuntimeTest();
            Console.WriteLine("RESULT " + passed + " tests passed. Artifacts: " + workspace);
            return 0;
        } catch (Exception ex) {
            Console.Error.WriteLine("FAIL " + ex);
            Console.Error.WriteLine("Artifacts: " + workspace);
            return 1;
        }
    }
}
