#!/usr/bin/env bash
# restart.sh — take lukeless down for maintenance, then bring it back up.
#
# The game client is static GitHub Pages, so there is no page server process
# to restart. (The 1v1 WebSocket relay is a separate Cloudflare Worker.) This
# flips config.js's maintenance flag and pushes, waits for GitHub Pages to
# publish that exact commit, then flips it back off and waits again. Any open
# tab notices within its next ~10-second poll and reloads onto the notice.
#
# Be aware of the real timing before relying on this for anything time
# sensitive: each half waits on an actual GitHub Pages build, which usually
# lands in 30-90 seconds but isn't guaranteed to. A full down-and-up cycle is
# a couple of minutes, not ten seconds — the ten seconds is how fast an
# already-open tab reacts once the change is actually live, not how fast the
# publish itself happens.
#
# Usage: ./restart.sh ["reason shown on the maintenance page"]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

REPO="Aidiotic/lukeless"
SITE="https://aidiotic.github.io/lukeless"
REASON="${*:-lukeless is down for a quick update. Back in a few minutes.}"
GIT_AUTHOR=(-c user.name="Aidiotic" -c user.email="jidiot72@gmail.com")

# GitHub Pages gives static files a ten-minute cache lifetime. If app.js from
# one release meets versus.js or songs.js from another, a room code can look
# broken even though the relay room exists. Stamp every local asset URL with
# the feature commit that is being published so a browser fetches one coherent
# release. The stamp lands in the maintenance-down commit before Pages builds.
release=$(git rev-parse --short HEAD)
LUKELESS_RELEASE="$release" perl -pi -e \
  's{\?v=[A-Za-z0-9._-]+}{"?v=" . $ENV{LUKELESS_RELEASE}}ge' \
  index.html src/app.js
LUKELESS_RELEASE="$release" perl -pi -e \
  's{(release:\s*['\''"])[^'\''"]+}{$1 . $ENV{LUKELESS_RELEASE}}ge' \
  config.js

# repos/$REPO/pages/builds/latest can report the *previous* commit's "built"
# status for a few seconds after a push, before GitHub has even started a new
# build for it — checking status alone once cost a real down-and-up cycle its
# "up" half, silently. This waits for OUR commit specifically to show built in
# the build list, not just for the latest entry to say so.
wait_for_publish() {
  local target="$1"
  echo "  waiting for GitHub Pages to publish ${target:0:7}…"
  for _ in $(seq 1 60); do
    status=$(gh api "repos/$REPO/pages/builds" --jq ".[] | select(.commit==\"$target\") | .status" 2>/dev/null | head -1)
    case "$status" in
      built) echo "  build finished."; return 0 ;;
      errored) echo "  build for ${target:0:7} errored — GitHub Pages can abort a build that's superseded by a fast follow-up push; watching for a retry" >&2 ;;
    esac
    sleep 5
  done
  echo "  gave up waiting on the build after 5 minutes for ${target:0:7} — check https://github.com/$REPO/deployments" >&2
  return 1
}

# The build API reporting success is not the same as the CDN actually serving
# the new content — this fetches the real page and checks it directly, rather
# than trusting the build status alone a second time today.
verify_live() {
  local expected="$1"
  echo "  confirming the live site actually shows maintenance: ${expected}…"
  for _ in $(seq 1 12); do
    live=$(curl -s "$SITE/config.js?t=$(date +%s%N)" | grep -oE 'maintenance:\s*(true|false)' | grep -oE '(true|false)' | head -1)
    if [ "$live" = "$expected" ]; then echo "  confirmed live."; return 0; fi
    sleep 5
  done
  echo "  config.js still reads '${live:-unknown}' live, expected $expected — check $SITE/config.js by hand" >&2
  return 1
}

push_config() {
  git add config.js index.html src/app.js
  git "${GIT_AUTHOR[@]}" commit -q -m "$1"
  git push -q origin main
  git rev-parse HEAD
}

echo "== taking lukeless down =="
node scripts/set-maintenance.mjs true "$REASON"
sha=$(push_config "Maintenance: take the site down")
wait_for_publish "$sha"
verify_live true

echo
echo "== bringing lukeless back up =="
node scripts/set-maintenance.mjs false
sha=$(push_config "Maintenance: bring the site back up")
wait_for_publish "$sha"
verify_live false

echo
echo "done — lukeless is confirmed back up: $SITE/"
