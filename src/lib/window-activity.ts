// window-activity.ts — marks <html data-window-active="false"> while the
// window is in the background (blurred or hidden). styles.css pauses every
// CSS animation under that flag, so pulsing status dots, spinners and the
// speaking aurora stop costing compositor frames when nobody is looking.

export function installWindowActivityFlag(doc: Document = document, win: Window = window): () => void {
  const root = doc.documentElement;
  const update = () => {
    root.dataset.windowActive = doc.visibilityState === 'visible' && doc.hasFocus() ? 'true' : 'false';
  };
  update();
  win.addEventListener('focus', update);
  win.addEventListener('blur', update);
  doc.addEventListener('visibilitychange', update);
  return () => {
    win.removeEventListener('focus', update);
    win.removeEventListener('blur', update);
    doc.removeEventListener('visibilitychange', update);
  };
}
