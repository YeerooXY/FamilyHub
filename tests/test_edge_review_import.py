import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('edge_sheet', Path(__file__).resolve().parents[1] / 'scripts/build-edge-review.py')
sheet = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sheet)


class ReviewImport(unittest.TestCase):
    def test_matching_custom_decision_is_preserved_and_stale_audio_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            track = dict(id='abcdefghijk', sha256='a'*64, artist='Artist', title='Song', duration=100,
                         proposed_start=0, proposed_end=99, beginning={'kind':'none','window_limited':False},
                         ending={'kind':'quiet fade','window_limited':False})
            (root/'results.json').write_text(json.dumps({'detector':'edge-rms-v1','tracks':[track]}))
            decision = dict(id=track['id'], sha256=track['sha256'], start=2, end=95, decision='custom', notes='check ending')
            export = root/'decisions.json'
            export.write_text(json.dumps({'detector':'edge-rms-v1','decisions':[decision]}))
            sheet.build(root, export)
            page = (root/'index.html').read_text(encoding='utf-8')
            self.assertIn('"notes": "check ending"', page)
            self.assertIn('custom,2,95,check ending', (root/'review.csv').read_text(encoding='utf-8-sig'))
            decision['sha256'] = 'b'*64
            export.write_text(json.dumps({'detector':'edge-rms-v1','decisions':[decision]}))
            with self.assertRaises(ValueError):
                sheet.build(root, export)
            decision['sha256'] = track['sha256']
            decision['end'] = 101
            export.write_text(json.dumps({'detector':'edge-rms-v1','decisions':[decision]}))
            with self.assertRaises(ValueError):
                sheet.build(root, export)

    def test_spreadsheet_formulas_are_escaped(self):
        self.assertEqual(sheet.spreadsheet_text('=1+1'), "'=1+1")
        self.assertEqual(sheet.spreadsheet_text('Artist'), 'Artist')
