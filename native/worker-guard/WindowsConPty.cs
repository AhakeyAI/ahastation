// Offline launch primitive for the existing PtyHost. Not a provider admission
// capability: no model/auth/tool egress or native hook attribution is supplied.
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

partial class WindowsGuard {
  [StructLayout(LayoutKind.Sequential)] struct COORD { public short x,y; }
  [DllImport("kernel32.dll")] static extern int CreatePseudoConsole(COORD size,IntPtr input,IntPtr output,uint flags,out IntPtr console);
  [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr console);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string s,uint revision,out IntPtr descriptor,out uint size);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetSecurityDescriptorSacl(IntPtr descriptor,out bool present,out IntPtr sacl,out bool defaulted);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern uint SetNamedSecurityInfo(string name,int type,uint info,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);

  static void PrivateWritable(string path,SecurityIdentifier sid) {
    DirectorySecurity acl=new DirectorySecurity();acl.SetAccessRuleProtection(true,false);
    var owner=WindowsIdentity.GetCurrent().User;acl.SetOwner(owner);
    acl.AddAccessRule(new FileSystemAccessRule(owner,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
    acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.Modify,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
    Check(!Directory.Exists(path),"terminal-directory-exists");Directory.CreateDirectory(path,acl);
    // Only a newly created isolated directory gets a low mandatory label.
    // Never relabel a user's repository/HOME or relax a global ACL.
    IntPtr descriptor;uint size;
    Check(ConvertStringSecurityDescriptorToSecurityDescriptor("S:(ML;OICI;NW;;;LW)",1,out descriptor,out size),"low-label-descriptor");
    try {bool present,defaulted;IntPtr sacl;
      Check(GetSecurityDescriptorSacl(descriptor,out present,out sacl,out defaulted) && present,"low-label-sacl");
      Check(SetNamedSecurityInfo(path,1,0x10,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,sacl)==0,"low-label");
    } finally {LocalFree(descriptor);}
  }
  // CommandLineToArgvW/CRT quoting, with an explicit image; no cmd or PATH.
  static string QuoteArg(string value) {
    StringBuilder b=new StringBuilder("\"");int slashes=0;
    foreach(char c in value) {if(c=='\\') {slashes++;continue;}
      if(c=='\"') {b.Append('\\',slashes*2+1);b.Append(c);} else {b.Append('\\',slashes);b.Append(c);}slashes=0;}
    b.Append('\\',slashes*2);return b.Append('"').ToString();
  }
  static int TerminalGuardian(Dictionary<string,object> config) {
    string profile="AhaTerminal."+Guid.NewGuid().ToString("N");
    IntPtr sid=IntPtr.Zero,job=IntPtr.Zero,attrs=IntPtr.Zero,capsPtr=IntPtr.Zero,env=IntPtr.Zero,console=IntPtr.Zero;
    IntPtr ir=IntPtr.Zero,iw=IntPtr.Zero,or=IntPtr.Zero,ow=IntPtr.Zero;PI pi=new PI();
    var stop=new ManualResetEventSlim(false);
    var outgoing=new BlockingCollection<OutFrame>(32);var incoming=new BlockingCollection<byte[]>(32);
    int sealedInput=0,resumed=0,outBytes=0,inBytes=0;
    Func<object,OutFrame> emit=value=> {
      string text=Json(value);int bytes=Encoding.UTF8.GetByteCount(text)+1;
      if(Interlocked.Add(ref outBytes,bytes)>2097152) {Interlocked.Add(ref outBytes,-bytes);stop.Set();return null;}
      var frame=new OutFrame {text=text,bytes=bytes};
      try {if(outgoing.TryAdd(frame))return frame;} catch(InvalidOperationException) {}
      Interlocked.Add(ref outBytes,-bytes);stop.Set();return null;
    };
    var writer=new Thread(()=> {try {foreach(var frame in outgoing.GetConsumingEnumerable()) {
      try {Console.WriteLine(frame.text);Console.Out.Flush();frame.written.Set();} finally {Interlocked.Add(ref outBytes,-frame.bytes);}
    }} catch {stop.Set();}});writer.IsBackground=true;writer.Start();
    try {
      var t=(Dictionary<string,object>)config["terminal"];string root=S(config,"directory");
      Check(CreateAppContainerProfile(profile,profile,"Offline ConPTY launch boundary",IntPtr.Zero,0,out sid)==0,"terminal-container");
      string sidText=new SecurityIdentifier(sid).Value;
      string code=Path.Combine(root,"image"),workspace=Path.Combine(root,"workspace"),home=Path.Combine(root,"home");
      Check(!Directory.Exists(code),"terminal-image-exists");PrivateRuntime(code,new SecurityIdentifier(sid));
      PrivateWritable(workspace,new SecurityIdentifier(sid));PrivateWritable(home,new SecurityIdentifier(sid));
      string exe=Path.Combine(code,"cli.exe");
      // Hold the source without write/delete sharing while copying. Verify the
      // staged immutable image, never just the pre-copy path.
      using(var source=new FileStream(S(t,"imagePath"),FileMode.Open,FileAccess.Read,FileShare.Read))
      using(var target=new FileStream(exe,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {source.CopyTo(target);target.Flush(true);}
      using(var algorithm=System.Security.Cryptography.SHA256.Create()) using(var file=File.OpenRead(exe)) {
        Check(BitConverter.ToString(algorithm.ComputeHash(file)).Replace("-","").ToLowerInvariant()==S(t,"sha256"),"terminal-image-mismatch");
      }
      SA sa=new SA {length=Marshal.SizeOf(typeof(SA))}; // no inherited handles
      Check(CreatePipe(out ir,out iw,ref sa,0) && CreatePipe(out or,out ow,ref sa,0),"terminal-pipes");
      Check(CreatePseudoConsole(new COORD {x=100,y=30},ir,ow,0,out console)==0,"pseudoconsole-create");
      IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);attrs=Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(attrs,2,0,ref size),"terminal-attributes");
      CAPS caps=new CAPS {sid=sid};capsPtr=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(CAPS)));Marshal.StructureToPtr(caps,capsPtr,false);
      Check(UpdateProcThreadAttribute(attrs,0,(IntPtr)0x20009,capsPtr,(IntPtr)Marshal.SizeOf(typeof(CAPS)),IntPtr.Zero,IntPtr.Zero),"terminal-capabilities");
      Check(UpdateProcThreadAttribute(attrs,0,(IntPtr)0x20016,console,(IntPtr)IntPtr.Size,IntPtr.Zero,IntPtr.Zero),"terminal-console-attribute");
      job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero,"terminal-job");
      EXT limits=new EXT();limits.basic.flags=0x2000|8;limits.basic.active=16;
      Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(EXT))),"terminal-job-limits");
      string system=Environment.GetEnvironmentVariable("SystemRoot");
      // Do not inherit tokens, proxy bypasses, plugins, personal config or PATH.
      env=Marshal.StringToHGlobalUni("APPDATA="+home+"\0CLAUDE_CONFIG_DIR="+home+"\0CODEX_HOME="+home+"\0HOME="+home+"\0LOCALAPPDATA="+home+"\0SystemRoot="+system+"\0TEMP="+home+"\0TERM=xterm-256color\0TMP="+home+"\0USERPROFILE="+home+"\0windir="+system+"\0\0");
      StringBuilder command=new StringBuilder(QuoteArg(exe));
      foreach(object arg in (System.Collections.IEnumerable)t["argv"]) command.Append(" ").Append(QuoteArg((string)arg));
      // Explicit null standard handles prevent the parent's JSON control
      // handles being copied into the target's process parameters. ConPTY
      // supplies the console; no host control pipe is a CLI output channel.
      SIX si=new SIX {si=new SI {cb=Marshal.SizeOf(typeof(SIX)),flags=0x100},attrs=attrs};
      Check(CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,false,0x00080000|0x400|4,env,workspace,ref si,out pi),"terminal-spawn-suspended");
      Check(AssignProcessToJobObject(job,pi.process),"terminal-job-attach");
      long start,end,k,u;Check(GetProcessTimes(pi.process,out start,out end,out k,out u),"terminal-start-id");
      Check(TokenSid(pi.process)==sidText,"terminal-token");
      bool member;Check(IsProcessInJob(pi.process,job,out member) && member,"terminal-job-identity");string boot=Boot();
      CloseHandle(ir);ir=IntPtr.Zero;CloseHandle(ow);ow=IntPtr.Zero;
      IntPtr heldOutput=or;or=IntPtr.Zero;IntPtr heldInput=iw;iw=IntPtr.Zero;IntPtr heldJob=job;PI heldPi=pi;
      var outputReader=new Thread(()=> {
        try {using(var stream=new FileStream(new SafeFileHandle(heldOutput,true),FileAccess.Read)) {
          byte[] bytes=new byte[4096];int count;
          while((count=stream.Read(bytes,0,bytes.Length))>0) {
            if(Volatile.Read(ref sealedInput)!=0)continue; // drain ConPTY during close
            if(emit(new {kind="terminal-output",pid=heldPi.pid,startId=start.ToString(),bootId=boot,data=Convert.ToBase64String(bytes,0,count)})==null)break;
          }
        }} catch {} finally {stop.Set();}
      });outputReader.IsBackground=true;outputReader.Start();
      var inputWriter=new Thread(()=> {
        try {using(var stream=new FileStream(new SafeFileHandle(heldInput,true),FileAccess.Write)) {
          foreach(byte[] bytes in incoming.GetConsumingEnumerable()) {
            try {if(Volatile.Read(ref sealedInput)!=0)break;stream.Write(bytes,0,bytes.Length);stream.Flush();}
            finally {Interlocked.Add(ref inBytes,-bytes.Length);}
          }
        }} catch {stop.Set();}
      });inputWriter.IsBackground=true;inputWriter.Start();
      // This evidence precedes ANY instruction in the target image. The host
      // may attach IF-2/adopt into PtyHost, then explicitly resume. No input yet.
      emit(new {kind="spawned",pid=pi.pid,startId=start.ToString(),bootId=boot,appContainerSid=sidText,suspended=true,network="none",workspace=workspace,home=home});
      var control=new Thread(()=> {
        try {string line;while((line=Line(Console.In))!=null) {
          var frame=Parse(line);string kind=S(frame,"kind");
          if(kind=="stop" || Volatile.Read(ref sealedInput)!=0)break;
          if(!Current(heldPi,heldJob,sidText,start))break;
          if(kind=="resume") {
            if(Interlocked.CompareExchange(ref resumed,1,0)!=0)break;
            Check(ResumeThread(heldPi.thread)!=0xffffffff,"terminal-resume");
            emit(new {kind="resumed",pid=heldPi.pid,startId=start.ToString(),bootId=boot});
          } else if(kind=="terminal-input" && Volatile.Read(ref resumed)==1) {
            byte[] bytes=Convert.FromBase64String(S(frame,"data"));
            if(bytes.Length>131072 || Interlocked.Add(ref inBytes,bytes.Length)>2097152 || !incoming.TryAdd(bytes))break;
          } else break; // includes input before resume and unknown operations
        }} catch {} finally {stop.Set();}
      });control.IsBackground=true;control.Start();
      // Bound a forgotten suspended launch; no timer/UI can implicitly resume.
      for(int i=0;!stop.Wait(10);i++) {
        if((Volatile.Read(ref resumed)==0 && i>=999) || !Current(pi,job,sidText,start)) {stop.Set();break;}
      }
      Interlocked.Exchange(ref sealedInput,1);incoming.CompleteAdding();
      Check(TerminateJobObject(job,1),"terminal-stop-tree");
      ACCOUNT accounting=new ACCOUNT();bool confirmed=false;
      for(int i=0;i<500;i++) {Check(QueryInformationJobObject(job,1,out accounting,Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero),"terminal-job-accounting");if(accounting.active==0) {confirmed=true;break;}Thread.Sleep(10);}
      var final=emit(new {kind="tree-exit",confirmed=confirmed,activeProcesses=accounting.active,pid=pi.pid,startId=start.ToString(),bootId=boot});
      if(final!=null)final.written.Wait(1000);return confirmed?0:2;
    } catch(Exception error) {
      Interlocked.Exchange(ref sealedInput,1);if(job!=IntPtr.Zero)TerminateJobObject(job,1);
      var final=emit(new {kind="fatal",error=error.Message});if(final!=null)final.written.Wait(1000);return 1;
    } finally {
      Interlocked.Exchange(ref sealedInput,1);incoming.CompleteAdding();
      if(job!=IntPtr.Zero) {TerminateJobObject(job,1);CloseHandle(job);}
      if(pi.process!=IntPtr.Zero) {TerminateProcess(pi.process,1);CloseHandle(pi.process);}if(pi.thread!=IntPtr.Zero)CloseHandle(pi.thread);
      foreach(IntPtr h in new[]{ir,iw,or,ow})if(h!=IntPtr.Zero)CloseHandle(h);
      // ClosePseudoConsole may synchronously drain output. Keep its reader
      // alive and close off the control/reaper path after Job evidence exists.
      if(console!=IntPtr.Zero) {IntPtr held=console;var closer=new Thread(()=>ClosePseudoConsole(held));closer.IsBackground=true;closer.Start();closer.Join(500);}
      if(attrs!=IntPtr.Zero) {DeleteProcThreadAttributeList(attrs);Marshal.FreeHGlobal(attrs);}if(capsPtr!=IntPtr.Zero)Marshal.FreeHGlobal(capsPtr);if(env!=IntPtr.Zero)Marshal.FreeHGlobal(env);
      outgoing.CompleteAdding();if(sid!=IntPtr.Zero)FreeSid(sid);DeleteAppContainerProfile(profile);
    }
  }
}
