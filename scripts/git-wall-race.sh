#!/usr/bin/env bash
# Races Nolzu's own git writes against a process that swaps a link into the repository's `.git/logs`,
# and reports whether a file or folder outside the repository changed. Each case runs a commit, then
# a worktree add, `count` times (500 unless given), with the wall off (Nolzu's git as it was before the
# wall) and on. Exits 1 when a walled write changed anything outside, and also when the race tested
# nothing: a writer that printed no counts, an unwalled case where nothing outside changed, or a
# walled case where git never finished a call.
#
#   bash scripts/git-wall-race.sh [count]
#
# The repositories, HOME and the outside folder sit in the ignored `.vitest` folder of this checkout,
# not the system temp folder, so the wall sees what it sees in a real project. Nothing reaches the
# network, and the folder goes at the end.
set -euo pipefail

count="${1:-500}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$root/.vitest"
base="$(mktemp -d "$root/.vitest/git-wall-race-XXXXXX")"
base="$(cd "$base" && pwd -P)"
work="$base/work"
outside_root="$base/outside"
mkdir -p "$work" "$outside_root"
trap 'rm -rf "$base"' EXIT

export HOME="$work/home"
mkdir -p "$HOME"
export GIT_CONFIG_GLOBAL="$work/gitconfig"
export GIT_CONFIG_NOSYSTEM=1
printf '[user]\n\tname = Race\n\temail = race@example.invalid\n' > "$GIT_CONFIG_GLOBAL"

entry=(node "$root/scripts/git-wall-race.ts")
walled_escapes=0
untested=0

for mode in off on; do
  for shape in rename link; do
    for write in commit worktree; do
      repo="$work/$mode-$shape-$write"
      outside="$outside_root/$mode-$shape-$write"
      mkdir -p "$outside"
      printf 'kept\n' > "$outside/victim"
      init=(git init -q -b main "$repo")
      "${init[@]}"
      first=(git -C "$repo" commit -q --allow-empty -m first)
      "${first[@]}"
      stop="$work/stop-$mode-$shape-$write"
      "${entry[@]}" attack "$shape" "$repo" "$outside" "$stop" &
      attacker=$!
      calls="$("${entry[@]}" write "$mode" "$write" "$repo" "$count")" || calls=""
      touch "$stop"
      wait "$attacker" || true
      changed=no
      if [ "$(cat "$outside/victim")" != "kept" ] || [ "$(ls -A "$outside" | tr '\n' ' ')" != "victim " ]; then changed=yes; fi
      echo "wall=$mode shape=$shape write=$write tries=$count $calls outside-changed=$changed"
      if [ "$mode" = on ] && [ "$changed" = yes ]; then walled_escapes=$((walled_escapes + 1)); fi
      # A case that tested nothing: the writer crashed or printed no counts, the unwalled race never
      # escaped, or no walled git call ever finished.
      if [ -z "$calls" ]; then echo "  the writer printed no counts"; untested=$((untested + 1)); fi
      if [ "$mode" = off ] && [ "$changed" = no ]; then echo "  the unwalled writes never escaped, so the race did not race"; untested=$((untested + 1)); fi
      if [ "$mode" = on ] && [[ "$calls" == *"git-done=0 "* ]]; then echo "  no walled git call finished"; untested=$((untested + 1)); fi
    done
  done
done

if [ "$walled_escapes" -gt 0 ]; then
  echo "A walled write changed a file outside the repository in $walled_escapes of 4 cases."
  exit 1
fi
if [ "$untested" -gt 0 ]; then
  echo "$untested cases tested nothing, so this run proves nothing."
  exit 1
fi
echo "No walled write changed anything outside the repository."
