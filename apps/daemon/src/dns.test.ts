import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DnsService, FakeDnsBackend, validateDnsSettings } from './dns.ts';
import type { DnsSettings } from '@land/protocol';

const manual: DnsSettings = { ipv4: { mode: 'manual', servers: ['192.0.2.1', '192.0.2.2'] }, ipv6: { mode: 'manual', servers: ['2001:db8::53'] } };

test('DNS validates address families and rejects command text, URLs, empty manual lists and unknown sources', () => {
  assert.deepEqual(validateDnsSettings(manual), manual);
  for (const value of ['https://example.com', '1.1.1.1;whoami', '1.1.1.1:53', '::', '0.0.0.0', '::1'])
    assert.throws(() => validateDnsSettings({ ...manual, ipv4: { mode: 'manual', servers: [value] } }));
  assert.throws(() => validateDnsSettings({ ...manual, ipv6: { mode: 'manual', servers: ['1.1.1.1'] } }));
  assert.throws(() => validateDnsSettings({ ...manual, ipv4: { mode: 'manual', servers: [] } }));
  assert.throws(() => validateDnsSettings({ ...manual, ipv4: { mode: 'unknown', servers: [] } }));
  assert.deepEqual(validateDnsSettings({ ipv4: { mode: 'auto', servers: ['old-dhcp-server'] }, ipv6: manual.ipv6 }).ipv4, { mode: 'auto', servers: [] });
});

test('DNS apply persists the original source before change, survives restart and restores it after multiple edits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'land-dns-'));
  const file = join(dir, 'dns.json');
  try {
    const backend = new FakeDnsBackend();
    const service = new DnsService({ backend, file });
    const initial = (await service.state()).adapters[0];
    const originalChange = backend.change.bind(backend);
    backend.change = async (before, settings) => {
      assert.equal(JSON.parse(readFileSync(file, 'utf8'))[0].settings.ipv4.mode, 'auto');
      await originalChange(before, settings);
    };
    let state = await service.change(initial.id, initial.revision, manual);
    assert.equal(state.backups.length, 1);
    assert.deepEqual(state.adapters[0].ipv6, manual.ipv6);
    state = await service.change(initial.id, state.adapters[0].revision, { ...manual, ipv4: { mode: 'manual', servers: ['192.0.2.3'] } });
    assert.equal(state.backups.length, 1);
    const restarted = new DnsService({ backend, file });
    state = await restarted.change(initial.id, state.adapters[0].revision);
    assert.deepEqual(state.adapters[0].ipv4, { mode: 'auto', servers: [] });
    assert.deepEqual(state.adapters[0].ipv6, { mode: 'auto', servers: [] });
    assert.equal(state.backups.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DNS rejects stale views, missing adapters, unknown source and missing backups before calling the OS', async () => {
  const backend = new FakeDnsBackend();
  const service = new DnsService({ backend, file: null });
  const adapter = (await service.state()).adapters[0];
  backend.change = async () => assert.fail('Must not touch the OS');
  await assert.rejects(service.change(adapter.id, 'stale', manual), /изменились/);
  await assert.rejects(service.change('missing', adapter.revision, manual), /изменились/);
  await assert.rejects(service.change(adapter.id, adapter.revision), /Нет сохранённых/);
  backend.adapters[0].ipv6.mode = 'unknown';
  const unknown = (await service.state()).adapters[0];
  await assert.rejects(service.change(unknown.id, unknown.revision, manual), /режим DNS/);
});

test('DNS serializes changes across clients and retains backup when UAC fails', async () => {
  const backend = new FakeDnsBackend();
  const service = new DnsService({ backend, file: null });
  const adapter = (await service.state()).adapters[0];
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  backend.change = async () => { started(); await new Promise<void>((resolve) => { release = resolve; }); throw new Error('UAC отменён'); };
  const first = service.change(adapter.id, adapter.revision, manual);
  const failed = assert.rejects(first, /UAC отменён/);
  await entered;
  await assert.rejects(service.change(adapter.id, adapter.revision, manual), /ещё выполняется/);
  release();
  await failed;
  assert.equal((await service.state()).backups.length, 1);
  assert.equal((await service.state()).adapters[0].ipv4.mode, 'auto');
});

test('DNS refuses mutations when backups are corrupted or cannot be saved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'land-dns-'));
  try {
    const backend = new FakeDnsBackend();
    backend.change = async () => assert.fail('Must not touch the OS');
    const file = join(dir, 'broken.json');
    writeFileSync(file, 'broken');
    let service = new DnsService({ backend, file });
    let state = await service.state();
    assert.equal(state.supported, false);
    await assert.rejects(service.change(state.adapters[0].id, state.adapters[0].revision, manual), /недоступно/);
    // The parent is a regular file, so creating the backup must fail before any OS operation.
    service = new DnsService({ backend, file: join(file, 'dns.json') });
    state = await service.state();
    await assert.rejects(service.change(state.adapters[0].id, state.adapters[0].revision, manual));
    assert.equal((await service.state()).backups.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('DNS fake mode probes no network, and unsupported platforms never read or write system settings', async () => {
  const service = new DnsService({ backend: new FakeDnsBackend(), file: null });
  const probes = await service.test(['192.0.2.53', '2001:db8::53']);
  assert.equal(probes.length, 6);
  assert.ok(probes.every((p) => p.addresses[0] === '192.0.2.1'));
  await assert.rejects(service.test(['192.0.2.1;echo x']));
  const unsupported = new DnsService({ backend: { supported: false, read: async () => assert.fail(), change: async () => assert.fail() }, file: null });
  assert.equal((await unsupported.state()).supported, false);
  await assert.rejects(unsupported.change('x', 'x', manual), /недоступно/);
});

const windowsScript = readFileSync(new URL('./windows-dns.ps1', import.meta.url), 'utf8');
function runPowerShell(code: string) {
  return spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsScript + '\n' + code, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 15_000 });
}

test('Windows DNS reads GUIDs with braces and ignores adapters without an IP family', { skip: process.platform !== 'win32' }, () => {
  const result = runPowerShell(`
    function Test-Path { param($LiteralPath)
      if ($LiteralPath -ne 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\{test-guid}') { throw 'Unexpected registry path' }
      return $true
    }
    function Get-Item { param($LiteralPath)
      return New-Object PSObject | Add-Member -MemberType ScriptMethod -Name GetValue -Value { param($name) return '192.0.2.53' } -PassThru
    }
    function Get-DnsClientServerAddress { param($InterfaceIndex, $AddressFamily, $ErrorAction)
      if ($InterfaceIndex -eq 2) { return @() }
      return @{ ServerAddresses = @('192.0.2.53') }
    }
    $withIp = Get-LandDnsFamily @{InterfaceGuid='{test-guid}';ifIndex=1} 'IPv4'
    $withoutIp = Get-LandDnsFamily @{InterfaceGuid='{test-guid}';ifIndex=2} 'IPv4'
    ConvertTo-Json -InputObject @($withIp, $withoutIp) -Depth 8 -Compress
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), [{ mode: 'manual', servers: ['192.0.2.53'] }, { mode: 'unknown', servers: [] }]);
});

test('Windows DNS helper generates family-specific netsh arguments without changing Windows', { skip: process.platform !== 'win32' }, () => {
  const result = runPowerShell(`
    $script:calls = [System.Collections.Generic.List[object]]::new()
    function Invoke-LandDnsNetsh([string[]]$Arguments) { $script:calls.Add($Arguments) }
    function Clear-DnsClientCache { }
    $settings = '${JSON.stringify(manual)}' | ConvertFrom-Json
    Set-LandDnsSettings @{ index = 17 } $settings
    $settings.ipv4.mode = 'auto'
    $settings.ipv6.mode = 'auto'
    Set-LandDnsSettings @{ index = 17 } $settings
    ConvertTo-Json -InputObject $script:calls -Depth 8 -Compress
  `);
  assert.equal(result.status, 0, result.stderr);
  const calls = JSON.parse(result.stdout.trim());
  assert.deepEqual(calls, [
    ['interface', 'ipv4', 'set', 'dnsservers', 'name=17', 'source=static', 'address=192.0.2.1', 'validate=no'],
    ['interface', 'ipv4', 'add', 'dnsservers', 'name=17', 'address=192.0.2.2', 'index=2', 'validate=no'],
    ['interface', 'ipv6', 'set', 'dnsservers', 'name=17', 'source=static', 'address=2001:db8::53', 'validate=no'],
    ['interface', 'ipv4', 'set', 'dnsservers', 'name=17', 'source=dhcp'],
    ['interface', 'ipv6', 'set', 'dnsservers', 'name=17', 'source=dhcp'],
  ]);
});

for (const [scenario, expectedCode] of [['success', 0], ['failure', 10], ['rollback-failure', 11], ['drift', 12]] as const) {
  test(`Windows DNS transaction: ${scenario}, with all OS mutations mocked`, { skip: process.platform !== 'win32' }, () => {
    const result = runPowerShell(`
      $script:adapter = @{ id = 'test'; index = 17; ipv4 = @{mode='auto';servers=@()}; ipv6 = @{mode='auto';servers=@()} }
      $before = $script:adapter | ConvertTo-Json -Depth 8 | ConvertFrom-Json
      $script:count = 0
      function Get-LandDnsAdapters { return @($script:adapter) }
      function Set-LandDnsSettings($adapter, $settings) {
        $script:count++
        if ('${scenario}' -eq 'rollback-failure' -or ('${scenario}' -eq 'failure' -and $script:count -eq 1)) { throw 'Simulated failure' }
        $script:adapter.ipv4 = $settings.ipv4
        $script:adapter.ipv6 = $settings.ipv6
      }
      if ('${scenario}' -eq 'drift') { $script:adapter.index = 18 }
      $settings = '${JSON.stringify(manual)}' | ConvertFrom-Json
      Invoke-LandDnsChange @{ before = $before; settings = $settings }
    `);
    assert.equal(result.status, expectedCode, result.stderr || result.error?.message);
  });
}
