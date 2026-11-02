"""Regression for Linux /app/device startup, plus real schema loading."""
import json
import shutil
import sys
import tempfile
import unittest
import uuid
from pathlib import Path, PurePosixPath, PureWindowsPath
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'services/remote/device'))
import collaboration_store


class ContractPathTest(unittest.TestCase):
    def test_linux_app_layout_has_only_three_parents(self):
        source = PurePosixPath('/app/device/collaboration_store.py')
        self.assertEqual(len(source.parents), 3)
        with self.assertRaises(IndexError):
            _ = source.parents[3]  # Exact original cloud failure.
        self.assertEqual(collaboration_store.contract_directories(source),
                         [PurePosixPath('/app/contracts/collaboration')])

    def test_windows_shallow_and_repository_layouts(self):
        shallow = PureWindowsPath('C:/app/device/collaboration_store.py')
        self.assertEqual(collaboration_store.contract_directories(shallow),
                         [PureWindowsPath('C:/app/contracts/collaboration')])
        repository = PurePosixPath('/workspace/station/services/remote/device/collaboration_store.py')
        self.assertIn(PurePosixPath('/workspace/station/contracts/collaboration'),
                      collaboration_store.contract_directories(repository))

    def test_minimal_root_layout_does_not_index_past_root(self):
        source = PurePosixPath('/collaboration_store.py')
        self.assertEqual(collaboration_store.contract_directories(source),
                         [PurePosixPath('/contracts/collaboration')])

    def test_real_schemas_load_in_both_layouts(self):
        command = {'protocol': 2, 'requestId': str(uuid.uuid4()), 'action': 'device.register',
                   'payload': {'deviceId': str(uuid.uuid4()), 'config': {
                       'name': 'Cloud startup', 'platform': 'windows',
                       'acceptingTasks': False, 'maxConcurrency': 1, 'agents': []}}}
        for layout in ('device', 'services/remote/device'):
            with self.subTest(layout=layout), tempfile.TemporaryDirectory() as folder:
                directory = Path(folder)
                schemas = directory / 'contracts/collaboration'
                schemas.mkdir(parents=True)
                for name in ('v1.schema.json', 'v2.schema.json'):
                    shutil.copyfile(ROOT / 'contracts/collaboration' / name, schemas / name)
                module_path = directory / layout / 'collaboration_store.py'
                with patch.object(collaboration_store, '__file__', str(module_path)):
                    validator = collaboration_store.contract_validator()
                self.assertTrue(validator.is_valid(command))
                self.assertFalse(validator.is_valid({**command, 'protocol': 1}))

    def test_partial_schema_pair_fails_with_actionable_error(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            schemas = directory / 'contracts/collaboration'
            schemas.mkdir(parents=True)
            shutil.copyfile(ROOT / 'contracts/collaboration/v1.schema.json',
                            schemas / 'v1.schema.json')
            with patch.object(collaboration_store, '__file__',
                              str(directory / 'device/collaboration_store.py')):
                with self.assertRaisesRegex(FileNotFoundError, 'Both collaboration schema files'):
                    collaboration_store.contract_validator()


if __name__ == '__main__':
    unittest.main()
