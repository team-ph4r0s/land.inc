# Loaded by dns.ts. Input is JSON encoded as base64, never executable client text.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

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
    if ($adapter.Properties) {
        $expected = if ($family -eq 'IPv4') { [System.Net.Sockets.AddressFamily]::InterNetwork } else { [System.Net.Sockets.AddressFamily]::InterNetworkV6 }
        $addresses = @($adapter.Properties.DnsAddresses | Where-Object AddressFamily -eq $expected | ForEach-Object { $_.ToString() })
        return @{ mode = $mode; servers = $addresses }
    }
    try {
        $row = @(Get-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -AddressFamily $family -ErrorAction Stop)
        if ($row.Count) { return @{ mode = $mode; servers = @($row.ServerAddresses | Where-Object { $_ }) } }
    } catch { }
    return @{ mode = 'unknown'; servers = @() }
}

function Get-LandFallbackAdapters {
    foreach ($item in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
        try {
            $properties = $item.GetIPProperties()
            $index = try { $properties.GetIPv4Properties().Index } catch { $null }
            if (-not $index) { $index = $properties.GetIPv6Properties().Index }
            if ($index -gt 0) {
                @{ InterfaceGuid = $item.Id; ifIndex = $index; Name = $item.Name; HardwareInterface = $false; Properties = $properties }
            }
        } catch { }
    }
}

function Get-LandDnsAdapters {
    $adapters = @{}
    $sources = 0
    try {
        foreach ($item in @(Get-NetAdapter -IncludeHidden -ErrorAction Stop)) {
            if ($item.InterfaceGuid -and $item.ifIndex -gt 0) {
                $adapters[$item.InterfaceGuid.ToString().Trim('{}')] = $item
            }
        }
        $sources++
    } catch { }
    try {
        foreach ($item in @(Get-LandFallbackAdapters)) {
            $id = $item.InterfaceGuid.ToString().Trim('{}')
            if (-not $adapters.ContainsKey($id)) { $adapters[$id] = $item }
        }
        $sources++
    } catch { }
    if (-not $sources) { throw 'Unable to enumerate Windows network interfaces' }
    return @($adapters.Values | Sort-Object @{Expression='HardwareInterface';Descending=$true}, ifIndex | ForEach-Object {
        @{
            id = $_.InterfaceGuid.ToString().Trim('{}').ToLowerInvariant()
            index = [int]$_.ifIndex
            name = $_.Name
            ipv4 = Get-LandDnsFamily $_ 'IPv4'
            ipv6 = Get-LandDnsFamily $_ 'IPv6'
        }
    })
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
