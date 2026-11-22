using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
public class App : Application {
    public override void Initialize() { }
    public override void OnFrameworkInitializationCompleted() {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime d) d.MainWindow = new Window { Title = "Epson iProjection (Linux port)" };
        base.OnFrameworkInitializationCompleted();
    }
}
