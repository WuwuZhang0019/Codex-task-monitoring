// 日期：2026-11-12。E 原生全屏检测夹具；仅显示独立窗口，8 秒后自行退出。
// 无用户数据读取、网络、输入注入或窗口枚举；不属于产品源码。
using System;
using System.Drawing;
using System.Windows.Forms;

internal sealed class FullscreenProbe : Form
{
    private readonly Timer closeTimer;

    internal FullscreenProbe()
    {
        Text = "E fullscreen probe 2026-11-12";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        Bounds = Screen.PrimaryScreen.Bounds;
        TopMost = false;
        ShowInTaskbar = true;
        BackColor = Color.RoyalBlue;
        Opacity = 1.0;
        AllowTransparency = false;

        Label message = new Label();
        message.Dock = DockStyle.Fill;
        message.BackColor = Color.RoyalBlue;
        message.ForeColor = Color.White;
        message.TextAlign = ContentAlignment.MiddleCenter;
        message.Font = new Font(FontFamily.GenericSansSerif, 32.0f);
        message.Text = "E fullscreen probe 2026-11-12";
        Controls.Add(message);

        closeTimer = new Timer();
        closeTimer.Interval = 8000;
        closeTimer.Tick += delegate
        {
            closeTimer.Stop();
            Close();
        };
        Shown += delegate
        {
            Activate();
            closeTimer.Start();
        };
        FormClosed += delegate { closeTimer.Dispose(); };
    }

    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using (FullscreenProbe form = new FullscreenProbe())
        {
            Application.Run(form);
        }
    }
}
