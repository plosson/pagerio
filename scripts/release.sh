#!/usr/bin/env bash
# Usage: scripts/release.sh X.Y.Z
# Bumps the version shown by the server and the Apple apps, builds the Mac app as a signed, notarized pkg,
# commits, tags vX.Y.Z, pushes, and publishes the pkg on the GitHub release for that tag.
# The server redeploys when siteio sees the new tag (auto-deploy: tag).
# Needs: "Developer ID Application" and "Developer ID Installer" certificates in the keychain, and asc
#   (App Store Connect CLI) signed in with an API key (`asc auth status`).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-}"
[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || { echo "usage: $0 X.Y.Z" >&2; exit 1; }
TAG="v$VERSION"
REPO="plosson/pagerio"
APPLE="$ROOT/apple"
BUILD="$APPLE/build/release"
TEAM="$(sed -n -E 's/^DEVELOPMENT_TEAM = ([A-Z0-9]+)$/\1/p' "$APPLE/Config/Base.xcconfig")"
MAC_BUNDLE_ID="com.houlahop.pagerio.mac"
MAC_PROFILE="Pocket Pager Mac Developer ID"
NAME="Pocket Pager"
FILE_NAME="Pocket-Pager-$VERSION"

[[ "$(git branch --show-current)" == "main" ]] || { echo "✗ releases are cut from main" >&2; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo "✗ working tree has uncommitted changes" >&2; exit 1; }
git fetch --quiet --tags origin
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || { echo "✗ main is not in sync with origin/main" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "✗ $TAG already exists" >&2; exit 1; }
[[ -n "$TEAM" ]] || { echo "✗ DEVELOPMENT_TEAM not found in apple/Config/Base.xcconfig" >&2; exit 1; }

LATEST="$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' | sort -V | tail -1)"
if [[ -n "$LATEST" && "$(printf '%s\n%s\n' "$LATEST" "$TAG" | sort -V | tail -1)" != "$TAG" ]]; then
  echo "✗ $TAG is not higher than $LATEST (siteio only deploys higher tags)" >&2
  exit 1
fi

sed -i '' -E "s/^(  \"version\": )\"[^\"]*\"/\1\"$VERSION\"/" server/package.json
sed -i '' -E "s/^([[:space:]]*MARKETING_VERSION: )\"[^\"]*\"/\1\"$VERSION\"/" apple/project.yml

if ! TEST_OUTPUT="$(cd server && bun test 2>&1)"; then
  echo "$TEST_OUTPUT" | tail -30 >&2
  echo "✗ server tests failed; version files left modified" >&2
  exit 1
fi

# --- Mac app: archive, export with Developer ID, notarize, and package as a pkg and a zip.

# Notarizes a zip, dmg or pkg. asc exits 0 whatever Apple decides, so ask for the final status
# and stop unless it is Accepted.
notarize() {
  local id status
  id="$(asc notarization submit --file "$1" --wait | jq -r '.data.id // .id')"
  status="$(asc notarization status --id "$id" | jq -r '.data.attributes.status')"
  echo "Notarization of $(basename "$1") ($id): $status"
  if [[ "$status" != "Accepted" ]]; then
    asc notarization log --id "$id" >&2 || true
    echo "✗ notarization was not accepted; version files left modified" >&2; exit 1
  fi
}

rm -rf "$BUILD"
mkdir -p "$BUILD"
(cd "$APPLE/PagerKit" && swift test)
(cd "$APPLE" && xcodegen generate)

# The export signs with this Developer ID profile (push, time-sensitive notifications, keychain groups).
PROFILES_DIR="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
mkdir -p "$PROFILES_DIR"
PROFILE_JSON="$(asc profiles list | jq --arg name "$MAC_PROFILE" '[.data[] | select(.attributes.name == $name and .attributes.profileState == "ACTIVE")][0]')"
[[ "$PROFILE_JSON" != "null" ]] || { echo "✗ no active provisioning profile named \"$MAC_PROFILE\"" >&2; exit 1; }
jq -r '.attributes.profileContent' <<<"$PROFILE_JSON" | base64 -d > "$PROFILES_DIR/$(jq -r '.attributes.uuid' <<<"$PROFILE_JSON").provisionprofile"

xcodebuild archive \
  -project "$APPLE/PocketPager.xcodeproj" -scheme PocketPager-macOS -configuration Release \
  -archivePath "$BUILD/PocketPager.xcarchive" -allowProvisioningUpdates

cat > "$BUILD/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>developer-id</string>
  <key>teamID</key><string>$TEAM</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Developer ID Application</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>$MAC_BUNDLE_ID</key><string>$MAC_PROFILE</string>
  </dict>
</dict>
</plist>
PLIST

xcodebuild -exportArchive \
  -archivePath "$BUILD/PocketPager.xcarchive" \
  -exportOptionsPlist "$BUILD/ExportOptions.plist" \
  -exportPath "$BUILD/export"
APP="$BUILD/export/$NAME.app"

ditto -c -k --keepParent "$APP" "$BUILD/notarize.zip"
notarize "$BUILD/notarize.zip"
xcrun stapler staple "$APP"
spctl --assess --type execute --verbose "$APP"

ZIP="$BUILD/$FILE_NAME.zip"
ditto -c -k --keepParent "$APP" "$ZIP"

# Installer that always puts the app in /Applications: not relocatable, so it never
# overwrites another copy of the app found elsewhere on the disk.
PKG="$BUILD/$FILE_NAME.pkg"
INSTALLER_ID="$(security find-identity -v | awk -v team="($TEAM)\"" '/Developer ID Installer/ && index($0, team) { print $2; exit }')"
[[ -n "$INSTALLER_ID" ]] || { echo "✗ no Developer ID Installer certificate for team $TEAM" >&2; exit 1; }
rm -rf "$BUILD/pkgroot"
mkdir -p "$BUILD/pkgroot"
ditto "$APP" "$BUILD/pkgroot/$NAME.app"
pkgbuild --analyze --root "$BUILD/pkgroot" "$BUILD/component.plist"
plutil -replace 0.BundleIsRelocatable -bool NO "$BUILD/component.plist"
pkgbuild --root "$BUILD/pkgroot" --component-plist "$BUILD/component.plist" \
  --identifier "$MAC_BUNDLE_ID.pkg" --version "$VERSION" --install-location /Applications \
  --sign "$INSTALLER_ID" "$PKG"
notarize "$PKG"
xcrun stapler staple "$PKG"
spctl --assess --type install --verbose "$PKG"

# --- Commit, tag and push (the server redeploys), then publish the Mac app.

git add server/package.json apple/project.yml
git diff --cached --quiet || git commit --quiet -m "chore(release): $TAG"
git tag -a "$TAG" -m "$TAG"
git push --quiet origin main "$TAG"
gh release create "$TAG" "$PKG" "$ZIP" --repo "$REPO" --verify-tag --title "$NAME $VERSION" \
  --notes "Mac: open $FILE_NAME.pkg to install $NAME in Applications. Or download $FILE_NAME.zip, unzip, move \"$NAME.app\" to Applications and open it."
echo "✓ released $TAG"
