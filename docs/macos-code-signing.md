# macOS code signing & notarization

How Bugyo's macOS builds are signed today, and how to turn on full Developer ID
signing + notarization when you're ready. No code changes are needed to flip the
switch — only Apple credentials added as repo secrets.

## Where we are today (0.1.0): ad-hoc signed

`src-tauri/tauri.conf.json` sets an **ad-hoc** signing identity:

```json
"bundle": {
  "macOS": {
    "signingIdentity": "-"
  }
}
```

Ad-hoc signing (`-`) needs no Apple account and no certificate. It matters
because on Apple Silicon macOS requires _some_ signature for apps downloaded from
the internet; without it, the universal build can be flagged as **"damaged"**.
Ad-hoc signing avoids that.

What it does **not** do: it is not a notarized Developer ID signature, so
Gatekeeper still shows an "unidentified developer" warning on first launch. Users
clear it once via **System Settings → Privacy & Security → Open Anyway**, or from
a terminal:

```bash
xattr -cr /Applications/Bugyo.app                        # clear all xattrs, or:
xattr -dr com.apple.quarantine /Applications/Bugyo.app   # just the quarantine flag
```

`xattr -cr` removes the `com.apple.quarantine` attribute the browser attaches to
downloads, which is what triggers Gatekeeper. It's a deliberate bypass — only run
it for a build you trust.

## How the release workflow is wired

`.github/workflows/release.yml` has a **Configure macOS code signing** step that
runs before `tauri-action` and writes the signing config to `$GITHUB_ENV`:

- If the `APPLE_CERTIFICATE` secret is **absent**, it exports only
  `APPLE_SIGNING_IDENTITY=-` (ad-hoc). It deliberately does **not** export an
  empty `APPLE_CERTIFICATE`: Tauri's bundler treats an empty-but-set value as
  "present" and tries to `security import` it, which fails the build.
- If the `APPLE_CERTIFICATE` secret is **present**, it exports the full set
  (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
  `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`) so the build is signed with the
  Developer ID identity and notarized.

So the same workflow produces an ad-hoc build today and a fully signed +
notarized build the moment the secrets are added — no workflow edits required.

## Turning on Developer ID signing + notarization

### 1. Prerequisites (one-time)

- An **Apple Developer Program** membership ($99/year). The free tier can sign
  but **cannot notarize**, so the "unidentified developer" warning would remain.
- A Mac to create/export the certificate.

### 2. Create a Developer ID Application certificate

On the [Certificates, IDs & Profiles](https://developer.apple.com/account/resources/certificates/list)
page, create a certificate of type **Developer ID Application** (for shipping
outside the App Store). Only the account Holder can create this type. Download
and open the `.cer` so it lands in your login keychain.

Find its identity string:

```bash
security find-identity -v -p codesigning
# e.g. "Developer ID Application: Your Name (TEAMID)"
```

### 3. Export the certificate for CI

In **Keychain Access → My Certificates**, expand the entry, right-click the
private key, **Export** it as a `.p12` (set a password), then base64-encode it:

```bash
openssl base64 -A -in certificate.p12 -out certificate-base64.txt
```

### 4. Add repo secrets

Settings → Secrets and variables → Actions:

| Secret                       | Value                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE`          | contents of `certificate-base64.txt`                                                          |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password                                                                    |
| `APPLE_SIGNING_IDENTITY`     | `Developer ID Application: Your Name (TEAMID)`                                                |
| `APPLE_ID`                   | your Apple ID email                                                                           |
| `APPLE_PASSWORD`             | an [app-specific password](https://support.apple.com/en-us/HT204397) (not your real password) |
| `APPLE_TEAM_ID`              | your 10-character Team ID                                                                     |

### 5. (Optional) Wire up entitlements

A minimal hardened-runtime `src-tauri/entitlements.plist` is already in the repo
but intentionally **not** referenced. If a capability needs it, reference it:

```json
"bundle": {
  "macOS": {
    "signingIdentity": "-",
    "entitlements": "entitlements.plist"
  }
}
```

Notarization requires the hardened runtime; `tauri-action` enables it when
signing with a real identity. Start without custom entitlements and only add
them if you hit a specific runtime restriction — over-broad entitlements weaken
the sandbox and can cause a blank-window launch.

### 6. Release

Push a `v*` tag (or run the workflow manually). `tauri-action` imports the
certificate, signs with the Developer ID identity, submits to Apple's notary
service, staples the ticket, and the downloaded `.dmg` opens with no warning.

## References

- Tauri — [macOS Code Signing](https://v2.tauri.app/distribute/sign/macos/)
- Tauri — [GitHub pipeline](https://tauri.app/distribute/pipelines/github/)
