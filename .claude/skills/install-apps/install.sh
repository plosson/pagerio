#!/usr/bin/env bash
# Build Pocket Pager development builds and install them on this Mac and/or the paired iPhone.
# Usage: install.sh [all|mac|ios]   (default: all)
set -euo pipefail

TARGET="${1:-all}"
case "$TARGET" in all | mac | ios) ;; *)
  echo "usage: $0 [all|mac|ios]" >&2
  exit 2
  ;;
esac

ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
APPLE="$ROOT/apple"
DERIVED="$APPLE/build/dd"
LOGS="${TMPDIR:-/tmp}/pocket-pager-install"
mkdir -p "$LOGS"

# Debug only: the entitlements say aps-environment=development and Debug builds report
# "sandbox" to the server. A Release build signed for development would report
# "production" and its pushes would be rejected.
build() {
  local scheme=$1 destination=$2 log="$LOGS/$1.log"
  echo "→ Building $scheme (Debug)… log: $log"
  if ! xcodebuild -project "$APPLE/PocketPager.xcodeproj" -scheme "$scheme" -configuration Debug \
    -destination "$destination" -derivedDataPath "$DERIVED" \
    -allowProvisioningUpdates -allowProvisioningDeviceRegistration build >"$log" 2>&1; then
    grep -E " error: " "$log" | cut -c1-300 | head -20 >&2 || true
    echo "✗ $scheme build failed (full log: $log)" >&2
    exit 1
  fi
}

install_mac() {
  build PocketPager-macOS "platform=macOS"
  local source="$DERIVED/Build/Products/Debug/Pocket Pager.app"
  local target="/Applications/Pocket Pager.app"
  echo "→ Replacing $target"
  osascript -e 'quit app id "com.chuut.pagerio.mac"' >/dev/null 2>&1 || true
  sleep 1
  pkill -f "Pocket Pager.app/Contents/MacOS/Pocket Pager" 2>/dev/null || true
  rm -rf "$target"
  ditto "$source" "$target"
  open "$target"
  echo "✓ Mac app installed in /Applications and launched"
}

# Prints "<devicectl identifier> <udid>" for the first paired iPhone.
paired_iphone() {
  local json="$LOGS/devices.json"
  xcrun devicectl list devices --json-output "$json" >/dev/null 2>&1
  python3 - "$json" <<'PY'
import json, sys
for device in json.load(open(sys.argv[1]))["result"]["devices"]:
    hw, conn = device["hardwareProperties"], device["connectionProperties"]
    if hw.get("platform") == "iOS" and hw.get("deviceType") == "iPhone" and conn.get("pairingState") == "paired":
        print(device["identifier"], hw["udid"])
        break
PY
}

install_ios() {
  local found identifier udid
  found="$(paired_iphone)"
  if [ -z "$found" ]; then
    echo "✗ No paired iPhone found. Connect it by USB (or same Wi-Fi), unlock it and trust this Mac." >&2
    exit 1
  fi
  read -r identifier udid <<<"$found"
  build PocketPager-iOS "id=$udid"
  local app="$DERIVED/Build/Products/Debug-iphoneos/Pocket Pager.app"
  echo "→ Installing on iPhone $udid"
  local attempt
  for attempt in 1 2 3; do
    if xcrun devicectl device install app --device "$identifier" "$app" >"$LOGS/ios-install.log" 2>&1; then
      break
    fi
    if [ "$attempt" = 3 ]; then
      grep -i error "$LOGS/ios-install.log" | head -3 >&2 || true
      echo "✗ Install failed. Is the iPhone unlocked and reachable? (log: $LOGS/ios-install.log)" >&2
      exit 1
    fi
    sleep 3
  done
  if xcrun devicectl device process launch --terminate-existing --device "$identifier" com.chuut.pagerio >/dev/null 2>&1; then
    echo "✓ iPhone app installed and launched"
  else
    echo "✓ iPhone app installed (not launched: unlock the iPhone and open Pocket Pager)"
  fi
}

(cd "$APPLE" && xcodegen generate --quiet)
case "$TARGET" in
mac) install_mac ;;
ios) install_ios ;;
all)
  install_mac
  install_ios
  ;;
esac
