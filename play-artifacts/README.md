# Play Store artifacts

The current Android App Bundle for Google Play Console uploads.

| File | versionName | versionCode | Signed by |
|---|---|---|---|
| `DocuDesk-1.0.2-play.aab` | 1.0.2 | 1000002 | upload key (`CN=DocuDesk`, `upload-key.jks`) |

- This is the file uploaded under **Play Console → Testing/Production → Create
  release**. Play App Signing re-signs it for distribution, so it is safe to
  keep in the repo — possession does not allow anyone to publish as this app.
- Only the **latest** AAB is kept here (each one adds ~40 MB to the repo's
  history forever; older versions are reproducible from their git tag with
  `npx tauri android build --aab`).
- Built by `npx tauri android build --aab` with
  `src-tauri/gen/android/app/keystore.properties` present (git-ignored — the
  upload key and its password never enter the repo).
