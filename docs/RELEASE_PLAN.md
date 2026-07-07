# DocuDesk — Release Plan

The complete, ordered plan to get DocuDesk onto the Google Play Store and to
finish the remaining engineering work. This is the master plan; the older
`docs/PLAY_STORE.md` is the quick playbook and is superseded by the Play
section here.

Legend: **[you]** = account owner action · **[repo]** = code/build work ·
**[both]** = needs a hand-off.

---

## 0. Where things stand (2026-07-07, v0.1.21)

- Windows (Electron + Tauri Lite) and Android (Tauri) all build and ship from
  GitHub Releases. Latest: **v0.1.21**.
- Code audited: clean TypeScript (no `any`/`TODO`/`console`), strong security
  (context isolation, tight CSP, fully offline), all dependencies permissive
  (MIT/Apache/ISC/OFL — no copyleft), 43-script CDP regression battery green.
- **Not yet Play-submittable.** The gaps are packaging + paperwork, not code.

## 1. Guiding facts (they simplify everything)

DocuDesk is **completely free and fully offline**: no ads, no in-app
purchases, no subscriptions, no payments, no accounts, no analytics, no data
collection, no network calls. This directly removes whole categories of Play
requirements:

- **Pricing:** Free. No Google Play billing, so no Payments policy, no tax/bank
  setup.
- **Ads declaration:** "No, my app does not contain ads."
- **Data safety form:** "No data collected" and "No data shared" — truthful and
  verifiable (no network code exists).
- **In-app purchases:** None.
- **Content rating:** Everyone / PEGI 3 (a productivity tool).

Keep it this way — the moment any SDK, ad network, or analytics is added, all
of the above reverses and the privacy policy must change.

---

## Workstream A — Google Play release (the mandatory path)

Ordered so the slow, serial items (account verification, the closed-test
window) start first.

### A1. Developer account — [you] — DO THIS FIRST (slowest)

1. Sign up at <https://play.google.com/console> — one-time **$25** fee.
2. Complete **identity verification** (government ID; hours to days).
3. Choose the account type deliberately:
   - **Personal account** (individual): after registering, you must run a
     **closed test with ≥ 20 testers who stay opted-in for 14 continuous
     days** before you may apply for production. Recruit those 20 early
     (friends/classmates who install and keep the app).
   - **Organization account:** needs a free **D-U-N-S number** (a few days to
     obtain) and is exempt from the 20-tester rule.
4. Decide the **public developer name** and a **contact email** — this email
   should match the one in the privacy policy.

**Acceptance:** Play Console shows your account as verified and able to create
an app.

### A2. Privacy policy — hosted URL — [both]

The text already exists at `docs/PRIVACY.md`. It must be reachable at a public
URL for the listing.

1. **[you]** In `docs/PRIVACY.md`, replace `<your-contact-email>` with your
   chosen public contact address.
2. **[repo]** Enable GitHub Pages so the file is served:
   - Repo → Settings → Pages → Source: "Deploy from a branch" → Branch:
     `main`, Folder: `/docs`.
   - Resulting URL (Jekyll renders the `.md`): roughly
     `https://udabg.github.io/DocuDesks/PRIVACY` (confirm the exact path after
     Pages builds; may be `/PRIVACY.html`).
3. **[you]** Paste that URL into Play Console → App content → Privacy policy.

**Acceptance:** the URL loads the policy in a browser; Play accepts it.

### A3. Remove the `INTERNET` permission — [repo] + on-device verify [you]

The Android manifest requests `android.permission.INTERNET`, a leftover from
the Tauri template. The app is fully offline, so it should be removed to match
the "collects no data" story and avoid reviewer questions.

1. **[repo]** In `src-tauri/gen/android/app/src/main/AndroidManifest.xml`,
   remove the `<uses-permission android:name="android.permission.INTERNET" />`
   line. (Note: `gen/android` is generated; if it is ever regenerated with
   `tauri android init`, re-apply this — consider a committed note.)
2. **[repo]** Rebuild the APK/AAB.
3. **[you] — REQUIRED:** install the resulting build on a **real device** and
   confirm the app still launches and works (open a PDF, sign, save). Tauri's
   Android asset serving is local and should not need INTERNET, but this
   cannot be verified in the desktop test harness — a device smoke-test is
   mandatory before trusting it. If the app fails to load, restore the
   permission and investigate.

**Acceptance:** app launches and all core flows work on-device with the
permission removed.

### A4. Upload keystore + Gradle signing config — [repo builds, you vault]

Play requires a proper, durable upload key — **not** the throwaway
`signer-local.jks` (whose password is in `scripts/sign-apk.ps1`; never reuse
it).

1. **[repo/you]** Generate a dedicated upload key (keep it forever):

   ```
   keytool -genkeypair -v -keystore upload-key.jks -alias upload \
     -keyalg RSA -keysize 2048 -validity 10000
   ```

   - **[you]** Choose a strong password. **Vault the `.jks` file and the
     password** (password manager + an offline backup). With Play App Signing
     (default), Google holds the real signing key, so a lost upload key is
     recoverable via support — but treat it as precious anyway.
   - `*.jks` is already git-ignored (`.gitignore`), so it will not be
     committed.
2. **[repo]** Add a git-ignored `src-tauri/gen/android/keystore.properties`:

   ```
   storeFile=<absolute path to upload-key.jks>
   storePassword=<password>
   keyAlias=upload
   keyPassword=<password>
   ```

   Add `keystore.properties` to `.gitignore` (the Android template already
   ignores it).
3. **[repo]** Wire a `signingConfigs` block into
   `src-tauri/gen/android/app/build.gradle.kts` that reads
   `keystore.properties` and apply it to the `release` build type (the current
   `release` block has no signing config). Recipe:
   <https://v2.tauri.app/distribute/sign/android/>.

**Acceptance:** `tauri android build --aab` produces an AAB signed by the
upload key (verify with `jarsigner -verify` or `bundletool`).

### A5. Build the AAB (all ABIs) — [repo]

Play requires an **Android App Bundle**, not an APK, and it should cover all
architectures (the current pipeline emits an **arm64-only APK**).

1. **[repo]**

   ```
   npx tauri android build --aab
   ```

   With no `--target`, Tauri builds all ABIs (arm64-v8a, armeabi-v7a, x86,
   x86_64); Play serves per-device splits from the one AAB.
2. Output: `src-tauri/gen/android/app/build/outputs/bundle/universalRelease/`
   (path may vary) — a signed `.aab` if A4 is wired.

**Acceptance:** a single signed `.aab` exists and installs via
`bundletool build-apks` + `install-apks` on a device.

### A6. In-app third-party attributions — [repo]

A redistribution obligation (Apache-2.0 §4 for qpdf's NOTICE; OFL-1.1 §2 for
the bundled fonts). Add an in-app **Licenses / Attributions** screen (or a
bundled `NOTICES` view) listing: tesseract.js (Apache-2.0), qpdf via
@neslinesli93/qpdf-wasm (qpdf Apache-2.0 + its NOTICE), pdf-lib,
@pdf-lib/fontkit, pdfjs-dist (Apache-2.0), perfect-freehand, zustand, i18next,
the @fontsource OFL fonts, and Liberation Sans/Serif (OFL-1.1, license already
at `src/assets/fonts/LICENSE`).

**Acceptance:** the app has a reachable Licenses screen; the privacy policy's
reference to it is accurate.

### A7. Store listing assets — [repo drafts, you approve]

- **Icon** 512×512 (from `build/icon.png`).
- **Feature graphic** 1024×500 (render from branding).
- **Phone screenshots** ≥ 2 (the CDP emulation harness produces clean
  1080×2400 captures; use the sign + edit + OCR flows).
- **Copy** (localize in the 6 shipped languages — Play supports per-language
  listings):
  - Title ≤ 30 chars, e.g. "DocuDesk: Sign & Edit PDFs".
  - Short description ≤ 80 chars.
  - Full description ≤ 4000 chars — lead with bulk signing, smart detect, OCR
    on scans, full edit mode, and the differentiators: **free, offline, no
    ads, no data collected**.

**Acceptance:** all required assets uploaded; listing preview looks right.

### A8. Play Console content forms — [you, with drafts from A7]

- **Privacy policy** URL (A2).
- **Data safety:** "No data collected", "No data shared". (If A3 is done, the
  no-permissions state supports this cleanly.)
- **Content rating** questionnaire → Everyone.
- **Target audience:** 13+ (not a kids' app).
- **Ads:** "No ads."
- **Pricing:** Free (all countries).

**Acceptance:** all "App content" sections show green/complete.

### A9. Release flow — [you]

1. **Internal testing** track: upload the AAB, add yourself as tester, install
   via the opt-in link — confirms the Play-signed build works end-to-end
   (Google re-signs; behavior should be identical). **Note the signature
   change:** anyone with the sideloaded GitHub APK must uninstall it before
   installing from Play (signatures can't mix; saved signatures are lost with
   the uninstall).
2. **Closed testing** (personal accounts): promote the build, enroll the 20
   testers, wait the 14 continuous days.
3. Apply for **production**, promote, submit for review (typically 1–7 days
   for a first app).
4. **Updates thereafter:** bump `version` in `tauri.conf.json` + `package.json`,
   rebuild the AAB, upload to the track — minutes.

---

## Workstream B — Engineering follow-ups (not Play blockers)

### B1. ESLint + CI — [repo]

- Add ESLint (typescript-eslint recommended + `eslint-plugin-react-hooks`) and
  an `npm run lint` script. The code is already `any`-free and clean; the
  intentional `// eslint-disable-next-line react-hooks/exhaustive-deps` sites
  are documented. Expect a small pass to green it.
- Add a **GitHub Actions** workflow running `npm ci`, `npm run typecheck`,
  `npm run lint`, and the CDP regression suite on every push — so quality is
  enforced once anyone (including future-you) commits.
- Needs npm installs (do it when the network is stable).

### B2. Split `EditStage.tsx` → then Sign-view zoom (Phase 2) — [repo]

`EditStage.tsx` is ~1,850 lines and is the one oversized file. Extract:
- the pure pixel/colour helpers (`inkFromPixels`, `sample*Color`) into `lib/`,
- the zoom/pan/pinch machinery into a `useZoomPan` hook,
- retype/OCR orchestration into an editor module.

Then **adopt the shared canvas in the Sign view** so it gets zoom/pan too
(this is the "zoom before signing" request) — reconciling pan gestures with
signature-stamp dragging (tap-a-stamp vs pan-empty-paper), the way the edit
view already does. Extraction is the enabler; Sign adoption is a second step.
Do this as its own carefully-tested pass — the gesture code was hardened over
many releases and must not be re-forked.

### B3. Desktop auto-update — [repo]

- **Electron:** `electron-updater` with the GitHub releases provider in
  `electron-builder.yml`; check on launch, notify, download, install on quit.
- **Tauri (Lite/Android):** the Tauri updater plugin against a static
  `latest.json` on GitHub releases (desktop); Android updates come through Play
  once listed.
- Ends the manual download-reinstall loop. Prerequisite already done: v0.1.16
  made in-place updates behave like clean installs (no stale caches).

---

## Workstream C — Roadmap (future, optional)

- **Annotation tap-to-edit** — convert a tapped annotation into an editable
  retype box (flatten-then-retype in one tap).
- **More OCR languages** — bundle/optionally-download additional traineddata
  (incl. Sinhala/Arabic scripts, which also need shaping — see below).
- **Complex-script shaping** — HarfBuzz-wasm so Sinhala/Arabic/Indic typed text
  renders correctly (currently warned).
- **Cryptographic signatures (PAdES)** — certificate-based digital signatures
  with timestamping, beyond the current visual signature.
- **Signature export/import** — so switching install channels (sideload → Play)
  doesn't lose saved signatures.
- **iOS build** — same Tauri project, needs a macOS + Xcode machine and an
  Apple Developer account.

---

## Recommended sequence

1. **[you] A1** (account signup + verification) — start today; it gates
   everything and is the slowest.
2. In parallel, **[repo]** A3 (remove INTERNET), A4 (signing config), A5 (AAB),
   A6 (attributions) — the buildable deliverables.
3. **[you]** A2 (privacy URL), A7 approval, A8 (forms).
4. **[you]** A9: internal test → recruit 20 → closed test (14 days) →
   production.
5. After launch: **B1** (ESLint/CI), then **B3** (auto-update), then **B2**
   (EditStage split + Sign zoom) as a dedicated pass.

Rough effort for the repo side of A (A3–A6): ~1–2 focused sessions. The
calendar time to production is dominated by account verification + the 14-day
closed test, not by code.

---

## Decisions needed from you

- [ ] Personal vs organization Play account (drives the 20-tester/14-day rule).
- [ ] Public contact email for the privacy policy + Console.
- [ ] Upload-key password custody (you hold it; I generate the key on request).
- [ ] Confirm the app stays free with no ads/IAP/analytics (assumed throughout).
- [ ] Final app title / short description wording.

## Risk register

- **INTERNET removal unverifiable in-harness** — must be device-tested (A3).
  Mitigation: test on a real phone via the internal-testing track before
  production.
- **Signature change on channel switch** — sideload → Play requires an
  uninstall; document it in the listing / release notes so testers aren't
  surprised, and consider B/C signature export/import before wide rollout.
- **App name collision** — "DocuDesk" may be taken on Play; the listing title
  can differ from the package id `com.docudesk.lite` (which is permanent) —
  check name availability early in A1.
- **Regenerating `gen/android`** wipes manual manifest/signing edits — keep A3
  and A4 changes documented so they can be re-applied.
