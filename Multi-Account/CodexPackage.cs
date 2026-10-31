// 2026-10-14 Dmitrii Fediuk https://github.com/dmitrii-fediuk
// "Resolve active MSIX package dynamically via Windows AppModel API and auto-repair AppExecLink after Codex updates":
// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/5
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
	private static extern int GetPackagesByPackageFamily(
		string family,
		ref uint count,
		IntPtr names,
		ref uint bufferLength,
		IntPtr buffer
	);
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
	private static extern int NtQueryInformationProcess(
		IntPtr processHandle,
		int processInformationClass,
		ref PROCESS_BASIC_INFORMATION processInformation,
		int processInformationLength,
		out int returnLength
	);
	[DllImport("kernel32.dll", SetLastError = true)]
	private static extern bool ReadProcessMemory(
		IntPtr hProcess,
		IntPtr lpBaseAddress,
		byte[] lpBuffer,
		int dwSize,
		out IntPtr lpNumberOfBytesRead
	);
	public static List<CodexPackage> Installed() {
		List<CodexPackage> r = null;
		for (int attempt = 0; 3 > attempt && null == r; attempt++) {
			uint count = 0, length = 0;
			int rc = GetPackagesByPackageFamily(Family, ref count, IntPtr.Zero, ref length, IntPtr.Zero);
			if (0 == rc && 0 == count) {
				r = new List<CodexPackage>();
			}
			else {
				if (InsufficientBuffer != rc) {
					throw new Win32Exception(rc, "Cannot enumerate registered Codex packages.");
				}
				IntPtr names = Marshal.AllocHGlobal(checked((int)count * IntPtr.Size));
				IntPtr buffer = Marshal.AllocHGlobal(checked((int)length * 2));
				try {
					rc = GetPackagesByPackageFamily(Family, ref count, names, ref length, buffer);
					if (InsufficientBuffer != rc) {
						if (0 != rc) {
							throw new Win32Exception(rc, "Cannot enumerate registered Codex packages.");
						}
						var result = new List<CodexPackage>();
						for (int i = 0; i < count; i++) {
							string fullName = Marshal.PtrToStringUni(Marshal.ReadIntPtr(names, i * IntPtr.Size));
							uint pathLength = 0;
							rc = GetPackagePathByFullName(fullName, ref pathLength, null);
							if (NoPackage != rc && 2 != rc && 3 != rc) {
								if (InsufficientBuffer != rc) {
									throw new Win32Exception(rc, "Cannot locate package " + fullName);
								}
								var path = new StringBuilder(checked((int)pathLength));
								rc = GetPackagePathByFullName(fullName, ref pathLength, path);
								if (NoPackage != rc && 2 != rc && 3 != rc) {
									if (0 != rc) {
										throw new Win32Exception(rc, "Cannot locate package " + fullName);
									}
									Version version;
									string[] parts = fullName.Split('_');
									if (2 > parts.Length || !Version.TryParse(parts[1], out version)) {
										throw new InvalidDataException("Invalid registered package identity: " + fullName);
									}
									result.Add(new CodexPackage { FullName = fullName, Root = path.ToString(), Version = version });
								}
							}
						}
						r = result;
					}
				}
				finally {
					Marshal.FreeHGlobal(buffer);
					Marshal.FreeHGlobal(names);
				}
			}
		}
		if (null == r) {
			throw new IOException("Codex registration kept changing during the update. Try again shortly.");
		}
		return r;
	}
	// 2026-10-30 Dmitrii Fediuk https://github.com/dmitrii-fediuk
	// "Support unprivileged staged MSIX discovery (GetStagedPackagePathByFullName), Win32/NT process scanning without WMI, and Rolldown bundle chain":
	// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/14
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
					if (null != key) {
						foreach (string subName in key.GetSubKeyNames()) {
							if (
								subName.StartsWith("OpenAI.Codex_", StringComparison.OrdinalIgnoreCase)
								&& subName.EndsWith("__2p2nqsd0c76g0", StringComparison.OrdinalIgnoreCase)
							) {
								names.Add(subName);
							}
						}
					}
				}
			}
			catch {}
		}
		try {
			string windowsApps = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "WindowsApps");
			if (Directory.Exists(windowsApps)) {
				foreach (string dir in Directory.GetDirectories(windowsApps, "OpenAI.Codex_*__2p2nqsd0c76g0")) {
					string name = Path.GetFileName(dir);
					if (!string.IsNullOrEmpty(name)) {
						names.Add(name);
					}
				}
			}
		}
		catch {}
		var result = new List<CodexPackage>();
		foreach (string fullName in names) {
			uint pathLength = 0;
			int rc = GetStagedPackagePathByFullName(fullName, ref pathLength, null);
			if (InsufficientBuffer == rc && 0 != pathLength) {
				var path = new StringBuilder(checked((int)pathLength));
				rc = GetStagedPackagePathByFullName(fullName, ref pathLength, path);
				if (0 == rc) {
					string root = path.ToString();
					if (!string.IsNullOrEmpty(root) && Directory.Exists(root)) {
						Version version;
						string[] parts = fullName.Split('_');
						if (2 <= parts.Length && Version.TryParse(parts[1], out version)) {
							result.Add(new CodexPackage { FullName = fullName, Root = root, Version = version });
						}
					}
				}
			}
		}
		return result.OrderByDescending(p => p.Version).ToList();
	}
	public static List<CodexPackage> Available() {
		var byName = new Dictionary<string, CodexPackage>(StringComparer.OrdinalIgnoreCase);
		foreach (CodexPackage pkg in Installed()) {
			byName[pkg.FullName] = pkg;
		}
		foreach (CodexPackage pkg in Staged()) {
			if (!byName.ContainsKey(pkg.FullName)) {
				byName[pkg.FullName] = pkg;
			}
		}
		return byName.Values.OrderByDescending(p => p.Version).ToList();
	}
	public static CodexPackage Resolve(Action<string> log) {
		return Select(Installed(), log);
	}
	public static List<CodexPackage> SelectCandidates(IEnumerable<CodexPackage> candidates, Action<string> log) {
		var r = new List<CodexPackage>();
		foreach (CodexPackage candidate in candidates.OrderByDescending(p => p.Version)) {
			try {
				r.Add(ReadManifest(candidate));
			}
			catch (IOException ex) {
				if (null != log) {
					log("Package unavailable: " + candidate.FullName + ": " + ex.Message);
				}
			}
			catch (XmlException ex) {
				if (null != log) {
					log("Invalid package manifest: " + candidate.FullName + ": " + ex.Message);
				}
			}
		}
		return r;
	}
	public static CodexPackage Select(IEnumerable<CodexPackage> candidates, Action<string> log) {
		var list = SelectCandidates(candidates, log);
		if (0 == list.Count) {
			throw new FileNotFoundException("No registered Codex package has a valid desktop application and executable.");
		}
		return list[0];
	}
	public static CodexPackage ReadManifest(CodexPackage package) {
		var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null };
		XDocument doc;
		using (var reader = XmlReader.Create(Path.Combine(package.Root, "AppxManifest.xml"), settings)) {
			doc = XDocument.Load(reader);
		}
		XNamespace ns = "http://schemas.microsoft.com/appx/manifest/foundation/windows10";
		var applications = null == doc.Root ? null : doc.Root.Element(ns + "Applications");
		if (null == applications) {
			throw new InvalidDataException("Manifest has no Applications element.");
		}
		var visible = applications.Elements(ns + "Application").Where(app =>
			app.Elements().Any(el =>
				"VisualElements" == el.Name.LocalName
				&& !string.Equals((string)el.Attribute("AppListEntry"), "none", StringComparison.OrdinalIgnoreCase)
			)
		).ToList();
		if (1 != visible.Count) {
			throw new InvalidDataException("Manifest must identify exactly one visible desktop application.");
		}
		string id = (string)visible[0].Attribute("Id");
		string relative = (string)visible[0].Attribute("Executable");
		if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(relative) || Path.IsPathRooted(relative)) {
			throw new InvalidDataException("Manifest has an invalid application ID or executable path.");
		}
		string root = Path.GetFullPath(package.Root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
		string exe = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
		if (
			!exe.StartsWith(root, StringComparison.OrdinalIgnoreCase)
			|| !string.Equals(Path.GetExtension(exe), ".exe", StringComparison.OrdinalIgnoreCase)
		) {
			throw new InvalidDataException("Manifest executable escapes the package or is not an executable.");
		}
		if (!File.Exists(exe)) {
			throw new FileNotFoundException("Manifest executable is missing: " + exe);
		}
		return new CodexPackage {
			FullName = package.FullName,
			Root = root,
			Version = package.Version,
			ApplicationId = id,
			Executable = exe
		};
	}
	public static bool Owns(Process process) {
		bool r = false;
		if (null != process) {
			IntPtr handle = OpenProcess(0x1000, false, process.Id);
			bool close = IntPtr.Zero != handle;
			if (!close) {
				handle = process.Handle;
			}
			try {
				uint length = 0;
				int rc = GetPackageFamilyName(handle, ref length, null);
				if (NoPackage != rc) {
					if (InsufficientBuffer != rc) {
						throw new Win32Exception(rc, "Cannot verify process package identity.");
					}
					var family = new StringBuilder(checked((int)length));
					rc = GetPackageFamilyName(handle, ref length, family);
					if (0 != rc) {
						throw new Win32Exception(rc, "Cannot verify process package identity.");
					}
					r = string.Equals(family.ToString(), Family, StringComparison.Ordinal);
				}
			}
			finally {
				if (close) {
					CloseHandle(handle);
				}
			}
		}
		return r;
	}
	public static bool OwnsProcessId(int pid) {
		bool r = false;
		if (4 < pid) {
			IntPtr handle = OpenProcess(0x1000, false, pid);
			if (IntPtr.Zero != handle) {
				try {
					uint length = 0;
					int rc = GetPackageFamilyName(handle, ref length, null);
					if (InsufficientBuffer == rc && 0 != length) {
						var family = new StringBuilder(checked((int)length));
						r = 0 == GetPackageFamilyName(handle, ref length, family)
							&& string.Equals(family.ToString(), Family, StringComparison.Ordinal);
					}
				}
				finally {
					CloseHandle(handle);
				}
			}
		}
		return r;
	}
	public static bool NeedsRegistration(string fullName) {
		bool r = false;
		if (!string.IsNullOrEmpty(fullName)) {
			bool registeredForUser = Installed().Any(p => string.Equals(p.FullName, fullName, StringComparison.OrdinalIgnoreCase));
			if (!registeredForUser) {
				r = true;
			}
			else {
				uint userStatus = 0, machineStatus = 0;
				int rcUser = GetPackageStatusForUser(IntPtr.Zero, fullName, out userStatus);
				int rcMachine = GetPackageStatus(fullName, out machineStatus);
				r = (0 == rcUser && 0 != userStatus) || (0 == rcMachine && 0 != machineStatus);
			}
		}
		return r;
	}
	public static int[] RunningUiProcesses() {
		var r = new List<int>();
		foreach (Process process in Process.GetProcesses()) {
			using (process) {
				try {
					if (
						4 < process.Id
						&& 0 != process.SessionId
						&& !string.Equals(process.ProcessName, "codex-windows-sandbox-service", StringComparison.OrdinalIgnoreCase)
						&& OwnsProcessId(process.Id)
						&& !process.HasExited
					) {
						r.Add(process.Id);
					}
				}
				catch (Win32Exception) {}
				catch (InvalidOperationException) {}
			}
		}
		return r.ToArray();
	}
	public static string ReadProcessExecutablePath(int pid) {
		string r = null;
		if (4 < pid) {
			IntPtr h = OpenProcess(0x1000, false, pid);
			if (IntPtr.Zero != h) {
				try {
					int capacity = 1024;
					var sb = new StringBuilder(capacity);
					if (QueryFullProcessImageName(h, 0, sb, ref capacity)) {
						r = sb.ToString(0, capacity);
					}
				}
				catch {}
				finally {
					CloseHandle(h);
				}
			}
		}
		return r;
	}
	public static int GetParentProcessId(int pid) {
		int r = 0;
		if (4 < pid) {
			IntPtr h = OpenProcess(0x1000, false, pid);
			if (IntPtr.Zero == h) {
				h = OpenProcess(0x0400, false, pid);
			}
			if (IntPtr.Zero != h) {
				try {
					var pbi = new PROCESS_BASIC_INFORMATION();
					int retLen;
					if (0 == NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out retLen)) {
						r = pbi.InheritedFromUniqueProcessId.ToInt32();
					}
				}
				catch {}
				finally {
					CloseHandle(h);
				}
			}
		}
		return r;
	}
	// 2026-10-24 Dmitrii Fediuk https://github.com/dmitrii-fediuk
	// "Resolve MSIX 0x80073D02 and 0x80073D0F registration deadlocks by terminating orphaned AppX container processes via PEB inspection":
	// https://github.com/dmitry-ai/chatgpt-desktop-addons/issues/12
	public static string ReadProcessCommandLine(int pid) {
		string r = null;
		if (8 == IntPtr.Size && 4 < pid) {
			IntPtr h = OpenProcess(0x1010, false, pid);
			if (IntPtr.Zero == h) {
				h = OpenProcess(0x0410, false, pid);
			}
			if (IntPtr.Zero != h) {
				try {
					var pbi = new PROCESS_BASIC_INFORMATION();
					int retLen;
					if (0 == NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out retLen) && IntPtr.Zero != pbi.PebBaseAddress) {
						byte[] ptrBuf = new byte[8];
						IntPtr read;
						if (ReadProcessMemory(h, (IntPtr)(pbi.PebBaseAddress.ToInt64() + 0x20), ptrBuf, 8, out read)) {
							IntPtr procParams = (IntPtr)BitConverter.ToInt64(ptrBuf, 0);
							if (IntPtr.Zero != procParams) {
								byte[] cmdHeader = new byte[16];
								if (ReadProcessMemory(h, (IntPtr)(procParams.ToInt64() + 0x70), cmdHeader, 16, out read)) {
									ushort byteLen = BitConverter.ToUInt16(cmdHeader, 0);
									IntPtr cmdPtr = (IntPtr)BitConverter.ToInt64(cmdHeader, 8);
									if (0 == byteLen) {
										r = "";
									}
									else if (IntPtr.Zero != cmdPtr) {
										byte[] cmdBuf = new byte[byteLen];
										if (ReadProcessMemory(h, cmdPtr, cmdBuf, byteLen, out read)) {
											r = Encoding.Unicode.GetString(cmdBuf);
										}
									}
								}
							}
						}
					}
				}
				catch {}
				finally {
					CloseHandle(h);
				}
			}
		}
		return r;
	}
	public static Dictionary<string, string> ReadProcessEnvironment(int pid) {
		var r = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
		if (8 == IntPtr.Size && 4 < pid) {
			IntPtr h = OpenProcess(0x1010, false, pid);
			if (IntPtr.Zero == h) {
				h = OpenProcess(0x0410, false, pid);
			}
			if (IntPtr.Zero != h) {
				try {
					var pbi = new PROCESS_BASIC_INFORMATION();
					int retLen;
					if (0 == NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out retLen) && IntPtr.Zero != pbi.PebBaseAddress) {
						byte[] ptrBuf = new byte[8];
						IntPtr read;
						if (ReadProcessMemory(h, (IntPtr)(pbi.PebBaseAddress.ToInt64() + 0x20), ptrBuf, 8, out read)) {
							IntPtr procParams = (IntPtr)BitConverter.ToInt64(ptrBuf, 0);
							if (
								IntPtr.Zero != procParams
								&& ReadProcessMemory(h, (IntPtr)(procParams.ToInt64() + 0x80), ptrBuf, 8, out read)
							) {
								IntPtr envPtr = (IntPtr)BitConverter.ToInt64(ptrBuf, 0);
								if (ReadProcessMemory(h, (IntPtr)(procParams.ToInt64() + 0x3F0), ptrBuf, 8, out read)) {
									ulong envSize = BitConverter.ToUInt64(ptrBuf, 0);
									if (IntPtr.Zero != envPtr && 0 < envSize && 1048576 >= envSize) {
										byte[] envBuf = new byte[(int)envSize];
										if (ReadProcessMemory(h, envPtr, envBuf, envBuf.Length, out read)) {
											string envText = Encoding.Unicode.GetString(envBuf);
											foreach (string entry in envText.Split('\0')) {
												if (!string.IsNullOrEmpty(entry)) {
													int eq = entry.IndexOf('=');
													if (0 < eq) {
														r[entry.Substring(0, eq)] = entry.Substring(eq + 1);
													}
												}
											}
										}
									}
								}
							}
						}
					}
				}
				catch {}
				finally {
					CloseHandle(h);
				}
			}
		}
		return r;
	}
	private static bool IsHelperOrTestProcess(string processName) {
		return !string.IsNullOrEmpty(processName) && (
			string.Equals(processName, "ChatGPT2Launcher", StringComparison.OrdinalIgnoreCase)
			|| string.Equals(processName, "LauncherTests", StringComparison.OrdinalIgnoreCase)
			|| string.Equals(processName, "RecoveryNativeTests", StringComparison.OrdinalIgnoreCase)
			|| string.Equals(processName, "AliasActivationRegression", StringComparison.OrdinalIgnoreCase)
			|| string.Equals(processName, "SupervisorRegression", StringComparison.OrdinalIgnoreCase)
		);
	}
	public static List<int> FindOrphanProcesses(string filterC2Profile, bool c1Only) {
		var r = new List<int>();
		int selfPid = Process.GetCurrentProcess().Id;
		var uiPids = new HashSet<int>(RunningUiProcesses());
		foreach (Process p in Process.GetProcesses()) {
			using (p) {
				try {
					if (4 < p.Id && selfPid != p.Id && !uiPids.Contains(p.Id) && !IsHelperOrTestProcess(p.ProcessName)) {
						var env = ReadProcessEnvironment(p.Id);
						if (0 < env.Count) {
							string family;
							bool hasFamily = env.TryGetValue("CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY", out family)
								&& string.Equals(family, Family, StringComparison.OrdinalIgnoreCase);
							string originator;
							bool hasOriginator = env.TryGetValue("CODEX_INTERNAL_ORIGINATOR_OVERRIDE", out originator)
								&& string.Equals(originator, "Codex Desktop", StringComparison.OrdinalIgnoreCase);
							string c2DataPath;
							bool hasC2Profile = env.TryGetValue("CODEX_ELECTRON_USER_DATA_PATH", out c2DataPath)
								&& !string.IsNullOrEmpty(c2DataPath);
							if (hasFamily || hasOriginator || hasC2Profile) {
								if (c1Only) {
									if (!hasC2Profile && (hasFamily || hasOriginator)) {
										r.Add(p.Id);
									}
								}
								else if (!string.IsNullOrEmpty(filterC2Profile)) {
									if (
										hasC2Profile
										&& string.Equals(
											Path.GetFullPath(c2DataPath).TrimEnd(Path.DirectorySeparatorChar),
											Path.GetFullPath(filterC2Profile).TrimEnd(Path.DirectorySeparatorChar),
											StringComparison.OrdinalIgnoreCase
										)
									) {
										r.Add(p.Id);
									}
								}
								else {
									r.Add(p.Id);
								}
							}
						}
					}
				}
				catch {}
			}
		}
		return r;
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
						if (null != log) {
							log("Stopping orphaned Codex container process PID " + pid + " (" + p.ProcessName + ").");
						}
						TerminateProcess(h, 0);
						handles.Add(p);
						p = null;
					}
				}
				catch {}
				finally {
					if (null != p) {
						p.Dispose();
					}
				}
			}
			var wait = Stopwatch.StartNew();
			foreach (Process p in handles) {
				try {
					int rem = Math.Max(0, 3000 - (int)wait.ElapsedMilliseconds);
					p.WaitForExit(rem);
				}
				catch {}
			}
		}
		finally {
			foreach (Process p in handles) {
				p.Dispose();
			}
		}
	}
	public static void StopOrphanContainerProcesses(Action<string> log) {
		if (0 == RunningUiProcesses().Length) {
			List<int> orphans = FindOrphanProcesses(null, false);
			if (0 < orphans.Count) {
				StopProcesses(orphans, log);
			}
		}
	}
	public static bool EnsureLatestRegistered(Action<string> log) {
		var available = SelectCandidates(Available(), log);
		return 0 < available.Count && EnsureRegistered(available[0], log);
	}
	public static bool EnsureRegistered(CodexPackage package, Action<string> log) {
		bool r = false;
		var available = SelectCandidates(Available(), log);
		if (0 < available.Count && (null == package || available[0].Version > package.Version)) {
			package = available[0];
		}
		if (null != package && !string.IsNullOrEmpty(package.FullName)) {
			if (!NeedsRegistration(package.FullName)) {
				r = true;
			}
			else if (0 < RunningUiProcesses().Length) {
				if (null != log) {
					log("Package " + package.FullName + " requires registration, but a Codex UI instance is currently open.");
				}
			}
			else {
				string manifest = Path.Combine(package.Root, "AppxManifest.xml");
				if (File.Exists(manifest)) {
					string ps = Path.Combine(
						Environment.GetFolderPath(Environment.SpecialFolder.System),
						@"WindowsPowerShell\v1.0\powershell.exe"
					);
					string escaped = manifest.Replace("'", "''");
					string cmd = "$ErrorActionPreference = 'Stop'; "
						+ "$ProgressPreference = 'SilentlyContinue'; "
						+ "Add-AppxPackage -Register '" + escaped + "' -DisableDevelopmentMode -ForceApplicationShutdown -ForceUpdateFromAnyVersion";
					string encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(cmd));
					bool aborted = false;
					for (int attempt = 1; 3 >= attempt && !r && !aborted; attempt++) {
						if (0 < RunningUiProcesses().Length) {
							aborted = true;
						}
						else {
							StopOrphanContainerProcesses(log);
							if (null != log) {
								log("Completing Windows registration for " + package.FullName + (1 < attempt ? " (attempt " + attempt + ")" : "") + "...");
							}
							var psi = new ProcessStartInfo(ps, "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + encoded) {
								UseShellExecute = false,
								CreateNoWindow = true,
								RedirectStandardError = true
							};
							using (Process proc = Process.Start(psi)) {
								string stderr = proc.StandardError.ReadToEnd();
								if (!proc.WaitForExit(60000)) {
									try {
										proc.Kill();
									}
									catch {}
									if (null != log) {
										log("Registration timed out for " + package.FullName);
									}
									aborted = true;
								}
								else if (0 != proc.ExitCode && null != log && !string.IsNullOrEmpty(stderr)) {
									log("Registration warning for " + package.FullName + ": " + stderr.Trim());
								}
							}
							if (!aborted) {
								if (!NeedsRegistration(package.FullName)) {
									if (null != log) {
										log("Registration status for " + package.FullName + ": OK");
									}
									r = true;
								}
								else if (3 > attempt) {
									System.Threading.Thread.Sleep(1000);
								}
							}
						}
					}
					if (!r && !aborted) {
						r = !NeedsRegistration(package.FullName);
						if (null != log) {
							log("Registration status for " + package.FullName + ": " + (r ? "OK" : "still pending"));
						}
					}
				}
			}
		}
		return r;
	}
}
