#!/bin/bash
# Build script for Chrome Extension distribution
# Usage: ./scripts/build.sh [--crx]
#
# Outputs:
#   dist/proj-k-extension-v{VERSION}.zip  (for Chrome Web Store or manual install)
#   dist/proj-k-extension-v{VERSION}.crx  (if --crx and key exists)
#   dist/update.xml                       (auto-update manifest)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$EXT_DIR/dist"

# Read version from manifest.json
VERSION=$(grep '"version"' "$EXT_DIR/manifest.json" | head -1 | sed 's/.*"\([0-9.]*\)".*/\1/')
echo "Building Project K Chrome Extension v${VERSION}"

# Clean dist
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# Create temp build directory (exclude dev files)
BUILD_DIR=$(mktemp -d)
trap "rm -rf $BUILD_DIR" EXIT

# Copy extension files, excluding dev-only files
rsync -a --exclude='scripts/' \
         --exclude='dist/' \
         --exclude='native-host/' \
         --exclude='log-server.py' \
         --exclude='logs/' \
         --exclude='debug.html' \
         --exclude='lib/config.js' \
         --exclude='*.md' \
         --exclude='.git*' \
         "$EXT_DIR/" "$BUILD_DIR/"

# Ensure config.js doesn't leak into build
rm -f "$BUILD_DIR/lib/config.js"

# Create zip
ZIP_NAME="proj-k-extension-v${VERSION}.zip"
(cd "$BUILD_DIR" && zip -r "$DIST_DIR/$ZIP_NAME" . -x ".*")

echo "Created: dist/$ZIP_NAME ($(du -h "$DIST_DIR/$ZIP_NAME" | cut -f1))"

# Generate update.xml template
# UPDATE_URL should be set to your hosting server URL
UPDATE_URL="${UPDATE_URL:-https://your-server.com/chrome-extension}"
EXTENSION_ID="${EXTENSION_ID:-your-extension-id-here}"

cat > "$DIST_DIR/update.xml" << XMLEOF
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${EXTENSION_ID}'>
    <updatecheck codebase='${UPDATE_URL}/proj-k-extension-v${VERSION}.zip' version='${VERSION}' />
  </app>
</gupdate>
XMLEOF

echo "Created: dist/update.xml"

# CRX build (optional, needs private key)
if [[ "${1:-}" == "--crx" ]]; then
  KEY_FILE="$EXT_DIR/scripts/extension.pem"
  if [[ -f "$KEY_FILE" ]]; then
    echo "Building CRX with existing key..."
    # Chrome can pack extensions from command line
    google-chrome --pack-extension="$BUILD_DIR" --pack-extension-key="$KEY_FILE" 2>/dev/null || \
    chromium --pack-extension="$BUILD_DIR" --pack-extension-key="$KEY_FILE" 2>/dev/null || \
    echo "Warning: Could not build CRX (Chrome/Chromium not found in PATH)"

    if [[ -f "$BUILD_DIR.crx" ]]; then
      mv "$BUILD_DIR.crx" "$DIST_DIR/proj-k-extension-v${VERSION}.crx"
      echo "Created: dist/proj-k-extension-v${VERSION}.crx"
    fi
  else
    echo "No key file found at scripts/extension.pem"
    echo "To generate: openssl genrsa -out scripts/extension.pem 2048"
    echo "Skipping CRX build."
  fi
fi

echo ""
echo "=== Build complete ==="
echo "Files in dist/:"
ls -lh "$DIST_DIR/"
echo ""
echo "=== Next steps ==="
echo "1. Upload dist/$ZIP_NAME to your hosting server"
echo "2. Update EXTENSION_ID and UPDATE_URL in dist/update.xml"
echo "3. Host update.xml at: \${UPDATE_URL}/update.xml"
echo "4. Users install from zip, Chrome auto-updates via update.xml"
