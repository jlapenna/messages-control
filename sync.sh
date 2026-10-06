#!/bin/sh
# Copy the extension where Windows Chrome can load it unpacked.
set -eu
dest=/mnt/c/Users/jlape/Downloads/messages-spam-filter
mkdir -p "$dest"
cd "$(dirname "$0")"
cp manifest.json *.js *.html *.css "$dest"/
rm -f "$dest/sync.sh"
echo "Synced to $dest; reload the extension in chrome://extensions"
