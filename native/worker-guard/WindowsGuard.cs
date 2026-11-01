// Windows 10+ offline broker boundary. No network capabilities, no workspace
// ACL grant, no shell broker. AppContainer isolates resources; Job owns lifetime.
// Private inherited handles are the only worker endpoint (no TCP/pipe name).
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Security.AccessControl;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

class WindowsGuard {
  static string Json(object value) { return new JavaScriptSerializer { MaxJsonLength = 1048576 }.Serialize(value); }
  static readonly object outputLock = new object();
  static void Emit(object value) { lock(outputLock) { Console.WriteLine(Json(value)); Console.Out.Flush(); } }
  static Dictionary<string,object> Parse(string s) { return new JavaScriptSerializer { MaxJsonLength = 1048576 }.Deserialize<Dictionary<string,object>>(s); }
  class OutFrame { public string text; public int bytes; public ManualResetEventSlim written=new ManualResetEventSlim(false); }
  static string Line(TextReader reader) { StringBuilder b=new StringBuilder(); int c; while((c=reader.Read())!=-1) { if(c==10) return b.ToString(); if(b.Length>=1048576) throw new Exception("frame-too-large"); if(c!=13)b.Append((char)c); } return b.Length==0?null:b.ToString(); }
  static string S(Dictionary<string,object> v, string k) { return (string)v[k]; }
  static void Check(bool ok, string name) { if(!ok) throw new Exception(name + ":" + Marshal.GetLastWin32Error()); }
  [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr descriptor; public int inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI {
    public int cb; public string reserved, desktop, title; public int x,y,xSize,ySize,xCount,yCount,fill,flags;
    public short show, reserved2; public IntPtr reservedPtr, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)] struct SIX { public SI si; public IntPtr attrs; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process, thread; public uint pid, tid; }
  [StructLayout(LayoutKind.Sequential)] struct CAPS { public IntPtr sid, capabilities; public uint count, reserved; }
  [StructLayout(LayoutKind.Sequential)] struct LIMIT {
    public long perProcess, perJob; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct EXT { public LIMIT basic; public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNT { public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated; }
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SA sa,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr h,uint mask,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr p,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr p,uint flags,IntPtr attr,IntPtr value,IntPtr size,IntPtr prev,IntPtr ret);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr p);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SIX si,out PI pi);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr sa,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr h,int cls,ref EXT value,int size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr h,int cls,out ACCOUNT value,int size,IntPtr ret);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr p);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr p,IntPtr job,out bool result);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr h,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr h,uint code);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr h);
  [DllImport("kernel32.dll")] static extern uint SetErrorMode(uint mode);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr h,out long start,out long end,out long kernel,out long user);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h,out uint exit);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr p,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int cls,IntPtr data,int length,out int returned);
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr caps,uint count,out IntPtr sid);
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
  [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls,IntPtr data,int size,out int returned);

  static string Boot() {
    IntPtr p=Marshal.AllocHGlobal(64); try { int n; Check(NtQuerySystemInformation(90,p,64,out n)==0,"boot-identity"); return Marshal.PtrToStructure<Guid>(p).ToString(); } finally { Marshal.FreeHGlobal(p); }
  }
  static string TokenSid(IntPtr process) {
    IntPtr t; Check(OpenProcessToken(process,8,out t),"token-open");
    try { int n; GetTokenInformation(t,31,IntPtr.Zero,0,out n); IntPtr p=Marshal.AllocHGlobal(n);
      try { Check(GetTokenInformation(t,31,p,n,out n),"appcontainer-token"); IntPtr sid=Marshal.ReadIntPtr(p); Check(sid!=IntPtr.Zero,"not-appcontainer"); return new SecurityIdentifier(sid).Value; }
      finally { Marshal.FreeHGlobal(p); }
    } finally { CloseHandle(t); }
  }
  static bool Current(PI pi,IntPtr job,string sid,long start) {
    bool member; uint exit; long actual,e,k,u;
    return GetExitCodeProcess(pi.process,out exit) && exit==259 && IsProcessInJob(pi.process,job,out member) && member
      && GetProcessTimes(pi.process,out actual,out e,out k,out u) && actual==start && TokenSid(pi.process)==sid;
  }
  static void PrivateRuntime(string directory, SecurityIdentifier sid) {
    DirectorySecurity acl=new DirectorySecurity(); acl.SetAccessRuleProtection(true,false);
    SecurityIdentifier owner=WindowsIdentity.GetCurrent().User; acl.SetOwner(owner);
    acl.AddAccessRule(new FileSystemAccessRule(owner,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
    acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.ReadAndExecute,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
    // DACL at creation, no interval with public/runtime write access.
    Directory.CreateDirectory(directory,acl);
  }
  static int Guardian() {
    string profile="AhaWorker."+Guid.NewGuid().ToString("N"); IntPtr sid=IntPtr.Zero,job=IntPtr.Zero,attrs=IntPtr.Zero;
    IntPtr handles=IntPtr.Zero,capsPtr=IntPtr.Zero,environment=IntPtr.Zero,pipeSecurity=IntPtr.Zero; PI pi=new PI();
    IntPtr inputRead=IntPtr.Zero,inputWrite=IntPtr.Zero,outputRead=IntPtr.Zero,outputWrite=IntPtr.Zero;
    var stopping=new ManualResetEventSlim(false);
    var output=new BlockingCollection<OutFrame>(32);
    var input=new BlockingCollection<string>(32);
    int sealedInput=0,inputBytes=0,outputBytes=0,writing=0;
    // The control reader and reaper never write to a pipe. Backpressure can
    // block background writers only; overflow seals the run instead of growing
    // memory or putting stop behind the child that must be stopped.
    Func<object,OutFrame> emit=value=> {
      string text=Json(value);int bytes=Encoding.UTF8.GetByteCount(text)+1;
      if(Interlocked.Add(ref outputBytes,bytes)>2097152) {Interlocked.Add(ref outputBytes,-bytes);stopping.Set();return null;}
      var frame=new OutFrame {text=text,bytes=bytes};
      try {if(output.TryAdd(frame))return frame;} catch(InvalidOperationException) {}
      Interlocked.Add(ref outputBytes,-bytes);stopping.Set();return null;
    };
    Func<object,bool> enqueue=value=> {
      if(Volatile.Read(ref sealedInput)!=0)return false;
      string text=Json(value);int bytes=Encoding.UTF8.GetByteCount(text)+1;
      if(Interlocked.Add(ref inputBytes,bytes)>2097152) {Interlocked.Add(ref inputBytes,-bytes);stopping.Set();return false;}
      try {if(input.TryAdd(text))return true;} catch(InvalidOperationException) {}
      Interlocked.Add(ref inputBytes,-bytes);stopping.Set();return false;
    };
    Thread outputWriter=new Thread(()=> {
      try {foreach(var frame in output.GetConsumingEnumerable()) {
        try {Console.WriteLine(frame.text);Console.Out.Flush();frame.written.Set();}
        finally {Interlocked.Add(ref outputBytes,-frame.bytes);}
      }} catch {stopping.Set();}
    });outputWriter.IsBackground=true;outputWriter.Start();
    try {
      Dictionary<string,object> config=Parse(Line(Console.In)); string root=S(config,"directory");
      Check(CreateAppContainerProfile(profile,profile,"Ephemeral offline worker",IntPtr.Zero,0,out sid)==0,"container-create");
      string sidText=new SecurityIdentifier(sid).Value; string runtime=Path.Combine(root,"runtime"); PrivateRuntime(runtime,new SecurityIdentifier(sid));
      string executable=Path.Combine(runtime,"worker.exe"); File.Copy(Process.GetCurrentProcess().MainModule.FileName,executable,false);
      if(config.ContainsKey("cliPath")) {
        string cli=Path.Combine(runtime,"cli.exe"); File.Copy(S(config,"cliPath"),cli,false);
        using(var algorithm=System.Security.Cryptography.SHA256.Create()) using(var file=File.OpenRead(cli)) {
          string hash=BitConverter.ToString(algorithm.ComputeHash(file)).Replace("-","").ToLowerInvariant();
          Check(hash==S(config,"cliSha256"),"cli-image-mismatch");
        }
        ((Dictionary<string,object>)config["hello"])["cliPath"]=cli;
      }
      var descriptor=new RawSecurityDescriptor("O:"+WindowsIdentity.GetCurrent().User.Value+"D:P(A;;GA;;;"+WindowsIdentity.GetCurrent().User.Value+")(A;;GA;;;SY)");
      byte[] descriptorBytes=new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(descriptorBytes,0); pipeSecurity=Marshal.AllocHGlobal(descriptorBytes.Length); Marshal.Copy(descriptorBytes,0,pipeSecurity,descriptorBytes.Length);
      SA sa=new SA {length=Marshal.SizeOf(typeof(SA)),inherit=1,descriptor=pipeSecurity};
      Check(CreatePipe(out inputRead,out inputWrite,ref sa,0),"input-pipe"); Check(CreatePipe(out outputRead,out outputWrite,ref sa,0),"output-pipe");
      Check(SetHandleInformation(inputWrite,1,0) && SetHandleInformation(outputRead,1,0),"noninherited-host-ends");
      IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size); attrs=Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(attrs,2,0,ref size),"attributes");
      CAPS caps=new CAPS {sid=sid}; capsPtr=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(CAPS))); Marshal.StructureToPtr(caps,capsPtr,false);
      Check(UpdateProcThreadAttribute(attrs,0,(IntPtr)0x20009,capsPtr,(IntPtr)Marshal.SizeOf(typeof(CAPS)),IntPtr.Zero,IntPtr.Zero),"security-capabilities");
      handles=Marshal.AllocHGlobal(IntPtr.Size*2); Marshal.WriteIntPtr(handles,inputRead); Marshal.WriteIntPtr(handles,IntPtr.Size,outputWrite);
      Check(UpdateProcThreadAttribute(attrs,0,(IntPtr)0x20002,handles,(IntPtr)(IntPtr.Size*2),IntPtr.Zero,IntPtr.Zero),"handle-list");
      job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero,"job-create");
      EXT limits=new EXT(); limits.basic.flags=0x2000|8; limits.basic.active=16;
      Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(EXT))),"job-limits");
      SIX si=new SIX {si=new SI {cb=Marshal.SizeOf(typeof(SIX)),flags=0x100,input=inputRead,output=outputWrite,error=outputWrite},attrs=attrs};
      environment=Marshal.StringToHGlobalUni("LOCALAPPDATA="+Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)+"\0SystemRoot="+Environment.GetEnvironmentVariable("SystemRoot")+"\0TEMP="+runtime+"\0TMP="+runtime+"\0windir="+Environment.GetEnvironmentVariable("SystemRoot")+"\0\0");
      Check(CreateProcess(executable,new StringBuilder("\""+executable+"\" --worker"),IntPtr.Zero,IntPtr.Zero,true,0x08000000|0x00080000|0x400|4,environment,runtime,ref si,out pi),"spawn");
      Check(AssignProcessToJobObject(job,pi.process),"job-attach");
      long start,end,kernel,user; Check(GetProcessTimes(pi.process,out start,out end,out kernel,out user),"process-start");
      Check(TokenSid(pi.process)==sidText,"wrong-token"); string boot=Boot();
      CloseHandle(inputRead); inputRead=IntPtr.Zero; CloseHandle(outputWrite); outputWrite=IntPtr.Zero;
      {
        IntPtr heldInput=inputWrite;inputWrite=IntPtr.Zero;
        Thread inputWriter=new Thread(()=> {
          try {using(StreamWriter writer=new StreamWriter(new FileStream(new SafeFileHandle(heldInput,true),FileAccess.Write),new UTF8Encoding(false))) {
            writer.AutoFlush=true;
            foreach(string text in input.GetConsumingEnumerable()) {
              if(Volatile.Read(ref sealedInput)!=0)break;
              try {Interlocked.Exchange(ref writing,1);writer.WriteLine(text);}
              finally {Interlocked.Exchange(ref writing,0);Interlocked.Add(ref inputBytes,-Encoding.UTF8.GetByteCount(text)-1);}
            }
          }} catch {stopping.Set();}
        });inputWriter.IsBackground=true;inputWriter.Start();
        // Secret is delivered through the private inherited descriptor, never argv/env/disk.
        Check(enqueue(config["hello"]),"initial-input-rejected");
        emit(new {kind="spawned",pid=pi.pid,startId=start.ToString(),bootId=boot,appContainerSid=sidText});
        Check(ResumeThread(pi.thread)!=0xffffffff,"resume");
        IntPtr heldJob=job,heldOutput=outputRead; PI heldPi=pi;
        Thread reader=new Thread(()=> {
          try { using(StreamReader child=new StreamReader(new FileStream(new SafeFileHandle(heldOutput,true),FileAccess.Read),new UTF8Encoding(false,true),false)) {
            string line; while((line=Line(child))!=null) {
              if(Volatile.Read(ref sealedInput)!=0 || !Current(heldPi,heldJob,sidText,start))break;
              var message=Parse(line);
              if(message==null)throw new Exception("worker-frame-not-object");
              if(emit(new {kind="request",pid=heldPi.pid,startId=start.ToString(),bootId=boot,message=message})==null)break;
            }
            emit(new {kind="stream-closed"});stopping.Set();
          }} catch {stopping.Set();}
        }); reader.IsBackground=true; reader.Start(); outputRead=IntPtr.Zero;
        Thread controlReader=new Thread(()=> {
          try {string command;while((command=Line(Console.In))!=null) {
            var v=Parse(command);string kind=S(v,"kind");
            if(kind=="stop" || Volatile.Read(ref sealedInput)!=0)break;
            // Host-side transport diagnosis for the isolated saturation test;
            // no child identity/permission/exit assertion is accepted here.
            if(kind=="transport-state") {emit(new {kind="transport-state",writing=Volatile.Read(ref writing),pendingBytes=Volatile.Read(ref inputBytes)});continue;}
            if(kind!="reply" && kind!="input")break;
            if(!Current(heldPi,heldJob,sidText,start) || !enqueue(v["message"]))break;
          }} catch {} finally {stopping.Set();}
        });controlReader.IsBackground=true;controlReader.Start();
        stopping.Wait();
        Interlocked.Exchange(ref sealedInput,1);input.CompleteAdding();
        Check(TerminateJobObject(job,1),"job-terminate");
        ACCOUNT accounting=new ACCOUNT(); bool confirmed=false;
        for(int i=0;i<500;i++) { Check(QueryInformationJobObject(job,1,out accounting,Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero),"job-accounting"); if(accounting.active==0) {confirmed=true;break;} Thread.Sleep(10); }
        var finalFrame=emit(new {kind="tree-exit",confirmed=confirmed,activeProcesses=accounting.active,pid=pi.pid,startId=start.ToString(),bootId=boot});
        // Reaping is already complete. A host that stopped reading gets no
        // confirmation, and can never block the reaper on its diagnostic.
        if(finalFrame!=null)finalFrame.written.Wait(1000);
        return confirmed?0:2;
      }
    } catch(Exception e) {
      Interlocked.Exchange(ref sealedInput,1);if(job!=IntPtr.Zero)TerminateJobObject(job,1);
      var frame=emit(new {kind="fatal",error=e.Message});if(frame!=null)frame.written.Wait(1000);return 1;
    }
    finally {
      Interlocked.Exchange(ref sealedInput,1);input.CompleteAdding();output.CompleteAdding();
      if(job!=IntPtr.Zero) { TerminateJobObject(job,1); CloseHandle(job); }
      if(pi.process!=IntPtr.Zero) { TerminateProcess(pi.process,1); CloseHandle(pi.process); } if(pi.thread!=IntPtr.Zero) CloseHandle(pi.thread);
      foreach(IntPtr h in new[]{inputRead,inputWrite,outputRead,outputWrite}) if(h!=IntPtr.Zero) CloseHandle(h);
      if(attrs!=IntPtr.Zero) { DeleteProcThreadAttributeList(attrs);Marshal.FreeHGlobal(attrs); } if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles); if(capsPtr!=IntPtr.Zero) Marshal.FreeHGlobal(capsPtr); if(environment!=IntPtr.Zero) Marshal.FreeHGlobal(environment);
      if(pipeSecurity!=IntPtr.Zero) Marshal.FreeHGlobal(pipeSecurity); if(sid!=IntPtr.Zero) FreeSid(sid); DeleteAppContainerProfile(profile);
    }
  }
  static bool TryWrite(string path) { try { File.WriteAllText(path,"ESCAPED"); return true; } catch {return false;} }
  static Process IdleChild() {
    // This fixture descendant has no protocol role. It must not consume the
    // parent's inherited stdin or write into the parent's authenticated output.
    var p=Process.Start(new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName,"--idle") {
      UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true});
    p.StandardInput.Close();p.BeginOutputReadLine();p.BeginErrorReadLine();return p;
  }
  static int Worker() {
    var hello=Parse(Line(Console.In)); Emit(new {op="bind",credential=hello["credential"],basis=hello["basis"],sessionId=hello["sessionId"]});
    // No task/probe before host has committed IF-2 and sent the first input.
    string line; while((line=Line(Console.In))!=null) {
      var value=Parse(line);
      if(value.ContainsKey("probePath")) {
        bool wrote=TryWrite(S(value,"probePath"));
        bool network=false; try { using(var client=new System.Net.Sockets.TcpClient()) { var result=client.BeginConnect("127.0.0.1",Convert.ToInt32(value["port"]),null,null); if(result.AsyncWaitHandle.WaitOne(1000)) {client.EndConnect(result);network=true;} } } catch {}
        // A descendant inherits AppContainer restrictions and the non-breakaway Job.
        var p=Process.Start(new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName,"--descendant \""+S(value,"probePath")+".child\"") {UseShellExecute=false,CreateNoWindow=true}); p.WaitForExit();
        Emit(new {op="probe-result",credential=hello["credential"],basis=hello["basis"],directWrite=wrote,network=network,descendantExit=p.ExitCode});
      } else if(value.ContainsKey("probeCli") && hello.ContainsKey("cliPath")) {
        var p=Process.Start(new ProcessStartInfo(S(hello,"cliPath"),"--version") {UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true});
        string version=p.StandardOutput.ReadToEnd(); p.StandardError.ReadToEnd();p.WaitForExit();
        Emit(new {op="cli-version",credential=hello["credential"],basis=hello["basis"],version=version.Trim(),exitCode=p.ExitCode});
      } else if(value.ContainsKey("send")) {
        var wire=(Dictionary<string,object>)value["send"];
        if(!wire.ContainsKey("credential")) wire["credential"]=hello["credential"];
        if(!wire.ContainsKey("basis")) wire["basis"]=hello["basis"];
        Emit(wire);
      }
      else if(value.ContainsKey("idleChild")) {
        var p=IdleChild();
        Emit(new {op="idle-child",credential=hello["credential"],basis=hello["basis"],pid=p.Id});
      } else if(value.ContainsKey("pauseInput")) {
        var p=IdleChild();
        Emit(new {op="input-paused",credential=hello["credential"],basis=hello["basis"],pid=p.Id});
        Thread.Sleep(Timeout.Infinite);
      } else Emit(new {op="response",credential=hello["credential"],basis=hello["basis"],value=value});
    }
    return 0;
  }
  static int Main(string[] args) {
    SetErrorMode(0x8003); // inherited by owned descendants; no WER/UI popups
    Console.InputEncoding=new UTF8Encoding(false,true);Console.OutputEncoding=new UTF8Encoding(false,true);
    if(args.Length>0 && args[0]=="--worker") return Worker();
    if(args.Length>1 && args[0]=="--descendant") return TryWrite(args[1])?99:0;
    if(args.Length>0 && args[0]=="--idle") { Thread.Sleep(60000);return 0; }
    return Guardian();
  }
}
