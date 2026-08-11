# DocuDesk — project brief & session handoff

Read this first. It is the working memory for a long-running collaboration;
the "Current state" section says exactly where we are and what is next.

## What this is

**DocuDesk**: a completely **free, fully offline** PDF signing + editing suite.
No ads, no accounts, no analytics, no payments, no INTERNET permission on
Android — ever. That promise is load-bearing (privacy policy, Play data-safety
form, and README all state it).

One React 19 + TypeScript + Vite core is shared by **three artifacts**:

| Artifact | Shell | Windows name | Notes |
|---|---|---|---|
| `npm run dist` | Electron 43 | **DocuDesk** (full) | primary Windows app, ~119 MB |
| `npm run dist:tauri` | Tauri 2 / WebView2 | **DocuDesk Lite** | lightweight Windows, ~9 MB |
| `npx tauri android build` | Tauri 2 / Android WebView | **DocuDesk** (no "Lite" on mobile) | package id `com.docudesk.lite` (permanent, fine) |

Platform differences live behind `SignerApi` (`electron/preload.ts` defines the
interface; `src/platform/tauriApi.ts` implements it for Tauri; runtime pick via
`isTauri()`). The LITE badge shows only on desktop Tauri (`isMobileTauri()`).

- Repo: https://github.com/UdaBG/DocuDesks (releases carry the installers/APKs)
- Privacy policy (live): https://udabg.github.io/DocuDesks/PRIVACY (GitHub Pages from /docs)
- Play listing kit: `store-assets/` (icon, feature graphic, phone + large
  screenshots, `listing.md` with title/short/full copy in 6 languages)
- Play upload bundle: `play-artifacts/` (keep ONLY the latest AAB)
- Plans: `docs/RELEASE_PLAN.md` (Play playbook), `docs/PRIVACY.md`

## Architecture map (where things live)

- `src/store.ts` — sign-side Zustand store (`useApp`): docs, signatures,
  placements, signAll/printAll, smart-detect orchestration, unlock, redetect.
  `finalizedBytesFor(doc)` = edits + signature stamps; ALL save/print paths go
  through it so Sign and Edit outputs never diverge.
- `src/editor/editStore.ts` (`useEdit`) + `src/editor/types.ts` — edit
  sessions, objects, undo. Placements/objects are **page fractions**; text has
  optional `rot` (degrees, clockwise on screen, pivot = nominal center from
  newline-count height; export mirrors with pdf-lib `degrees(-rot)`).
- `src/components/edit/EditStage.tsx` (~2000 lines) — the canvas: zoom/pan/
  pinch/tap gestures (touchesRef/pinchRef/panRef/tapRef + window-level release
  self-healing), retype (incl. vertical text via reading-frame math), OCR
  integration, color sampling. **The most battle-hardened code in the app —
  change with extreme care and run the full gesture battery.**
- `src/components/Stage.tsx` — sign view (stamp drag/resize/rotate, smart hint
  + "Detect again"). No zoom/pan yet (that's the next task).
- `src/lib/pdf.ts` — pdf.js open/render. **`wasmUrl` must point at
  `public/pdfjs-wasm/`** or fax/JPX scans render blank (silent worker failure).
- `src/lib/smartDetect.ts` — signature-spot detection (label/line/field/
  closing evidence; final page gets only +8, strong evidence wins anywhere).
- `src/lib/ocr.ts` (tesseract, bundled, `cacheMethod:'none'`, `?v=` busting),
  `src/lib/unlockPdf.ts` (qpdf-wasm `--decrypt`), `src/lib/pdfSign.ts`
  (applyStamps + `signedName`), `src/editor/exportPdf.ts` (bake edits,
  rotation-aware), `src/lib/fileName.ts` (safeStem/displayNameFromPath),
  `src/lib/pdfFlatten.ts` (annotations flattened so whiteout/stamps win).
- `src/main.tsx` — platform install, **Android pick net** (`__androidPickedFiles`
  with save-suppression guards), **back-button ladder** (`__handleBackButton`),
  and all test hooks (see Testing).
- `src-tauri/gen/android/.../MainActivity.kt` — edge-to-edge insets, textZoom
  pin, activity-result pick net, **onBackPressed → JS ladder**, **VIEW/SEND
  intent handling** ("Open with DocuDesk"), DISPLAY_NAME resolution.
- `src-tauri/src/lib.rs` — pending files, print, `exit_app`.
- i18n: `src/i18n/*.json`, **flat keys**, 6 locales (en de es fr sv si),
  currently 213 keys; `node scripts/check-i18n.mjs` must stay green.

## Build, sign, release

```powershell
npm run typecheck          # tsc
npm run build              # typecheck + renderer + electron main -> dist/, dist-electron/
npm run dist               # Electron installer -> release/DocuDesk-Setup-<v>.exe
npm run dist:tauri         # Lite installer -> src-tauri/target/release/bundle/nsis/
# Android (env vars needed per shell):
$env:JAVA_HOME="$env:LOCALAPPDATA\Java\jdk-21"; $env:ANDROID_HOME="$env:LOCALAPPDATA\Android\Sdk"
$env:NDK_HOME="$env:LOCALAPPDATA\Android\Sdk\ndk\27.2.12479018"
$env:Path="$env:USERPROFILE\.cargo\bin;$env:JAVA_HOME\bin;$env:Path"
npx tauri android build --apk --target aarch64   # sideload APK
npx tauri android build --aab                    # Play bundle (all ABIs)
powershell -ExecutionPolicy Bypass -File scripts\sign-apk.ps1   # re-sign APK
```

**Two signing keys — do not mix them:**
- **Sideload APKs** must keep the local dev key (`CN=Signer Local`,
  `signer-local.jks`) or phones refuse to update. `sign-apk.ps1` re-signs
  whatever Gradle emits. Verify with apksigner: expect `CN=Signer Local`.
- **Play AABs** are auto-signed by Gradle with the upload key (`CN=DocuDesk`,
  `C:\Signer\upload-key.jks` + git-ignored `keystore.properties`). Verify with
  jarsigner: expect `Signed by "CN=DocuDesk"`. Never commit the key.

Version bumps: BOTH `package.json` and `src-tauri/tauri.conf.json`.
Android versionCode = major*1e6 + minor*1e3 + patch (1.1.1 → 1001001) and must
always increase. **The user likes versions whose digits sum to 3** (1.0.2,
1.1.1; 1.2.0 is the natural next).

Releases: idempotent PowerShell scripts (pattern in the scratchpad history —
create release via GitHub API with stored GCM token, upload assets, skip ones
already present; safe to re-run after network failures). Stable releases carry
3 public assets (Electron setup, Lite setup, arm64 APK); the AAB stays out of
public releases but IS committed to `play-artifacts/` (latest only). Test
builds go out as **pre-releases** so "Latest" stays the stable one.
Push pattern (stderr fools `$?`): push, then compare `git rev-parse HEAD` to
`git ls-remote origin -h refs/heads/main` in a retry loop.

## How to test (the regression harness)

Everything is verified end-to-end against the **built Electron app** driven
over CDP. There is no unit-test runner; the suite is `scripts/*.mjs`.

Pattern each script follows: `npm run build` first, then spawn Electron with
`--remote-debugging-port`, connect a WebSocket, `Runtime.evaluate` against the
app, assert on store state / DOM / produced PDFs. Phone layout = 
`Emulation.setDeviceMetricsOverride({width:360|412, height:640..915, deviceScaleFactor:2-3, mobile:true})`;
touch input = `Input.dispatchTouchEvent`. `SIGNER_OUTPUT_DIR=<dir>` env makes
save flows write without dialogs. **Scripts must live in `scripts/`** (bare
imports like `electron` don't resolve from elsewhere).

Window test hooks (installed in `src/main.tsx`): `__signerStore`, `__editStore`
(zustand stores), `__pdfText(bytes)`, `__pdfTextGeom(bytes)` (text + transforms),
`__renderProbe(path, page, extraOpts)` (render + ink %, catches blank renders),
`__pdfDebugProbe(path)` (operator-level), `__makeScannedPdf(lines)` /
`__makeVerticalPdf(label)` / `__makeContractPdf(pages, labelPage)` (fixtures),
`__androidPickedFiles(items)` (pick net), `__handleBackButton()` (back ladder),
`__editGestureDebug()` / `__editScrollDebug()`.

Core battery (run after touching anything central; each prints ALL CHECKS
PASSED / *PASSED*):

```
node scripts/e2e.mjs                # bulk sign, 9 docs, smart mode
node scripts/edit-shot.mjs / edit-shot2.mjs / edit-shot3.mjs   # edit flows
node scripts/ocr-scan.mjs           # scanned-doc retype via OCR
node scripts/vertical-retype.mjs    # rotated text end-to-end
node scripts/retype-fixes.mjs, gesture-heal.mjs, mobile-edit-fixes.mjs, pinch-probe*.mjs  # gestures
node scripts/read-mode.mjs          # Read view: chrome-free, zoom, page nav, edits+stamps composite
node scripts/sign-zoom.mjs          # Sign canvas: tap-vs-slide, crisp zoom, stamp drag 1:1
node scripts/zoom-anchor.mjs        # commit never repositions (pinch across fit, pill bursts)
node scripts/view-continuity.mjs    # page+zoom+center survive Read->Sign->Edit; read default
node scripts/smart-scan-budget.mjs  # OCR budget on multi-page scans; manual->smart retries
node scripts/tools-drawer.mjs       # phone edit tools drawer (veil + back button close)
node scripts/fonts-embed.mjs        # every bundled TTF embeds via pdf-lib (plain Node)
node scripts/smart-letters.mjs, smart-contract.mjs             # detection
node scripts/edit-sign-merge.mjs, edit-save-signature.mjs      # sign+edit merge
node scripts/multi-stamps.mjs, annot-cover.mjs, cover-color.mjs
node scripts/pick-net.mjs, save-suppress.mjs, android-names.mjs  # Android nets
node scripts/back-button.mjs, apply-keeps-view.mjs, tool-hints.mjs
node scripts/typing-space.mjs, unlock-longname.mjs             # phone layout
node scripts/update-data.mjs        # old-version data survives updates
node scripts/wasm-assets.mjs        # pdf.js wasm decoders present + fetchable
node scripts/licenses-check.mjs, blank-undo.mjs, pages-drag.mjs, color-chip.mjs
node scripts/check-i18n.mjs         # locale consistency (214 keys)
```

Diagnostics (take a path arg): `probe-pdf-render.mjs` (render any PDF, ink %),
`probe-pdf-verbose.mjs` (pdf.js in Node, verbosity 5 — how the blank-page bug
was found), `preview.mjs <shot.png> <pdfs...>` (screenshot utility).
Marketing shots: `play-assets.mjs` (phone 1080×1920), `play-assets-large.mjs`
(2560×1440 tablet/Chromebook/XR). Both stash+restore the machine's real
signatures.json — keep that pattern for anything touching %APPDATA%\DocuDesk.

Quirks: run multi-line PowerShell via script files (inline here-strings get
mangled); tests occasionally flake under batch load (re-run in isolation before
believing a failure); `e2e-out*`, `e2e-shots/` are disposable outputs.
Android-only behavior (intents, keyboard, SAF providers) cannot be exercised
here — flag it for the user to verify on-device; they test every build.

## Current state (as of 2026-08-11)

**Play Store**: closed test COMPLETE (all criteria struck through), the
**"Apply for production" button is available** — user was advised to click it
(application review runs in parallel; access ≠ publish). Store listing,
App-content forms, screenshots: all done. Live stable release everywhere:
**v1.1.1** (versionCode 1001001) = rename to "DocuDesk" + back-button ladder +
open-with/share-sheet intake. `play-artifacts/DocuDesk-1.1.1-play.aab`.

**Launch scope decision**: ship the closed-test feedback fixes + Read mode
before the production release (user chose "Fixes + Read mode").

Feedback fixes DONE (each with its own commit + regression script):
1. Blank fax-scan PDFs → bundled `public/pdfjs-wasm/` + `wasmUrl` (also fixes
   OCR on such scans; pdfjs-dist bumped to 6.2.108)
2. Apply-to-stack keeps zoom/scroll/page (`apply-keeps-view.mjs`)
3. Junk-doc-after-save: name-based net suppression (`save-suppress.mjs` case 5)
4. Smart detect: last-page bias fixed + "Detect again" (`smart-contract.mjs`)
5. Tool hints: name + action for all 8 tools ×6 locales (`tool-hints.mjs`)

**Read mode + shared canvas: DONE** (3 commits, full battery green):
1. `useZoomPan` hook (`src/lib/useZoomPan.ts`) — EditStage's zoom/pan/pinch/
   tap machinery extracted verbatim; Edit consumes it, behavior identical.
2. **Read view** (`src/components/ReadStage.tsx`) — Read | Sign | Edit toggle;
   chrome-free reader (no panels/action bar), composites unsaved edits, page
   nav (pill + arrow keys), 2-tab mobile nav with tools-tab guard. Android
   open-with lands in Read (mobile only — `isMobileTauri()` gate in store
   init); i18n `view.read` ×6 (214 keys). Regression: `read-mode.mjs`.
3. **Sign view on the canvas** — zoom/pan before signing; tap-vs-slide on
   empty paper (tap places on pointerup, slide pans), stamp drag ÷
   pendingScale mid-pinch. ⚠ The `.sign-overlay` div is LOAD-BEARING: pdf.js
   re-renders replace the canvas node, and a touch implicitly captured by a
   replaced canvas fires lostpointercapture → self-heal kills the pinch (this
   bug cost a debugging session; Edit/Read overlays dodge it by design).
   `multi-stamps.mjs` now taps via pointer events. Regression: `sign-zoom.mjs`.

Versions bumped to **1.2.0** (versionCode 1002000) in both files. Beware:
PowerShell `Set-Content -Encoding utf8` writes a BOM that breaks vite's
JSON.parse of package.json — write JSON with `UTF8Encoding($false)`.

**⚠ UNPUSHED**: all commits since `c5f4d96` are LOCAL ONLY — the user's
GitHub token expired. They must run `git push origin main` once in their own
terminal (browser re-auth); after that scripted pushes work again. Verify
sync (`git ls-remote origin -h refs/heads/main`) before releasing.

`pinch-probe.mjs` / `pinch-probe2.mjs` run `src-tauri/target/release/
signer.exe` — rebuild Lite first (`npm run dist:tauri`) or they test a stale
binary. probe1 now dispatches trusted ctrl+wheel bursts (what Windows
trackpads really send): WebView2's CDP acknowledges
`Input.synthesizePinchGesture` but delivers NO events — never use it.

**Read mode also composites signature stamps** (`finalizedBytesFor` is the
read preview builder): Edit shows your objects, Sign shows edits + live
stamps, Read shows the final paper. One canvas, three views, one output.

**1.2.0** went out as a GitHub pre-release; the user tested on device and
filed 7 findings — ALL FIXED as **1.2.1** (versionCode 1002001; 1.2.0's
1002000 can't be reused on Play). The fixes, each with its own commit +
regression:
1. App opens in **Read** (store default; scripts set their view explicitly)
2. **Continuity**: page+zoom+viewport-center survive Read↔Sign↔Edit per doc
   (useZoomPan viewMemory; Edit syncs session.pageIndex both ways). Sign
   still jumps to the placement page on signing intents; readers are never
   yanked. Two traps: unmount cleanups run AFTER React nulls DOM refs
   (track state continuously, never measure on exit); mount-time listener
   effects miss containers when a stage first renders empty (callback ref).
3. **Smart detect on scans**: two-pass (cheap sweep, then budgeted OCR:
   last page first, ≤6 pages/25s, early-exit on confident evidence);
   manual→smart retries empty verdicts; addGeneratedDoc/replaceDocBytes
   kick detection in smart mode.
4. **Zoom never repositions**: the sheet fills the sizer top-left (a
   margin:auto sheet centered in the CSS-grown sizer = phantom gutter the
   commit clamps away) + content-anchored commitRender.
5. Tool hints auto-hide after 4.5s (sign hints stay — Detect again lives there)
6. Phone edit tools = slide-in drawer (.tools-host, display:contents on
   desktop; veil + back-button rung closes it)
7. Fonts on phones: bundled Carlito (=Calibri) + Cousine (=Courier New),
   OFL, same file: ids as the Windows fallback; attributions updated.

**NEXT**: build 1.2.1 artifacts (APK sideload key / AAB upload key →
play-artifacts / both installers), cut v1.2.1 GitHub pre-release, user
re-tests on device, uploads AAB to the Play closed track (testers verify →
promote to production), then flip the release to stable/Latest.

Backlog (post-launch 1.2.x/1.3): open user-password PDFs (qpdf `--password`),
encrypt-on-save (qpdf `--encrypt`), performance pass (need tester specifics),
in-app "Send feedback" mailto (udaabhagya@gmail.com), desktop auto-update
(electron-updater + Tauri updater), ESLint + CI, finish EditStage decomposition.

## Working conventions with the user

- They test every build on a real phone and report precisely; give them a
  short on-device checklist per build (things the harness can't verify).
- Be direct and honest ("brutally honest" is their phrase); when they propose
  a design, evaluate it critically before implementing.
- Commit style: detailed messages explaining root cause; end with
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- The app stays free forever — reject anything implying ads/tracking/payment.
- Test builds → GitHub **pre-releases** (stable stays "Latest"); every release
  gets honest, user-readable notes.
