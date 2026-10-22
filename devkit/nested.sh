#!/bin/sh
# Boot a nested GNOME desktop, with the extension in it.
#
#   ./devkit/nested.sh
#
# `--devkit` is what GNOME 49 and later have (the old `--nested` is gone).
# It opens a *new desktop in a window* on the current display, with the
# extension from the working tree -- the extension is enabled in dconf, and
# the nested shell reads the same dconf, so it runs the code as it is in the
# tree right now.  No logout needed.
#
# The nested session has a session bus of its own, so that the shell can
# export the services that would otherwise clash with the host session.  The
# applications inside it are ordinary applications of that session: open
# Firefox, or anything else, from the nested desktop.
#
# Everything the session and the extension print goes to the terminal *and*
# to devkit/nested.log, so the log of a run can be looked at afterwards.
set -e

here=$(cd "$(dirname "$0")" && pwd)
log="$here/nested.log"

echo "menubar: the log of the nested session is in $log"

# A session of its own means an accessibility bus of its own, and the
# registry of that bus cannot be started: it is a systemd unit of the user,
# and that unit already belongs to the host session ("Could not activate
# remote peer 'org.a11y.atspi.Registry': unit failed" -- seen in the log).
# Applications in the nested session can register with the host's
# accessibility bus instead: it is only IPC, and its registry already runs.
if [ -z "$AT_SPI_BUS_ADDRESS" ]; then
    AT_SPI_BUS_ADDRESS=$(gdbus call --session --dest org.a11y.Bus \
        --object-path /org/a11y/bus --method org.a11y.Bus.GetAddress 2>/dev/null |
        sed -n "s/^('\(.*\)',)$/\1/p")
    if [ -n "$AT_SPI_BUS_ADDRESS" ]; then
        export AT_SPI_BUS_ADDRESS
        echo "menubar: accessibility bus of the host session: $AT_SPI_BUS_ADDRESS"
    else
        echo "menubar: the host session has no accessibility bus; the nested session will have none either"
    fi
fi

exec dbus-run-session -- gnome-shell --devkit --wayland 2>&1 | tee -a "$log"
