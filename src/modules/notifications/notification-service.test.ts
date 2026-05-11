import { describe, it, expect } from 'vitest';
import type os from 'node:os';
import { resolveInstanceLabel } from './notification-service';

type Ifaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

function ipv4(address: string, internal = false): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`,
  };
}

function ipv6(address: string, internal = false): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: 'ffff:ffff:ffff:ffff::',
    family: 'IPv6',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/64`,
    scopeid: 0,
  };
}

describe('resolveInstanceLabel', () => {
  const eth0Only: Ifaces = { eth0: [ipv4('192.168.2.117')] };
  const eth0WithLoopback: Ifaces = {
    lo: [ipv4('127.0.0.1', true)],
    eth0: [ipv4('192.168.3.185')],
  };
  const v6Only: Ifaces = { eth0: [ipv6('fe80::1')] };

  it('prefers config.instance.label when set', () => {
    expect(
      resolveInstanceLabel({
        configLabel: 'Werkstatt',
        interfaces: eth0Only,
        hostname: 'charging-master',
      })
    ).toBe('Werkstatt');
  });

  it('ignores empty / whitespace config label and falls through to IPv4', () => {
    expect(
      resolveInstanceLabel({
        configLabel: '   ',
        interfaces: eth0Only,
        hostname: 'charging-master',
      })
    ).toBe('192.168.2.117');
  });

  it('uses first non-internal IPv4 when no config label', () => {
    expect(
      resolveInstanceLabel({
        configLabel: null,
        interfaces: eth0WithLoopback,
        hostname: 'charging-master',
      })
    ).toBe('192.168.3.185');
  });

  it('skips loopback IPv4 (127.x) even if listed first', () => {
    const ifaces: Ifaces = {
      lo: [ipv4('127.0.0.1', true)],
      eth0: [ipv4('10.0.0.5')],
    };
    expect(
      resolveInstanceLabel({
        configLabel: undefined,
        interfaces: ifaces,
        hostname: 'charging-master',
      })
    ).toBe('10.0.0.5');
  });

  it('falls back to hostname when only IPv6 / no eligible IPv4', () => {
    expect(
      resolveInstanceLabel({
        configLabel: null,
        interfaces: v6Only,
        hostname: 'charging-master',
      })
    ).toBe('charging-master');
  });

  it('falls back to hostname when interfaces empty', () => {
    expect(
      resolveInstanceLabel({
        configLabel: null,
        interfaces: {},
        hostname: 'charging-master',
      })
    ).toBe('charging-master');
  });

  it('config label takes precedence even over loopback-only interfaces', () => {
    expect(
      resolveInstanceLabel({
        configLabel: 'Buero',
        interfaces: { lo: [ipv4('127.0.0.1', true)] },
        hostname: 'charging-master',
      })
    ).toBe('Buero');
  });
});
