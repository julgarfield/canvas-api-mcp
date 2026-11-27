#!/bin/sh
# Store (or replace) your Canvas API token in the macOS login Keychain.
# The token is typed at an interactive prompt from `security` itself, so it
# never appears in shell history, argv, or the process list.
set -eu
ORIGIN="${CANVAS_BASE_URL:-https://canvas.wisc.edu}"
ACCOUNT="$(printf '%s' "$ORIGIN" | sed -E 's#^https://##; s#/.*$##')"
SERVICE="canvas-mcp"
if [ "$(uname)" != "Darwin" ]; then echo "macOS Keychain is only available on macOS; use CANVAS_API_TOKEN instead." >&2; exit 1; fi
echo "Storing Canvas token in Keychain (service: $SERVICE, account: $ACCOUNT)."
echo "Paste the token when prompted (input is hidden). You will be asked twice."
# -U updates an existing item (rotation). -w as the LAST argument makes security prompt for the value.
/usr/bin/security add-generic-password -U -s "$SERVICE" -a "$ACCOUNT" -l "Canvas API token ($ACCOUNT)" -w
echo "Saved. Verify with: npm run token:check   (prints only whether a token exists)"
