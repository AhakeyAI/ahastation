"""Read the same verified Codex interval used by Station's TypeScript runtime."""
import json
import re
import sys
from pathlib import Path


def parse_version(value):
    if not isinstance(value, str) or not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', value):
        return None
    parts = tuple(int(part) for part in value.split('.'))
    return parts if all(part <= 9007199254740991 for part in parts) else None


def validate_contract(value):
    if not isinstance(value, dict) or set(value) != {'schemaVersion', 'bundled', 'min', 'maxExclusive'}:
        raise ValueError('Invalid Codex runtime contract')
    minimum, maximum, bundled = (parse_version(value[key]) for key in ('min', 'maxExclusive', 'bundled'))
    if type(value['schemaVersion']) is not int or value['schemaVersion'] != 1 or not minimum or not maximum or not bundled \
            or minimum >= maximum or not minimum <= bundled < maximum:
        raise ValueError('Invalid Codex runtime contract')
    return dict(value)


def load_contract(path=None):
    if path is None:
        if getattr(sys, 'frozen', False):
            path = Path(sys._MEIPASS) / 'contracts/runtime/codex.json'
        else:
            module = Path(__file__).resolve()
            exported = module.parent.parent / 'contracts/runtime/codex.json'
            path = exported if exported.is_file() else module.parents[3] / 'contracts/runtime/codex.json'
    return validate_contract(json.loads(Path(path).read_text(encoding='utf-8')))


CODEX_RUNTIME = load_contract()


def is_supported(version):
    parsed = parse_version(version)
    return parsed is not None and parse_version(CODEX_RUNTIME['min']) <= parsed < parse_version(CODEX_RUNTIME['maxExclusive'])
