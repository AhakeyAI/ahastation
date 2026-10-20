"""Local-only project authorization. Hub options cannot widen these roots."""
from pathlib import Path
import os

def authorized_cwd(cwd, policy):
    if policy is None: return Path(cwd)  # Explicit legacy configuration keeps its behavior.
    if not isinstance(policy,dict) or policy.get('confirmed') is not True:
        raise ValueError('Confirm project authorization on this computer first')
    roots=policy.get('roots',[])
    if not isinstance(roots,list) or not roots: raise ValueError('No project roots are authorized')
    actual=Path(cwd).resolve(strict=True)
    if not actual.is_dir(): raise ValueError('Selected project directory does not exist')
    for raw in roots:
        root=Path(raw).resolve(strict=True)
        try:
            if root.is_dir() and any(parent.samefile(root) for parent in (actual,*actual.parents)): return actual
        except ValueError: pass
    raise ValueError('Selected project is outside locally authorized roots (including symlink targets)')
