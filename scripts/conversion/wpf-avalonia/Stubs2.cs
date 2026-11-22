// Second-wave source-level WPF API adaptation (POA-generated declarations).
global using RoutedEventArgs = PoaCompat.RoutedEventArgs;
global using RoutedEventHandler = PoaCompat.RoutedEventHandler;
global using KeyEventHandler = PoaCompat.KeyEventHandler;
global using MouseButtonEventHandler = PoaCompat.MouseButtonEventHandler;
global using ButtonBase = PoaCompat.ButtonBase;
global using Selector = PoaCompat.Selector;
global using WindowInteropHelper = PoaCompat.WindowInteropHelper;
global using Application = PoaCompat.Application;
global using PasswordBox = PoaCompat.PasswordBox;
namespace PoaCompat
{
    public class RoutedEventArgs : Avalonia.Interactivity.RoutedEventArgs { public object? OriginalSource; }
    public delegate void RoutedEventHandler(object sender, RoutedEventArgs e);
    public delegate void KeyEventHandler(object sender, RoutedEventArgs e);
    public delegate void MouseButtonEventHandler(object sender, RoutedEventArgs e);
    public class ButtonBase : Avalonia.Controls.Button { }
    public class Selector : Avalonia.Controls.ListBox { }
    public class WindowInteropHelper {
        public WindowInteropHelper(object w) { }
        public IntPtr Handle => IntPtr.Zero;
    }
    public class Application : Avalonia.Application {
        public Avalonia.Controls.Window? MainWindow { get; set; }
        public static void LoadComponent(object target) { }
    }
    public class PasswordBox : Avalonia.Controls.TextBox { public string Password { get; set; } = ""; }
}
