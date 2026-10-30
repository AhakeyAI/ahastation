"""Harmless task-owned process for native capability checks, including frozen builds."""
import time
import sys
time.sleep(.01 if '--quick' in sys.argv else 30)
