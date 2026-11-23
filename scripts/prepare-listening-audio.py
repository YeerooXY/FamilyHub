"""Prepare and verify finished audio on the server; originals remain unchanged."""
import argparse
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from music_web import load_intake
from music_web.finished_audio import FinishedAudio, prepare_record
from music_web.listening_versions import ListeningVersions


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--source-id", action="append", default=[])
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    workspace, library = config["WORKSPACE"], config["LIBRARY"]
    intake = load_intake(config["CLI_PATH"])
    store = FinishedAudio(workspace, intake)
    editions = ListeningVersions(workspace, intake, state=config)
    results = []
    for item in sorted(Path(workspace).glob("yt-*")):
        source_id = item.name[3:14]
        if args.source_id and source_id not in args.source_id:
            continue
        try:
            _, manifest, _ = intake.load_item(str(item))
            record = manifest.get("import")
            if not record or manifest.get("edit"):
                continue
            row, path = prepare_record(store, editions, library, str(item), manifest)
            result = {"id": source_id, "title": record["title"], "state": "ready", **row}
        except Exception as error:
            # Exception text from acquisition helpers can include paths or URLs.
            result = {"id": source_id, "state": "error", "error_type": type(error).__name__}
        results.append(result)
        temporary = args.report.with_suffix(".tmp")
        temporary.write_text(json.dumps(results, indent=2) + "\n")
        os.replace(temporary, args.report)
        print(json.dumps(result), flush=True)
    if any(row["state"] == "error" for row in results):
        sys.exit(1)


if __name__ == "__main__":
    main()
