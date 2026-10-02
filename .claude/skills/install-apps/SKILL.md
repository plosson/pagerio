---
name: install-apps
description: Builds the Pocket Pager iOS and macOS apps from this repo and installs them on this Mac (/Applications) and the paired iPhone as development builds. Use when the user asks to install, update, reinstall or deploy the Mac or iPhone app, after changing apple/ code, or when the app stops opening because its yearly development profile expired.
---

# Install Pocket Pager on this Mac and the iPhone

The apps are distributed as **development builds**, not TestFlight. The spec records this
decision. One script builds and installs both apps:

```bash
.claude/skills/install-apps/install.sh          # both apps
.claude/skills/install-apps/install.sh mac      # Mac only
.claude/skills/install-apps/install.sh ios      # iPhone only
```

Run it from the repo root and let it finish. Builds take one to three minutes, and each
build's log path is printed at the start.

## What it does

1. Runs `xcodegen generate` in `apple/`. The `.xcodeproj` is git-ignored and always regenerated.
2. **Mac:**
   - Builds `PocketPager-macOS` in Debug with automatic signing.
   - Quits the running app and replaces `/Applications/Pocket Pager.app`.
   - Launches the new build.
3. **iPhone:**
   - Finds the first paired iPhone.
   - Builds `PocketPager-iOS` in Debug for it.
   - Installs it with `devicectl`, retrying 3 times for flaky connections.
   - Relaunches the app.

## Rules

- **The APNs environment comes from `APS_ENVIRONMENT` in `apple/Config/Base.xcconfig`** (currently
  `development` = sandbox). The aps-environment entitlement and the app's reported environment
  (Info.plist `PagerioApsEnvironment`) both read it, so they cannot disagree. The install script
  still builds Debug.
- Don't commit anything this produces. `apple/build/` and the `.xcodeproj` are git-ignored.
- Signing uses team `427N276E3Q` with `-allowProvisioningUpdates`. A new Mac or iPhone is
  registered automatically (`-allowProvisioningDeviceRegistration`).

## Before running

- **iPhone:** connected by USB or on the same Wi-Fi, **unlocked**, and trusting this Mac.
- **Xcode:** signed into the Apple account for team `427N276E3Q` (Xcode › Settings › Accounts).

## After installing

- Nothing to redo. Each app keeps its session (Keychain) and re-registers its push token on
  launch, so pages keep arriving.
- **First Mac install only:** if **Launch at login** shows off in the menu-bar panel, turn it
  on once. The login item must point at the copy in `/Applications`.
- **Quick check:** in the app, tap **Test my pager**. Both devices should ring.

## When it fails

| Symptom | Fix |
|---|---|
| `No paired iPhone found` | Plug the iPhone in by USB, unlock it, tap **Trust**. |
| Install fails, "device disconnected", "locked" | Unlock the iPhone and run `install.sh ios` again. |
| `No profiles for 'com.chuut.pagerio…'` | Xcode isn't signed into the team. Add the account in Xcode › Settings › Accounts and retry. |
| App won't open, "integrity could not be verified" | The development profile expired (it lasts one year). Run `install.sh` to rebuild. |
| Build error | Read the log path the script printed. `cd apple/PagerKit && swift test` checks the shared package on its own. |
