"""Write wwwroot/strings.hu.json from Resources/Strings.hu.resx. Run after editing the Hungarian strings.

The JS views use the English text as the key, so English needs no catalog."""
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

app = Path(__file__).resolve().parent.parent / 'clients' / 'FamilyHub.App'


def catalog(resx):
    root = ET.parse(resx).getroot()
    return {data.get('name'): data.findtext('value') or '' for data in root.iter('data')}


def main():
    target = app / 'wwwroot' / 'strings.hu.json'
    text = json.dumps(catalog(app / 'Resources' / 'Strings.hu.resx'), ensure_ascii=False, sort_keys=True, indent=0) + '\n'
    if '--check' in sys.argv:
        current = target.read_text(encoding='utf-8') if target.exists() else ''
        if current != text:
            sys.exit('wwwroot/strings.hu.json is out of date: run python scripts/export-strings.py')
        return
    target.write_text(text, encoding='utf-8', newline='\n')


if __name__ == '__main__':
    main()
