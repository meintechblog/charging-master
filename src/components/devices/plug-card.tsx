'use client';

type PlugCardProps = {
  plug: {
    id: string;
    name: string;
    online: boolean;
    enabled: boolean;
    lastSeen: number | null;
  };
};

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `vor ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `vor ${minutes} Min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `vor ${hours} Std`;
  const days = Math.floor(hours / 24);
  return `vor ${days} Tagen`;
}

export function PlugCard({ plug }: PlugCardProps) {
  return (
    <div
      className={`bg-neutral-900 rounded-lg border border-neutral-800 p-4 hover:border-neutral-700 transition-colors ${
        !plug.enabled ? 'opacity-50' : ''
      }`}
    >
      {/* Header: Name + Online Status */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-base font-medium text-neutral-100 truncate">
          {plug.name}
        </span>
        <div className="flex items-center gap-1.5">
          <span
            className={`w-2 h-2 rounded-full ${
              plug.online ? 'bg-green-500' : 'bg-red-500'
            }`}
          />
          <span className="text-xs text-neutral-400">
            {plug.online ? 'Online' : 'Offline'}
          </span>
        </div>
      </div>

      {/* Power Value */}
      <div className="mb-3">
        <span className="text-2xl font-bold text-neutral-100">--</span>
        <span className="text-sm text-neutral-400 ml-1">W</span>
      </div>

      {/* Last Seen */}
      <div className="text-xs text-neutral-500">
        {plug.lastSeen
          ? formatRelativeTime(plug.lastSeen)
          : 'Noch nie gesehen'}
      </div>
    </div>
  );
}
