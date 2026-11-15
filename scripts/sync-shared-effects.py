"""Copy or verify canonical shared effects assets used by the native app."""
import argparse
import hashlib
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Verify assets without writing")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    source = root / "packages/paddock-effects"
    output = root / "clients/FamilyHub.App/wwwroot"
    changed = []
    for extension in ("css", "js"):
        data = (source / ("effects." + extension)).read_bytes()
        target = output / ("paddock-theme." + extension)
        if args.check:
            if not target.exists() or target.read_bytes() != data:
                changed.append(target.name)
        else:
            target.write_bytes(data)
        print(f"{target.name} sha256={hashlib.sha256(data).hexdigest()}")
    if changed:
        parser.error("Shared effects assets differ: " + ", ".join(changed))
    print("Shared effects assets match." if args.check else "Shared effects assets copied.")


if __name__ == "__main__":
    main()
