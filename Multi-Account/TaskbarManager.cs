using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class TaskbarManager {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr hWnd, uint Msg, UIntPtr wParam, IntPtr lParam,
        uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern IntPtr LoadImage(
        IntPtr hInst, string lpszName, uint uType,
        int cxDesired, int cyDesired, uint fuLoad);

    [DllImport("shell32.dll", SetLastError = true)]
    public static extern int SHGetPropertyStoreForWindow(
        IntPtr hwnd, ref Guid riid, out IPropertyStore ppv);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    public const uint WM_SETICON = 0x0080;
    public const uint ICON_SMALL = 0;
    public const uint ICON_BIG = 1;
    public const uint IMAGE_ICON = 1;
    public const uint LR_LOADFROMFILE = 0x0010;
    public const uint LR_DEFAULTSIZE = 0x0040;
    public const uint SMTO_ABORTIFHUNG = 0x0002;

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    public struct PROPERTYKEY {
        public Guid fmtid;
        public uint pid;
        public PROPERTYKEY(Guid guid, uint id) {
            fmtid = guid;
            pid = id;
        }
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct PROPVARIANT {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr pwszVal;
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore {
        int GetCount(out uint cProps);
        int GetAt(uint iProp, out PROPERTYKEY pkey);
        int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
        int SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
        int Commit();
    }

    private static readonly PROPERTYKEY PKEY_AppUserModel_ID =
        new PROPERTYKEY(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);

    private static readonly PROPERTYKEY PKEY_AppUserModel_RelaunchIconResource =
        new PROPERTYKEY(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 3);

    public static List<IntPtr> FindWindowsForPid(uint targetPid) {
        var list = new List<IntPtr>();
        EnumWindows((hWnd, lParam) => {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid == targetPid) {
                var sbClass = new StringBuilder(256);
                GetClassName(hWnd, sbClass, 256);
                string cls = sbClass.ToString();
                if (cls.Contains("Chrome_WidgetWin") || cls.Contains("CabinetWClass") || cls.Length > 0) {
                    list.Add(hWnd);
                }
            }
            return true;
        }, IntPtr.Zero);
        return list;
    }

    public static bool ApplyTaskbarProperties(IntPtr hwnd, string appId, string icoPath) {
        try {
            IntPtr hBig = LoadImage(IntPtr.Zero, icoPath, IMAGE_ICON, 0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE);
            IntPtr hSmall = LoadImage(IntPtr.Zero, icoPath, IMAGE_ICON, 16, 16, LR_LOADFROMFILE);

            UIntPtr res;
            if (hBig != IntPtr.Zero) {
                SendMessageTimeout(hwnd, WM_SETICON, (UIntPtr)ICON_BIG, hBig, SMTO_ABORTIFHUNG, 2000, out res);
            }
            if (hSmall != IntPtr.Zero) {
                SendMessageTimeout(hwnd, WM_SETICON, (UIntPtr)ICON_SMALL, hSmall, SMTO_ABORTIFHUNG, 2000, out res);
            }
        } catch { }

        try {
            Guid guid = typeof(IPropertyStore).GUID;
            IPropertyStore store;
            int hr = SHGetPropertyStoreForWindow(hwnd, ref guid, out store);
            if (hr == 0 && store != null) {
                PROPVARIANT pvAppId = new PROPVARIANT();
                pvAppId.vt = 31; // VT_LPWSTR
                pvAppId.pwszVal = Marshal.StringToCoTaskMemUni(appId);
                PROPERTYKEY keyAppId = PKEY_AppUserModel_ID;
                store.SetValue(ref keyAppId, ref pvAppId);

                PROPVARIANT pvIcon = new PROPVARIANT();
                pvIcon.vt = 31; // VT_LPWSTR
                pvIcon.pwszVal = Marshal.StringToCoTaskMemUni(icoPath + ",0");
                PROPERTYKEY keyIcon = PKEY_AppUserModel_RelaunchIconResource;
                store.SetValue(ref keyIcon, ref pvIcon);

                store.Commit();
                Marshal.ReleaseComObject(store);
            }
        } catch { }

        return true;
    }
}
