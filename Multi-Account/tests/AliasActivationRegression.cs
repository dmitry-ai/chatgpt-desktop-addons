// 2026-10-16 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Fix C2 window lifecycle supervision, cold-start VBS visibility, and disable duplicate Sparkle auto-updater in C2":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/8
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
public static class AliasActivationRegression {
	[STAThread]
	public static int Main(string[] args) {
		int r = 1;
		using (var output = new StreamWriter(args[1], false) { AutoFlush = true }) {
			Console.SetOut(output);
			Console.SetError(output);
			string home = TestWorkspace.CreateDirectory("startup");
			Process target = null;
			Thread observer = null;
			IntPtr desktop = IntPtr.Zero;
			Exception observationFailure = null;
			try {
				var package = CodexPackage.Resolve(Console.WriteLine);
				string alias = TestWorkspace.AliasFile(home, "startup");
				string profile = Path.Combine(home, "profile");
				Directory.CreateDirectory(profile);
				AppExecLink.Ensure(alias, CodexPackage.Family, package.AppUserModelId, package.Executable);
				target = C2Process.Start(alias, profile, Path.GetDirectoryName(package.Executable), 19226);
				if (!CodexPackage.Owns(target)) {
					throw new Exception("Unexpected runtime process identity.");
				}
				desktop = ChatGPT2Launcher.OpenDesktop("Default", 0, false, ChatGPT2Launcher.DESKTOP_ACCESS);
				if (IntPtr.Zero == desktop) {
					throw new Exception("Cannot inspect the interactive desktop.");
				}
				IntPtr mainWindow = IntPtr.Zero;
				ChatGPT2Launcher.EnumWindowsProc find = (window, ignored) => {
					uint pid;
					ChatGPT2Launcher.RECT rect;
					ChatGPT2Launcher.GetWindowThreadProcessId(window, out pid);
					if (
						pid == (uint)target.Id
						&& ChatGPT2Launcher.IsWindowVisible(window)
						&& ChatGPT2Launcher.GetWindowRect(window, out rect)
						&& 200 < rect.Width
						&& 200 < rect.Height
					) {
						mainWindow = window;
					}
					return true;
				};
				var wait = Stopwatch.StartNew();
				while (IntPtr.Zero == mainWindow && 30000 > wait.ElapsedMilliseconds) {
					if (target.HasExited) {
						throw new Exception("Codex exited before its first window.");
					}
					ChatGPT2Launcher.EnumDesktopWindows(desktop, find, IntPtr.Zero);
					if (IntPtr.Zero == mainWindow) {
						Thread.Sleep(50);
					}
				}
				if (IntPtr.Zero == mainWindow) {
					throw new Exception("Codex did not reveal its first window.");
				}
				Console.WriteLine("COLD START PID=" + target.Id + " HWND=0x" + mainWindow.ToInt64().ToString("X"));
				using (var activation = new EventWaitHandle(false, EventResetMode.AutoReset)) {
					observer = new Thread(() => {
						try {
							var observation = Stopwatch.StartNew();
							while (1500 > observation.ElapsedMilliseconds) {
								if (!ChatGPT2Launcher.IsWindowVisible(mainWindow)) {
									throw new Exception("REGRESSION: first supervisor activation hid the real Codex window at " + observation.ElapsedMilliseconds + " ms.");
								}
								if (target.HasExited) {
									throw new Exception("Codex exited during startup activation.");
								}
								Thread.Sleep(20);
							}
						}
						catch (Exception ex) {
							observationFailure = ex;
						}
						finally {
							C2Process.StopOwnedTree(target, Console.WriteLine);
						}
					});
					observer.Start();
					ChatGPT2Launcher.RunSupervisor(
						target,
						mainWindow,
						args[0],
						activation,
						desktop,
						() => C2Process.RequestActivation(alias, profile, Path.GetDirectoryName(package.Executable), 19226)
					);
					observer.Join();
				}
				if (null != observationFailure) {
					throw observationFailure;
				}
				Console.WriteLine("PASS cold alias launch stays visible during first supervisor activation from a hidden GUI process.");
				r = 0;
			}
			catch (Exception ex) {
				Console.Error.WriteLine("FAIL " + ex);
			}
			finally {
				if (null != observer && observer.IsAlive) {
					observer.Join();
				}
				if (null != target) {
					try {
						C2Process.StopOwnedTree(target, Console.WriteLine);
					}
					finally {
						target.Dispose();
					}
				}
				if (IntPtr.Zero != desktop) {
					ChatGPT2Launcher.CloseDesktop(desktop);
				}
			}
		}
		return r;
	}
}
