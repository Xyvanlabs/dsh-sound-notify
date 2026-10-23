# dsh-sound-notify 一键验证脚本
#
# 用法（DSH 重启后，在 PowerShell 里跑）：
#   pwsh -File verify.ps1
#   pwsh -File verify.ps1 -BaseUrl http://127.0.0.1:5694
#
# 它做三件事：
#   1. 探活：/sound-notify/state 是否 200 且 subscribed=true
#   2. 自检：POST /test 分别投放「正常结束」「中断」两条事件
#   3. 复核：再读一次 /state，确认 played 计数与 lastEvent 场景对得上
# 真实对话的两次触发（正常结束 / 你按停止）仍需手动做，脚本结尾会给出命令。

param(
  # DSH 每次启动端口都不同，留空则自动从正在运行的宿主进程里探测。
  [string]$BaseUrl = ''
)

if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
  $probe = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*dsh-desktop-host*' }
  foreach ($proc in $probe) {
    $conns = Get-NetTCPConnection -OwningProcess $proc.ProcessId -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::1', '::') }
    foreach ($conn in $conns) {
      $candidate = "http://127.0.0.1:$($conn.LocalPort)"
      try {
        $null = Invoke-RestMethod -Uri "$candidate/sound-notify/state" -TimeoutSec 2
        $BaseUrl = $candidate
        break
      } catch { }
    }
    if ($BaseUrl) { break }
  }
  if (-not $BaseUrl) {
    Write-Host "找不到正在监听的 DSH 宿主（或插件尚未加载）。请手动指定：pwsh -File verify.ps1 -BaseUrl http://127.0.0.1:<端口>" -ForegroundColor Red
    exit 1
  }
  Write-Host "自动探测到宿主：$BaseUrl" -ForegroundColor Cyan
}

$ErrorActionPreference = 'Stop'
$pass = 0
$fail = 0

function Check($label, $ok, $detail) {
  if ($ok) { $script:pass++; Write-Host "PASS  $label" -ForegroundColor Green }
  else { $script:fail++; Write-Host "FAIL  $label  -- $detail" -ForegroundColor Red }
}

Write-Host "`n[1/3] 探测宿主路由  $BaseUrl/sound-notify/state" -ForegroundColor Cyan
try {
  $state = Invoke-RestMethod -Uri "$BaseUrl/sound-notify/state" -TimeoutSec 5
} catch {
  Write-Host "  /state 不可达：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host "  最常见原因：DSH 还没重启。完全退出 DSH 再打开，然后重跑本脚本。" -ForegroundColor Yellow
  exit 1
}

Check '返回 ok=true'          ($state.ok -eq $true)                      ($state | ConvertTo-Json -Compress)
Check "版本 $($state.version)" ($state.version -eq '1.0.0')             "版本= $($state.version)"
Check '已订阅 session/event'  ($state.stats.subscribed -eq $true)       "subscribed= $($state.stats.subscribed)"
Check '子代理默认不发声'      ($state.config.includeSubagents -eq $false) "includeSubagents= $($state.config.includeSubagents)"
Write-Host ("  全局音量={0}  静音={1}  中断音效={2}  结束音效={3}" -f `
  $state.config.volume, $state.config.muted, $state.config.interrupted.sound, $state.config.completed.sound)

$playedBefore = [int]$state.stats.played
$turnsBefore  = [int]$state.stats.turnEnds

Write-Host "`n[2/3] 自检投放三条事件（请先点一下页面任意处，让浏览器获得音频手势权限）" -ForegroundColor Cyan
$r1 = Invoke-RestMethod -Uri "$BaseUrl/sound-notify/test?scene=completed" -Method Post -TimeoutSec 5
Check '投放「正常结束」事件' ($r1.ok -eq $true -and $r1.event.scene -eq 'completed') ($r1 | ConvertTo-Json -Compress)

Start-Sleep -Milliseconds 1200
$r2 = Invoke-RestMethod -Uri "$BaseUrl/sound-notify/test?scene=interrupted" -Method Post -TimeoutSec 5
Check '投放「中断」事件' ($r2.ok -eq $true -and $r2.event.scene -eq 'interrupted') ($r2 | ConvertTo-Json -Compress)

Start-Sleep -Milliseconds 1200
$r3 = Invoke-RestMethod -Uri "$BaseUrl/sound-notify/test?scene=ask" -Method Post -TimeoutSec 5
Check '投放「提问」事件' ($r3.ok -eq $true -and $r3.event.scene -eq 'ask') ($r3 | ConvertTo-Json -Compress)

Write-Host "  应该听到三段：上行两音 → 下行两音 → 下行两音。" -ForegroundColor Yellow

Write-Host "`n[3/3] 复核计数" -ForegroundColor Cyan
Start-Sleep -Milliseconds 800
$after = Invoke-RestMethod -Uri "$BaseUrl/sound-notify/state" -TimeoutSec 5
Check 'played 计数 +3'          ([int]$after.stats.played -eq ($playedBefore + 3)) "before=$playedBefore after=$($after.stats.played)"
Check 'lastEvent 场景=提问'      ($after.stats.lastEvent.scene -eq 'ask')          "scene= $($after.stats.lastEvent.scene)"
Check 'lastEvent kind=awaiting-input' ($after.stats.lastEvent.kind -eq 'awaiting-input') "kind= $($after.stats.lastEvent.kind)"
Check '提问钩子已挂上 user-questions/request' ($after.stats.askSubscribed -eq $true) "askSubscribed= $($after.stats.askSubscribed)"
Check '提问钩子已挂上 tools/pre-execute'     ($after.stats.toolHookSubscribed -eq $true) "toolHookSubscribed= $($after.stats.toolHookSubscribed)"

Write-Host "`n落地日志：$($after.log)" -ForegroundColor DarkGray
if (Test-Path $after.log) {
  Get-Content $after.log -Tail 6 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
}

Write-Host "`n===== 自检 $pass 项通过 / $fail 项失败 =====" -ForegroundColor Cyan
Write-Host @"

接下来手动做两次真实触发（这才是你要的最终验证）：

  A. 正常结束：发一条「回复 OK」，等它答完
     -> 第二次对话开始时，用这条命令确认判成了 completed：
        (Invoke-RestMethod $BaseUrl/sound-notify/state).stats.lastEvent

  B. 中断：发一条要跑一阵的消息（如「把 1 到 100 万逐个平方后求和」），
     跑到一半点停止按钮
     -> lastEvent.scene 应为 interrupted、kind 应为 aborted

两场景的耳朵判据：正常结束是上行两音（明亮），中断是下行两音（沉闷）。
"@ -ForegroundColor Gray

if ($fail -gt 0) { exit 1 }
