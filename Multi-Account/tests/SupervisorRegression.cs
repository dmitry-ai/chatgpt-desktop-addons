using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

public static class SupervisorRegression {
    [STAThread]
    public static int Main(string[] args) {
        using (var log = new StreamWriter(args[2], false) { AutoFlush = true }) {
            Console.SetOut(log);
            Console.SetError(log);
            return Run(args);
        }
    }

    private static int Run(string[] args) {
        string home = TestWorkspace.CreateDirectory("window");
        string prefix = @"Local\CodexC2WindowTest-" + Path.GetFileName(home);
        using (var ready = new EventWaitHandle(false, EventResetMode.ManualReset, prefix + "-Ready"))
        using (var hide = new EventWaitHandle(false, EventResetMode.AutoReset, prefix + "-Hide"))
        using (var restore = new EventWaitHandle(false, EventResetMode.AutoReset, prefix + "-Restore"))
        using (var contentVisible = new EventWaitHandle(false, EventResetMode.ManualReset, prefix + "-ContentVisible"))
        using (var recreate = new EventWaitHandle(false, EventResetMode.AutoReset, prefix + "-Recreate"))
        using (var quit = new EventWaitHandle(false, EventResetMode.AutoReset, prefix + "-Quit"))
        using (var activate = new EventWaitHandle(false, EventResetMode.AutoReset))
        using (var target = StartFixture(args[0], home)) {
            IntPtr desktop = ChatGPT2Launcher.OpenDesktop("Default", 0, false, ChatGPT2Launcher.DESKTOP_ACCESS);
            Exception failure = null;
            int activationRequests = 0;
            Thread supervisor = null;
            try {
                if (!ready.WaitOne(10000)) throw new Exception("Test window did not become ready.");
                IntPtr window = IntPtr.Zero;
                ChatGPT2Launcher.EnumWindowsProc find = (hwnd, data) => {
                    uint pid;
                    ChatGPT2Launcher.GetWindowThreadProcessId(hwnd, out pid);
                    var title = new StringBuilder(256);
                    ChatGPT2Launcher.GetWindowText(hwnd, title, title.Capacity);
                    if (pid == (uint)target.Id && title.ToString() == "C2 lifecycle fixture") window = hwnd;
                    return true;
                };
                ChatGPT2Launcher.EnumDesktopWindows(desktop, find, IntPtr.Zero);
                if (window == IntPtr.Zero) throw new Exception("Test window was not found.");
                supervisor = new Thread(() => {
                    try { ChatGPT2Launcher.RunSupervisor(target, window, args[1], activate, desktop,
                        () => { Interlocked.Increment(ref activationRequests); restore.Set(); }); }
                    catch (Exception ex) { failure = ex; }
                });
                supervisor.IsBackground = true;
                supervisor.Start();
                Thread.Sleep(700);
                if (!ChatGPT2Launcher.IsWindowVisible(window)) throw new Exception("REGRESSION: initial activation from the hidden GUI launcher hid the application window.");
                if (failure != null) throw failure;
                Console.WriteLine("PASS initial activation from a hidden GUI launcher keeps the application window visible.");
                hide.Set();
                Thread.Sleep(4000);
                if (target.HasExited) throw new Exception("REGRESSION: supervisor terminated the application after its window was hidden.");
                if (failure != null) throw failure;
                Console.WriteLine("PASS process survives a hidden window beyond the old two-second deadline.");
                // Reproduce the old split state without activating a test window:
                // the OS frame is shown, but the application's content stays hidden.
                ChatGPT2Launcher.ShowWindow(window, 4); // SW_SHOWNOACTIVATE
                if (!ChatGPT2Launcher.IsWindowVisible(window) || contentVisible.WaitOne(0))
                    throw new Exception("Could not reproduce a visible frame with hidden application content.");
                activate.Set();
                Thread.Sleep(1000);
                if (!ChatGPT2Launcher.IsWindowVisible(window) || !contentVisible.WaitOne(0) || Volatile.Read(ref activationRequests) != 1)
                    throw new Exception("Activation did not ask the application to restore its hidden content.");
                Console.WriteLine("PASS visible frame with hidden content is restored through the application.");
                recreate.Set();
                Thread.Sleep(4000);
                if (target.HasExited) throw new Exception("REGRESSION: supervisor terminated the application while its window was being recreated.");
                activate.Set();
                var requestWait = Stopwatch.StartNew();
                while (Volatile.Read(ref activationRequests) < 2 && requestWait.ElapsedMilliseconds < 1500) Thread.Sleep(20);
                if (Volatile.Read(ref activationRequests) != 2) throw new Exception("Destroyed-window activation was not forwarded to the application.");
                Console.WriteLine("PASS activation of a destroyed window is forwarded to the application.");
                if (!ready.WaitOne(5000)) throw new Exception("Replacement window did not become ready.");
                Thread.Sleep(700);
                if (failure != null) throw failure;
                Console.WriteLine("PASS application survives six seconds without a window and accepts its replacement.");
                quit.Set();
                if (!target.WaitForExit(10000)) throw new Exception("Test app did not exit.");
                if (!supervisor.Join(5000)) throw new Exception("Supervisor did not finish when the application exited.");
                if (failure != null) throw failure;
                Console.WriteLine("PASS supervisor exits after the application itself exits.");
                return 0;
            } catch (Exception ex) {
                Console.Error.WriteLine("FAIL " + ex);
                return 1;
            } finally {
                quit.Set();
                if (!target.WaitForExit(2000)) C2Process.StopOwnedTree(target, Console.WriteLine);
                if (supervisor != null) supervisor.Join(5000);
                ChatGPT2Launcher.CloseDesktop(desktop);
            }
        }
    }

    private static Process StartFixture(string executable, string home) {
        // No STARTF_USESHOWWINDOW override: the fixture's ShowWithoutActivation
        // must stay effective while the user works in another application.
        var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true };
        start.EnvironmentVariables["CODEX_HOME"] = home;
        return Process.Start(start);
    }
}
