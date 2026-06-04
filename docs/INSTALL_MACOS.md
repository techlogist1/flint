# Installing Flint on macOS

Flint's macOS builds are **ad-hoc signed but not notarized** by Apple. There is
no paid Apple Developer certificate behind them yet, so on first launch macOS
Gatekeeper will refuse to open the app — usually with **"Flint" is damaged and
can't be opened** (especially on Apple Silicon) or **"Flint" cannot be opened
because the developer cannot be verified**.

The app is not actually damaged. The message appears because the download
carries a *quarantine* attribute and the binary isn't notarized, so Gatekeeper
blocks it. Pick either fix below.

## Fix 1 — clear the quarantine attribute (fastest)

Open **Terminal** and run:

```sh
xattr -dr com.apple.quarantine /Applications/Flint.app
```

(Adjust the path if you put Flint somewhere other than `/Applications`.) Then
open Flint normally. This removes the download quarantine so Gatekeeper stops
blocking it.

## Fix 2 — Open Anyway (no Terminal)

1. In Finder, **right-click** (or Control-click) **Flint.app → Open**.
2. If the dialog only offers *Move to Trash* / *Cancel*, click **Cancel**, then
   open **System Settings → Privacy & Security**, scroll to the Security
   section, and click **Open Anyway** next to the Flint message.
3. Confirm **Open**. macOS remembers the choice for future launches.

## Why this happens

Apple's Gatekeeper trusts apps that are signed with a paid **Developer ID**
certificate *and* **notarized** (scanned and stapled by Apple). Flint v0.1 ships
without those, so it falls outside that trust. Everything Flint does is local
and offline — no network calls, no telemetry (see the README's Data & Privacy
section) — the warning is about provenance, not behavior.

A proper signed + notarized build is wired up and ready to switch on; it only
needs an Apple Developer account. See below.

---

## For maintainers — enabling signing + notarization

The release workflow (`.github/workflows/release.yml`) already passes the Apple
signing/notarization environment variables to `tauri-action`. It is **inert**
until the matching GitHub repository secrets exist, so today's builds stay
ad-hoc/un-notarized and nothing breaks. To turn on real signing:

1. **Enrol in the Apple Developer Program** (~$99/year):
   <https://developer.apple.com/programs/>.
2. **Create a "Developer ID Application" certificate** (Apple Silicon + Intel
   distribution outside the App Store) in the Apple Developer portal or via
   Xcode, then export it from **Keychain Access** as a password-protected
   `.p12`.
3. **Base64-encode the certificate** for the secret:
   ```sh
   base64 -i certificate.p12 | pbcopy
   ```
4. **Create an app-specific password** for notarization at
   <https://appleid.apple.com> → Sign-In and Security → App-Specific Passwords.
5. **Add these GitHub repository secrets** (Settings → Secrets and variables →
   Actions). Names must match `release.yml` exactly:

   | Secret | What it is |
   | --- | --- |
   | `APPLE_CERTIFICATE` | base64 of the `.p12` from step 3 |
   | `APPLE_CERTIFICATE_PASSWORD` | the password you set on the `.p12` |
   | `APPLE_SIGNING_IDENTITY` | the identity name, e.g. `Developer ID Application: Your Name (TEAMID)` |
   | `KEYCHAIN_PASSWORD` | any string — names the temporary CI keychain |
   | `APPLE_ID` | your Apple Account email |
   | `APPLE_PASSWORD` | the app-specific password from step 4 |
   | `APPLE_TEAM_ID` | your 10-character Team ID (Membership page) |

   > Notarization can alternatively use an App Store Connect API key
   > (`APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`) instead of the
   > Apple-ID trio above; either set is consumed by `tauri-action`.

6. **Tag a release** (`git tag vX.Y.Z && git push --tags`). The workflow now
   produces a Developer ID-signed, notarized, stapled `.dmg`, and the
   "damaged"/"unverified" prompts disappear for end users — they can open Flint
   normally with no Terminal step.

Once notarization is live, simplify the macOS section of the README's Download
table accordingly. Until then, this page is the honest install path.
