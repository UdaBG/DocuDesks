# Per-user Android toolchain for Tauri: JDK 21 + cmdline-tools + SDK + NDK.
# Idempotent: safe to re-run; each step is skipped when already present.
$ErrorActionPreference = 'Stop'
$java = "$env:LOCALAPPDATA\Java\jdk-21"
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
$ndkVersion = '27.2.12479018'

# --- 1. Microsoft OpenJDK 21 (zip, no elevation) ---------------------------
if (-not (Test-Path "$java\bin\java.exe")) {
  New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\Java" | Out-Null
  $zip = "$env:TEMP\msjdk21.zip"
  if (-not (Test-Path $zip)) {
    Invoke-WebRequest -Uri 'https://aka.ms/download-jdk/microsoft-jdk-21-windows-x64.zip' -OutFile $zip
  }
  Expand-Archive $zip -DestinationPath "$env:TEMP\msjdk21" -Force
  $inner = Get-ChildItem "$env:TEMP\msjdk21" -Directory | Select-Object -First 1
  Move-Item $inner.FullName $java -Force
}
$env:JAVA_HOME = $java
$env:Path = "$java\bin;$env:Path"
Write-Output "JDK ready: $java"

# --- 2. Android command-line tools ------------------------------------------
$cmdtools = "$sdk\cmdline-tools\latest"
if (-not (Test-Path "$cmdtools\bin\sdkmanager.bat")) {
  New-Item -ItemType Directory -Force "$sdk\cmdline-tools" | Out-Null
  $zip2 = "$env:TEMP\android-cmdtools.zip"
  if (-not (Test-Path $zip2)) {
    Invoke-WebRequest -Uri 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip' -OutFile $zip2
  }
  Expand-Archive $zip2 -DestinationPath "$env:TEMP\android-cmdtools" -Force
  Move-Item "$env:TEMP\android-cmdtools\cmdline-tools" $cmdtools -Force
}
Write-Output "cmdline-tools ready"

# --- 3. Licenses + components ------------------------------------------------
# Feed the license prompts through a real stdin redirect via cmd — piping from
# PowerShell does not reliably reach the JVM under sdkmanager.bat.
$yesFile = "$env:TEMP\sdk-yes.txt"
Set-Content -Path $yesFile -Value (@('y') * 60) -Encoding ascii
cmd /c "`"$cmdtools\bin\sdkmanager.bat`" --sdk_root=$sdk --licenses < `"$yesFile`"" | Select-Object -Last 2
Write-Output "licenses accepted"
cmd /c "`"$cmdtools\bin\sdkmanager.bat`" --sdk_root=$sdk platform-tools `"platforms;android-34`" `"build-tools;34.0.0`" `"ndk;$ndkVersion`" < `"$yesFile`"" |
  ForEach-Object { if ($_ -notmatch '^\[=*\s*\]') { $_ } }
Write-Output "SDK components installed"

# --- 4. Persist env for future shells ---------------------------------------
[Environment]::SetEnvironmentVariable('JAVA_HOME', $java, 'User')
[Environment]::SetEnvironmentVariable('ANDROID_HOME', $sdk, 'User')
[Environment]::SetEnvironmentVariable('NDK_HOME', "$sdk\ndk\$ndkVersion", 'User')
Write-Output "ANDROID SETUP DONE"
