// 2026-10-10 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Create isolated second profile C2 (Codex-Profile2) with dedicated AppUserModelID, badge icon, and AppExecLink launcher":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/2
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public class ChatGPT2Launcher {
	[DllImport("user32.dll", EntryPoint = "OpenDesktopW", CharSet = CharSet.Unicode, SetLastError = true)]
	public static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);
	[DllImport("user32.dll", SetLastError = true)]
	public static extern bool CloseDesktop(IntPtr hDesktop);
	[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
	public static extern bool SetWindowText(IntPtr hWnd, string lpString);
	[DllImport("user32.dll")]
	public static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumWindowsProc lpEnumFunc, IntPtr lParam);
	[DllImport("user32.dll")]
	public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
	[DllImport("user32.dll")]
	public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
	[DllImport("user32.dll", CharSet = CharSet.Auto)]
	public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
	[DllImport("user32.dll", CharSet = CharSet.Auto)]
	public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
	[DllImport("user32.dll")]
	public static extern bool IsWindow(IntPtr hWnd);
	[DllImport("user32.dll")]
	public static extern bool IsWindowVisible(IntPtr hWnd);
	[DllImport("user32.dll")]
	public static extern bool IsIconic(IntPtr hWnd);
	[DllImport("user32.dll")]
	private static extern IntPtr GetWindow(IntPtr hWnd, uint command);
	[DllImport("user32.dll")]
	public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
	[DllImport("user32.dll")]
	public static extern IntPtr GetForegroundWindow();
	[DllImport("user32.dll", SetLastError = true)]
	public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
	[DllImport("user32.dll", SetLastError = true)]
	public static extern IntPtr SendMessageTimeout(
		IntPtr hWnd,
		uint Msg,
		UIntPtr wParam,
		IntPtr lParam,
		uint fuFlags,
		uint uTimeout,
		out UIntPtr lpdwResult
	);
	[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
	public static extern IntPtr LoadImage(
		IntPtr hInst,
		string lpszName,
		uint uType,
		int cxDesired,
		int cyDesired,
		uint fuLoad
	);
	[DllImport("user32.dll", SetLastError = true)]
	public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
	[DllImport("shell32.dll", SetLastError = true)]
	public static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid riid, out IPropertyStore ppv);
	public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
	[StructLayout(LayoutKind.Sequential)]
	public struct RECT {
		public int Left, Top, Right, Bottom;
		public int Width { get { return Right - Left; } }
		public int Height { get { return Bottom - Top; } }
	}
	public const uint WM_GETICON = 0x007F;
	public const uint WM_SETICON = 0x0080;
	public const uint ICON_SMALL = 0;
	public const uint ICON_BIG = 1;
	public const uint IMAGE_ICON = 1;
	public const uint LR_LOADFROMFILE = 0x0010;
	public const uint SMTO_ABORTIFHUNG = 0x0002;
	public const uint SWP_NOMOVE = 0x0002;
	public const uint SWP_NOSIZE = 0x0001;
	public const uint SWP_NOZORDER = 0x0004;
	public const uint SWP_NOACTIVATE = 0x0010;
	public const uint SWP_FRAMECHANGED = 0x0020;
	public const int SW_RESTORE = 9;
	public const int SW_SHOW = 5;
	public const uint DESKTOP_ACCESS = 0x00C1;
	public const int CDP_PORT_C2 = 9224;
	[StructLayout(LayoutKind.Sequential, Pack = 4)]
	public struct PROPERTYKEY {
		public Guid fmtid;
		public uint pid;
		public PROPERTYKEY(Guid guid, uint id) {
			fmtid = guid;
			pid = id;
		}
	}
	[StructLayout(LayoutKind.Explicit, Size = 24)]
	public struct PROPVARIANT {
		[FieldOffset(0)] public ushort vt;
		[FieldOffset(2)] public ushort wReserved1;
		[FieldOffset(4)] public ushort wReserved2;
		[FieldOffset(6)] public ushort wReserved3;
		[FieldOffset(8)] public IntPtr pwszVal;
	}
	[ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	public interface IPropertyStore {
		[PreserveSig] int GetCount(out uint cProps);
		[PreserveSig] int GetAt(uint iProp, out PROPERTYKEY pkey);
		[PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
		[PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
		[PreserveSig] int Commit();
	}
	[DllImport("user32.dll", SetLastError = true)]
	private static extern bool DestroyIcon(IntPtr icon);
	[DllImport("user32.dll", EntryPoint = "MessageBoxW", CharSet = CharSet.Unicode)]
	private static extern int MessageBox(IntPtr owner, string text, string title, uint type);
	private const string MutexName = @"Local\ChatGPT2Launcher_SingleInstance_Mutex";
	private const string ActivationName = @"Local\Codex.Profile2.Activate";
	private static IntPtr s_hDesktop;
	private static string logPath;
	private static readonly PROPERTYKEY AppIdKey = new PROPERTYKEY(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);
	private static readonly PROPERTYKEY IconKey = new PROPERTYKEY(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 3);
	public static void Log(string message) {
		if (null != logPath) {
			bool owned = false;
			using (var mutex = new Mutex(false, @"Local\Codex.Profile2.Log")) {
				try {
					try {
						owned = mutex.WaitOne(1000);
					}
					catch (AbandonedMutexException) {
						owned = true;
					}
					if (!owned) {
						Trace.TraceError(message);
					}
					else {
						File.AppendAllText(logPath, string.Format("[{0:yyyy-MM-dd HH:mm:ss.fff}] {1}\r\n", DateTime.Now, message));
					}
				}
				catch (IOException ex) {
					Trace.TraceError("Launcher log failed: " + ex.Message);
				}
				catch (UnauthorizedAccessException ex) {
					Trace.TraceError("Launcher log failed: " + ex.Message);
				}
				finally {
					if (owned) {
						mutex.ReleaseMutex();
					}
				}
			}
		}
	}
	[STAThread]
	public static int Main(string[] args) {
		int r = 0;
		string appDir = AppDomain.CurrentDomain.BaseDirectory;
		string appData = Environment.GetEnvironmentVariable("APPDATA");
		if (string.IsNullOrWhiteSpace(appData)) {
			appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
		}
		string localAppData = Environment.GetEnvironmentVariable("LOCALAPPDATA");
		if (string.IsNullOrWhiteSpace(localAppData)) {
			localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
		}
		string profile = Path.Combine(appData, "Codex-Profile2");
		logPath = Path.Combine(profile, "launcher.log");
		string alias = Path.Combine(localAppData, @"Microsoft\WindowsApps\ChatGPT2.exe");
		bool diagnostic = 1 == args.Length && "--repair-alias" == args[0];
		Log("=== ChatGPT2Launcher invoked ===");
		bool owned = false;
		using (var mutex = new Mutex(false, MutexName)) {
			try {
				if (0 < args.Length && !diagnostic) {
					throw new ArgumentException("Supported option: --repair-alias");
				}
				if (diagnostic) {
					RepairAlias(alias);
				}
				else {
					try {
						owned = mutex.WaitOne(0);
					}
					catch (AbandonedMutexException) {
						owned = true;
					}
					if (!owned) {
						SignalActivation();
						Log("Existing supervisor notified; no second application was launched.");
					}
					else {
						using (var activation = new EventWaitHandle(false, EventResetMode.AutoReset, ActivationName)) {
							s_hDesktop = OpenDesktop("Default", 0, false, DESKTOP_ACCESS);
							if (IntPtr.Zero == s_hDesktop) {
								throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot open the interactive desktop.");
							}
							Directory.CreateDirectory(profile);
							Process existing = C2Process.FindExisting(alias, CDP_PORT_C2);
							using (Process target = existing ?? Launch(alias, profile)) {
								if (!CodexPackage.Owns(target)) {
									throw new InvalidOperationException("The launched process is not a Codex package.");
								}
								if (null != existing) {
									RequestApplicationWindow(alias, profile);
									Log("Existing C2 activation requested through the application.");
								}
								var timer = Stopwatch.StartNew();
								IntPtr window = IntPtr.Zero;
								while (30000 > timer.ElapsedMilliseconds) {
									if (target.HasExited) {
										throw new InvalidOperationException("Codex exited before creating its window (exit code " + target.ExitCode + ").");
									}
									var windows = FindVisibleWindowsForProcess(target.Id, s_hDesktop);
									if (0 < windows.Count) {
										window = windows[0];
										break;
									}
									Thread.Sleep(100);
								}
								if (IntPtr.Zero == window) {
									throw new TimeoutException("Codex did not create its window within 30 seconds.");
								}
								Log(string.Format("C2 ready (PID: {0}, HWND: 0x{1:X}, window wait: {2} ms).", target.Id, window.ToInt64(), timer.ElapsedMilliseconds));
								RunSupervisor(
									target,
									window,
									Path.Combine(appDir, "ChatGPT2.ico"),
									activation,
									s_hDesktop,
									() => RequestApplicationWindow(alias, profile)
								);
							}
						}
						Log("=== C2 supervisor exited cleanly ===");
					}
				}
			}
			catch (Exception ex) {
				Log("ERROR: " + ex);
				if (!diagnostic) {
					MessageBox(
						IntPtr.Zero,
						"Failed to open the second Codex profile.\n\n" + ex.Message + "\n\nLog: " + logPath,
						"Codex - C2",
						0x10
					);
				}
				r = 1;
			}
			finally {
				if (IntPtr.Zero != s_hDesktop) {
					CloseDesktop(s_hDesktop);
					s_hDesktop = IntPtr.Zero;
				}
				if (owned) {
					mutex.ReleaseMutex();
				}
			}
		}
		return r;
	}
	private static void SignalActivation() {
		bool signaled = false;
		for (int i = 0; 40 > i && !signaled; i++) {
			try {
				using (var activation = EventWaitHandle.OpenExisting(ActivationName)) {
					activation.Set();
					signaled = true;
				}
			}
			catch (WaitHandleCannotBeOpenedException) {
				Thread.Sleep(50);
			}
		}
		if (!signaled) {
			throw new TimeoutException("The existing C2 supervisor is not responding.");
		}
	}
	private static bool IsTransientPackageError(int win32Error, int hresult) {
		return 2 == win32Error
			|| 3 == win32Error
			|| 5 == win32Error
			|| 15600 == win32Error
			|| 15602 == win32Error
			|| 15618 == win32Error
			|| 15631 == win32Error
			|| unchecked((int)0x80004005) == hresult
			|| unchecked((int)0x80073D02) == hresult
			|| unchecked((int)0x80073D0F) == hresult
			|| unchecked((int)0x800700E9) == hresult;
	}
	// 2026-10-14 Dmitrii Fediuk https://github.com/dmitrii-fediuk
	// "Resolve active MSIX package dynamically via Windows AppModel API and auto-repair AppExecLink after Codex updates":
	// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/5
	private static CodexPackage RepairAlias(string alias) {
		CodexPackage.EnsureLatestRegistered(Log);
		CodexPackage r = CodexPackage.Resolve(Log);
		if (CodexPackage.NeedsRegistration(r.FullName)) {
			CodexPackage.EnsureRegistered(r, Log);
			r = CodexPackage.Resolve(Log);
		}
		bool changed = AppExecLink.Ensure(alias, CodexPackage.Family, r.AppUserModelId, r.Executable);
		Log(string.Format(
			"Execution alias {0}: {1}; app ID: {2}.",
			changed ? "repaired" : "verified",
			r.Executable,
			r.AppUserModelId
		));
		return r;
	}
	private static Process Launch(string alias, string profile) {
		Process r = null;
		CodexPackage.EnsureLatestRegistered(Log);
		var candidates = CodexPackage.SelectCandidates(CodexPackage.Installed(), Log);
		if (0 == candidates.Count) {
			throw new FileNotFoundException("No registered Codex package has a valid desktop application and executable.");
		}
		Exception lastException = null;
		for (int i = 0; i < candidates.Count && null == r; i++) {
			CodexPackage package = candidates[i];
			bool isLastCandidate = i == candidates.Count - 1;
			for (int attempt = 1; 3 >= attempt && null == r; attempt++) {
				try {
					if (CodexPackage.NeedsRegistration(package.FullName)) {
						CodexPackage.EnsureRegistered(package, Log);
					}
					bool changed = AppExecLink.Ensure(alias, CodexPackage.Family, package.AppUserModelId, package.Executable);
					Log(string.Format(
						"Execution alias {0}: {1}; app ID: {2}.",
						changed ? "repaired" : "verified",
						package.Executable,
						package.AppUserModelId
					));
					r = C2Process.Start(alias, profile, Path.GetDirectoryName(package.Executable), CDP_PORT_C2);
				}
				catch (FileNotFoundException ex) {
					lastException = ex;
					if (3 == attempt || isLastCandidate) {
						break;
					}
					Log("Package candidate " + package.FullName + " not found; retry " + attempt + ": " + ex.Message);
					Thread.Sleep(1000);
				}
				catch (Win32Exception ex) {
					lastException = ex;
					Log(string.Format(
						"Package candidate {0} launch failed (Win32 {1} / HRESULT 0x{2:X}): {3}",
						package.FullName,
						ex.NativeErrorCode,
						ex.ErrorCode,
						ex.Message
					));
					if (3 > attempt && IsTransientPackageError(ex.NativeErrorCode, ex.ErrorCode)) {
						CodexPackage.EnsureRegistered(package, Log);
						Log("Package launch may be updating; retry " + attempt);
						Thread.Sleep(1500);
					}
					else {
						if (!isLastCandidate) {
							Log("Falling back to next available installed package candidate: " + candidates[i + 1].FullName);
						}
						break;
					}
				}
			}
		}
		if (null == r) {
			throw lastException ?? new InvalidOperationException("Failed to launch any installed Codex package.");
		}
		return r;
	}
	// 2026-10-16 Dmitrii Fediuk https://github.com/dmitrii-fediuk
	// "Fix C2 window lifecycle supervision, cold-start VBS visibility, and disable duplicate Sparkle auto-updater in C2":
	// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/8
	private static void RequestApplicationWindow(string alias, string profile) {
		CodexPackage package = RepairAlias(alias);
		C2Process.RequestActivation(alias, profile, Path.GetDirectoryName(package.Executable), CDP_PORT_C2);
	}
	internal static void RunSupervisor(
		Process target,
		IntPtr window,
		string iconPath,
		EventWaitHandle activation,
		IntPtr desktop,
		Action requestApplicationWindow
	) {
		IntPtr big = LoadImage(IntPtr.Zero, iconPath, IMAGE_ICON, 32, 32, LR_LOADFROMFILE);
		IntPtr small = LoadImage(IntPtr.Zero, iconPath, IMAGE_ICON, 16, 16, LR_LOADFROMFILE);
		try {
			if (IntPtr.Zero == big || IntPtr.Zero == small) {
				throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot load the C2 icon.");
			}
			ApplyWindowProperties(window, big, small, iconPath);
			bool waitingForWindow = false;
			var styled = new HashSet<IntPtr> { window };
			int cycle = 0;
			while (!target.HasExited) {
				bool activate = activation.WaitOne(500);
				if (activate && !target.HasExited) {
					requestApplicationWindow();
					Log("C2 activation forwarded to the application.");
				}
				var windows = FindVisibleWindowsForProcess(target.Id, desktop);
				if (0 == windows.Count) {
					bool hiddenToTray = false;
					foreach (IntPtr hwnd in styled) {
						if (IsWindow(hwnd) && !IsWindowVisible(hwnd) && !IsIconic(hwnd)) {
							hiddenToTray = true;
							break;
						}
					}
					if (hiddenToTray) {
						var exitWait = Stopwatch.StartNew();
						while (!target.HasExited && 1500 > exitWait.ElapsedMilliseconds) {
							if (0 < FindVisibleWindowsForProcess(target.Id, desktop).Count) {
								hiddenToTray = false;
								break;
							}
							Thread.Sleep(100);
						}
						if (hiddenToTray) {
							if (!target.HasExited) {
								Log("C2 window was closed to tray; stopping the C2 process tree.");
								C2Process.StopOwnedTree(target, Log);
							}
							break;
						}
						continue;
					}
					if (!waitingForWindow) {
						Log("C2 has no visible main window; waiting for replacement window.");
						waitingForWindow = true;
					}
					continue;
				}
				if (waitingForWindow) {
					Log("C2 main window is visible again.");
				}
				waitingForWindow = false;
				foreach (IntPtr hwnd in windows) {
					UIntPtr current;
					IntPtr result = SendMessageTimeout(hwnd, WM_GETICON, (UIntPtr)ICON_SMALL, IntPtr.Zero, SMTO_ABORTIFHUNG, 500, out current);
					if (
						!styled.Contains(hwnd)
						|| (
							IntPtr.Zero != result
							&& (current.ToUInt64() & 0xFFFFFFFFL) != ((ulong)small.ToInt64() & 0xFFFFFFFFL)
						)
					) {
						ApplyWindowProperties(hwnd, big, small, iconPath);
						styled.Add(hwnd);
					}
					else if (0 == cycle % 10) {
						var title = new StringBuilder(256);
						GetWindowText(hwnd, title, title.Capacity);
						if ("ChatGPT 2" != title.ToString()) {
							SetWindowText(hwnd, "ChatGPT 2");
						}
					}
				}
				cycle++;
			}
			Log("C2 application exited.");
		}
		finally {
			if (IntPtr.Zero != small) {
				DestroyIcon(small);
			}
			if (IntPtr.Zero != big) {
				DestroyIcon(big);
			}
		}
	}
	private static void SetStringProperty(IPropertyStore store, PROPERTYKEY key, string value) {
		var variant = new PROPVARIANT { vt = 31, pwszVal = Marshal.StringToCoTaskMemUni(value) };
		try {
			Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref variant));
		}
		finally {
			Marshal.FreeCoTaskMem(variant.pwszVal);
		}
	}
	private static void ApplyWindowProperties(IntPtr window, IntPtr big, IntPtr small, string iconPath) {
		IPropertyStore store = null;
		try {
			Guid guid = typeof(IPropertyStore).GUID;
			Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(window, ref guid, out store));
			SetStringProperty(store, AppIdKey, "OpenAI.Codex.Profile2");
			SetStringProperty(store, IconKey, iconPath + ",0");
			Marshal.ThrowExceptionForHR(store.Commit());
			UIntPtr ignored;
			SendMessageTimeout(window, WM_SETICON, (UIntPtr)ICON_BIG, big, SMTO_ABORTIFHUNG, 1000, out ignored);
			SendMessageTimeout(window, WM_SETICON, (UIntPtr)ICON_SMALL, small, SMTO_ABORTIFHUNG, 1000, out ignored);
			SetWindowText(window, "ChatGPT 2");
			SetWindowPos(window, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
			Log(string.Format("C2 icon and grouping applied (HWND: 0x{0:X}).", window.ToInt64()));
		}
		catch (COMException ex) {
			Log("Window property update failed: " + ex.Message);
		}
		finally {
			if (null != store) {
				Marshal.ReleaseComObject(store);
			}
		}
	}
	private static List<IntPtr> FindVisibleWindowsForProcess(int pid, IntPtr desktop) {
		var r = new List<IntPtr>();
		EnumWindowsProc callback = (window, data) => {
			uint windowPid;
			GetWindowThreadProcessId(window, out windowPid);
			if (windowPid == (uint)pid && IsWindowVisible(window)) {
				IntPtr owner = GetWindow(window, 4);
				if (IntPtr.Zero == owner || !IsWindowVisible(owner)) {
					RECT rect;
					if (
						GetWindowRect(window, out rect)
						&& (
							IsIconic(window)
							|| (-10000 >= rect.Left && -10000 >= rect.Top)
							|| (200 < rect.Width && 200 < rect.Height)
						)
					) {
						r.Add(window);
					}
				}
			}
			return true;
		};
		if (!EnumDesktopWindows(desktop, callback, IntPtr.Zero)) {
			throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot enumerate C2 windows.");
		}
		return r;
	}
}
