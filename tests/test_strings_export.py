import subprocess
import sys
import unittest
from pathlib import Path


class StringsExport(unittest.TestCase):
    def test_hungarian_catalog_matches_the_resources(self):
        script = Path(__file__).resolve().parent.parent / 'scripts' / 'export-strings.py'
        result = subprocess.run([sys.executable, str(script), '--check'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
