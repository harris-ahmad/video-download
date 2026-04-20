#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <chrome-extension-id>"
  echo "Example: $0 abcdefghijklmnopqrstuvwxyzabcdef"
  exit 1
fi

EXTENSION_ID="$1"
HOST_NAME="com.harrisahmad.video_download_helper"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_SCRIPT_PATH="$SCRIPT_DIR/index.js"
NODE_BIN="$(command -v node || true)"
LAUNCHER_PATH="$SCRIPT_DIR/run-host.sh"
HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST_PATH="$HOST_DIR/$HOST_NAME.json"

if [[ -z "$NODE_BIN" ]]; then
  echo "Error: node is not installed or not found in PATH"
  exit 1
fi

mkdir -p "$HOST_DIR"
chmod +x "$HOST_SCRIPT_PATH"

cat > "$LAUNCHER_PATH" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "$NODE_BIN" "$HOST_SCRIPT_PATH"
EOF

chmod +x "$LAUNCHER_PATH"

cat > "$MANIFEST_PATH" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Native helper for TS to MP4 conversion",
  "path": "$LAUNCHER_PATH",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF

echo "Installed native host manifest: $MANIFEST_PATH"
echo "Native launcher path: $LAUNCHER_PATH"
echo "Native helper script: $HOST_SCRIPT_PATH"
echo "Node binary: $NODE_BIN"
echo "Allowed extension origin: chrome-extension://$EXTENSION_ID/"
