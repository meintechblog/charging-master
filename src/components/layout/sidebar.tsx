'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_ITEMS = [
  { href: '/', label: 'Dashboard' },
  { href: '/devices', label: 'Geraete' },
  { href: '/profiles', label: 'Profile' },
  { href: '/settings', label: 'Einstellungen' },
  { href: '/history', label: 'Verlauf', disabled: true },
];

function useMqttStatus() {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let active = true;

    async function check() {
      try {
        const res = await fetch('/api/mqtt/status');
        if (!active) return;
        if (res.ok) {
          const data = await res.json();
          setConnected(data.connected);
        }
      } catch {
        if (active) setConnected(false);
      }
    }

    check();
    const interval = setInterval(check, 5000);
    return () => { active = false; clearInterval(interval); };
  }, []);

  return connected;
}

export function Sidebar() {
  const pathname = usePathname();
  const mqttConnected = useMqttStatus();

  function isActive(href: string) {
    if (href === '/') return pathname === '/';
    return pathname.startsWith(href);
  }

  return (
    <nav className="w-64 h-screen bg-neutral-900 border-r border-neutral-800 flex flex-col p-4 shrink-0">
      <div className="text-lg font-bold text-neutral-100 mb-8">
        Charging Master
      </div>

      <div className="flex flex-col gap-1 flex-1">
        {NAV_ITEMS.map((item) => {
          const active = isActive(item.href);
          if (item.disabled) {
            return (
              <span
                key={item.href}
                className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-neutral-600 cursor-not-allowed"
              >
                {item.label}
              </span>
            );
          }
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                active
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800/50'
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </div>

      <div className="flex items-center gap-2 px-3 py-2 text-xs text-neutral-400">
        <span
          className={`w-2 h-2 rounded-full ${
            mqttConnected ? 'bg-green-500' : 'bg-red-500'
          }`}
        />
        MQTT {mqttConnected ? 'Verbunden' : 'Getrennt'}
      </div>
    </nav>
  );
}
