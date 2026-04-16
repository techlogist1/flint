#!/usr/bin/env bash
# fetch-fonts.sh — refresh the bundled JetBrains Mono woff2 files.
#
# [H-3] Flint bundles JetBrains Mono locally instead of pulling from
# fonts.googleapis.com so the app stays local-first and renders correctly
# offline / on first launch with no network. This script downloads the
# four weights (400, 500, 600, 700) from the official GitHub release and
# drops them into src/assets/fonts/.
#
# Run when:
#   - Bumping to a newer JetBrains Mono release
#   - Cloning the repo into a fresh worktree if the woff2 files are missing
#
# Usage:
#   bash scripts/fetch-fonts.sh           # uses the pinned VERSION below
#   VERSION=v2.305 bash scripts/fetch-fonts.sh   # override

set -euo pipefail

VERSION="${VERSION:-v2.304}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${SCRIPT_DIR}/../src/assets/fonts"
BASE="https://github.com/JetBrains/JetBrainsMono/raw/${VERSION}/fonts/webfonts"

mkdir -p "$DEST"

WEIGHTS=(
  "JetBrainsMono-Regular.woff2"
  "JetBrainsMono-Medium.woff2"
  "JetBrainsMono-SemiBold.woff2"
  "JetBrainsMono-Bold.woff2"
)

for f in "${WEIGHTS[@]}"; do
  echo "fetching $f from $VERSION ..."
  curl -L --fail --max-time 60 -o "$DEST/$f" "$BASE/$f"
done

echo "done — fonts in $DEST"
ls -lh "$DEST"
