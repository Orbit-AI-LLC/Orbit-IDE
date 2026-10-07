"""Write orbit-update.json, the file Orbit Mission Control reads to offer a release as an update.

    python3 .github/scripts/orbit_update_manifest.py artifacts \\
        --version 0.1.0-build.13 --build 13 --commit "$GITHUB_SHA"

Every ``<asset>.sig`` in the folder is the signature of ``<asset>`` (the Tauri
CLI writes them next to each update bundle; the Mac workflow writes Sparkle's
the same way). They go into the manifest and are removed, so the release
carries each signature once, where Mission Control reads it. With no
signatures (the signing secrets are not set) no manifest is written, and
Mission Control passes the release over: installed apps are only ever offered
builds they can verify.

The same script is in every Orbit repository with a desktop app; keep them in step.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("folder", type=Path, help="the release's assets")
    parser.add_argument("--version", required=True, help="the version stamped into the build")
    parser.add_argument("--build", required=True, type=int, help="the workflow's run number")
    parser.add_argument("--commit", default="")
    args = parser.parse_args(argv)

    if not SEMVER.match(args.version):
        parser.error(f"{args.version!r} is not a semantic version")

    signatures = {}
    for sig in sorted(args.folder.glob("*.sig")):
        asset = sig.with_suffix("")
        if not asset.is_file():
            parser.error(f"{sig.name} signs {asset.name}, which is not among the assets")
        signatures[asset.name] = sig.read_text().strip()
        sig.unlink()

    if not signatures:
        print("::warning::No update signatures: this release is not offered as an update. Set the signing secrets.")
        return 0

    manifest = {
        "format": 1,
        "version": args.version,
        "build": args.build,
        "commit": args.commit,
        "signatures": signatures,
    }
    (args.folder / "orbit-update.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"orbit-update.json: {args.version} (build {args.build}) signing {', '.join(signatures)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
