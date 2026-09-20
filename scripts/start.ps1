<#
.SYNOPSIS
  qywork 一键启动。

.DESCRIPTION
  两种模式：

    desktop（默认）  Tauri 原生窗口。dev.ts 从源码拉起 qy sidecar；前后端源码变化
                     共用空闲换代闸门，不会在活动 run 中更新成两个版本。
    web              浏览器。与桌面模式共用 dev.ts 的进程、换代和更新管理，
                     打印带令牌的地址并自动开浏览器。

  两种模式都会先把 5180 与 7717 上残留的开发进程清掉——这是实际踩过的
  坑：上一次没退干净的 vite 还占着 5180，新的 vite 顺延到 5181，而 Tauri 的 devUrl
  还指着 5180，报出来的却是「连不上 dev server」，方向完全被带偏。

.EXAMPLE
  .\scripts\start.ps1
  .\scripts\start.ps1 -Mode web
  .\scripts\start.ps1 -SkipInstall
#>
[CmdletBinding()]
param(
  [ValidateSet('desktop', 'web')]
  [string]$Mode = 'desktop',

  # 跳过依赖检查（node_modules 已经装好、想快点起的时候用）
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
trap {
  Write-Host ("启动失败：" + $_.Exception.Message) -ForegroundColor Red
  Read-Host '按回车键关闭' | Out-Null
  exit 1
}
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Say($msg) { Write-Host "  $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "  $msg" -ForegroundColor Yellow }

# --- 端口清场 -----------------------------------------------------------------
# 只清开发进程（node / bun / vite / qy / qywork）。端口被别的进程占着就停下来
# 报给人看——脚本替你猜着杀进程，比端口冲突本身危险得多。
function Clear-DevPort([int]$Port) {
  $conns = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  foreach ($c in $conns) {
    $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    $name = if ($proc) { $proc.ProcessName } else { '<已退出>' }
    if ($proc -and $proc.ProcessName -notin @('node', 'bun', 'vite', 'qy', 'qywork')) {
      throw "端口 $Port 被 $name (pid $($c.OwningProcess)) 占用，不像是 qywork 的开发进程，脚本不动它。请自行确认后处理。"
    }
    Warn "端口 $Port 被 $name (pid $($c.OwningProcess)) 占着，清掉"
    try { Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop } catch { }
  }
  if ($conns.Count) { Start-Sleep -Milliseconds 500 }
}

# 上一次没退干净的桌面壳。
#
# 它不占 5180，也不占固定端口（sidecar 走 --port 0），所以端口清场抓不到它。
# 但它**占着 `.tmp\cargo-target\debug\qy.exe` 的文件句柄**——tauri-build 要把新的 sidecar
# 复制过去，复制失败后整个 dev 构建以 exit 101 退出，报出来的只有一句
# 「拒绝访问」，完全看不出和上一个还在跑的窗口有关。实测踩到过。
#
# 只清本仓 target 目录下的那两个可执行文件，路径不匹配的同名进程一律不动
# ——机器上可能装着正式版 qywork。
function Clear-StaleShell {
  $root = (Resolve-Path $PSScriptRoot\..).Path
  foreach ($p in @(Get-Process qywork, qy -ErrorAction SilentlyContinue)) {
    $path = try { $p.Path } catch { $null }
    if ($path -and $path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
      Warn "上一次的 $($p.ProcessName) (pid $($p.Id)) 还在跑，占着 .tmp\cargo-target\debug 里的文件，清掉"
      try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { }
    }
  }
}

# --- 前置检查 -----------------------------------------------------------------
# npm 的 bun.cmd 只用于定位真实可执行文件，不能作为常驻父进程，否则 Ctrl-C 会等待批处理确认。
function Resolve-Bun {
  $cands = @(
    Get-Command bun -All -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandType -eq 'Application' } |
      Select-Object -ExpandProperty Source
  )
  $hit = $cands | Where-Object { $_ -like '*.exe' } | Select-Object -First 1
  if (-not $hit) { $hit = $cands | Where-Object { $_ -like '*.cmd' -or $_ -like '*.bat' } | Select-Object -First 1 }
  if (-not $hit) { return $null }
  $executable = & $hit --print 'process.execPath'
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw '无法定位 Bun 可执行文件'
  }
  return $executable
}

$bunExe = Resolve-Bun
if (-not $bunExe) {
  throw "PATH 上找不到 bun。装一个：https://bun.sh （或 ``irm bun.sh/install.ps1 | iex``）"
}

if (-not $SkipInstall -and -not (Test-Path (Join-Path $root 'node_modules'))) {
  Say '首次运行，装依赖（bun install）…'
  & $bunExe install
  if ($LASTEXITCODE -ne 0) { throw 'bun install 失败' }
}

if (-not (Test-Path (Join-Path $root 'node_modules\.bin'))) {
  Warn 'node_modules 看起来不完整，建议手动跑一次 bun install'
}

$configFile = if ($env:QYWORK_HOME) {
  Join-Path $env:QYWORK_HOME 'config.json'
} else {
  Join-Path $env:USERPROFILE '.qywork\config.json'
}
if (-not (Test-Path $configFile)) {
  Warn "还没有配置文件 $configFile"
  Warn '先跑一次：bun run packages/cli/src/index.ts init'
}

# --- 启动 ---------------------------------------------------------------------
if ($Mode -eq 'desktop' -and -not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  throw '桌面端需要 Rust；浏览器模式可使用 start.bat web。'
}
Clear-DevPort 5180
Clear-DevPort 7717
if ($Mode -eq 'desktop') { Clear-StaleShell }
Say "以 $Mode 模式启动；关闭终端会结束本实例。"
$devArgs = @((Join-Path $PSScriptRoot 'dev.ts'))
if ($Mode -eq 'web') { $devArgs += '--web' }
& $bunExe @devArgs
if ($LASTEXITCODE -ne 0) { throw "进程退出，退出码 $LASTEXITCODE" }
exit $LASTEXITCODE
