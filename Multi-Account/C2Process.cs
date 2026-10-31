// 2026-10-16 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Fix C2 window lifecycle supervision, cold-start VBS visibility, and disable duplicate Sparkle auto-updater in C2":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/8
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
	private static extern bool CreateProcess(
		string executable,
		StringBuilder command,
		IntPtr processAttributes,
		IntPtr threadAttributes,
		bool inherit,
		uint flags,
		IntPtr environment,
		string directory,
		ref StartupInfo startup,
		out ProcessInfo process
	);
	[DllImport("kernel32.dll")]
	private static extern bool CloseHandle(IntPtr handle);
	[DllImport("kernel32.dll", SetLastError = true)]
	private static extern bool TerminateProcess(IntPtr process, uint exitCode);
	public static string FirstArgument(string command) {
		string r;
		command = (command ?? "").TrimStart();
		if (command.StartsWith("\"", StringComparison.Ordinal)) {
			int end = command.IndexOf('"', 1);
			r = 0 > end ? "" : command.Substring(1, end - 1);
		}
		else {
			int space = command.IndexOf(' ');
			r = 0 > space ? command : command.Substring(0, space);
		}
		return r;
	}
	// 2026-10-30 Dmitrii Fediuk https://github.com/dmitrii-fediuk
	// "Support unprivileged staged MSIX discovery (GetStagedPackagePathByFullName), Win32/NT process scanning without WMI, and Rolldown bundle chain":
	// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/14
	public static Process FindExisting(string alias, int debugPort) {
		Process r = null;
		try {
			foreach (int pid in CodexPackage.RunningUiProcesses()) {
				string command = CodexPackage.ReadProcessCommandLine(pid);
				if (
					!string.IsNullOrEmpty(command)
					&& string.Equals(FirstArgument(command), alias, StringComparison.OrdinalIgnoreCase)
					&& command.Split(' ').Contains("--remote-debugging-port=" + debugPort)
				) {
					Process candidate = null;
					try {
						candidate = Process.GetProcessById(pid);
						IntPtr pinned = candidate.Handle;
						if (candidate.HasExited || !CodexPackage.Owns(candidate)) {
							candidate.Dispose();
						}
						else {
							if (null != r) {
								throw new InvalidOperationException("More than one verified C2 instance is running.");
							}
							r = candidate;
							candidate = null;
						}
					}
					catch (ArgumentException) {}
					catch (InvalidOperationException) {
						if (null == candidate || !candidate.HasExited) {
							throw;
						}
					}
					catch (Win32Exception) {
						if (null == candidate || !candidate.HasExited) {
							throw;
						}
					}
					finally {
						if (null != candidate) {
							candidate.Dispose();
						}
					}
				}
			}
		}
		catch {
			if (null != r) {
				r.Dispose();
			}
			throw;
		}
		return r;
	}
	private static ProcessInfo CreateChild(string alias, string profile, string workingDirectory, int debugPort) {
		var values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
		foreach (System.Collections.DictionaryEntry item in Environment.GetEnvironmentVariables()) {
			values[(string)item.Key] = (string)item.Value;
		}
		values["CODEX_HOME"] = profile;
		values["CODEX_ELECTRON_USER_DATA_PATH"] = profile;
		values["CODEX_SPARKLE_ENABLED"] = "false";
		var block = new StringBuilder();
		foreach (var pair in values) {
			block.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
		}
		block.Append('\0');
		IntPtr environment = Marshal.StringToHGlobalUni(block.ToString());
		var startup = new StartupInfo {
			cb = Marshal.SizeOf(typeof(StartupInfo)),
			desktop = @"WinSta0\Default",
			flags = 1,
			show = 1
		};
		var command = new StringBuilder("\"" + alias + "\" --remote-debugging-port=" + debugPort);
		ProcessInfo r;
		try {
			if (!CreateProcess(alias, command, IntPtr.Zero, IntPtr.Zero, false, 0x400, environment, workingDirectory, ref startup, out r)) {
				throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot start the Codex execution alias.");
			}
		}
		finally {
			Marshal.FreeHGlobal(environment);
		}
		return r;
	}
	public static Process Start(string alias, string profile, string workingDirectory, int debugPort) {
		Process r;
		ProcessInfo info = CreateChild(alias, profile, workingDirectory, debugPort);
		try {
			var process = Process.GetProcessById(info.pid);
			try {
				IntPtr pinned = process.Handle;
				r = process;
			}
			catch {
				process.Dispose();
				throw;
			}
		}
		finally {
			CloseHandle(info.thread);
			CloseHandle(info.process);
		}
		return r;
	}
	public static void RequestActivation(string alias, string profile, string workingDirectory, int debugPort) {
		ProcessInfo info = CreateChild(alias, profile, workingDirectory, debugPort);
		CloseHandle(info.thread);
		CloseHandle(info.process);
	}
	// 2026-10-24 Dmitrii Fediuk https://github.com/dmitrii-fediuk
	// "Resolve MSIX 0x80073D02 and 0x80073D0F registration deadlocks by terminating orphaned AppX container processes via PEB inspection":
	// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/12
	public static void StopOwnedTree(Process root, Action<string> log) {
		if (!root.HasExited) {
			string c2Profile = null;
			var rootEnv = CodexPackage.ReadProcessEnvironment(root.Id);
			rootEnv.TryGetValue("CODEX_ELECTRON_USER_DATA_PATH", out c2Profile);
			var owned = new List<Process> { root };
			var seen = new HashSet<int> { root.Id };
			try {
				for (int i = 0; i < owned.Count; i++) {
					Process parent = owned[i];
					if (!parent.HasExited) {
						DateTime parentStart = parent.StartTime.ToUniversalTime();
						foreach (Process snapshot in Process.GetProcesses()) {
							int pid;
							using (snapshot) {
								pid = snapshot.Id;
							}
							if (4 < pid && !seen.Contains(pid) && parent.Id == CodexPackage.GetParentProcessId(pid)) {
								Process child = null;
								try {
									child = Process.GetProcessById(pid);
									IntPtr pinned = child.Handle;
									if (!child.HasExited && child.StartTime.ToUniversalTime() >= parentStart && parent.Id == CodexPackage.GetParentProcessId(child.Id)) {
										owned.Add(child);
										seen.Add(pid);
										child = null;
									}
								}
								catch (ArgumentException) {}
								catch (InvalidOperationException) {
									if (null == child || !child.HasExited) {
										throw;
									}
								}
								catch (Win32Exception) {
									if (null == child || !child.HasExited) {
										throw;
									}
								}
								finally {
									if (null != child) {
										child.Dispose();
									}
								}
							}
						}
					}
				}
				for (int i = owned.Count - 1; 0 <= i; i--) {
					if (!owned[i].HasExited && !TerminateProcess(owned[i].Handle, 0)) {
						int error = Marshal.GetLastWin32Error();
						if (!owned[i].HasExited) {
							throw new Win32Exception(error, "Cannot stop an owned C2 process.");
						}
					}
				}
				var wait = Stopwatch.StartNew();
				foreach (Process process in owned) {
					int remaining = Math.Max(0, 5000 - (int)wait.ElapsedMilliseconds);
					if (!process.WaitForExit(remaining)) {
						throw new TimeoutException("An owned C2 process did not exit after termination.");
					}
				}
				if (!string.IsNullOrEmpty(c2Profile)) {
					var orphans = CodexPackage.FindOrphanProcesses(c2Profile, false);
					if (0 < orphans.Count) {
						CodexPackage.StopProcesses(orphans, log);
					}
				}
				if (null != log) {
					log("Stopped the verified C2 process tree.");
				}
			}
			finally {
				for (int i = 1; i < owned.Count; i++) {
					owned[i].Dispose();
				}
			}
		}
	}
}
