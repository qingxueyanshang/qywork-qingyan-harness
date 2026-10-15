# 仅输出启动诊断字段。路径通过环境变量传入，不插入 PowerShell 代码。
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Emit($section, $data) {
    [Console]::WriteLine((@{ section = $section; data = $data } | ConvertTo-Json -Depth 6 -Compress))
}

try {
    $os = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    Emit 'windows' @{ build = $os.CurrentBuildNumber; revision = $os.UBR; displayVersion = $os.DisplayVersion }
} catch { Emit 'windows' @{ unavailable = $_.Exception.Message } }

$targets = @($env:QYWORK_DIAGNOSTIC_TARGET, $env:QYWORK_DIAGNOSTIC_SHELL) | Where-Object { $_ } | Select-Object -Unique
foreach ($path in $targets) {
    try {
        $signature = Get-AuthenticodeSignature -LiteralPath $path
        Emit 'signature' @{
            path = $path
            status = [string]$signature.Status
            subject = $signature.SignerCertificate.Subject
            thumbprint = $signature.SignerCertificate.Thumbprint
        }
    } catch { Emit 'signature' @{ path = $path; unavailable = $_.Exception.Message } }
}

try {
    $events = @(Get-WinEvent -FilterHashtable @{
        LogName = 'Microsoft-Windows-CodeIntegrity/Operational'
        Id = 3077, 3089
        StartTime = (Get-Date).AddMinutes(-10)
    } -MaxEvents 128 -ErrorAction Stop)
    $records = @($events | ForEach-Object {
        $xml = [xml]$_.ToXml()
        $fields = @{}
        foreach ($item in $xml.Event.EventData.Data) { $fields[[string]$item.Name] = [string]$item.'#text' }
        @{ id = $_.Id; time = $_.TimeCreated.ToUniversalTime().ToString('o'); activity = [string]$xml.Event.System.Correlation.ActivityID; fields = $fields }
    })
    # NT 设备路径与盘符路径按盘符后的完整路径匹配，避免收集其它软件的拦截记录。
    $blocks = @($records | Where-Object {
        $record = $_
        $paths = @($record.fields['FileName'], $record.fields['File Name'], $record.fields['ProcessName'], $record.fields['Process Name']) | Where-Object { $_ }
        $record.id -eq 3077 -and @($targets | Where-Object {
            $suffix = if ($_ -match '^[A-Za-z]:\\') { $_.Substring(2) } else { $_ }
            @($paths | Where-Object { $_.EndsWith($suffix, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
        }).Count -gt 0
    })
    $activities = @($blocks | ForEach-Object { $_.activity } | Where-Object { $_ })
    $related = @($records | Where-Object { $_ -in $blocks -or ($_.activity -and $_.activity -in $activities) } | Select-Object -First 12)
    Emit 'code_integrity' @{ status = 'ok'; events = $related; scanned = $records.Count }
} catch {
    if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') {
        Emit 'code_integrity' @{ status = 'no_matching_events'; events = @() }
    } else {
        Emit 'code_integrity' @{ status = 'unavailable'; reason = $_.Exception.Message }
    }
}
