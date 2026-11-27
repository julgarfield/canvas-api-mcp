#!/bin/sh
set -eu
ORIGIN="${CANVAS_BASE_URL:-https://canvas.wisc.edu}"
ACCOUNT="$(printf '%s' "$ORIGIN" | sed -E 's#^https://##; s#/.*$##')"
/usr/bin/security delete-generic-password -s canvas-mcp -a "$ACCOUNT" >/dev/null && echo "Removed Keychain item canvas-mcp/$ACCOUNT. The token itself stays valid in Canvas until it expires; to revoke it early at UW–Madison, contact the DoIT Help Desk (https://kb.wisc.edu/1)."
