using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;

class DpapiProtect {
  static int Main(string[] args) {
    if (args.Length != 1) {
      Console.Error.WriteLine("usage: DpapiProtect <user-data-dir>");
      return 2;
    }
    const string sentinel = "ahastation-dpapi-smoke-not-a-real-key";
    var ciphertext = Convert.ToBase64String(ProtectedData.Protect(
      Encoding.UTF8.GetBytes(sentinel), null, DataProtectionScope.CurrentUser));
    Directory.CreateDirectory(args[0]);
    var json = "{\n"
      + "  \"anthropicApiKeyEnc\": \"" + ciphertext + "\",\n"
      + "  \"backendAuth\": [\n"
      + "    { \"backendId\": \"codex\", \"authMode\": \"apikey\", \"apiKeyEnc\": \"" + ciphertext + "\" }\n"
      + "  ]\n"
      + "}\n";
    File.WriteAllText(Path.Combine(args[0], "settings.json"), json, new UTF8Encoding(false));
    Console.Write("{\"dpapi\":\"ProtectedData.CurrentUser\",\"encrypted\":true}");
    return 0;
  }
}
