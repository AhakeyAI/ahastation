using System;
using System.Diagnostics;
using System.IO;
using System.Text;

class SevenZipWrapper {
  static string Quote(string value) {
    return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
  }

  static int Main(string[] args) {
    var start = new ProcessStartInfo {
      FileName = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "7za-real.exe"),
      Arguments = string.Join(" ", Array.ConvertAll(args, Quote)),
      UseShellExecute = false,
      CreateNoWindow = true,
    };
    var process = Process.Start(start);
    process.WaitForExit();
    if (process.ExitCode == 2) {
      foreach (var arg in args) {
        if (!arg.StartsWith("-o", StringComparison.Ordinal)) continue;
        var root = arg.Substring(2).Trim('"');
        var lib = Path.Combine(root, "darwin", "10.12", "lib");
        try {
          File.Copy(Path.Combine(lib, "libcrypto.1.0.0.dylib"), Path.Combine(lib, "libcrypto.dylib"), true);
          File.Copy(Path.Combine(lib, "libssl.1.0.0.dylib"), Path.Combine(lib, "libssl.dylib"), true);
          return 0;
        } catch (Exception error) {
          Console.Error.WriteLine(error.Message);
          return process.ExitCode;
        }
      }
    }
    return process.ExitCode;
  }
}
