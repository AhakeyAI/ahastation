// Headless walkthrough of the B07 prototype: click every meeting-layout
// control, assert DOM state, capture screenshots. Usage:
//   electron main.cjs <prototype.html> <outDir>
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const [file, outDir] = process.argv.slice(-2);
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { offscreen: true } });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  await win.loadFile(file);
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => {
    await new Promise((r) => setTimeout(r, 250));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
  };
  const state = () => js(`({
    tiles: document.querySelectorAll('.tiles .tile').length,
    tilesCollapsed: !!document.querySelector('.tiles-collapsed'),
    drawer: !!document.querySelector('.drawer'),
    drawerTab: document.querySelector('.drawer [data-tab][aria-pressed="true"]')?.textContent ?? null,
    full: !!document.querySelector('.meet.full'),
    stage: !!document.querySelector('.shared .board'),
    toolbar: [...document.querySelectorAll('.toolbar .tb')].map(b => b.textContent.trim()),
    title: document.querySelector('#vtitle')?.textContent,
  })`);
  const click = (sel) => js(`document.querySelector(${JSON.stringify(sel)})?.click(), true`);
  const results = [];
  const check = async (step, expect) => {
    const s = await state();
    const fails = Object.entries(expect).filter(([k, v]) => JSON.stringify(s[k]) !== JSON.stringify(v));
    results.push({ step, ok: fails.length === 0, fails: fails.map(([k, v]) => `${k}: want ${JSON.stringify(v)} got ${JSON.stringify(s[k])}`), state: s });
  };

  await check('1 default: meeting with tiles on top, stage below, chat closed', { title: '会议', tiles: 5, tilesCollapsed: false, drawer: false, full: false, stage: true });
  await shot('1-default');
  await click('#tChat'); await check('2 open chat (会议对话)', { drawer: true, drawerTab: '会议对话' }); await shot('2-chat');
  await click('[data-tab="group"]'); await check('3 switch to 群聊 tab', { drawer: true, drawerTab: '群聊 · 全部项目' }); await shot('3-group');
  await click('#chatClose'); await check('4 collapse chat', { drawer: false });
  await click('#tTiles'); await check('5 collapse participant tiles', { tilesCollapsed: true, tiles: 0 }); await shot('5-tiles-collapsed');
  await click('#tilesOpen2'); await check('6 expand tiles again', { tilesCollapsed: false, tiles: 5 });
  await click('#tGroup'); await check('7 open 群聊 from toolbar', { drawer: true, drawerTab: '群聊 · 全部项目' });
  await click('#tFull'); await check('8 fullscreen stage hides tiles and chat', { full: true, tiles: 0, drawer: false, stage: true }); await shot('8-fullscreen');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })), true`);
  await check('9 Esc exits fullscreen, chat state restored', { full: false, tiles: 5, drawer: true });
  // Voice key: short press toggles recording, tile shows 录音中, stage locked.
  await js(`(() => { const b = document.querySelector('#ptt'); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); return true; })()`);
  await new Promise((r) => setTimeout(r, 100));
  const rec = await js(`({ locked: !!document.querySelector('.shared.locked'), meTag: document.querySelector('.tiles .tile .st')?.textContent ?? null })`);
  results.push({ step: '10 short press starts recording: stage locked, my tile shows 录音中', ok: rec.locked && rec.meTag === '录音中', state: rec });
  await shot('10-recording');
  // Narrow (phone) width
  win.setSize(400, 860); await new Promise((r) => setTimeout(r, 300));
  const overflow = await js(`document.documentElement.scrollWidth > window.innerWidth + 1`);
  results.push({ step: '11 phone width has no horizontal page scroll', ok: !overflow, state: { overflow } });
  await shot('11-phone');

  fs.writeFileSync(path.join(outDir, 'walkthrough.json'), JSON.stringify({ results, consoleErrors: errors }, null, 2));
  console.log(results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.step}${r.fails?.length ? ' — ' + r.fails.join('; ') : ''}`).join('\n'));
  console.log(`console errors: ${errors.length}`);
  app.quit();
});
