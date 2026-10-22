#!/bin/sh
# Boot a nested GNOME Shell (the "development kit") with this extension
# installed and enabled, and run devkit/smoke.js inside it.
#
#   ./devkit/run.sh
#
# The nested shell gets its own D-Bus session, so it does not disturb the
# running desktop session.  Useful to check that the extension loads and
# activates without touching the live session.
set -e

here=$(cd "$(dirname "$0")" && pwd)
ext=$(dirname "$here")
tmp=$(mktemp -d)

# gnome-extensions pack only picks up the files it knows about, so build the
# bundle ourselves
python3 - "$ext" "$tmp" <<'PY'
import os, sys, zipfile
src, tmp = sys.argv[1], sys.argv[2]
out = os.path.join(tmp, 'menubar@local.shell-extension.zip')
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, _dirs, files in os.walk(src):
        for f in files:
            p = os.path.join(root, f)
            z.write(p, os.path.relpath(p, src))
print(out)
PY

cd "$here"
exec dbus-run-session -- gnome-shell-test-tool --devkit \
    --extension "$tmp/menubar@local.shell-extension.zip" smoke.js
