# CI acceptance test for the Windows installer (runs on the GitHub windows-latest runner).
# Installs the built .exe silently, starts the installed app in test mode, drives the engine through
# its local API (import, export), looks at memory use, then uninstalls. Writes smoke-result.txt.
$ErrorActionPreference = 'Continue'
$script:lines = New-Object System.Collections.Generic.List[string]
$script:failed = 0

function Log([string]$m) { $script:lines.Add($m); Write-Host $m }
function Check([bool]$ok, [string]$name, [string]$detail = '') {
  if ($ok) { Log ("PASS  " + $name + " " + $detail) } else { $script:failed++; Log ("FAIL  " + $name + " " + $detail) }
}
function Finish {
  Log ''
  if ($script:failed -eq 0) { Log 'ACCEPTANCE: PASS' } else { Log ('ACCEPTANCE: FAIL (' + $script:failed + ' check(s))') }
  $script:lines | Out-File -FilePath 'smoke-result.txt' -Encoding utf8
}

$app = $null
try {
  $inst = Get-ChildItem 'src-tauri\target\release\bundle\nsis' -Filter *.exe | Select-Object -First 1
  if (-not $inst) { throw 'no installer was built' }
  Log ('installer: ' + $inst.Name + ' (' + [math]::Round($inst.Length / 1MB, 1) + ' MB)')

  # ---- install silently
  $p = Start-Process -FilePath $inst.FullName -ArgumentList '/S' -Wait -PassThru
  Check ($p.ExitCode -eq 0) 'silent install exits 0' ('exit=' + $p.ExitCode)
  $dir = $null
  foreach ($cand in @((Join-Path $env:LOCALAPPDATA 'Lite Editor'), (Join-Path $env:LOCALAPPDATA 'Programs\Lite Editor'))) {
    if (Test-Path $cand) { $dir = $cand; break }
  }
  if (-not $dir) { throw 'install folder not found' }
  Log ('install folder: ' + $dir)
  $sizeMB = [math]::Round(((Get-ChildItem $dir -Recurse -File | Measure-Object Length -Sum).Sum) / 1MB, 0)
  Log ('installed size: ' + $sizeMB + ' MB')
  foreach ($f in @('ffmpeg\ffmpeg.exe', 'ffmpeg\ffprobe.exe', 'ui\main.js', 'ui\index.html', 'stock\index.json', 'THIRD_PARTY_LICENSES.txt')) {
    Check (Test-Path (Join-Path $dir $f)) ('installed file ' + $f)
  }

  # ---- start the installed app in test mode
  $exe = Get-ChildItem $dir -Filter *.exe | Where-Object { $_.Name -notlike 'uninstall*' } | Select-Object -First 1
  if (-not $exe) { throw 'app executable not found' }
  $env:LITE_TEST_PORT = '47871'
  $env:LITE_TEST_TOKEN = 'citest'
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $app = Start-Process -FilePath $exe.FullName -PassThru
  $base = 'http://127.0.0.1:47871'
  $up = $false
  $ws = $null
  $html = ''
  for ($i = 0; $i -lt 60 -and -not $up; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $r = Invoke-WebRequest -Uri ($base + '/?t=citest') -UseBasicParsing -SessionVariable s1 -TimeoutSec 3
      if ($r.StatusCode -eq 200) { $up = $true; $ws = $s1; $html = [string]$r.Content }
    } catch { }
  }
  $sw.Stop()
  Check $up 'installed app answers on its local port' ('after ' + [math]::Round($sw.Elapsed.TotalSeconds, 1) + ' s')
  if (-not $up) { throw 'the app did not start' }

  Check ($html -match 'main\.js') 'home page references main.js'
  $js = Invoke-WebRequest -Uri ($base + '/main.js') -UseBasicParsing -WebSession $ws
  Check (($js.StatusCode -eq 200) -and (([string]$js.Content).Length -gt 5000)) 'main.js is served' ([string]([string]$js.Content).Length + ' chars')

  Start-Sleep -Seconds 5
  $app.Refresh()
  Check (-not $app.HasExited) 'app process is still running'
  Log ("main window title: '" + $app.MainWindowTitle + "'")
  Check ($app.MainWindowTitle -like '*Lite Editor*') 'app window is open'

  # ---- memory use of the running app and its webview
  $wv = @(Get-Process -Name msedgewebview2 -ErrorAction SilentlyContinue)
  $wvMB = 0
  if ($wv.Count -gt 0) { $wvMB = [math]::Round((($wv | Measure-Object WorkingSet64 -Sum).Sum) / 1MB, 0) }
  $appMB = [math]::Round($app.WorkingSet64 / 1MB, 0)
  Log ('memory at idle: app ' + $appMB + ' MB, webview ' + $wv.Count + ' processes ' + $wvMB + ' MB, total ' + ($appMB + $wvMB) + ' MB')

  function Api([string]$cmd, $body = @{}) {
    $json = $body | ConvertTo-Json -Depth 30 -Compress
    $r = Invoke-RestMethod -Method Post -Uri ($base + '/api/' + $cmd) -Body $json -WebSession $ws -ContentType 'application/json'
    if (-not $r.ok) { throw ('api ' + $cmd + ' failed: ' + $r.error) }
    return $r.data
  }

  # ---- engine and bundled ffmpeg
  $si = Api 'sys_info'
  Check ($si.os -eq 'windows') 'engine reports windows' ([string]$si.os)
  Check ($null -ne $si.ffmpeg) 'bundled ffmpeg runs' ([string]$si.ffmpeg)
  Log ('usable video encoders: ' + (@($si.encoders) -join ', '))
  Check (@($si.encoders).Count -ge 1) 'at least one video encoder works'

  # ---- make a clip, import it, export a project with a clip and a text overlay
  $ff = Join-Path $dir 'ffmpeg\ffmpeg.exe'
  $fp = Join-Path $dir 'ffmpeg\ffprobe.exe'
  $clip = Join-Path $env:TEMP 'ci-clip.mp4'
  & $ff -hide_banner -loglevel error -y -f lavfi -i 'testsrc2=s=640x360:r=30:d=3' -f lavfi -i 'sine=f=440:d=3' -c:v mpeg4 -q:v 4 -c:a aac -shortest $clip
  Check (Test-Path $clip) 'test clip created'

  $imp = Api 'media_import' @{ paths = @($clip) }
  $item = $imp.items[0]
  Check ((-not $item.error) -and ($item.kind -eq 'video')) 'import reads the clip' ([string]$item.error)

  $doc = Api 'project_new' @{ name = 'ci'; width = 640; height = 360; fps = 30 }
  $adj = [pscustomobject]@{ brightness = 0; contrast = 1; saturation = 1; hue = 0; warmth = 0; blur = 0 }
  $doc.media = @($item)
  $v1 = $doc.tracks | Where-Object { $_.id -eq 't-v1' }
  $v1.clips = @([pscustomobject]@{ id = 'c1'; media = $item.id; start = 0; dur = 3000000; 'in' = 0; speed = 1; x = 0; y = 0; scale = 1; rot = 0; opacity = 1; mirror = $false; volume = 1; fade_in = 0; fade_out = 0; adj = $adj })
  $tt = $doc.tracks | Where-Object { $_.id -eq 't-text' }
  $txt = [pscustomobject]@{ content = 'CI test'; size = 0.1; color = '#ffffff'; bold = $true; outline = $true; shadow = $false; boxed = $false }
  $tt.clips = @([pscustomobject]@{ id = 'c2'; start = 500000; dur = 2000000; 'in' = 0; speed = 1; x = 0; y = 0; scale = 1; rot = 0; opacity = 1; mirror = $false; volume = 1; fade_in = 0; fade_out = 0; adj = $adj; text = $txt })

  $outFile = Join-Path $env:TEMP 'ci-export.mp4'
  Remove-Item $outFile -ErrorAction SilentlyContinue
  $job = Api 'export_start' @{ doc = $doc; settings = @{ path = $outFile; width = 640; height = 360; fps = 30; quality = 'low'; encoder = 'auto'; audio_only = $false } }
  $state = 'running'
  $st = $null
  for ($i = 0; $i -lt 180; $i++) {
    Start-Sleep -Seconds 1
    $st = Api 'job_status' @{ id = $job.job }
    $state = [string]$st.state
    if ($state -ne 'running') { break }
  }
  Check ($state -eq 'done') 'export finishes' ('state=' + $state + ' ' + [string]$st.message)
  $exists = Test-Path $outFile
  Check ($exists -and ((Get-Item $outFile).Length -gt 10000)) 'export file written'
  if ($exists) {
    $probe = & $fp -v error -show_entries stream=codec_name,codec_type,width,height -of csv=p=0 $outFile
    Log ('exported streams: ' + (@($probe) -join ' | '))
    Check ((@($probe) -join ' ') -match 'video') 'export has video'
    Check ((@($probe) -join ' ') -match 'audio') 'export has audio'
    $sig = (& $ff -v error -ss 1 -i $outFile -frames:v 1 -vf 'signalstats,metadata=print:file=-' -f null - 2>&1) | Out-String
    $m = [regex]::Match($sig, 'YAVG=([0-9.]+)')
    Check ($m.Success -and ([double]$m.Groups[1].Value -gt 15)) 'export frame is not black' ($m.Value)
  }

  # ---- memory again, after the work
  $wv2 = @(Get-Process -Name msedgewebview2 -ErrorAction SilentlyContinue)
  $wvMB2 = 0
  if ($wv2.Count -gt 0) { $wvMB2 = [math]::Round((($wv2 | Measure-Object WorkingSet64 -Sum).Sum) / 1MB, 0) }
  $app.Refresh()
  Log ('memory after export: app ' + [math]::Round($app.WorkingSet64 / 1MB, 0) + ' MB, webview ' + $wvMB2 + ' MB')
}
catch {
  Check $false 'script error' ($_.Exception.Message)
}
finally {
  try {
    if ($app -and -not $app.HasExited) { Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue }
    Get-Process -Name msedgewebview2 -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    $dir2 = Join-Path $env:LOCALAPPDATA 'Lite Editor'
    $un = Get-ChildItem $dir2 -Filter 'uninstall*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($un) {
      $u = Start-Process -FilePath $un.FullName -ArgumentList '/S' -Wait -PassThru
      Log ('uninstall exit code: ' + $u.ExitCode)
      Start-Sleep -Seconds 4
      Log ('install folder removed after uninstall: ' + (-not (Test-Path (Join-Path $dir2 'ui\main.js'))))
    }
  } catch { Log ('cleanup note: ' + $_.Exception.Message) }
  Finish
}
exit 0
