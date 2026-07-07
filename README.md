# DocuDesk

**Sign one, sign them all.** DocuDesk (formerly Signer) is an installable desktop app for bulk-signing PDF documents: load a stack of PDFs (for example the same form filled in by many people), place your signature once on the top document, and every document in the stack is signed in the same spot — or let **Smart detect** find the signature line in each document automatically.

![stack](docs/screenshot-placeholder.png)

## Features

- **Bulk signing** — add any number of PDFs (file dialog, drag & drop anywhere, or command line). The preview shows the top of the stack with the count of documents beneath; one click signs them all.
- **Manual mode** — drag the signature anywhere on the preview, resize with the corner handle, choose first/last/specific page. The same page-relative placement is applied to every document, so mixed page sizes still line up.
- **Smart detect mode** — scans each document for AcroForm signature fields, signature-related labels in 10+ languages (`Signature`, `Unterschrift`, `Firma`, `Assinatura`, `Underskrift`, `අත්සන`, …) and ruled/underscore signing lines, then proposes a per-document placement. Any single document's proposal can be corrected by dragging without affecting the rest. **Scanned documents work too**: pages without a text layer are read with bundled OCR (tesseract.js, offline) and ruled lines are found in the bitmap itself.
- **Three ways to create a signature**
  - **Draw** — pressure-sensitive smooth strokes (mouse, trackpad, pen) via perfect-freehand.
  - **Photo** — photograph your signature on paper; an illumination-map extraction (adaptive to shadows and uneven lighting) lifts only the ink onto a transparent background, with sliders for ink pickup and speckle clean-up, keeping the original ink colour or re-inking it.
  - **Type** — type your name and pick one of five script faces (Great Vibes, Dancing Script, Sacramento, Caveat, Homemade Apple).
- **Signature manager** — save multiple signatures (stored per-user in `%APPDATA%/signer/signatures.json`), switch the active one, delete old ones.
- **Multi-language UI** — English, සිංහල, Deutsch, Français, Español, Svenska; auto-detected from the OS, switchable in the top bar, persisted.
- **Safe output** — originals are never modified; signed copies are written as `name_signed.pdf` to a folder you choose, with automatic de-duplication of file names.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Shell | **Electron 43** (primary desktop) and Tauri 2 (mobile + lightweight desktop) | Electron pins its own Chromium: trackpad pinch zoom, the full installed-font list, and the screen eyedropper all work, and behavior is identical on every machine. Tauri's WebView2 shell is 3.7 MB but inherits WebView2 gaps (no pinch-to-page, font-access permission hangs); it remains the build path for **Android/iOS** |
| UI | React 19 + TypeScript + Vite 8 | Fast, typed, hot-reload dev loop |
| State | Zustand | Tiny, no boilerplate |
| PDF render | pdf.js (worker inlined, shared worker thread) | Crisp DPI-aware previews |
| PDF write | pdf-lib | Pure-JS stamping, no native deps |
| i18n | i18next / react-i18next | Plurals, interpolation, 6 locales |
| Drawing | perfect-freehand | Natural variable-width ink |

The entire feature core (`src/`) is a portable web app behind a 14-function platform
interface (`SignerApi`). Electron implements it in a preload bridge
(`electron/preload.ts`); Tauri implements it with plugins
(`src/platform/tauriApi.ts`) — the right one is picked at runtime, so both shells
share one build of the UI. The Tauri project (`src-tauri/`) is also the basis for
the planned mobile app (`tauri [android|ios] init`).

## Getting started

```powershell
npm install
npm run dev          # Electron dev app with hot reload (Node only) — primary
npm run dev:tauri    # Tauri dev app (needs Rust + MSVC Build Tools)
npm run samples      # generate sample filled forms into samples/
npm run build        # typecheck + production bundles
npm run dist         # Electron NSIS installer -> release/DocuDesk-Setup-x.y.z.exe  (primary)
npm run dist:tauri   # Tauri NSIS installer -> src-tauri/target/release/bundle/nsis/ (lightweight)
```

## Integrating Signer with other apps

- **Command line / file association** — any app can hand documents to Signer:
  ```powershell
  DocuDesk.exe form1.pdf form2.pdf form3.pdf
  ```
  If Signer is already running, the files are forwarded into the running window (single-instance). `.pdf` "Open with → Signer" is registered by the installer.
- **Preset output folder** — set `SIGNER_OUTPUT_DIR` to skip the output-folder dialog (useful for scripted flows):
  ```powershell
  $env:SIGNER_OUTPUT_DIR = 'C:\Signed'; DocuDesk.exe C:\Forms\*.pdf
  ```
- **Automation hook** — the renderer exposes `window.__signerStore` (Zustand store), which drives every feature programmatically. `scripts/e2e.mjs` shows a complete headless run over the Chrome DevTools Protocol: load documents → create a signature → smart detect → sign all → verify output.

## Edit mode

The top-bar switch toggles between **Sign** and **Edit**. Edit mode is a full
page editor on the selected document:

- **Retype text** — click any existing text; it is covered (whiteout) and
  replaced with an editable text box prefilled with the original string, in a
  matched font (exact installed family from the PDF font name when possible,
  bold/italic detected) and the original ink color (sampled from the page).
  On scanned pages the clicked text is recognized with the bundled OCR and
  the cover is toned to match the scan's paper, not pure white.
  Re-clicking a retyped area edits the existing box; overlapping hidden runs
  in previously saved edits are deduplicated automatically.

- **Unlock protected PDFs** — files with owner-password protection (view-OK
  but edit-blocked) are flagged; entering Edit offers a one-tap Unlock that
  strips the protection with bundled qpdf-wasm (offline), so the file becomes
  fully editable and signable. The original on disk is never modified.

  ⚠️ Like all cover-based editors, the original text remains in the file
  underneath the cover — it is still selectable and searchable. Retype is for
  corrections, **not redaction**. Do not use it to remove sensitive data.
- **Text** in any installed font (standard PDF fonts plus real Windows faces
  like Arial/Calibri/Segoe UI, embedded into the file), any size and color.
- **Pen** (pressure-smoothed ink), **rectangle / ellipse / line / arrow** with
  stroke, fill, width and opacity; **whiteout eraser** for covering content.
- **Pages** — add blank, duplicate (with its edits), delete, reorder.
- **Watermark** — text, size, angle, opacity, color, optional tiling; applied
  to every page on save; removable until saved. Pre-existing watermarks can be
  covered with the whiteout tool.
- **Merge PDFs** into a new document; **duplicate documents** from the list.
- **Undo/redo** (Ctrl+Z / Ctrl+Y), delete selected object with Del.
- **Save edited PDF** writes a `_edited.pdf` copy; **Apply to stack** replaces
  the in-memory document so you can bulk-sign the edited version immediately.

## How smart detect works

For every page of every document, three kinds of evidence are collected and scored:

1. **AcroForm signature fields** (`/Sig` widgets) — strongest signal, exact rectangle.
2. **Widget fields** whose names mention signing.
3. **Text evidence** — signature labels in many languages and ruled `______` / dotted lines. Labels with room to their right get the signature on the line beside them; labels under a line get it above; long sentences that merely contain the word are down-weighted. Later pages and the bottom half of a page get a bonus (forms are signed at the end).

The best-scoring candidate becomes that document's proposal. Documents with no evidence are marked "No spot found", are skipped when signing, and can be placed manually.

## Project layout

```
electron/          main process (window, IPC, single-instance CLI) + preload bridge
src/
  components/      TopBar, DocumentList, Stage (preview + stack + drag), RightPanel,
                   SignatureStudio (Draw / Photo / Type), ActionBar, ResultOverlay
  lib/             pdf.ts (pdf.js worker mgmt), pdfSign.ts (pdf-lib stamping),
                   smartDetect.ts, extractSignature.ts (photo pipeline),
                   typedSignature.ts, drawing.ts, imageUtils.ts
  i18n/            en, si, de, fr, es, sv
  store.ts         app state + bulk-signing pipeline
scripts/           dev runner, esbuild, icon/sample generators, CDP e2e drivers
```

## Mobile (Android)

The Tauri project doubles as the Android app. The UI switches to a phone layout
below 760 px: bottom tab navigation (Documents / Sign / Signatures), full-width
action button, full-screen signature studio. Mobile file flows differ from
desktop: PDFs come in through the system document picker, and signed copies are
written to the app's storage (`chooseOutputDir` resolves it automatically —
there are no folder pickers on Android).

One-time setup (all per-user, no admin): `scripts/setup-android.ps1` installs
JDK 21, the Android SDK and the NDK, then:

```powershell
npx tauri android init      # generates src-tauri/gen/android
npx tauri android build --apk --target aarch64   # release APK (unsigned)
scripts/sign-apk.ps1        # sign with a local dev keystore -> installable APK
npx tauri android dev       # run on a connected device/emulator
```

Building on Windows requires Developer Mode (Tauri symlinks the built
library into the Gradle project). The dev keystore in `scripts/sign-apk.ps1`
is for sideloading only — generate a proper upload key for Play Store releases.

iOS uses the same project (`npx tauri ios init`) but must be built on macOS
with Xcode. All mobile icons are already generated in `src-tauri/icons/`.

## Roadmap

**Next up**

- **Desktop auto-update** — the Electron build should check GitHub releases
  and update itself (electron-updater); the Android app should at least
  notify when a newer APK exists. Ends the manual download-reinstall loop.
- **Annotation editing** — text added on top of a page by other apps (FreeText
  notes, stamps, filled form fields) lives in the annotation layer, not the
  page content. Since 0.1.4 it is flattened on save so covers work and looks
  identical, but editing it directly needs a save/reopen round-trip. Plan:
  tapping an annotation in edit mode converts it on the spot — remove the
  annotation and open the existing retype box prefilled with its text.
- **Flatten annotations when signing** — the sign pipeline should flatten the
  way the editor does, so a placed signature can never be painted over by an
  annotation sitting above the page content.
- **Bundled fallback fonts on Android** — retype matches installed fonts via
  `queryLocalFonts`, which only exists on desktop; mobile retype falls back to
  the standard PDF fonts. Ship a small set of metric-compatible faces.
- **Complex-script text** (සිංහල, Arabic, Indic) — pdf-lib does not shape
  glyphs, so typed/retyped text in these scripts renders unshaped; needs a
  shaping engine (HarfBuzz-wasm) or an honest warning in the UI.

**Planned**

- **Google Play release** — full playbook in
  [docs/PLAY_STORE.md](docs/PLAY_STORE.md): developer account, upload
  keystore + AAB signing, privacy policy, store listing in 6 languages,
  internal → closed (20 testers / 14 days) → production flow.
- **More OCR languages** — the bundled model is English ("fast" variant);
  other Latin-script languages mostly work, but dedicated models (and
  Sinhala/Arabic scripts) need their own traineddata, ideally as an optional
  download.
- **Cryptographic signatures (PAdES)** — current signing is visual (an ink
  image, like the "simple electronic signature" in most e-sign tools).
  Certificate-based digital signatures with timestamping are the next layer.
- **Mobile polish** — Android print, share sheet after saving, "open with
  DocuDesk" intent for PDFs, camera capture in the photo signature tab.
- **Distribution** — signed installers (SmartScreen), auto-update, CI that
  runs the CDP regression suite on every push, iOS build (needs macOS).
- **Deep-link protocol** (`docudesk://sign?...`) and a headless CLI mode for
  server-side batch signing.
