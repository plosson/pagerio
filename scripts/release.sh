#!/usr/bin/env bash
# Usage: scripts/release.sh X.Y.Z
# Bumps the version shown by the server and the Apple apps, commits, tags vX.Y.Z and pushes.
# The server redeploys when siteio sees the new tag (auto-deploy: tag).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-}"
[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || { echo "usage: $0 X.Y.Z" >&2; exit 1; }
TAG="v$VERSION"

[[ "$(git branch --show-current)" == "main" ]] || { echo "✗ releases are cut from main" >&2; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo "✗ working tree has uncommitted changes" >&2; exit 1; }
git fetch --quiet --tags origin
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || { echo "✗ main is not in sync with origin/main" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "✗ $TAG already exists" >&2; exit 1; }

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

git add server/package.json apple/project.yml
git diff --cached --quiet || git commit --quiet -m "chore(release): $TAG"
git tag -a "$TAG" -m "$TAG"
git push --quiet origin main "$TAG"
echo "✓ released $TAG"
