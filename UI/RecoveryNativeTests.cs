using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public static class RecoveryNativeTests {
    private sealed class BackgroundForm : Form {
        protected override bool ShowWithoutActivation { get { return true; } }
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo {
        public int Size; public IntPtr Reserved, Desktop, Title;
        public int X, Y, Width, Height, XChars, YChars, Fill, Flags;
        public short Show, ReservedBytes;
        public IntPtr ReservedPointer, Input, Output, Error;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern void GetStartupInfo(out StartupInfo info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int RegisterApplicationRestart(string command, uint flags);
    [STAThread]
    public static int Main(string[] args) {
        if (args.Length == 2 && args[0] == "--host") { Host(args[1]); return 0; }
        if (args.Length == 1 && args[0] == "--remote-debugging-port=19823") { PrimaryChild(); return 0; }
        Process first = null, second = null;
        string one = @"Local\CodexUIRecovery-" + Guid.NewGuid().ToString("N");
        string two = @"Local\CodexUIRecovery-" + Guid.NewGuid().ToString("N");
        try {
            PrimaryLaunch();
            first = Start(one); second = Start(two);
            if (!WindowsRestart.IsRegistered(first) || !WindowsRestart.IsRegistered(second))
                throw new Exception("Fixture restart registration failed.");
            WindowsRestart.Shutdown(first);
            if (!first.HasExited) throw new Exception("The registered fixture was not closed.");
            if (second.HasExited) throw new Exception("An unrelated process was closed.");
            Console.WriteLine("PASS: graceful shutdown closes only the pinned, registered fixture.");
            C1ProcessInfo before = C1Runtime.Probe();
            try { C1Runtime.Recover(-1, "0"); throw new Exception("Invalid recovery target was accepted."); }
            catch (InvalidOperationException) { }
            C1ProcessInfo after = C1Runtime.Probe();
            if ((before == null) != (after == null) || (before != null && before.StartTicks != after.StartTicks))
                throw new Exception("Rejecting an invalid recovery request affected C1.");
            Console.WriteLine("PASS: stale or invalid target cannot close the real C1.");
            if (before != null && args.Contains("--allow-app-activation")) {
                C1Runtime.Activate();
                after = C1Runtime.Probe();
                if (after == null || before.StartTicks != after.StartTicks)
                    throw new Exception("Warm package activation replaced the running C1 unexpectedly.");
                Console.WriteLine("PASS: Windows activation addresses the registered C1 without affecting C2.");
            }
            return 0;
        } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        finally { Close(first, one); Close(second, two); }
    }
    private static void PrimaryLaunch() {
        string[] keys = { "CODEX_HOME", "CODEX_ELECTRON_USER_DATA_PATH", "CODEX_SPARKLE_ENABLED", "CODEX_C1_START_TEST_PIPE" };
        string[] previous = keys.Select(Environment.GetEnvironmentVariable).ToArray();
        string pipe = "CodexUIC1Start-" + Guid.NewGuid().ToString("N");
        string[] expected = { "test-home-" + pipe, "test-user-data-" + pipe, "updater-preserved", pipe };
        Process child = null;
        try {
            for (int i = 0; i < keys.Length; i++) Environment.SetEnvironmentVariable(keys[i], expected[i]);
            using (var server = new NamedPipeServerStream(pipe, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous)) {
                child = C1Runtime.StartProcess(Process.GetCurrentProcess().MainModule.FileName, 19823);
                if (!server.WaitForConnectionAsync().Wait(10000)) throw new TimeoutException("Direct primary child did not connect.");
                using (var reader = new BinaryReader(server)) {
                    if (reader.ReadInt32() != child.Id || reader.ReadString() != "--remote-debugging-port=19823")
                        throw new Exception("C1 direct launch lost its process identity or UI argument.");
                    for (int i = 0; i < 3; i++) if (reader.ReadString() != expected[i])
                        throw new Exception("C1 launch changed its profile or disabled its updater.");
                    if ((reader.ReadInt32() & 1) == 0 || reader.ReadInt16() != 1)
                        throw new Exception("Hidden wrapper startup would hide the main application.");
                }
                if (!child.WaitForExit(5000) || child.ExitCode != 0) throw new Exception("Primary child did not exit cleanly.");
            }
            Console.WriteLine("PASS: direct C1 launch preserves its argument, inherited profile and updater, and explicit normal startup.");
        } finally {
            if (child != null) { try { if (!child.HasExited) child.Kill(); } finally { child.Dispose(); } }
            for (int i = 0; i < keys.Length; i++) Environment.SetEnvironmentVariable(keys[i], previous[i]);
        }
    }
    private static void PrimaryChild() {
        string pipe = Environment.GetEnvironmentVariable("CODEX_C1_START_TEST_PIPE");
        if (pipe == null || !pipe.StartsWith("CodexUIC1Start-")) throw new InvalidOperationException("Missing test channel.");
        using (var client = new NamedPipeClientStream(".", pipe, PipeDirection.Out)) {
            client.Connect(5000);
            using (var writer = new BinaryWriter(client)) {
                writer.Write(Process.GetCurrentProcess().Id);
                writer.Write(Environment.GetCommandLineArgs()[1]);
                foreach (string key in new[] { "CODEX_HOME", "CODEX_ELECTRON_USER_DATA_PATH", "CODEX_SPARKLE_ENABLED" })
                    writer.Write(Environment.GetEnvironmentVariable(key) ?? "");
                StartupInfo startup; GetStartupInfo(out startup);
                writer.Write(startup.Flags); writer.Write(startup.Show);
            }
        }
    }
    private static Process Start(string key) {
        using (var ready = new EventWaitHandle(false, EventResetMode.ManualReset, key + "-ready")) {
            var info = new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName,
                "--host " + key) { UseShellExecute = false, CreateNoWindow = true };
            Process process = Process.Start(info);
            IntPtr pinned = process.Handle;
            if (!ready.WaitOne(10000)) { Close(process, key); throw new TimeoutException("Fixture did not start."); }
            return process;
        }
    }
    private static void Close(Process process, string key) {
        if (process == null) return;
        try {
            if (!process.HasExited) {
                using (var quit = EventWaitHandle.OpenExisting(key + "-quit")) quit.Set();
                if (!process.WaitForExit(5000)) process.Kill(); // Only this test's pinned child.
                process.WaitForExit();
            }
        } finally { process.Dispose(); }
    }
    private static void Host(string key) {
        Marshal.ThrowExceptionForHR(RegisterApplicationRestart("", 0));
        using (var ready = EventWaitHandle.OpenExisting(key + "-ready"))
        using (var quit = new EventWaitHandle(false, EventResetMode.ManualReset, key + "-quit"))
        using (var timer = new System.Windows.Forms.Timer())
        using (var form = new BackgroundForm { Text = "Codex UI recovery test", ShowInTaskbar = false, Opacity = 0,
            StartPosition = FormStartPosition.Manual, Left = SystemInformation.VirtualScreen.Right + 1000 }) {
            timer.Interval = 50;
            timer.Tick += (sender, e) => { if (quit.WaitOne(0)) form.Close(); };
            form.Shown += (sender, e) => ready.Set();
            timer.Start();Application.Run(form);
        }
    }
}
