<#
.SYNOPSIS
  qywork 一键启动。

.DESCRIPTION
  两种模式：

    desktop（默认）  Tauri 原生窗口。dev.ts 从源码启动 qy sidecar；前后端源码变化
                     共用同一个空闲替换判定，不会在 run 运行中更新为两个版本。
    web              浏览器。与桌面模式共用 dev.ts 的进程、代码替换与更新管理，
                     输出带令牌的地址并自动打开浏览器。

  两种模式都会先结束 5180 与 7717 上残留的开发进程。原因：上一次未完全
  退出的 vite 仍占用 5180 时，新的 vite 顺延到 5181，而 Tauri 的 devUrl
  仍指向 5180，报错显示无法连接 dev server，误导排查方向。

.EXAMPLE
  .\scripts\start.ps1
  .\scripts\start.ps1 -Mode web
  .\scripts\start.ps1 -SkipInstall
#>
[CmdletBinding()]
param(
  [ValidateSet('desktop', 'web')]
  [string]$Mode = 'desktop',

  # 跳过依赖检查（node_modules 已安装且需要快速启动时使用）
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

# --- 端口清理 -----------------------------------------------------------------
# 只清理开发进程（node / bun / vite / qy / qywork）。端口被其他进程占用时停止并
# 报告给用户：由脚本推测并结束进程，比端口冲突本身危险得多。
function Clear-DevPort([int]$Port) {
  $conns = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  foreach ($c in $conns) {
    $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    $name = if ($proc) { $proc.ProcessName } else { '<已退出>' }
    if ($proc -and $proc.ProcessName -notin @('node', 'bun', 'vite', 'qy', 'qywork')) {
      throw "端口 $Port 被 $name (pid $($c.OwningProcess)) 占用，判定不是 qywork 的开发进程，脚本不结束该进程。请自行确认后处理。"
    }
    Warn "端口 $Port 被 $name (pid $($c.OwningProcess)) 占用，正在结束该进程"
    try { Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop } catch { }
  }
  if ($conns.Count) { Start-Sleep -Milliseconds 500 }
}

# 上一次未完全退出的桌面外壳。
#
# 它不占用 5180，也不占用固定端口（sidecar 使用 --port 0），因此端口清理无法发现它。
# 但它持有 `.tmp\cargo-target\debug\qy.exe` 的文件句柄：tauri-build 需要把新的 sidecar
# 复制到该位置，复制失败后整个 dev 构建以 exit 101 退出，报错只有一句
# 「拒绝访问」，无法看出与上一个仍在运行的窗口有关。已实测复现。
#
# 只清理本仓库 target 目录下的两个可执行文件，路径不匹配的同名进程一律不处理：
# 本机可能安装了正式版 qywork。
function Clear-StaleShell {
  $root = (Resolve-Path $PSScriptRoot\..).Path
  foreach ($p in @(Get-Process qywork, qy -ErrorAction SilentlyContinue)) {
    $path = try { $p.Path } catch { $null }
    if ($path -and $path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
      Warn "上一次的 $($p.ProcessName) (pid $($p.Id)) 仍在运行，占用 .tmp\cargo-target\debug 中的文件，正在结束该进程"
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
  throw "PATH 上未找到 bun。请安装：https://bun.sh （或 ``irm bun.sh/install.ps1 | iex``）"
}

if (-not $SkipInstall -and -not (Test-Path (Join-Path $root 'node_modules'))) {
  Say '首次运行，正在安装依赖（bun install）…'
  & $bunExe install
  if ($LASTEXITCODE -ne 0) { throw 'bun install 失败' }
}

if (-not (Test-Path (Join-Path $root 'node_modules\.bin'))) {
  Warn 'node_modules 可能不完整，建议手动运行一次 bun install'
}

$configFile = if ($env:QYWORK_HOME) {
  Join-Path $env:QYWORK_HOME 'config.json'
} else {
  Join-Path $env:USERPROFILE '.qywork\config.json'
}
if (-not (Test-Path $configFile)) {
  Warn "尚无配置文件 $configFile"
  Warn '请先运行：bun run packages/cli/src/index.ts init'
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
