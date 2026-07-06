# Publishing DocuDesk Lite to Google Play

The complete path from this repository to a public Play Store listing.
Steps marked **[you]** need the account owner; steps marked **[repo]** are
technical work done in this codebase.

Realistic timeline for a personal developer account: **3–4 weeks**, dominated
by identity verification and the mandatory closed-test period. Cost: **$25**
one-time.

---

## 1. Developer account — [you], start first (slowest step)

1. Sign up at <https://play.google.com/console> — one-time $25 USD fee.
2. Complete identity verification (government ID; hours to days).
3. **Personal vs. organization**: personal accounts created since Nov 2023
   must run a **closed test with ≥ 20 testers enrolled continuously for
   14 days** before they may apply for production access. Organization
   accounts (require a free D-U-N-S number, ~days to obtain) are exempt.
   As an individual, plan the 20 testers early — friends/classmates who
   opt in via a link and keep the app installed for the whole window.

## 2. Release build changes — [repo]

- [ ] **Upload keystore.** Generate a dedicated upload key (NOT the dev
      `signer-local.jks`):

      keytool -genkeypair -v -keystore upload-key.jks -alias upload \
        -keyalg RSA -keysize 2048 -validity 10000

      Vault the file and password (password manager + offline copy). With
      Play App Signing (default), Google holds the true app-signing key, so
      a lost upload key is recoverable via support — but avoid needing that.
      **The keystore must never be committed** (`.gitignore` already blocks
      `*.jks`).
- [ ] **Gradle signing config** for release bundles: a
      `keystore.properties` (git-ignored) in `src-tauri/gen/android/` and a
      `signingConfigs` block in `app/build.gradle.kts` — the standard Tauri
      recipe from <https://v2.tauri.app/distribute/sign/android/>.
- [ ] **Build an AAB** (Play accepts only bundles for new apps):

      npx tauri android build --aab --target aarch64

      For Play, build all ABIs (drop `--target` or list them) so arm32 and
      x86_64 devices are covered — Play serves per-device splits from one AAB.
- [ ] Already satisfied by this repo: `targetSdk 36` (Play requires a recent
      API level), unique `applicationId` `com.docudesk.lite` (permanent —
      can never change after the first upload), version code/name derived
      from `tauri.conf.json`.

## 3. Listing materials — [repo drafts, you approve]

- [ ] **Privacy policy URL** — mandatory for every app. DocuDesk's honest
      story: all processing is on-device; no network calls, no analytics,
      no accounts, no data collection. Host the policy on GitHub Pages from
      this repo.
- [ ] **Graphics**: 512×512 icon (from `build/icon.png` source), 1024×500
      feature graphic (render from branding), ≥ 2 phone screenshots
      (the CDP emulation harness produces clean 1080×2400 captures).
- [ ] **Copy** (localizable — we ship 6 UI languages, list in all of them):
      - Title ≤ 30 chars, e.g. "DocuDesk: Sign & Edit PDFs"
      - Short description ≤ 80 chars
      - Full description ≤ 4000 chars (bulk signing, smart detect, OCR on
        scans, edit mode, offline/no-data-collection as differentiators)

## 4. Play Console setup — [you, with drafts from §3]

1. Create app → name, default language, "App", Free.
2. **App content** section: privacy policy URL; Data safety form (declare
   *no data collected, no data shared* — true for this app); content rating
   questionnaire (Productivity → rated Everyone); target audience (13+;
   not a kids' app); ads declaration (none).
3. Store listing: paste copy, upload graphics/screenshots.

## 5. Release flow — [you]

1. **Internal testing** track first: upload the AAB, add your own Google
   account as tester, install via the opt-in link — this verifies the
   Play-signed build end-to-end (Google re-signs the app; behavior should
   be identical).
2. **Closed testing**: promote the same build, enroll the 20 testers,
   wait out the 14 continuous days (personal accounts).
3. Apply for **production** access in the console, promote the build,
   submit for review (typically 1–7 days for a first release).
4. Ship updates thereafter: bump `version` in `tauri.conf.json` and
   `package.json`, rebuild the AAB, upload to the track — minutes.

## Gotchas worth knowing in advance

- **Sideload conflict**: Play re-signs the app, so devices with the
  sideloaded GitHub APK must uninstall it before installing from Play
  (signatures cannot mix). Saved signatures/settings are lost with the
  uninstall — consider adding a signature export/import feature before
  wide rollout.
- The GitHub releases can continue in parallel (same version numbers,
  different signature); document that users should pick ONE channel.
- App name collisions: "DocuDesk" may be contested on Play; the title can
  differ from the package name — check availability early.
- Once on Play, **crash reporting** appears in the console (Android
  vitals) — worth watching after each release.

## Suggested order of work

1. [you] Start account signup + identity verification today.
2. [repo] Keystore + signing config + multi-ABI AAB.
3. [repo] Privacy policy page, graphics, store copy (6 languages).
4. [you] Console forms with the drafts; internal test.
5. [you] Closed test (recruit 20 testers), 14 days.
6. [you] Production review → public.
