"""The legacy count is read-only and matches projects that have no owner secret."""
import importlib.util
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

WEB = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location('projects_audit', WEB / 'server' / 'projects_audit.py')
projects_audit = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(projects_audit)


def _snap(folder: Path):
    found = []
    for path in sorted(folder.rglob('*')):
        st = path.stat()
        body = path.read_bytes() if path.is_file() else None
        found.append((str(path.relative_to(folder)), st.st_mtime_ns, st.st_size, stat.S_IMODE(st.st_mode), body))
    return found


class LegacyCountTests(unittest.TestCase):
    def test_count_ignores_owned_projects_and_does_not_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            (folder / 'owned.json').write_text('{"name":"Owned","parts":[]}')
            (folder / 'owned.secret').write_text('abc123\n')
            (folder / 'plain.json').write_text('{"name":"Plain","parts":[]}')
            (folder / 'blank.json').write_text('{"name":"Blank","parts":[]}')
            (folder / 'blank.secret').write_text('  \n')
            (folder / 'notes.txt').write_text('leave me')
            before = _snap(folder)
            self.assertEqual(projects_audit.count_legacy(folder), 2)
            proc = subprocess.run(
                [sys.executable, '-m', 'server.projects_audit', '--count-legacy', str(folder)],
                cwd=str(WEB), capture_output=True, text=True,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(proc.stdout.strip(), '2')
            self.assertEqual(proc.stderr, '')
            self.assertEqual(_snap(folder), before)

    def test_missing_directory_is_an_error_and_prints_nothing_to_count(self):
        missing = Path(tempfile.gettempdir()) / 'esp32lab-no-such-projects'
        proc = subprocess.run(
            [sys.executable, '-m', 'server.projects_audit', '--count-legacy', str(missing)],
            cwd=str(WEB), capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stdout, '')
        self.assertIn('not a directory', proc.stderr)
        self.assertFalse(missing.exists())


if __name__ == '__main__':
    unittest.main()
