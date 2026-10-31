export const macosTaskTestsEnabled =
  process.platform !== 'darwin' || process.env.POCKET_VIBE_MACOS_TASKS_SUPPORTED !== 'false';
