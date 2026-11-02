"""
打一个可直接加载的干净包（不含 tests / tools），输出到 dist/。

用法: python tools/package.py
"""

import json
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")

INCLUDE_FILES = ["manifest.json", "README.md", "dist/ui-main.png", "dist/ui-settings.png"]
INCLUDE_DIRS = ["src", "icons", "vendor"]
EXCLUDE_NAMES = {".DS_Store", "Thumbs.db"}


def collect():
    items = []
    for name in INCLUDE_FILES:
        full = os.path.join(ROOT, name)
        if os.path.isfile(full):
            items.append((full, name))
    for d in INCLUDE_DIRS:
        base = os.path.join(ROOT, d)
        for dirpath, _dirnames, filenames in os.walk(base):
            for fn in filenames:
                if fn in EXCLUDE_NAMES:
                    continue
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, ROOT).replace("\\", "/")
                items.append((full, rel))
    return sorted(items, key=lambda x: x[1])


def main():
    with open(os.path.join(ROOT, "manifest.json"), "r", encoding="utf-8") as fp:
        version = json.load(fp)["version"]

    os.makedirs(DIST, exist_ok=True)
    out = os.path.join(DIST, "edge-page-copilot-%s.zip" % version)

    items = collect()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for full, rel in items:
            zf.write(full, rel)

    size = os.path.getsize(out)
    print("wrote %s" % out)
    print("  %d 个文件, %.1f KB" % (len(items), size / 1024.0))
    for _full, rel in items:
        print("  + " + rel)


if __name__ == "__main__":
    main()
