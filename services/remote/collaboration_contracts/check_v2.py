"""Read the same wire fixtures as TypeScript; never starts a Hub."""
import json
import sys
from pathlib import Path
if hasattr(sys.stdin,'reconfigure'):sys.stdin.reconfigure(encoding='utf-8',errors='strict')
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'device'))
from collaboration_store import check
from fastapi import HTTPException
results=[]
for case in json.load(sys.stdin):
    try:check(case['value']);results.append(True)
    except HTTPException:results.append(False)
print(json.dumps(results))
