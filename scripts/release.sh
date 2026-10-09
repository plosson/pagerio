#!/usr/bin/env bash
# Usage: scripts/release.sh X.Y.Z
# Bumps the version shown by the server and the Apple apps, builds the Mac app as a signed, notarized pkg and zip,
# commits, tags vX.Y.Z, pushes, publishes the pkg, zip and Sparkle appcast on the GitHub release for that tag,
# and updates the Homebrew cask.
# The server redeploys when siteio sees the new tag (auto-deploy: tag).
# The Mac steps live in the houlahop-mac-release submodule: see scripts/mac-release/lib.sh for what they need.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[[ -f scripts/mac-release/lib.sh ]] || git submodule update --init scripts/mac-release
source scripts/mac-release/lib.sh

release_version "${1:-}"
APPLE="$ROOT/apple"
TEAM="$(sed -n -E 's/^DEVELOPMENT_TEAM = ([A-Z0-9]+)$/\1/p' "$APPLE/Config/Base.xcconfig")"
NAME="Pocket Pager"
FILE_NAME="Pocket-Pager-$VERSION"
REPO="plosson/pagerio"
BUNDLE_ID="com.houlahop.pagerio.mac"
MAC_PROFILE="Pocket Pager Mac Developer ID"
PROJECT="$APPLE/PocketPager.xcodeproj"
SCHEME="PocketPager-macOS"
BUILD="$APPLE/build/release"
SPARKLE_ACCOUNT="pagerio"
CASK="pocket-pager"
CASK_DESC="Personal pager that scripts and AI agents call through a private URL"
MIN_MACOS="sequoia"

[[ "$(git branch --show-current)" == "main" ]] || release_fail "releases are cut from main"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || release_fail "working tree has uncommitted changes"
git fetch --quiet --tags origin
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || release_fail "main is not in sync with origin/main"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && release_fail "$TAG already exists"
[[ -n "$TEAM" ]] || release_fail "DEVELOPMENT_TEAM not found in apple/Config/Base.xcconfig"

LATEST="$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' | sort -V | tail -1)"
if [[ -n "$LATEST" && "$(printf '%s\n%s\n' "$LATEST" "$TAG" | sort -V | tail -1)" != "$TAG" ]]; then
  release_fail "$TAG is not higher than $LATEST (siteio only deploys higher tags)"
fi

sed -i '' -E "s/^(  \"version\": )\"[^\"]*\"/\1\"$VERSION\"/" server/package.json
sed -i '' -E "s/^([[:space:]]*MARKETING_VERSION: )\"[^\"]*\"/\1\"$VERSION\"/" apple/project.yml
trap 'echo "✗ version files left modified" >&2' EXIT

if ! TEST_OUTPUT="$(cd server && bun test 2>&1)"; then
  echo "$TEST_OUTPUT" | tail -30 >&2
  release_fail "server tests failed"
fi

# --- Mac app: archive, export with Developer ID, notarize, and package as a pkg, a zip and a Sparkle appcast.

release_clean_build
(cd "$APPLE/PagerKit" && swift test)
(cd "$APPLE" && xcodegen generate)

# The export signs with this Developer ID profile (push, time-sensitive notifications, keychain groups).
release_install_profile "$MAC_PROFILE"
release_archive -allowProvisioningUpdates
release_export "$MAC_PROFILE"
release_notarize_app
release_pkg
release_appcast

# --- Commit, tag and push (the server redeploys), then publish the Mac app.

git add server/package.json apple/project.yml
git diff --cached --quiet || git commit --quiet -m "chore(release): $TAG"
trap - EXIT
git tag -a "$TAG" -m "$TAG"
git push --quiet origin main "$TAG"
release_publish --verify-tag
release_cask
echo "✓ released $TAG"
