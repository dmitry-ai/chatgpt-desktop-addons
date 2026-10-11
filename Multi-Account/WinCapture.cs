using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Threading;
using System.Runtime.InteropServices;

public class WinCapture {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetThreadDesktop(IntPtr hDesktop);

    public static void Grab(int x, int y, int w, int h, string savePath) {
        var t = new Thread(() => {
            IntPtr hDesk = OpenDesktop("Default", 0, false, 0x10000000);
            SetThreadDesktop(hDesk);
            using (var bmp = new Bitmap(w, h)) {
                using (var g = Graphics.FromImage(bmp)) {
                    g.CopyFromScreen(x, y, 0, 0, new Size(w, h));
                }
                bmp.Save(savePath, ImageFormat.Png);
            }
        });
        t.Start();
        t.Join();
    }
}
