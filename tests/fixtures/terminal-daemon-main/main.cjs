// Isolated real Electron main. Never imports the production app or user config.
const { app } = require('electron');
const { writeFileSync, existsSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
app.disableHardwareAcceleration();
app.setPath('userData', process.env.AHA_D1_MAIN_DATA);
app.whenReady().then(async () => {
  const { ensureTerminalDaemon } = await import(process.env.AHA_D1_LAUNCHER);
  const client = await ensureTerminalDaemon({ dataDir: process.env.AHA_D1_DATA,
    runtimePath: process.env.AHA_D1_RUNTIME, entryPath: process.env.AHA_D1_ENTRY });
  const sessions = [];
  for (let i = 0; i < 2; i++) {
    const terminalId = randomUUID();
    const requestId = randomUUID();
    const launch = { terminalId, file: process.env.AHA_D1_SHELL, args: ['-NoProfile', '-File', process.env.AHA_D1_PROBE, String(i)], cwd: process.env.AHA_D1_DATA,
      env: Object.fromEntries(['SystemRoot', 'windir', 'ComSpec', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'AHA_D1_DATA']
        .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]])),
      cols: 100, rows: 30, label: `offline-${i}` };
    const session = await client.spawn(requestId, launch);
    await client.attach(terminalId);
    sessions.push({ ...session, requestId, launch });
  }
  writeFileSync(process.env.AHA_D1_READY, JSON.stringify({ mainPid: process.pid, isPackaged: app.isPackaged,
    versions: process.versions, descriptor: client.descriptor, sessions }));
  const timer = setInterval(() => {
    if (existsSync(process.env.AHA_D1_QUIT)) { clearInterval(timer); client.disconnect(); app.quit(); }
  }, 100);
}).catch(error => { console.error(error); app.exit(1); });
