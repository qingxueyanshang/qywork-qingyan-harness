<#
.SYNOPSIS
  qywork 一键启动。

.DESCRIPTION
  两种模式：

    desktop（默认）  Tauri 原生窗口。dev.ts 从源码拉起 qy sidecar；前后端源码变化
                     共用空闲换代闸门，不会在活动 run 中更新成两个版本。
    web              浏览器 / 手机。qy serve 固定在 7717，vite 在 5180 代理过去，
                     脚本把带令牌的地址打出来并自动开浏览器。

  两种模式都会先把 5180（web 模式还有 7717）上残留的开发进程清掉——这是实际踩过的
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
# Start-Process 只认真正的可执行文件。npm 装出来的 bun 在 PATH 上有三个同名入口
# （bun.ps1 / bun.cmd / 无扩展名的 shell 脚本），`-FilePath 'bun'` 会挑到最后那个，
# 报「%1 is not a valid Win32 application」。所以这里显式挑 .exe，退而求其次挑 .cmd。
function Resolve-Exe([string]$Name) {
  $cands = @(
    Get-Command $Name -All -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandType -eq 'Application' } |
      Select-Object -ExpandProperty Source
  )
  $hit = $cands | Where-Object { $_ -like '*.exe' } | Select-Object -First 1
  if (-not $hit) { $hit = $cands | Where-Object { $_ -like '*.cmd' -or $_ -like '*.bat' } | Select-Object -First 1 }
  return $hit
}

$bunExe = Resolve-Exe 'bun'
if (-not $bunExe) {
  throw "PATH 上找不到 bun。装一个：https://bun.sh （或 ``irm bun.sh/install.ps1 | iex``）"
}

if (-not $SkipInstall -and -not (Test-Path (Join-Path $root 'node_modules'))) {
  Say '首次运行，装依赖（bun install）…'
  bun install
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

# --- desktop ------------------------------------------------------------------
if ($Mode -eq 'desktop') {
  if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw "桌面端要编译 Rust 外壳，但 PATH 上没有 cargo。装 Rust：https://rustup.rs 。只想先用起来的话跑 -Mode web。"
  }

  Clear-DevPort 5180
  Clear-StaleShell

  # 走 scripts/dev.ts，**不要直接 `tauri dev`**。
  #
  # 直接跑 tauri dev 的话，外壳会 spawn `externalBin` 那个预编译的 bin/qy——
  # 因此改了 packages/server 不重编就完全看不出来，现象还会表现成前端 bug。
  # 实际踩到过：旧二进制少一条路由，前端抛的是 undefined.id；旧二进制还在按
  # 老规矩报协议版本，新前端已经不发这个字段，界面上是「服务端协议版本 2，
  # 客户端 undefined」。dev.ts 让 sidecar 从源码跑并把令牌和端口
  # 灌给两边。前端 HMR 在桌面协调模式下关闭，packages 与 web 源码变化共用同一条
  # 空闲闸门；sidecar 换代后页面再按新 streamId 刷新，不会出现新前端配旧后端。
  #
  # dev.ts 不设 QYWORK_WORKSPACE：当前项目由服务端按账本中最近打开的工作区恢复，
  # 不会把 qywork 源码仓库误登记成用户项目。
  Say 'dev 编排启动中：sidecar 从源码跑，外壳首次编译较慢，之后约 20 秒…'
  Say "工作区 $root"
  Say '窗口出来即可用。Ctrl-C 或关窗口退出，sidecar 会跟着退。'
  Write-Host ''

  bun run dev
  exit $LASTEXITCODE
}

# --- web ----------------------------------------------------------------------
Clear-DevPort 7717
Clear-DevPort 5180

$logDir = Join-Path $root '.tmp\start'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$serveLog = Join-Path $logDir "serve-$PID.log"
if (Test-Path $serveLog) { Remove-Item $serveLog -Force }

$serve = $null
$vite = $null
try {
  Say '起 qy serve (127.0.0.1:7717)…'
  # stdout 重定向是为了抓 `--print-token` 的两行握手输出；stderr 不重定向，
  # 让启动横幅和扫码二维码原样留在这个终端里。
  # --parent-pid 让 sidecar 盯着本脚本：脚本被 Ctrl-C 掉也不会留下孤儿服务。
  $serve = Start-Process -FilePath $bunExe -PassThru -NoNewWindow `
    -ArgumentList 'run', 'packages/cli/src/index.ts', 'serve',
                  '--port', '7717', '--print-token', '--parent-pid', $PID `
    -RedirectStandardOutput $serveLog

  # 等令牌。sidecar 保证这两行在任何装饰性输出之前打出来，格式稳定。
  $token = $null
  for ($i = 0; $i -lt 60 -and -not $token; $i++) {
    if ($serve.HasExited) { throw "qy serve 启动即退出（exit $($serve.ExitCode)），看上面的报错。" }
    if (Test-Path $serveLog) {
      $line = Select-String -Path $serveLog -Pattern '^QYWORK_TOKEN=(.+)$' -ErrorAction SilentlyContinue |
              Select-Object -First 1
      if ($line) { $token = $line.Matches[0].Groups[1].Value.Trim() }
    }
    if (-not $token) { Start-Sleep -Milliseconds 500 }
  }
  if (-not $token) { throw '30 秒内没等到 qy serve 打出令牌，启动失败。' }

  Say '起前端 dev server (127.0.0.1:5180)…'
  $vite = Start-Process -FilePath $bunExe -PassThru -NoNewWindow `
    -ArgumentList 'run', '--cwd', 'apps/web', 'dev'

  $url = "http://127.0.0.1:5180/#t=$token"
  $ready = $false
  for ($i = 0; $i -lt 40 -and -not $ready; $i++) {
    if ($vite.HasExited) { throw "vite 启动即退出（exit $($vite.ExitCode)）。" }
    try {
      Invoke-WebRequest 'http://127.0.0.1:5180/' -UseBasicParsing -TimeoutSec 2 | Out-Null
      $ready = $true
    } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $ready) { throw '前端 dev server 没起来。' }

  Write-Host ''
  Write-Host '  qywork 已就绪' -ForegroundColor Green
  Write-Host "  $url"
  Write-Host '  局域网/手机接入看上面 qy serve 打出的地址与二维码（那条链路直连 7717，不过 vite）'
  Write-Host '  Ctrl-C 退出，两个进程一起收' -ForegroundColor DarkGray
  Write-Host ''

  Start-Process $url

  Wait-Process -Id $vite.Id
} finally {
  foreach ($p in @($vite, $serve)) {
    if ($p -and -not $p.HasExited) {
      try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { }
    }
  }
  # vite 是 bun 起的 node 子进程，父进程被杀不一定带走它，补一刀。
  Clear-DevPort 5180
  Clear-DevPort 7717
  if (Test-Path $serveLog) { Remove-Item -LiteralPath $serveLog -Force }
}
