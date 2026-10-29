import json
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'device'))
from codex_runtime import CODEX_RUNTIME, is_supported, load_contract, validate_contract


class CodexRuntimeTest(unittest.TestCase):
    def test_verified_stable_interval(self):
        for version in ('0.156.1', '0.156.2', '0.156.999'):
            self.assertTrue(is_supported(version), version)
        for version in (None, '', '0.156.0', '0.157.0', '0.164.0', '0.156.1-beta.1', '0.156.1+build',
                        '00.156.1', '0.156', '0.15\u0666.1', '0.156.1\u0660', '9007199254740992.0.0'):
            self.assertFalse(is_supported(version), version)

    def test_contract_missing_malformed_and_invalid_fail_closed(self):
        with tempfile.TemporaryDirectory(prefix='codex-contract-') as directory:
            path = Path(directory) / 'codex.json'
            with self.assertRaises(FileNotFoundError):
                load_contract(path)
            path.write_text('{', encoding='utf-8')
            with self.assertRaises(json.JSONDecodeError):
                load_contract(path)
            for patch in ({'schemaVersion': True}, {'bundled': '0.164.0'}, {'min': CODEX_RUNTIME['maxExclusive']},
                          {'maxExclusive': '9007199254740992.0.0'}, {'bundled': '0.156.1-beta.1'}, {'extra': True}):
                with self.subTest(patch=patch), self.assertRaises(ValueError):
                    validate_contract({**CODEX_RUNTIME, **patch})

    def test_frozen_receiver_uses_its_own_contract_and_never_source_fallback(self):
        with tempfile.TemporaryDirectory(prefix='codex-frozen-contract-') as directory:
            with patch.object(sys, 'frozen', True, create=True), patch.object(sys, '_MEIPASS', directory, create=True):
                with self.assertRaises(FileNotFoundError):
                    load_contract()
                contract = Path(directory) / 'contracts/runtime/codex.json'
                contract.parent.mkdir(parents=True)
                contract.write_text(json.dumps(CODEX_RUNTIME), encoding='utf-8')
                self.assertEqual(load_contract(), CODEX_RUNTIME)
                contract.write_text('{', encoding='utf-8')
                with self.assertRaises(json.JSONDecodeError):
                    load_contract()


if __name__ == '__main__':
    unittest.main()
