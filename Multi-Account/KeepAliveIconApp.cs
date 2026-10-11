using System;
using System.Drawing;
using System.Threading;
using System.Runtime.InteropServices;

public class KeepAliveIconApp {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetThreadDesktop(IntPtr hDesktop);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr hWnd, uint Msg, UIntPtr wParam, IntPtr lParam,
        uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern IntPtr LoadImage(
        IntPtr hInst, string lpszName, uint uType,
        int cxDesired, int cyDesired, uint fuLoad);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    public const uint WM_SETICON = 0x0080;
    public const uint ICON_SMALL = 0;
    public const uint ICON_BIG = 1;
    public const uint IMAGE_ICON = 1;
    public const uint LR_LOADFROMFILE = 0x0010;
    public const uint LR_DEFAULTSIZE = 0x0040;
    public const uint SMTO_ABORTIFHUNG = 0x0002;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOZORDER = 0x0004;
    public const uint SWP_FRAMECHANGED = 0x0020;

    [ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ITaskbarList3 {
        // ITaskbarList
        void HrInit();
        void AddTab(IntPtr hwnd);
        void DeleteTab(IntPtr hwnd);
        void ActivateTab(IntPtr hwnd);
        void SetActiveAlt(IntPtr hwnd);
        // ITaskbarList2
        void MarkFullscreenWindow(IntPtr hwnd, int fFullscreen);
        // ITaskbarList3
        void SetProgressValue(IntPtr hwnd, ulong ullCompleted, ulong ullTotal);
        void SetProgressState(IntPtr hwnd, int tbpFlags);
        void RegisterTab(IntPtr hwndTab, IntPtr hwndMDI);
        void UnregisterTab(IntPtr hwndTab);
        void SetTabOrder(IntPtr hwndTab, IntPtr hwndInsertBefore);
        void SetTabActive(IntPtr hwndTab, IntPtr hwndMDI, uint dwReserved);
        void ThumbBarAddButtons(IntPtr hwnd, uint cButtons, IntPtr pButton);
        void ThumbBarUpdateButtons(IntPtr hwnd, uint cButtons, IntPtr pButton);
        void ThumbBarSetImageList(IntPtr hwnd, IntPtr himl);
        void SetOverlayIcon(IntPtr hwnd, IntPtr hIcon, [MarshalAs(UnmanagedType.LPWStr)] string pszDescription);
        void SetThumbnailTooltip(IntPtr hwnd, [MarshalAs(UnmanagedType.LPWStr)] string pszTip);
        void SetThumbnailClip(IntPtr hwnd, IntPtr prcClip);
    }

    [ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090"), ClassInterface(ClassInterfaceType.None)]
    public class TaskbarList { }

    public static void Main(string[] args) {
        if (args.Length < 2) return;
        long hwndVal = Convert.ToInt64(args[0], 16);
        IntPtr hwnd = (IntPtr)hwndVal;
        string icoPath = args[1];

        IntPtr hDesk = OpenDesktop("Default", 0, false, 0x10000000);
        SetThreadDesktop(hDesk);

        IntPtr hBig = LoadImage(IntPtr.Zero, icoPath, IMAGE_ICON, 32, 32, LR_LOADFROMFILE);
        IntPtr hSmall = LoadImage(IntPtr.Zero, icoPath, IMAGE_ICON, 16, 16, LR_LOADFROMFILE);

        Console.WriteLine("Loaded icons: Big=" + hBig.ToInt64().ToString("X") + ", Small=" + hSmall.ToInt64().ToString("X"));

        UIntPtr res;
        SendMessageTimeout(hwnd, WM_SETICON, (UIntPtr)ICON_BIG, hBig, SMTO_ABORTIFHUNG, 2000, out res);
        SendMessageTimeout(hwnd, WM_SETICON, (UIntPtr)ICON_SMALL, hSmall, SMTO_ABORTIFHUNG, 2000, out res);

        try {
            ITaskbarList3 tbl = (ITaskbarList3)new TaskbarList();
            tbl.HrInit();
            tbl.SetOverlayIcon(hwnd, hSmall, "Profile 2");
            Console.WriteLine("SetOverlayIcon called successfully!");
        } catch (Exception ex) {
            Console.WriteLine("SetOverlayIcon error: " + ex.Message);
        }

        SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);

        Console.WriteLine("Applied. Entering sleep to keep HICON alive...");
        Thread.Sleep(30000);
    }
}
