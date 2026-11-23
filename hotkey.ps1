# dsh-screenshot-bridge — screen capture hotkey helper (FALLBACK ONLY).
#
# The Host prefers the resident native daemon (bin/dshshotd.exe). This script is
# kept for source checkouts without a build and for parity on machines where the
# daemon cannot start; expect ~0.5-1 s per capture here versus ~50 ms there.
#
# Registers one system-wide keyboard hotkey (RegisterHotKey) or one mouse trigger
# (a low-level mouse hook for side buttons / the wheel), captures the screen into
# a PNG the moment it fires, and reports the path as one JSON line on stdout so
# the Host plugin can hand it to the Web client.
#
# Holding a keyboard chord or a side button down must still mean one capture:
# Windows repeats WM_HOTKEY while a chord is held, so the helper disarms itself
# on the first message and only rearms once the trigger key/button is physically
# released. Wheel notches are discrete events; a short cooldown prevents one
# inertial spin from producing a burst of screenshots.
#
# Speaks NDJSON on stdout:
#   {"kind":"ready","hotkey":"Alt+Z"}
#   {"kind":"capture","path":"C:\\...\\shot-....png","width":1920,"height":1080}
#   {"kind":"error","message":"..."}
#
# Parameters:
#   -Hotkey     e.g. 'Alt+Z', 'Ctrl+Alt+S', 'Alt+XButton1', 'WheelUp', 'Ctrl+Shift+WheelDown'
#               (modifiers joined with +, last token is a key or mouse action)
#   -OutDir     directory the PNG files are written into (created when missing)
#   -AllScreens capture the whole virtual desktop instead of the cursor's screen
#   -DryRun     capture once, print the line, and exit (no hotkey registration)

param(
  [string]$Hotkey = 'Alt+Z',
  [string]$OutDir = '',
  [switch]$AllScreens,
  [switch]$DryRun,
  [string]$Backend = 'auto',
  [string]$CaptureExe = '',
  [string]$ClearExe = '',
  [string]$KernelCtl = ''
)

$ErrorActionPreference = 'Stop'

$csharp = @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class DshScreenshotHotkey
{
    /** Optional native capture helper (shotcap.exe). Empty disables it. */
    public static string CaptureExe = "";
    /** Optional affinity cleaner (wdaclear.exe). Empty disables it. */
    public static string ClearExe = "";
    /** Optional kernel driver front end (dshcapctl.exe). Empty disables it. */
    public static string KernelCtl = "";
    /** auto | gdi | dxgi */
    public static string Backend = "auto";
    private const int HotkeyId = 0x445348;
    private const int WmHotkey = 0x0312;

    private const int WhMouseLl = 14;
    private const int WmXButtonDown = 0x020B;
    private const int WmXButtonUp = 0x020C;
    private const int WmMouseWheel = 0x020A;
    private const int WmMouseHWheel = 0x020E;

    private const int VkShift = 0x10;
    private const int VkControl = 0x11;
    private const int VkMenu = 0x12;
    private const int VkLWin = 0x5B;
    private const int VkRWin = 0x5C;
    private const int VkXButton1 = 0x05;
    private const int VkXButton2 = 0x06;

    private readonly string combo;
    private readonly string outDir;
    private readonly bool allScreens;
    private readonly int modifiers;
    private readonly int keyCode;
    private readonly string mouseAction; // null for keyboard chords
    private NativeWindow window;
    private bool armed = true;
    private Timer releaseTimer;
    private Timer wheelTimer;

    private static LowLevelMouseProc mouseProc;
    private IntPtr mouseHook = IntPtr.Zero;

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MsllHookStruct
    {
        public Point Point;
        public uint MouseData;
        public uint Flags;
        public uint Time;
        public IntPtr ExtraInfo;
    }

    private delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, int fsModifiers, int vk);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc callback, IntPtr hMod, uint threadId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hook);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hook, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vk);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto)]
    private static extern IntPtr GetModuleHandle(string moduleName);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetWindowDisplayAffinity(IntPtr hwnd, out uint affinity);

    public DshScreenshotHotkey(string combo, string outDir, bool allScreens)
    {
        this.combo = combo;
        this.outDir = outDir;
        this.allScreens = allScreens;
        this.modifiers = ParseModifiers(combo);
        this.mouseAction = ParseMouseAction(combo);
        this.keyCode = this.mouseAction == null ? ParseKey(combo) : 0;
    }

    private sealed class HotkeyWindow : NativeWindow
    {
        private readonly DshScreenshotHotkey owner;

        public HotkeyWindow(DshScreenshotHotkey owner)
        {
            this.owner = owner;
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WmHotkey)
            {
                this.owner.OnHotkey();
                return;
            }
            base.WndProc(ref m);
        }
    }

    private static string Escape(string value)
    {
        if (value == null) return string.Empty;
        return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    private static void Emit(string line)
    {
        Console.Out.WriteLine(line);
        Console.Out.Flush();
    }

    public static void EmitReady(string combo)
    {
        Emit("{\"kind\":\"ready\",\"hotkey\":\"" + Escape(combo) + "\"}");
    }

    public static void EmitError(string message)
    {
        Emit("{\"kind\":\"error\",\"message\":\"" + Escape(message) + "\"}");
    }

    private static int ParseModifiers(string combo)
    {
        int value = 0;
        foreach (string raw in combo.Split('+'))
        {
            switch (raw.Trim().ToLowerInvariant())
            {
                case "ctrl":
                case "control": value |= 0x0002; break;
                case "alt": value |= 0x0001; break;
                case "shift": value |= 0x0004; break;
                case "win":
                case "meta": value |= 0x0008; break;
            }
        }
        return value;
    }

    /** Canonical mouse token, or null when the last token is a keyboard key. */
    private static string ParseMouseAction(string combo)
    {
        string[] parts = combo.Split('+');
        string name = parts[parts.Length - 1].Trim().ToLowerInvariant();
        switch (name)
        {
            case "xbutton1": case "mouse4": case "back": return "XButton1";
            case "xbutton2": case "mouse5": case "forward": return "XButton2";
            case "middle": case "middlebutton": case "mouse3": return "MiddleButton";
            case "wheelup": case "scrollup": return "WheelUp";
            case "wheeldown": case "scrolldown": return "WheelDown";
            case "wheelleft": case "scrollleft": return "WheelLeft";
            case "wheelright": case "scrollright": return "WheelRight";
            default: return null;
        }
    }

    private static int ParseKey(string combo)
    {
        string[] parts = combo.Split('+');
        string name = parts[parts.Length - 1].Trim();
        if (name.Length == 0) throw new ArgumentException("hotkey has no key: " + combo);

        string upper = name.ToUpperInvariant();
        if (upper.Length == 1)
        {
            char c = upper[0];
            if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return (int)c;
            if (c == ' ') return 0x20;
        }

        switch (upper)
        {
            case "PRINTSCREEN": case "PRTSC": return 0x2C;
            case "SCROLLLOCK": return 0x91;
            case "PAUSE": return 0x13;
            case "INSERT": return 0x2D;
            case "DELETE": case "DEL": return 0x2E;
            case "HOME": return 0x24;
            case "END": return 0x23;
            case "PAGEUP": return 0x21;
            case "PAGEDOWN": return 0x22;
            case "LEFT": return 0x25;
            case "UP": return 0x26;
            case "RIGHT": return 0x27;
            case "DOWN": return 0x28;
            case "SPACE": return 0x20;
            case "TAB": return 0x09;
            case "ENTER": case "RETURN": return 0x0D;
            case "BACKSPACE": return 0x08;
            case "ESC": case "ESCAPE": return 0x1B;
            case "`": case "BACKQUOTE": return 0xC0;
            case "-": case "MINUS": return 0xBD;
            case "=": case "EQUAL": return 0xBB;
            case "[": return 0xDB;
            case "]": return 0xDD;
            case ";": return 0xBA;
            case "'": return 0xDE;
            case ",": case "COMMA": return 0xBC;
            case ".": case "PERIOD": return 0xBE;
            case "/": case "SLASH": return 0xBF;
            case "\\": return 0xDC;
        }

        if (upper.StartsWith("F") && upper.Length <= 3)
        {
            int number = int.Parse(upper.Substring(1));
            if (number >= 1 && number <= 24) return 0x70 + number - 1;
        }

        throw new ArgumentException("unknown key in hotkey: " + combo);
    }

    private static bool IsKeyDown(int vk)
    {
        return (GetAsyncKeyState(vk) & 0x8000) != 0;
    }

    private bool ModifiersMatch()
    {
        bool ctrl = IsKeyDown(VkControl);
        bool alt = IsKeyDown(VkMenu);
        bool shift = IsKeyDown(VkShift);
        bool win = IsKeyDown(VkLWin) || IsKeyDown(VkRWin);
        bool wantCtrl = (this.modifiers & 0x0002) != 0;
        bool wantAlt = (this.modifiers & 0x0001) != 0;
        bool wantShift = (this.modifiers & 0x0004) != 0;
        bool wantWin = (this.modifiers & 0x0008) != 0;
        return ctrl == wantCtrl && alt == wantAlt && shift == wantShift && win == wantWin;
    }

    private IntPtr MouseHookProc(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            MsllHookStruct data = (MsllHookStruct)Marshal.PtrToStructure(lParam, typeof(MsllHookStruct));
            int message = wParam.ToInt32();
            int highWord = (int)((data.MouseData >> 16) & 0xFFFF);
            string action = null;
            bool swallow = false;

            if (message == WmXButtonDown)
            {
                action = highWord == 1 ? "XButton1" : highWord == 2 ? "XButton2" : null;
            }
            else if (message == WmXButtonUp)
            {
                string released = highWord == 1 ? "XButton1" : highWord == 2 ? "XButton2" : null;
                if (released != null && released == this.mouseAction)
                {
                    this.armed = true;
                    return new IntPtr(1);
                }
                return CallNextHookEx(this.mouseHook, nCode, wParam, lParam);
            }
            else if (message == WmMouseWheel)
            {
                action = highWord > 0 ? "WheelUp" : highWord < 0 ? "WheelDown" : null;
            }
            else if (message == WmMouseHWheel)
            {
                action = highWord > 0 ? "WheelRight" : highWord < 0 ? "WheelLeft" : null;
            }

            if (action != null && action == this.mouseAction && this.ModifiersMatch())
            {
                bool fired = this.OnHotkey();
                // Side buttons stay swallowed while held (including the repeat
                // before release); wheels only swallow a notch that fired so
                // ordinary scrolling still works during the cooldown.
                swallow = fired || message == WmXButtonDown;
            }

            if (swallow) return new IntPtr(1);
        }
        return CallNextHookEx(this.mouseHook, nCode, wParam, lParam);
    }

    public static string Capture(string outDir, bool allScreens)
    {
        if (!Directory.Exists(outDir)) Directory.CreateDirectory(outDir);

        // Preferred path: shotcap.exe (DXGI desktop duplication, with GDI inside
        // as its own fallback). It reports how much of the frame is actually
        // lit, so a compositor placeholder is noticed instead of shipped.
        if (CaptureExe != null && CaptureExe.Length != 0 && File.Exists(CaptureExe))
        {
            string native = CaptureNative(outDir, allScreens);
            if (native != null) return native;
        }
        return CaptureGdi(outDir, allScreens);
    }

    /** Run shotcap.exe; null means "fall back to GDI". */
    private static string CaptureNative(string outDir, bool allScreens)
    {
        string path = Path.Combine(
            outDir,
            "shot-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff") + ".png");

        // Only pay for the affinity sweep when the foreground window is protected.
        if (ClearExe != null && ClearExe.Length != 0 && File.Exists(ClearExe) && ForegroundProtected())
        {
            RunTool(ClearExe, "--clear --target foreground", 4000);
            // Guarded / protected processes refuse the in-process payload; the
            // kernel driver opens them from SYSTEM and creates the thread there.
            if (ForegroundProtected() && KernelCtl != null && KernelCtl.Length != 0
                && File.Exists(KernelCtl))
            {
                RunTool(KernelCtl, "--clear --guard 5", 4000);
            }
        }

        string backend = string.IsNullOrEmpty(Backend) ? "auto" : Backend;
        string mode = allScreens ? "desktop" : "screen";
        string args = "--out \"" + path + "\" --mode " + mode + " --backend " + backend + " --json";
        string output = RunTool(CaptureExe, args, 8000);
        if (output == null) return null;
        foreach (string raw in output.Split('\n'))
        {
            string line = raw.Trim();
            if (line.StartsWith("{") && line.Contains("\"kind\":\"capture\""))
            {
                if (line.Contains("\"blank\":true"))
                {
                    // Compositor handed back a placeholder: keep the file as
                    // evidence but let GDI have a turn, then report the better one.
                    string gdi = CaptureGdi(outDir, allScreens);
                    return gdi ?? line;
                }
                return line;
            }
        }
        return null;
    }

    private static string CaptureGdi(string outDir, bool allScreens)
    {
        if (!Directory.Exists(outDir)) Directory.CreateDirectory(outDir);

        Rectangle bounds = allScreens
            ? SystemInformation.VirtualScreen
            : Screen.FromPoint(Cursor.Position).Bounds;
        if (bounds.Width <= 0 || bounds.Height <= 0) throw new InvalidOperationException("empty screen bounds");

        string path = Path.Combine(
            outDir,
            "shot-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff") + ".png");

        using (Bitmap bitmap = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb))
        {
            using (Graphics graphics = Graphics.FromImage(bitmap))
            {
                graphics.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, bounds.Size, CopyPixelOperation.SourceCopy);
            }
            bitmap.Save(path, ImageFormat.Png);
        }

        return "{\"kind\":\"capture\",\"backend\":\"gdi\",\"path\":\"" + Escape(path)
            + "\",\"width\":" + bounds.Width
            + ",\"height\":" + bounds.Height + "}";
    }

    /** True when the foreground window asked the compositor to hide it from capture. */
    private static bool ForegroundProtected()
    {
        IntPtr hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return false;
        uint affinity;
        if (!GetWindowDisplayAffinity(hwnd, out affinity)) return false;
        return affinity != 0;
    }

    /** Run one helper binary, capture stdout, and give up after `millis`. */
    private static string RunTool(string exe, string arguments, int millis)
    {
        try
        {
            ProcessStartInfo info = new ProcessStartInfo(exe, arguments);
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            using (Process process = Process.Start(info))
            {
                if (process == null) return null;
                System.Text.StringBuilder text = new System.Text.StringBuilder();
                process.OutputDataReceived += (sender, e) =>
                {
                    if (e.Data != null) text.AppendLine(e.Data);
                };
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                if (!process.WaitForExit(millis))
                {
                    try { process.Kill(); } catch { }
                    return null;
                }
                process.WaitForExit();
                return text.ToString();
            }
        }
        catch
        {
            return null;
        }
    }

    private bool OnHotkey()
    {
        // Auto-repeat keeps posting WM_HOTKEY while a chord is held; a held side
        // button is handled by its release message. Only the first event fires.
        if (!this.armed) return false;
        this.armed = false;
        try
        {
            string line = Capture(this.outDir, this.allScreens);
            try { System.Media.SystemSounds.Asterisk.Play(); } catch { }
            Emit(line);
        }
        catch (Exception error)
        {
            EmitError("capture failed: " + error.Message);
        }
        finally
        {
            this.ArmOnRelease();
        }
        return true;
    }

    /** Poll the trigger until it is up, then accept the next press. */
    private void ArmOnRelease()
    {
        if (this.mouseAction != null && this.mouseAction.StartsWith("Wheel", StringComparison.Ordinal))
        {
            // Wheel notches are instantaneous. A short cooldown stops a fast
            // inertial scroll from producing several screenshots.
            if (this.wheelTimer == null)
            {
                this.wheelTimer = new Timer();
                this.wheelTimer.Interval = 600;
                this.wheelTimer.Tick += (sender, args) =>
                {
                    this.wheelTimer.Stop();
                    this.armed = true;
                };
            }
            this.wheelTimer.Stop();
            this.wheelTimer.Start();
            return;
        }

        if (this.releaseTimer == null)
        {
            this.releaseTimer = new Timer();
            this.releaseTimer.Interval = 25;
            this.releaseTimer.Tick += (sender, args) =>
            {
                if (!IsTriggerDown())
                {
                    this.releaseTimer.Stop();
                    this.armed = true;
                }
            };
        }
        this.releaseTimer.Start();
    }

    private bool IsTriggerDown()
    {
        if (this.mouseAction == "XButton1") return IsKeyDown(VkXButton1);
        if (this.mouseAction == "XButton2") return IsKeyDown(VkXButton2);
        if (this.mouseAction == "MiddleButton") return IsKeyDown(0x04);
        return this.keyCode != 0 && IsKeyDown(this.keyCode);
    }

    public void Run()
    {
        try { SetProcessDPIAware(); } catch { }

        this.window = new HotkeyWindow(this);
        CreateParams parameters = new CreateParams();
        parameters.Caption = "dsh-screenshot-bridge";
        this.window.CreateHandle(parameters);

        if (this.mouseAction == null)
        {
            if (!RegisterHotKey(this.window.Handle, HotkeyId, this.modifiers, this.keyCode))
            {
                EmitError("hotkey registration failed (combination taken or reserved): " + this.combo);
                return;
            }
        }
        else
        {
            mouseProc = new LowLevelMouseProc(this.MouseHookProc);
            this.mouseHook = SetWindowsHookEx(WhMouseLl, mouseProc, GetModuleHandle(null), 0);
            if (this.mouseHook == IntPtr.Zero)
            {
                EmitError("mouse hook registration failed: " + this.combo);
                return;
            }
        }

        EmitReady(this.combo);
        Application.Run();

        if (this.mouseHook != IntPtr.Zero)
        {
            UnhookWindowsHookEx(this.mouseHook);
            this.mouseHook = IntPtr.Zero;
        }
        if (this.mouseAction == null) UnregisterHotKey(this.window.Handle, HotkeyId);
    }
}
'@

try {
  Add-Type -TypeDefinition $csharp -ReferencedAssemblies 'System.Windows.Forms', 'System.Drawing' -ErrorAction Stop
} catch {
  # Windows PowerShell 5.1 resolves these without explicit references.
  Add-Type -TypeDefinition $csharp -ErrorAction Stop
}

[DshScreenshotHotkey]::CaptureExe = $CaptureExe
[DshScreenshotHotkey]::ClearExe = $ClearExe
[DshScreenshotHotkey]::KernelCtl = $KernelCtl
[DshScreenshotHotkey]::Backend = $Backend

if ($DryRun) {
  $line = [DshScreenshotHotkey]::Capture($OutDir, [bool]$AllScreens)
  Write-Output $line
  exit 0
}

$runner = New-Object DshScreenshotHotkey($Hotkey, $OutDir, [bool]$AllScreens)
$runner.Run()

