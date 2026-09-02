#!/usr/bin/env bash
# restart.sh — take lukeless down for maintenance, then bring it back up.
#
# There is no server process behind this site to literally restart: it's
# static pages on GitHub Pages, and a 1v1 match runs peer-to-peer between two
# browsers with nothing of ours in the middle. What this does instead is the
# closest real equivalent — flip config.js's maintenance flag on and push,
# wait for GitHub Pages to actually publish that (confirmed against the Pages
# build API, not a guessed sleep), then flip it back off and wait again. Any
# tab open against the site — mid-match or sitting on the menu — notices
# within its next ~10-second poll and reloads onto the notice, which is also
# the only way to interrupt a match already running.
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
REASON="${*:-lukeless is down for a quick update. Back in a few minutes.}"
GIT_AUTHOR=(-c user.name="Aidiotic" -c user.email="jidiot72@gmail.com")

wait_for_publish() {
  echo "  waiting for GitHub Pages to publish…"
  for _ in $(seq 1 60); do
    status=$(gh api "repos/$REPO/pages/builds/latest" --jq .status 2>/dev/null || echo "")
    if [ "$status" = "built" ]; then echo "  published."; return 0; fi
    sleep 5
  done
  echo "  gave up waiting after 5 minutes — check https://github.com/$REPO/deployments" >&2
  return 1
}

push_config() {
  git add config.js
  git "${GIT_AUTHOR[@]}" commit -q -m "$1"
  git push -q origin main
}

echo "== taking lukeless down =="
node scripts/set-maintenance.mjs true "$REASON"
push_config "Maintenance: take the site down"
wait_for_publish

echo
echo "== bringing lukeless back up =="
node scripts/set-maintenance.mjs false
push_config "Maintenance: bring the site back up"
wait_for_publish

echo
echo "done — lukeless is back up: https://aidiotic.github.io/lukeless/"
