param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][string]$PayloadDirectory,
    [Parameter(Mandatory = $true)][string]$ReportPath,
    [switch]$RequireSigned
)

# PayloadDirectory 必须来自本次安装包的解压结果，不能使用编译目录代替。
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../apps/desktop/src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
$payload = (Get-Item -LiteralPath $PayloadDirectory).FullName
$installer = Get-Item -LiteralPath $InstallerPath
if (!(Test-Path -LiteralPath $payload -PathType Container) -or $installer.PSIsContainer) {
    throw 'InstallerPath 必须是安装包，PayloadDirectory 必须是解压目录。'
}

$binaries = @(Get-ChildItem -LiteralPath $payload -Recurse -File | Where-Object { $_.Extension -in '.exe', '.dll' })
$mainName = if ($config.mainBinaryName) { $config.mainBinaryName } else { $config.productName }
$expected = @("$mainName.exe") + @($config.bundle.externalBin | ForEach-Object { ($_ -split '[/\\]')[-1] + '.exe' })
$missing = @($expected | Where-Object { $_ -notin $binaries.Name })
$files = @($installer) + $binaries
$records = @($files | ForEach-Object {
    $file = $_
    $name = if ($file.FullName -eq $installer.FullName) { $file.Name } else { $file.FullName.Substring($payload.Length).TrimStart('\', '/') }
    try {
        $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
        [ordered]@{
            file = $name
            sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
            status = [string]$signature.Status
            signer = $signature.SignerCertificate.Subject
            thumbprint = $signature.SignerCertificate.Thumbprint
        }
    } catch {
        [ordered]@{ file = $name; status = 'VerificationFailed'; error = $_.Exception.Message }
    }
})
$untrusted = @($records | Where-Object { $_.status -ne 'Valid' })
$report = [ordered]@{
    checkedAt = [DateTime]::UtcNow.ToString('o')
    mode = if ($RequireSigned) { 'required' } else { 'audit' }
    missing = $missing
    allValid = $missing.Count -eq 0 -and $untrusted.Count -eq 0
    files = $records
}
$reportFile = [IO.Path]::GetFullPath($ReportPath)
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($reportFile)) | Out-Null
[IO.File]::WriteAllText($reportFile, ($report | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
$records | ForEach-Object { Write-Host ('{0}: {1}' -f $_.file, $_.status) }

if ($missing.Count -gt 0) {
    Write-Error ('安装包缺少必要程序：' + ($missing -join ', ')) -ErrorAction Continue
    exit 1
}
if ($untrusted.Count -gt 0) {
    $message = 'Windows Authenticode 检查未通过；更新包 .sig 不能替代程序签名。'
    if ($RequireSigned) { Write-Error $message -ErrorAction Continue; exit 1 }
    Write-Warning $message
}
exit 0
