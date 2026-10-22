#!/bin/sh
# Open a second Firefox, as an ordinary window of this session.
#
#   ./devkit/second-firefox.sh
#
# It is the same Firefox, with your profile, on the same session bus and the
# same accessibility bus -- so it is an ordinary application and the apps
# inside it behave normally.  The extension of the running session sees its
# menus like it sees the ones of any other window.
#
# `--no-remote` is what makes it a second instance: without it Firefox is
# single-instance per profile and would just hand the command line to the
# Firefox that is already running.
set -e

profile="$HOME/.mozilla/firefox/$(sed -n 's/^Default=//p' "$HOME/.mozilla/firefox/profiles.ini" | head -1)"
if [ ! -d "$profile" ]; then
    profile=$(ls -d "$HOME"/.mozilla/firefox/*/ | head -1)
fi

echo "menubar: starting a second Firefox with the profile $profile"
exec firefox --no-remote --new-instance --profile "$profile" "$@"
