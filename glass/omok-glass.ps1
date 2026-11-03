<#
  오목 투명창 — 오목 페이지를 전용 창(크롬/엣지 앱 창)으로 띄우고, 그 창을 반투명하게 만들어 줍니다.

  - 진하기·항상 위: 오목 창 위쪽 슬라이더/📌 버튼으로 조절 (페이지가 창 제목 끝에 보이지 않는 글자로 값을 적어 두면
    이 도우미가 읽어서 윈도우 창 투명도를 바꿉니다 — 서버·권한·설치 불필요)
  - Ctrl+Alt+H: 오목 창 숨기기/보이기 (어디서든)
  - 알림 영역(트레이) 아이콘: 클릭하면 숨기기/보이기, 우클릭 메뉴에서 작업표시줄 숨김·종료
  - 작업표시줄에 오목 창이 안 보이게(기본 켬). 최소화하면 트레이로 들어갑니다.
  - 오목 창을 닫으면 도우미도 같이 끝납니다.
#>
param(
  [string]$Url = 'https://cheon-jaeryong.github.io/omok/',
  [string[]]$ExtraArgs = @()
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

function Show-Err([string]$msg) {
  [System.Windows.Forms.MessageBox]::Show($msg, '오목 투명창', 'OK', 'Warning') | Out-Null
}

try {
  $src = @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace OmokGlass {
  [ComImport, Guid("56FDF342-FD6D-11d0-958A-006097C9A090"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ITaskbarList {
    void HrInit(); void AddTab(IntPtr h); void DeleteTab(IntPtr h); void ActivateTab(IntPtr h); void SetActiveAlt(IntPtr h);
  }
  [ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090")] class TaskbarListCls { }

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  static class W {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
    [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte a, uint f);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int pid);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr h, int id);
  }

  public class App : Form {
    const int GWL_EXSTYLE = -20, WS_EX_LAYERED = 0x80000, WS_EX_TOPMOST = 0x8;
    const int SW_HIDE = 0, SW_SHOW = 5, SW_RESTORE = 9;
    const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10;
    const uint WM_CLOSE = 0x10; const int WM_HOTKEY = 0x312, HOTKEY_ID = 7;
    const string REG = @"Software\OmokGlass";
    static readonly Regex TitleTag = new Regex("\u2060([\u200B\u200C]{8})\u2060");

    readonly string browser, url, extra;
    IntPtr win = IntPtr.Zero;
    int wantAlpha = 100, appliedAlpha = -1; bool wantTop = true;
    bool hideTaskbar, launched, hotkeyOk, quitting;
    int ticks; DateTime t0 = DateTime.Now;
    RECT lastRect; bool haveRect;
    NotifyIcon tray; System.Windows.Forms.Timer timer; ITaskbarList tbl;
    ToolStripMenuItem miToggle, miTaskbar;

    public static int Run(string browser, string url, string extra, string iconPath) {
      bool created;
      var mutex = new Mutex(true, @"Local\OmokGlass.v1", out created);
      var showEvt = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\OmokGlass.v1.show");
      if (!created) { showEvt.Set(); return 1; } // 이미 실행 중 → 그 창을 보이게 하고 끝
      Application.EnableVisualStyles();
      var app = new App(browser, url, extra, iconPath);
      if (app.quitting) return 1;
      ThreadPool.RegisterWaitForSingleObject(showEvt, delegate {
        try { app.BeginInvoke(new MethodInvoker(app.ShowWin)); } catch { }
      }, null, -1, false);
      Application.Run(app);
      GC.KeepAlive(showEvt);
      mutex.ReleaseMutex();
      return 0;
    }

    App(string browser, string url, string extra, string iconPath) {
      this.browser = browser; this.url = url; this.extra = extra ?? "";
      ShowInTaskbar = false; FormBorderStyle = FormBorderStyle.None; Text = "OmokGlassHost";
      CreateHandle();
      hideTaskbar = RegInt("HideTaskbar", 1) == 1;
      hotkeyOk = W.RegisterHotKey(Handle, HOTKEY_ID, 0x2 | 0x1 | 0x4000, (uint)Keys.H); // Ctrl+Alt+H (반복 없음)

      Icon ico = null;
      try { if (!string.IsNullOrEmpty(iconPath) && System.IO.File.Exists(iconPath)) ico = new Icon(iconPath, 16, 16); } catch { }
      var menu = new ContextMenuStrip();
      miToggle = new ToolStripMenuItem("숨기기", null, delegate { ToggleWin(); });
      miToggle.ShortcutKeyDisplayString = "Ctrl+Alt+H";
      miTaskbar = new ToolStripMenuItem("작업표시줄에 안 보이게", null, delegate { SetHideTaskbar(!hideTaskbar); });
      menu.Items.Add(miToggle);
      menu.Items.Add(miTaskbar);
      menu.Items.Add(new ToolStripSeparator());
      menu.Items.Add(new ToolStripMenuItem("종료 (오목 창 닫기)", null, delegate { Quit(true); }));
      menu.Opening += delegate { UpdateMenu(); };
      tray = new NotifyIcon();
      tray.Icon = ico ?? SystemIcons.Application;
      tray.Text = hotkeyOk ? "오목 투명창 · Ctrl+Alt+H 숨기기/보이기" : "오목 투명창 · 클릭해서 숨기기/보이기";
      tray.ContextMenuStrip = menu;
      tray.MouseClick += delegate (object s, MouseEventArgs e) { if (e.Button == MouseButtons.Left) ToggleWin(); };
      tray.Visible = true;

      timer = new System.Windows.Forms.Timer();
      timer.Interval = 120;
      timer.Tick += delegate { Tick(); };

      win = FindTagged(); // 이미 열려 있는 투명창이 있으면 그 창에 붙음
      if (win == IntPtr.Zero) Launch(); else OnFound();
      if (!quitting) timer.Start();
    }

    protected override void SetVisibleCore(bool value) { base.SetVisibleCore(false); } // 도우미 자체 창은 안 보임

    protected override void WndProc(ref Message m) {
      if (m.Msg == WM_HOTKEY && m.WParam.ToInt32() == HOTKEY_ID) ToggleWin();
      base.WndProc(ref m);
    }

    void Launch() {
      try {
        var psi = new ProcessStartInfo(browser, "--app=\"" + url + "\" " + extra);
        psi.UseShellExecute = false;
        W.AllowSetForegroundWindow(-1); // 새 창이 앞으로 나올 수 있게
        Process.Start(psi);
      } catch (Exception e) { Fail("브라우저를 열지 못했어요.\n" + browser + "\n" + e.Message); return; }
      launched = true; t0 = DateTime.Now;
    }

    static string Title(IntPtr h) {
      int n = W.GetWindowTextLength(h);
      if (n <= 0) return "";
      var sb = new StringBuilder(n + 2);
      W.GetWindowText(h, sb, sb.Capacity);
      return sb.ToString();
    }

    // 제목 끝에 투명창 표시(폭 0 문자)가 붙은 크롬/엣지 창 찾기
    static IntPtr FindTagged() {
      IntPtr best = IntPtr.Zero; bool bestVisible = false;
      W.EnumWindows(delegate (IntPtr h, IntPtr l) {
        var c = new StringBuilder(64); W.GetClassName(h, c, 64);
        if (c.ToString() != "Chrome_WidgetWin_1") return true;
        if (!TitleTag.IsMatch(Title(h))) return true;
        bool vis = W.IsWindowVisible(h);
        if (best == IntPtr.Zero || (vis && !bestVisible)) { best = h; bestVisible = vis; }
        return true;
      }, IntPtr.Zero);
      return best;
    }

    void OnFound() {
      t0 = DateTime.Now;
      if (launched) {
        // 지난번 위치·크기로, 처음이면 화면 오른쪽에 세로로 길게
        Rectangle wa = Screen.PrimaryScreen.WorkingArea;
        int x = RegInt("X", int.MinValue), y = RegInt("Y", 0), w = RegInt("W", 0), h = RegInt("H", 0);
        Rectangle r = new Rectangle(x, y, w, h);
        bool ok = x != int.MinValue && w >= 300 && h >= 300;
        if (ok) { ok = false; foreach (Screen s in Screen.AllScreens) if (s.WorkingArea.IntersectsWith(r)) ok = true; }
        if (!ok) {
          w = Math.Min(540, wa.Width - 40); h = Math.Min(940, wa.Height - 40);
          r = new Rectangle(wa.Right - w - 24, wa.Top + (wa.Height - h) / 2, w, h);
        }
        W.SetWindowPos(win, IntPtr.Zero, r.X, r.Y, r.Width, r.Height, SWP_NOZORDER | SWP_NOACTIVATE);
      }
      // 한 번도 활성화된 적 없는 창은 '항상 위'가 안 먹으므로 앞으로 꺼내 둠 (안 되면 사용자가 창을 클릭할 때 먹음)
      W.SetForegroundWindow(win);
      Apply(true);
      if (hideTaskbar) DeleteTab();
      UpdateMenu();
    }

    void Tick() {
      ticks++;
      if (win == IntPtr.Zero) {
        win = FindTagged();
        if (win == IntPtr.Zero) {
          if ((DateTime.Now - t0).TotalSeconds > 45) Fail("오목 창을 찾지 못했어요.\n인터넷 연결을 확인하고 다시 실행해 주세요.");
          return;
        }
        OnFound();
      }
      if (!W.IsWindow(win)) { Quit(false); return; }

      var m = TitleTag.Match(Title(win));
      if (m.Success) {
        int v = 0;
        foreach (char ch in m.Groups[1].Value) v = (v << 1) | (ch == '\u200C' ? 1 : 0);
        wantAlpha = Math.Max(10, Math.Min(100, v & 127));
        wantTop = (v & 128) != 0;
      }
      Apply(false);

      bool vis = W.IsWindowVisible(win);
      if (vis && W.IsIconic(win)) {
        if (hideTaskbar) { W.ShowWindow(win, SW_HIDE); UpdateMenu(); } // 작업표시줄 버튼이 없으니 최소화 = 트레이로
      } else if (vis) {
        RECT rc;
        if (!W.IsZoomed(win) && W.GetWindowRect(win, out rc)) { lastRect = rc; haveRect = true; }
        if (hideTaskbar && ticks % 5 == 0) DeleteTab();
      }
    }

    void Apply(bool force) {
      int ex = W.GetWindowLong(win, GWL_EXSTYLE);
      if ((ex & WS_EX_LAYERED) == 0) { W.SetWindowLong(win, GWL_EXSTYLE, ex | WS_EX_LAYERED); force = true; }
      if (force || appliedAlpha != wantAlpha) {
        W.SetLayeredWindowAttributes(win, 0, (byte)Math.Round(wantAlpha * 2.55), 0x2);
        appliedAlpha = wantAlpha;
      }
      bool isTop = (ex & WS_EX_TOPMOST) != 0;
      if (isTop != wantTop)
        W.SetWindowPos(win, new IntPtr(wantTop ? -1 : -2), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }

    void DeleteTab() {
      try {
        if (tbl == null) { tbl = (ITaskbarList)new TaskbarListCls(); tbl.HrInit(); }
        tbl.DeleteTab(win);
      } catch { }
    }
    void AddTab() {
      try {
        if (tbl == null) { tbl = (ITaskbarList)new TaskbarListCls(); tbl.HrInit(); }
        tbl.AddTab(win);
      } catch { }
    }

    bool IsWinShown() { return win != IntPtr.Zero && W.IsWindowVisible(win) && !W.IsIconic(win); }

    public void ShowWin() {
      if (win == IntPtr.Zero || !W.IsWindow(win)) return;
      W.ShowWindow(win, W.IsIconic(win) ? SW_RESTORE : SW_SHOW);
      W.SetForegroundWindow(win);
      if (hideTaskbar) DeleteTab();
      Apply(true);
      UpdateMenu();
    }
    void HideWin() {
      if (win == IntPtr.Zero) return;
      W.ShowWindow(win, SW_HIDE);
      UpdateMenu();
    }
    void ToggleWin() { if (IsWinShown()) HideWin(); else ShowWin(); }

    void SetHideTaskbar(bool on) {
      hideTaskbar = on;
      RegSet("HideTaskbar", on ? 1 : 0);
      if (win != IntPtr.Zero && W.IsWindowVisible(win)) { if (on) DeleteTab(); else AddTab(); }
      UpdateMenu();
    }

    void UpdateMenu() {
      miToggle.Text = IsWinShown() ? "오목 창 숨기기" : "오목 창 보이기";
      miTaskbar.Checked = hideTaskbar;
    }

    void Fail(string msg) {
      if (timer != null) timer.Stop();
      MessageBox.Show(msg, "오목 투명창", MessageBoxButtons.OK, MessageBoxIcon.Warning);
      Quit(false);
    }

    void Quit(bool closeWindow) {
      if (quitting) return;
      quitting = true;
      if (timer != null) timer.Stop();
      if (haveRect) {
        RegSet("X", lastRect.Left); RegSet("Y", lastRect.Top);
        RegSet("W", lastRect.Right - lastRect.Left); RegSet("H", lastRect.Bottom - lastRect.Top);
      }
      if (closeWindow && win != IntPtr.Zero && W.IsWindow(win)) W.PostMessage(win, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
      if (hotkeyOk) W.UnregisterHotKey(Handle, HOTKEY_ID);
      tray.Visible = false;
      tray.Dispose();
      Application.Exit();
    }

    static int RegInt(string name, int def) {
      try {
        using (var k = Registry.CurrentUser.OpenSubKey(REG)) {
          object v = k == null ? null : k.GetValue(name);
          return v is int ? (int)v : def;
        }
      } catch { return def; }
    }
    static void RegSet(string name, int v) {
      try { using (var k = Registry.CurrentUser.CreateSubKey(REG)) k.SetValue(name, v, RegistryValueKind.DWord); } catch { }
    }
  }
}
'@

  # 컴파일 결과를 저장해 두고 다음부터는 바로 불러오기(실행 속도)
  $dir = Join-Path $env:LOCALAPPDATA 'omok-glass'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $hash = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($src))[0..5] | ForEach-Object { $_.ToString('x2') })
  $dll = Join-Path $dir "OmokGlass-$hash.dll"
  if (-not (Test-Path $dll)) {
    Get-ChildItem -Path $dir -Filter 'OmokGlass-*.dll' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    Add-Type -TypeDefinition $src -Language CSharp -ReferencedAssemblies System.Windows.Forms, System.Drawing -OutputAssembly $dll -OutputType Library
  }
  Add-Type -Path $dll

  # 브라우저: 기본 브라우저가 엣지면 엣지, 아니면 크롬(없으면 엣지)
  function Get-AppPath([string]$exe) {
    foreach ($root in 'HKCU:', 'HKLM:') {
      try {
        $v = (Get-ItemProperty -Path "$root\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exe" -ErrorAction Stop).'(default)'
        if ($v) { $v = $v.Trim('"'); if (Test-Path -LiteralPath $v) { return $v } }
      } catch { }
    }
    return $null
  }
  $chrome = Get-AppPath 'chrome.exe'
  if (-not $chrome) {
    $chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") |
      Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  }
  $edge = Get-AppPath 'msedge.exe'
  if (-not $edge) {
    $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
      Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  }
  $prog = ''
  try { $prog = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice' -ErrorAction Stop).ProgId } catch { }
  $browser = if ($prog -like 'MSEdge*' -and $edge) { $edge } elseif ($chrome) { $chrome } else { $edge }
  if (-not $browser) { Show-Err '크롬이나 엣지 브라우저를 찾지 못했어요.'; exit 1 }

  $glassUrl = ($Url -split '#')[0] + '#glass'
  $icon = Join-Path $PSScriptRoot 'omok.ico'
  [void][OmokGlass.App]::Run($browser, $glassUrl, ($ExtraArgs -join ' '), $icon)
} catch {
  Show-Err ("오목 투명창을 실행하지 못했어요.`n`n" + $_.Exception.Message)
  exit 1
}
