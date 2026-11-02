import { app } from 'electron';
console.log(JSON.stringify({ stage: 'before-ready', electron: process.versions.electron }));
await app.whenReady();
console.log(JSON.stringify({ stage: 'ready', electron: process.versions.electron }));
app.quit();
