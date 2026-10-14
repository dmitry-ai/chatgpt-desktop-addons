using System;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class AppExecLink {
    private const uint Tag = 0x8000001B;
    private const uint OpenReparse = 0x00200000;
    private const uint BackupSemantics = 0x02000000;
    private const uint GetReparse = 0x000900A8;
    private const uint SetReparse = 0x000900A4;
    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle Open(string name, uint access, uint share, IntPtr security,
        uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", EntryPoint = "DeviceIoControl", SetLastError = true)]
    private static extern bool Query(SafeFileHandle handle, uint code, IntPtr input, uint inputLength,
        byte[] output, uint outputLength, out uint returned, IntPtr overlapped);
    [DllImport("kernel32.dll", EntryPoint = "DeviceIoControl", SetLastError = true)]
    private static extern bool Write(SafeFileHandle handle, uint code, byte[] input, uint inputLength,
        IntPtr output, uint outputLength, out uint returned, IntPtr overlapped);

    public static string[] Read(string path) {
        using (var handle = Open(path, 0, 7, IntPtr.Zero, 3, OpenReparse | BackupSemantics, IntPtr.Zero)) {
            if (handle.IsInvalid) {
                int error = Marshal.GetLastWin32Error();
                if (error == 2 || error == 3) return null;
                throw new Win32Exception(error, "Cannot read execution alias: " + path);
            }
            var buffer = new byte[16384];
            uint returned;
            if (!Query(handle, GetReparse, IntPtr.Zero, 0, buffer, (uint)buffer.Length, out returned, IntPtr.Zero)) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Refusing to overwrite a file that is not an execution alias: " + path);
            }
            int length = BitConverter.ToUInt16(buffer, 4);
            if (returned < 12 || BitConverter.ToUInt32(buffer, 0) != Tag ||
                length < 4 || (length % 2) != 0 || length + 8 > returned || BitConverter.ToUInt32(buffer, 8) != 3) {
                throw new InvalidDataException("Unsupported execution alias format: " + path);
            }
            string[] fields = Encoding.Unicode.GetString(buffer, 12, length - 4).Split('\0');
            if (fields.Length != 5 || fields[4] != "" || fields[3] != "0") {
                throw new InvalidDataException("Malformed execution alias: " + path);
            }
            return fields.Take(4).ToArray();
        }
    }

    public static bool Ensure(string path, string family, string appId, string executable) {
        string[] expected = { family, appId, executable, "0" };
        string[] actual = Read(path);
        if (actual != null && actual.SequenceEqual(expected)) return false;
        if (actual != null && !string.Equals(actual[0], family, StringComparison.Ordinal)) {
            throw new InvalidDataException("Refusing to overwrite an alias owned by another package: " + path);
        }
        byte[] payload;
        using (var stream = new MemoryStream())
        using (var writer = new BinaryWriter(stream, Encoding.Unicode)) {
            writer.Write((uint)3);
            foreach (string field in expected) {
                if (string.IsNullOrEmpty(field) || field.IndexOf('\0') >= 0) throw new ArgumentException("Invalid execution alias field.");
                writer.Write(field.ToCharArray());
                writer.Write((char)0);
            }
            payload = stream.ToArray();
        }
        if (payload.Length > 16376) throw new ArgumentException("Execution alias payload is too large.");
        byte[] data = new byte[8 + payload.Length];
        Array.Copy(BitConverter.GetBytes(Tag), data, 4);
        Array.Copy(BitConverter.GetBytes(checked((ushort)payload.Length)), 0, data, 4, 2);
        Array.Copy(payload, 0, data, 8, payload.Length);
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        using (var handle = Open(path, 0x40000000, 7, IntPtr.Zero, 4, OpenReparse | BackupSemantics, IntPtr.Zero)) {
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot open execution alias for repair: " + path);
            uint returned;
            if (!Write(handle, SetReparse, data, (uint)data.Length, IntPtr.Zero, 0, out returned, IntPtr.Zero)) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot repair execution alias: " + path);
            }
        }
        if (!Read(path).SequenceEqual(expected)) throw new IOException("Execution alias verification failed after repair.");
        return true;
    }
}
