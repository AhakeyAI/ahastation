"""Production tray/window lifecycle with injected native-backend failures.

No Tk desktop is opened; these are not native GUI/tray acceptance results.
"""
import queue
import sys
import threading
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'device'))
from bridge_app import TrayWindow

class Window:
    def __init__(self): self.actions=[]
    def withdraw(self): self.actions.append('withdraw')
    def iconify(self): self.actions.append('iconify')

class Tray:
    def __init__(self,fail=False,show_fails=False):
        self.fail=fail; self.show_fails=show_fails; self.stopped=0; self.setup=None
    def run_detached(self,setup):
        self.setup=setup
        if self.fail: raise RuntimeError('Injected tray backend startup failure')
    def stop(self): self.stopped+=1
    @property
    def visible(self): return False
    @visible.setter
    def visible(self,value):
        if self.show_fails: raise RuntimeError('Injected icon show failure')

class TrayWindowTest(unittest.TestCase):
    def create(self):
        window=Window(); errors=[]; return window,errors,TrayWindow(window,errors.append)

    def test_failed_start_close_and_background_minimize_instead_of_hide(self):
        for event in ('close','background'):
            with self.subTest(event=event):
                window,errors,lifecycle=self.create(); tray=Tray(fail=True)
                lifecycle.start(tray)
                self.assertIsNone(lifecycle.tray); self.assertFalse(lifecycle.started)
                self.assertEqual(tray.stopped,1); self.assertIn('任务栏',errors[0])
                lifecycle.hide()  # Same production callback for close and background startup.
                self.assertEqual(window.actions,['iconify'])
                tray.setup(tray); lifecycle.poll()  # A delayed setup cannot resurrect a failed icon.
                self.assertFalse(lifecycle.started)
                lifecycle.hide(); self.assertEqual(window.actions,['iconify','iconify'])

    def test_created_tray_is_not_ready_and_visible_ready_tray_can_hide(self):
        window,errors,lifecycle=self.create(); tray=Tray(); lifecycle.start(tray)
        lifecycle.hide(); self.assertEqual(window.actions,['iconify'])
        tray.setup(tray); lifecycle.hide()
        self.assertTrue(lifecycle.started); self.assertEqual(window.actions,['iconify','withdraw'])
        lifecycle.stop(); self.assertEqual(tray.stopped,1); self.assertFalse(errors)

    def test_show_failure_keeps_error_and_minimizes(self):
        window,errors,lifecycle=self.create(); tray=Tray(show_fails=True)
        lifecycle.start(tray); tray.setup(tray); lifecycle.poll(); lifecycle.hide()
        self.assertIsNone(lifecycle.tray); self.assertEqual(tray.stopped,1)
        self.assertEqual(window.actions,['iconify']); self.assertEqual(len(errors),1)

    def test_partial_pystray_setup_thread_is_released_on_failure(self):
        window,errors,lifecycle=self.create(); tray=Tray(fail=True)
        # Pinned pystray starts this thread before invoking _run_detached.
        tray._Icon__queue=queue.Queue(); tray._running=False
        tray._setup_thread=threading.Thread(target=lambda: (tray._Icon__queue.get(),tray.setup(tray)),daemon=True)
        tray._setup_thread.start()
        lifecycle.start(tray); tray._setup_thread.join(1)
        self.assertFalse(tray._setup_thread.is_alive()); self.assertFalse(lifecycle.started)
        lifecycle.hide(); self.assertEqual(window.actions,['iconify']); self.assertTrue(errors)

if __name__=='__main__': unittest.main()
