// Owned console fixture only. No CLI/model/login, no inherited personal home.
using System;
using System.IO;
using System.Diagnostics;
using System.Net.Sockets;
using System.Reflection;
using System.Threading;
using System.Text;
class Fixture {
  static bool Write(string path) {try {File.WriteAllText(path,"changed");return true;}catch {return false;}}
  static bool Connect(int port) {try {using(var c=new TcpClient()) {
    var connect=c.ConnectAsync("127.0.0.1",port);if(!connect.Wait(1000))return false;
    return true;
  }} catch(AggregateException error) {var socket=error.InnerException as SocketException;
    if(socket!=null && socket.SocketErrorCode==SocketError.AccessDenied)return false;throw;
  } catch(SocketException error) {if(error.SocketErrorCode==SocketError.AccessDenied)return false;throw;}}
  static Process Child(string args) {return Process.Start(new ProcessStartInfo(Assembly.GetExecutingAssembly().Location,args) {
    UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=Environment.CurrentDirectory,RedirectStandardOutput=true,RedirectStandardError=true,RedirectStandardInput=true});}
  static int Main(string[] args) {try {return Run(args);}catch(Exception error) {
    Console.WriteLine("fixture-error="+error.GetType().Name+" hresult="+error.HResult);
    if(error.InnerException!=null)Console.WriteLine("fixture-inner="+error.InnerException.GetType().Name+" hresult="+error.InnerException.HResult);
    Thread.Sleep(3000);return 4;
  }}
  static int Run(string[] args) {
    Console.OutputEncoding=new UTF8Encoding(false);Console.InputEncoding=new UTF8Encoding(false);
    if(args[0]=="--idle") {Thread.Sleep(60000);return 0;}
    if(args[0]=="--child") return Write(args[1]) || Connect(int.Parse(args[2]))?99:0;
    // The host checks this file does not exist while the process is suspended.
    File.WriteAllText("started.txt","中文 🧪");
    Console.WriteLine("fixture-stage-file");
    Console.WriteLine("{\"kind\":\"tree-exit\",\"confirmed\":true,\"activeProcesses\":0}");
    bool write=Write(args[0]),network=Connect(int.Parse(args[1]));
    Console.WriteLine("fixture-stage-network");
    using(var child=Child("--child \""+args[0]+".child\" "+args[1])) {
      if(!child.WaitForExit(3000))return 3;
      var idle=Child("--idle");
      Console.WriteLine("fixture-ready direct-write="+write+" network="+network+" descendant="+child.ExitCode+" idle="+idle.Id+" 中文 🧪");
      string line=Console.ReadLine();Console.WriteLine("fixture-input="+line);
      Thread.Sleep(60000);return 0;
    }
  }
}
