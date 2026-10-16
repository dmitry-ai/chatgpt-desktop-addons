using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Windows.Forms;
public static class WindowLifecycleHost {
    [STAThread]
    public static void Main() {
        string prefix = @"Local\CodexC2WindowTest-" + Path.GetFileName(Environment.GetEnvironmentVariable("CODEX_HOME"));
        using (var ready = new EventWaitHandle(false, EventResetMode.ManualReset, prefix + "-Ready"))
        using (var hide = new EventWaitHandle(false, EventResetMode.AutoReset, prefix + "-Hide"))
        using (var recreate = new EventWaitHandle(false, EventResetMode.AutoReset, prefix + "-Recreate"))
        using (var quit = new EventWaitHandle(false, EventResetMode.AutoReset, prefix + "-Quit"))
        using (var context = new ApplicationContext())
        using (var tick = new System.Windows.Forms.Timer()) {
            Form form = null;
            Action show = () => {
                form = new Form { Text = "C2 lifecycle fixture", Width = 640, Height = 420, ShowInTaskbar = false };
                form.Show();
                ready.Set();
            };
            var timer = Stopwatch.StartNew();
            long recreateAt = -1;
            show();
            tick.Interval = 50;
            tick.Tick += (sender, args) => {
                if (quit.WaitOne(0)) {
                    if (form != null) form.Dispose();
                    context.ExitThread();
                    return;
                }
                if (hide.WaitOne(0) && form != null) form.Hide();
                if (recreate.WaitOne(0)) {
                    ready.Reset();
                    if (form != null) { form.Dispose(); form = null; }
                    recreateAt = timer.ElapsedMilliseconds + 6000;
                }
                if (recreateAt >= 0 && timer.ElapsedMilliseconds >= recreateAt) {
                    recreateAt = -1;
                    show();
                }
            };
            tick.Start();
            Application.Run(context);
        }
    }
}
