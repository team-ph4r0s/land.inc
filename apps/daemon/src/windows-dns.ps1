# Loaded by dns.ts. Input is JSON encoded as base64, never executable client text.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Get-LandDnsFamily($adapter, [string]$family) {
    $service = if ($family -eq 'IPv4') { 'Tcpip' } else { 'Tcpip6' }
    $guid = $adapter.InterfaceGuid.ToString().Trim('{}')
    $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$service\Parameters\Interfaces\{$guid}"
    $mode = 'unknown'
    try {
        if (Test-Path -LiteralPath $key) {
            $value = (Get-Item -LiteralPath $key).GetValue('NameServer')
            $mode = if (($value -join ',').Trim()) { 'manual' } else { 'auto' }
        }
    } catch { }
    $row = @(Get-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -AddressFamily $family -ErrorAction SilentlyContinue)
    if (-not $row.Count) { return @{ mode = 'unknown'; servers = @() } }
    return @{ mode = $mode; servers = @($row.ServerAddresses | Where-Object { $_ }) }
}

function Get-LandDnsAdapters {
    return @(Get-NetAdapter -IncludeHidden | Where-Object Status -eq 'Up' | Sort-Object @{Expression='HardwareInterface';Descending=$true}, ifIndex | ForEach-Object {
        @{
            id = $_.InterfaceGuid.ToString().Trim('{}').ToLowerInvariant()
            index = [int]$_.ifIndex
            name = $_.Name
            ipv4 = Get-LandDnsFamily $_ 'IPv4'
            ipv6 = Get-LandDnsFamily $_ 'IPv6'
        }
    } | Where-Object { $_.ipv4.mode -ne 'unknown' -or $_.ipv6.mode -ne 'unknown' })
}

function Assert-LandDnsSettings($settings) {
    foreach ($family in @('ipv4', 'ipv6')) {
        $value = $settings.$family
        if ($value.mode -notin @('auto', 'manual')) { throw 'Unknown DNS source' }
        $servers = @($value.servers)
        if ($value.mode -eq 'manual' -and ($servers.Count -lt 1 -or $servers.Count -gt 8)) { throw 'Invalid DNS server count' }
        foreach ($server in $servers) {
            $ip = $null
            if (-not [ipaddress]::TryParse([string]$server, [ref]$ip)) { throw 'Invalid IP address' }
            $expected = if ($family -eq 'ipv4') { [System.Net.Sockets.AddressFamily]::InterNetwork } else { [System.Net.Sockets.AddressFamily]::InterNetworkV6 }
            if ($ip.AddressFamily -ne $expected) { throw 'Wrong address family' }
        }
    }
}

function Test-LandDnsEqual($actual, $expected) {
    foreach ($family in @('ipv4', 'ipv6')) {
        if ($actual.$family.mode -ne $expected.$family.mode) { return $false }
        # DHCP can renew addresses while the operation is in progress.
        if ($expected.$family.mode -eq 'manual') {
            $a = @($actual.$family.servers | ForEach-Object { ([ipaddress]$_).ToString() }) -join ','
            $b = @($expected.$family.servers | ForEach-Object { ([ipaddress]$_).ToString() }) -join ','
            if ($a -ne $b) { return $false }
        }
    }
    return $true
}

function Invoke-LandDnsNetsh([string[]]$Arguments) {
    & "$env:SystemRoot\System32\netsh.exe" @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'DNS update failed' }
}

function Set-LandDnsSettings($adapter, $settings) {
    Assert-LandDnsSettings $settings
    foreach ($family in @('ipv4', 'ipv6')) {
        $value = $settings.$family
        # netsh scopes DHCP reset to exactly one address family.
        $netArgs = @('interface', $family, 'set', 'dnsservers', "name=$($adapter.index)")
        if ($value.mode -eq 'auto') {
            Invoke-LandDnsNetsh ($netArgs + @('source=dhcp'))
        } else {
            Invoke-LandDnsNetsh ($netArgs + @('source=static', "address=$($value.servers[0])", 'validate=no'))
            for ($i = 1; $i -lt @($value.servers).Count; $i++) {
                Invoke-LandDnsNetsh @('interface', $family, 'add', 'dnsservers', "name=$($adapter.index)", "address=$($value.servers[$i])", "index=$($i + 1)", 'validate=no')
            }
        }
    }
    Clear-DnsClientCache
}

function Invoke-LandDnsChange($request) {
    # Also serialize helpers left running by a daemon restart.
    $mutex = [Threading.Mutex]::new($false, 'Global\land.inc.dns')
    $locked = $false
    try {
        try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { exit 13 }
        Invoke-LandDnsTransaction $request
    } finally {
        if ($locked) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Invoke-LandDnsTransaction($request) {
    $adapter = @(Get-LandDnsAdapters | Where-Object id -eq $request.before.id)
    if ($adapter.Count -ne 1) { exit 12 }
    $adapter = $adapter[0]
    if ($adapter.index -ne $request.before.index -or -not (Test-LandDnsEqual $adapter $request.before)) { exit 12 }
    Assert-LandDnsSettings $request.before
    Assert-LandDnsSettings $request.settings
    try {
        Set-LandDnsSettings $adapter $request.settings
        $after = @(Get-LandDnsAdapters | Where-Object id -eq $adapter.id)[0]
        if (-not $after -or -not (Test-LandDnsEqual $after $request.settings)) { throw 'DNS verification failed' }
        exit 0
    } catch {
        try {
            Set-LandDnsSettings $adapter $request.before
            $after = @(Get-LandDnsAdapters | Where-Object id -eq $adapter.id)[0]
            if (-not $after -or -not (Test-LandDnsEqual $after $request.before)) { throw 'DNS rollback verification failed' }
            exit 10
        } catch { exit 11 }
    }
}
