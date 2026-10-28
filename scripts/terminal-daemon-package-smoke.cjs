// D1-only unpacked artifact: production files/dependencies/config, with an
// isolated test main instead of starting the user's real app/configuration.
const config = require('../electron-builder.json');
module.exports = {
  ...config,
  directories: { ...config.directories, output: 'release/d1-smoke' },
  electronDist: 'node_modules/electron/dist',
  npmRebuild: false,
  win: { ...config.win, signAndEditExecutable: false },
  files: [...config.files, { from: 'tests/fixtures/terminal-daemon-main', to: 'd1-main', filter: ['**/*'] }],
  extraMetadata: { main: 'd1-main/main.cjs' },
};
