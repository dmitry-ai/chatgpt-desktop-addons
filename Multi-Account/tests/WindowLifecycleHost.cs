// 2026-10-16 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Fix C2 window lifecycle supervision, cold-start VBS visibility, and disable duplicate Sparkle auto-updater in C2":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/8
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Windows.Forms;
public static class WindowLifecycleHost {
	private sealed class BackgroundForm : Form {
		protected override bool ShowWithoutActivation { get { return true; } }
	}
	[STAThread]
	public static void Main() {
		string prefix = @"Local\CodexC2WindowTest-" + Path.GetFileName(Environment.GetEnvironmentVariable("CODEX_HOME"));
		using (var ready = new EventWaitHandle(false, EventResetMode.ManualReset, prefix + "-Ready"))
		using (var hide = new EventWaitHandle(false, EventResetMode.AutoReset, prefix + "-Hide"))
		using (var restore = new EventWaitHandle(false, EventResetMode.AutoReset, prefix + "-Restore"))
		using (var contentVisible = new EventWaitHandle(false, EventResetMode.ManualReset, prefix + "-ContentVisible"))
		using (var recreate = new EventWaitHandle(false, EventResetMode.AutoReset, prefix + "-Recreate"))
		using (var quit = new EventWaitHandle(false, EventResetMode.AutoReset, prefix + "-Quit"))
		using (var context = new ApplicationContext())
		using (var tick = new System.Windows.Forms.Timer()) {
			Form form = null;
			Action show = () => {
				form = new BackgroundForm {
					Text = "C2 lifecycle fixture",
					Width = 640,
					Height = 420,
					ShowInTaskbar = false,
					StartPosition = FormStartPosition.Manual,
					Left = SystemInformation.VirtualScreen.Right + 1000,
					Top = SystemInformation.VirtualScreen.Top
				};
				form.Show();
				contentVisible.Set();
				ready.Set();
			};
			var timer = Stopwatch.StartNew();
			long recreateAt = -1;
			show();
			tick.Interval = 50;
			tick.Tick += (sender, args) => {
				if (quit.WaitOne(0)) {
					if (null != form) {
						form.Dispose();
					}
					context.ExitThread();
				}
				else {
					if (hide.WaitOne(0) && null != form) {
						contentVisible.Reset();
						form.Hide();
					}
					if (restore.WaitOne(0) && null != form) {
						form.Show();
						contentVisible.Set();
					}
					if (recreate.WaitOne(0)) {
						ready.Reset();
						contentVisible.Reset();
						if (null != form) {
							form.Dispose();
							form = null;
						}
						recreateAt = timer.ElapsedMilliseconds + 6000;
					}
					if (0 <= recreateAt && timer.ElapsedMilliseconds >= recreateAt) {
						recreateAt = -1;
						show();
					}
				}
			};
			tick.Start();
			Application.Run(context);
		}
	}
}
