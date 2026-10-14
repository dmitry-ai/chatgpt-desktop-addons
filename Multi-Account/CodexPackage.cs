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

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetPackagesByPackageFamily(string family, ref uint count,
        IntPtr names, ref uint bufferLength, IntPtr buffer);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetPackagePathByFullName(string fullName, ref uint length, StringBuilder path);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetPackageFamilyName(IntPtr process, ref uint length, StringBuilder family);

    public static List<CodexPackage> Installed() {
        // Public Windows package registration API; no private registry layout.
        for (int attempt = 0; attempt < 3; attempt++) {
            uint count = 0, length = 0;
            int rc = GetPackagesByPackageFamily(Family, ref count, IntPtr.Zero, ref length, IntPtr.Zero);
            if (rc == 0 && count == 0) return new List<CodexPackage>();
            if (rc != InsufficientBuffer) throw new Win32Exception(rc, "Cannot enumerate registered Codex packages.");
            IntPtr names = Marshal.AllocHGlobal(checked((int)count * IntPtr.Size));
            IntPtr buffer = Marshal.AllocHGlobal(checked((int)length * 2));
            try {
                rc = GetPackagesByPackageFamily(Family, ref count, names, ref length, buffer);
                if (rc == InsufficientBuffer) continue; // Store changed registration between calls.
                if (rc != 0) throw new Win32Exception(rc, "Cannot enumerate registered Codex packages.");
                var result = new List<CodexPackage>();
                for (int i = 0; i < count; i++) {
                    string fullName = Marshal.PtrToStringUni(Marshal.ReadIntPtr(names, i * IntPtr.Size));
                    uint pathLength = 0;
                    rc = GetPackagePathByFullName(fullName, ref pathLength, null);
                    if (rc == NoPackage || rc == 2 || rc == 3) continue;
                    if (rc != InsufficientBuffer) throw new Win32Exception(rc, "Cannot locate package " + fullName);
                    var path = new StringBuilder(checked((int)pathLength));
                    rc = GetPackagePathByFullName(fullName, ref pathLength, path);
                    if (rc == NoPackage || rc == 2 || rc == 3) continue;
                    if (rc != 0) throw new Win32Exception(rc, "Cannot locate package " + fullName);
                    Version version;
                    string[] parts = fullName.Split('_');
                    if (parts.Length < 2 || !Version.TryParse(parts[1], out version)) {
                        throw new InvalidDataException("Invalid registered package identity: " + fullName);
                    }
                    result.Add(new CodexPackage { FullName = fullName, Root = path.ToString(), Version = version });
                }
                return result;
            } finally {
                Marshal.FreeHGlobal(buffer);
                Marshal.FreeHGlobal(names);
            }
        }
        throw new IOException("Codex registration kept changing during the update. Try again shortly.");
    }

    public static CodexPackage Resolve(Action<string> log) { return Select(Installed(), log); }

    public static CodexPackage Select(IEnumerable<CodexPackage> candidates, Action<string> log) {
        foreach (CodexPackage candidate in candidates.OrderByDescending(p => p.Version)) {
            try {
                return ReadManifest(candidate);
            } catch (IOException ex) {
                if (log != null) log("Package unavailable: " + candidate.FullName + ": " + ex.Message);
            } catch (XmlException ex) {
                if (log != null) log("Invalid package manifest: " + candidate.FullName + ": " + ex.Message);
            }
        }
        throw new FileNotFoundException("No registered Codex package has a valid desktop application and executable.");
    }

    public static CodexPackage ReadManifest(CodexPackage package) {
        var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null };
        XDocument doc;
        using (var reader = XmlReader.Create(Path.Combine(package.Root, "AppxManifest.xml"), settings)) {
            doc = XDocument.Load(reader);
        }
        XNamespace ns = "http://schemas.microsoft.com/appx/manifest/foundation/windows10";
        var applications = doc.Root == null ? null : doc.Root.Element(ns + "Applications");
        if (applications == null) throw new InvalidDataException("Manifest has no Applications element.");
        var visible = applications.Elements(ns + "Application").Where(app =>
            app.Elements().Any(el => el.Name.LocalName == "VisualElements" &&
                !string.Equals((string)el.Attribute("AppListEntry"), "none", StringComparison.OrdinalIgnoreCase))).ToList();
        if (visible.Count != 1) throw new InvalidDataException("Manifest must identify exactly one visible desktop application.");
        string id = (string)visible[0].Attribute("Id");
        string relative = (string)visible[0].Attribute("Executable");
        if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(relative) || Path.IsPathRooted(relative)) {
            throw new InvalidDataException("Manifest has an invalid application ID or executable path.");
        }
        string root = Path.GetFullPath(package.Root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        string exe = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
        if (!exe.StartsWith(root, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(Path.GetExtension(exe), ".exe", StringComparison.OrdinalIgnoreCase)) {
            throw new InvalidDataException("Manifest executable escapes the package or is not an executable.");
        }
        if (!File.Exists(exe)) throw new FileNotFoundException("Manifest executable is missing: " + exe);
        return new CodexPackage {
            FullName = package.FullName, Root = root, Version = package.Version,
            ApplicationId = id, Executable = exe
        };
    }

    public static bool Owns(Process process) {
        uint length = 0;
        int rc = GetPackageFamilyName(process.Handle, ref length, null);
        if (rc == NoPackage) return false;
        if (rc != InsufficientBuffer) throw new Win32Exception(rc, "Cannot verify process package identity.");
        var family = new StringBuilder(checked((int)length));
        rc = GetPackageFamilyName(process.Handle, ref length, family);
        if (rc != 0) throw new Win32Exception(rc, "Cannot verify process package identity.");
        return string.Equals(family.ToString(), Family, StringComparison.Ordinal);
    }
}
