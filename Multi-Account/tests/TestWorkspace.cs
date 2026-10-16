using System;
using System.IO;

public static class TestWorkspace {
    private static string RunRoot {
        get {
            string value = Environment.GetEnvironmentVariable("CODEX_C2_TEST_RUN_ROOT");
            if (string.IsNullOrWhiteSpace(value)) throw new InvalidOperationException("Run tests with build.ps1 so temporary data is cleaned up.");
            string root = Path.GetFullPath(value);
            string name = Path.GetFileName(root);
            Guid id;
            if (!string.Equals(Path.GetDirectoryName(root), Path.GetFullPath(Path.GetTempPath()).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase) ||
                !name.StartsWith("CodexC2Run-", StringComparison.Ordinal) || !Guid.TryParseExact(name.Substring(11), "N", out id))
                throw new InvalidOperationException("Unexpected temporary test directory.");
            return root;
        }
    }

    public static string CreateDirectory(string name) {
        if (name != "core" && name != "startup" && name != "window") throw new ArgumentException("Unknown test workspace.");
        string path = Path.Combine(RunRoot, name + "-" + Path.GetFileName(RunRoot).Substring(11));
        Directory.CreateDirectory(path);
        return path;
    }

    public static string AliasFile(string directory, string kind) {
        if (kind != "runtime" && kind != "startup") throw new ArgumentException("Unknown runtime test.");
        return Path.Combine(directory, "c2-launcher-test-" + Path.GetFileName(RunRoot).Substring(11) + "-" + kind + ".exe");
    }
}
