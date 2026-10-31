// 2026-10-17 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Register staged MSIX updates in c1-runtime.ps1 and activate C1 on WinSta0\Default via IApplicationActivationManager":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/10
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
	[DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
	private static extern int RegisterApplicationRestart(string command, uint flags);
	[STAThread]
	public static int Main(string[] args) {
		int r = 0;
		if (2 == args.Length && "--host" == args[0]) {
			Host(args[1]);
		}
		else {
			Process first = null, second = null;
			string one = @"Local\CodexUIRecovery-" + Guid.NewGuid().ToString("N");
			string two = @"Local\CodexUIRecovery-" + Guid.NewGuid().ToString("N");
			try {
				PackageResolution();
				first = Start(one);
				second = Start(two);
				if (!WindowsRestart.IsRegistered(first) || !WindowsRestart.IsRegistered(second)) {
					throw new Exception("Fixture restart registration failed.");
				}
				if (!C1Runtime.HasVisibleMainWindow(first.Id)) {
					throw new Exception("Visible fixture window was not detected by HasVisibleMainWindow.");
				}
				WindowsRestart.Shutdown(first);
				if (!first.HasExited) {
					throw new Exception("The registered fixture was not closed.");
				}
				if (second.HasExited) {
					throw new Exception("An unrelated process was closed.");
				}
				Console.WriteLine("PASS: graceful shutdown closes only the pinned, registered fixture.");
				C1ProcessInfo before = C1Runtime.Probe();
				try {
					C1Runtime.Recover(-1, "0");
					throw new Exception("Invalid recovery target was accepted.");
				}
				catch (InvalidOperationException) { }
				C1ProcessInfo after = C1Runtime.Probe();
				if ((null == before) != (null == after) || (null != before && before.StartTicks != after.StartTicks)) {
					throw new Exception("Rejecting an invalid recovery request affected C1.");
				}
				Console.WriteLine("PASS: stale or invalid target cannot close the real C1.");
				if (null != before && args.Contains("--allow-app-activation")) {
					int pid = C1Runtime.Launch(true);
					after = C1Runtime.Probe();
					if (null == after || pid != before.Pid || before.StartTicks != after.StartTicks) {
						throw new Exception("Warm package activation replaced the running C1 unexpectedly.");
					}
					Console.WriteLine("PASS: Windows activation addresses the registered C1 without affecting C2.");
				}
			}
			catch (Exception error) {
				Console.Error.WriteLine(error);
				r = 1;
			}
			finally {
				Close(first, one);
				Close(second, two);
			}
		}
		return r;
	}
	private static void PackageResolution() {
		CodexPackage package = CodexPackage.Resolve(null);
		if (string.IsNullOrEmpty(package.AppUserModelId) || !File.Exists(package.Executable)) {
			throw new Exception("Registered Codex package did not resolve to a valid AUMID and executable.");
		}
		Console.WriteLine("PASS: registered Codex package resolves AUMID and executable for activation.");
	}
	private static Process Start(string key) {
		using (var ready = new EventWaitHandle(false, EventResetMode.ManualReset, key + "-ready")) {
			var info = new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName,
				"--host " + key) { UseShellExecute = false, CreateNoWindow = true };
			Process r = Process.Start(info);
			IntPtr pinned = r.Handle;
			if (!ready.WaitOne(10000)) {
				Close(r, key);
				throw new TimeoutException("Fixture did not start.");
			}
			return r;
		}
	}
	private static void Close(Process process, string key) {
		if (null != process) {
			try {
				if (!process.HasExited) {
					using (var quit = EventWaitHandle.OpenExisting(key + "-quit")) {
						quit.Set();
					}
					if (!process.WaitForExit(5000)) {
						process.Kill();
					}
					process.WaitForExit();
				}
			}
			finally {
				process.Dispose();
			}
		}
	}
	private static void Host(string key) {
		Marshal.ThrowExceptionForHR(RegisterApplicationRestart("", 0));
		using (var ready = EventWaitHandle.OpenExisting(key + "-ready"))
		using (var quit = new EventWaitHandle(false, EventResetMode.ManualReset, key + "-quit"))
		using (var timer = new System.Windows.Forms.Timer())
		using (var form = new BackgroundForm {
			Text = "Codex UI recovery test",
			Width = 640,
			Height = 420,
			ShowInTaskbar = false,
			Opacity = 0,
			StartPosition = FormStartPosition.Manual,
			Left = SystemInformation.VirtualScreen.Right + 1000
		}) {
			timer.Interval = 50;
			timer.Tick += (sender, e) => {
				if (quit.WaitOne(0)) {
					form.Close();
				}
			};
			form.Shown += (sender, e) => ready.Set();
			timer.Start();
			Application.Run(form);
		}
	}
}
