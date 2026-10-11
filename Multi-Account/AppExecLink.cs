using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public class AppExecLink {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern SafeFileHandle CreateFile(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        IntPtr lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool DeviceIoControl(
        SafeFileHandle hDevice,
        uint dwIoControlCode,
        byte[] lpInBuffer,
        uint nInBufferSize,
        IntPtr lpOutBuffer,
        uint nOutBufferSize,
        out uint lpBytesReturned,
        IntPtr lpOverlapped);

    const uint GENERIC_WRITE = 0x40000000;
    const uint OPEN_ALWAYS = 4;
    const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    const uint FSCTL_SET_REPARSE_POINT = 0x000900A4;
    const uint IO_REPARSE_TAG_APPEXECLINK = 0x8000001B;

    public static bool Create(string linkPath, string pfn, string aumid, string targetExe) {
        using (var ms = new MemoryStream())
        using (var bw = new BinaryWriter(ms, Encoding.Unicode)) {
            bw.Write((uint)3); // Version
            bw.Write(pfn.ToCharArray());
            bw.Write((char)0);
            bw.Write(aumid.ToCharArray());
            bw.Write((char)0);
            bw.Write(targetExe.ToCharArray());
            bw.Write((char)0);
            bw.Write('0');
            bw.Write((char)0);

            byte[] data = ms.ToArray();
            ushort dataLength = (ushort)data.Length;

            byte[] reparseBuffer = new byte[8 + dataLength];
            Array.Copy(BitConverter.GetBytes(IO_REPARSE_TAG_APPEXECLINK), 0, reparseBuffer, 0, 4);
            Array.Copy(BitConverter.GetBytes(dataLength), 0, reparseBuffer, 4, 2);
            Array.Copy(BitConverter.GetBytes((ushort)0), 0, reparseBuffer, 6, 2);
            Array.Copy(data, 0, reparseBuffer, 8, dataLength);

            using (var h = CreateFile(linkPath, GENERIC_WRITE, 0, IntPtr.Zero, OPEN_ALWAYS, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero)) {
                if (h.IsInvalid) {
                    return false;
                }
                uint bytesRet;
                bool ok = DeviceIoControl(h, FSCTL_SET_REPARSE_POINT, reparseBuffer, (uint)reparseBuffer.Length, IntPtr.Zero, 0, out bytesRet, IntPtr.Zero);
                return ok;
            }
        }
    }
}
