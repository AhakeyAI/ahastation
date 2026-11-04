"""Read the same wire fixture file as TypeScript; never starts a Hub."""
import json
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'device'))
from collaboration_store import check
from fastapi import HTTPException
results=[]
for case in json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')):
    try:check(case['value']);results.append(True)
    except HTTPException:results.append(False)
print(json.dumps(results))
