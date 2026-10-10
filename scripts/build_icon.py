"""Render the Orbit IDE icon in every form the app needs.

    python3 scripts/build_icon.py

The mark is a terminal window among the stars: a screen with its prompt and
cursor, in bright cyan and violet on Orbit IDE's dark editor tile, a scatter
of stars round it in place of the family's orbit. The geometry and colours live in
``scripts/orbitmark.swift``, the family renderer every Orbit app shares. This
compiles it with the Xcode toolchain's ``swiftc`` (no Xcode licence needed),
renders each size, and writes:

* src-tauri/icons/*.png, icon.icns, icon.ico, icon.png (the macOS set
  ``cargo tauri build`` bundles: the mark on the dark macOS icon tile)
* src-tauri/icons/orbit-ide.svg (the macOS tile at 1024)
* ui/mark.svg (the in-app mark, the dark tile with the bolder small-size
  mark) and ui/logo.svg (the bare mark in its own colours)

Edit the geometry and re-run; never hand-edit the outputs.
"""

from __future__ import annotations

import pathlib
import shutil
import struct
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "scripts" / "orbitmark.swift"
ICONS = ROOT / "src-tauri" / "icons"
UI = ROOT / "ui"

TOOLCHAIN = pathlib.Path("/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin")
SDK = pathlib.Path("/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk")

MARK = "ide"


def compile_renderer(workdir: pathlib.Path) -> pathlib.Path:
    swiftc = TOOLCHAIN / "swiftc"
    if not swiftc.exists():
        swiftc = pathlib.Path(shutil.which("swiftc") or "swiftc")
    binary = workdir / "orbitmark"
    command = [str(swiftc), "-O", "-o", str(binary), str(SOURCE)]
    if SDK.exists():
        command[1:1] = ["-sdk", str(SDK)]
    subprocess.run(command, check=True)
    return binary


def detail(size: int) -> tuple[str, ...]:
    """The object alone at 16 px, the bolder mark up to 48 px, the full one above."""
    return ("tiny",) if size <= 16 else ("small",) if size <= 48 else ()


def render(binary: pathlib.Path, out: pathlib.Path, size: int, layout: str, *flags: str) -> bytes:
    subprocess.run([str(binary), "png", MARK, str(out), str(size), layout, *flags], check=True)
    return out.read_bytes()


def svg(binary: pathlib.Path, layout: str, size: int, *flags: str) -> bytes:
    return subprocess.run([str(binary), "svg", MARK, layout, str(size), *flags], check=True, capture_output=True).stdout


def write(path: pathlib.Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    print(f"  {path.relative_to(ROOT)}  {len(data):,} bytes")


def write_icns(path: pathlib.Path, images: dict[str, bytes]) -> None:
    body = b"".join(code.encode("ascii") + struct.pack(">I", 8 + len(blob)) + blob for code, blob in images.items())
    write(path, b"icns" + struct.pack(">I", 8 + len(body)) + body)


def write_ico(path: pathlib.Path, images: list[tuple[int, bytes]]) -> None:
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries, blobs = b"", b""
    for size, blob in images:
        dim = size if size < 256 else 0
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
        blobs += blob
    write(path, header + entries + blobs)


def main() -> int:
    print("Orbit IDE icons")
    with tempfile.TemporaryDirectory() as tmp:
        work = pathlib.Path(tmp)
        binary = compile_renderer(work)
        png = work / "out.png"
        mac = {size: render(binary, png, size, "mac", *detail(size)) for size in (16, 32, 48, 64, 128, 256, 512, 1024)}
        for size, name in ((32, "32x32.png"), (64, "64x64.png"), (128, "128x128.png"), (256, "128x128@2x.png")):
            write(ICONS / name, mac[size])
        write(ICONS / "icon.png", mac[1024])
        write_icns(ICONS / "icon.icns", {
            "ic11": mac[32], "ic12": mac[64], "ic07": mac[128], "ic13": mac[256], "ic09": mac[512], "ic10": mac[1024],
        })
        write_ico(ICONS / "icon.ico", [(s, mac[s]) for s in (16, 32, 48, 64, 128, 256)])
        write(ICONS / "orbit-ide.svg", svg(binary, "mac", 1024))
        write(UI / "mark.svg", svg(binary, "tile", 64, "small"))
        write(UI / "logo.svg", svg(binary, "colour", 64))
    return 0


if __name__ == "__main__":
    sys.exit(main())
