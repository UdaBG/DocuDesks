# Sign the release APK with a locally generated keystore so it installs on devices.
# For Play Store distribution, generate a proper upload key and keep it safe.
$ErrorActionPreference = 'Stop'
$java = "$env:LOCALAPPDATA\Java\jdk-21"
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
$ks = "C:\Signer\src-tauri\signer-local.jks"
$pass = 'signer-local-dev'

$apkDir = 'C:\Signer\src-tauri\gen\android\app\build\outputs\apk\universal\release'
# Before the Play upload key existed, Gradle emitted *-unsigned.apk; with
# keystore.properties present it emits an upload-key-signed APK instead.
# Sideload builds must KEEP the local dev key (phones refuse to update across
# a signature change), so re-sign whichever file Gradle produced.
$unsigned = Get-ChildItem $apkDir -Filter '*-unsigned.apk' | Select-Object -First 1
if (-not $unsigned) {
  $unsigned = Get-ChildItem $apkDir -Filter 'app-universal-release.apk' | Select-Object -First 1
}
if (-not $unsigned) { throw "no release APK found in $apkDir" }

if (-not (Test-Path $ks)) {
  & "$java\bin\keytool.exe" -genkeypair -v -keystore $ks -alias signer -keyalg RSA -keysize 2048 -validity 10000 `
    -storepass $pass -keypass $pass -dname 'CN=Signer Local' | Out-Null
  Write-Output "keystore created: $ks"
}

$ver = (Get-Content 'C:\Signer\src-tauri\tauri.conf.json' -Raw | ConvertFrom-Json).version
$out = Join-Path $apkDir "DocuDesk_Lite_${ver}_arm64-signed.apk"
Copy-Item $unsigned.FullName $out -Force
& "$sdk\build-tools\34.0.0\apksigner.bat" sign --ks $ks --ks-pass "pass:$pass" --key-pass "pass:$pass" $out
& "$sdk\build-tools\34.0.0\apksigner.bat" verify $out
Write-Output "SIGNED APK: $out"
