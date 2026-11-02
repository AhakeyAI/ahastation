"""Same engine in source and Python-free Bridge packages."""
import sys
from pathlib import Path

def python_command(script):
    if getattr(sys,'frozen',False):
        return [sys.executable,'--component',Path(script).stem]
    return [sys.executable,str(script)]
