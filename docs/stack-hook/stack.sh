#!/bin/sh
# Own commands for the two-repository recipe workspace, under Start the app for every repository.
# Set them as three commands, with the full path to this file:
#   Start:  sh '<path>/stack.sh' load {key}
#   Stop:   sh '<path>/stack.sh' unload {key}
#   Status: sh '<path>/stack.sh' status {key}
# Nolzu runs an answer for every repository in the card's checkout root, so a repository the card
# lists is at $PWD/<repo>.
set -u

action=${1:-}
key=${2:-}
if [ -z "$action" ] || [ -z "$key" ]; then
  echo "Name the action and the card, for example: stack.sh load APP-1." >&2
  exit 2
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running, so stack.sh cannot run $action. Start Docker and run it again." >&2
  exit 1
fi

# The card's own checkout when NOLZU_REPOS lists the repository, and the project's otherwise, so a
# card that changes only the api still gets a web page.
folder() {
  if printf '%s\n' "${NOLZU_REPOS:-}" | grep -qx "$1"; then
    echo "$PWD/$1"
  else
    echo "${NOLZU_PROJECT:-$PWD}/$1"
  fi
}
API_DIR=$(folder api)
WEB_DIR=$(folder web)
export API_DIR WEB_DIR

# Compose refuses a project name with capitals, and card keys have them.
name=nolzu-$(printf '%s' "$key" | tr 'A-Z' 'a-z')
# CDPATH would make cd print the folder too.
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

case $action in
  load)
    # Progress goes to stderr, so the two address lines are the last thing on stdout.
    docker compose -p "$name" -f "$here/compose.yaml" up -d --wait >&2 || exit $?
    echo "api http://localhost:8787/recipes"
    echo "web http://localhost:8080"
    ;;
  unload)
    docker compose -p "$name" -f "$here/compose.yaml" down
    ;;
  status)
    docker compose -p "$name" -f "$here/compose.yaml" ps
    ;;
  *)
    echo "The action is load, unload or status, not $action." >&2
    exit 2
    ;;
esac
