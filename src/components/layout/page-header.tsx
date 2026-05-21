import type { ReactNode } from 'react';

/**
 * PageHeader — editorial-style title block used at the top of every page.
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ HARDWARE · 02                                                │
 *   │ Geräte                                  [+ Neues Gerät]      │
 *   │ Optional sublabel sits here in soft body color               │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Reads at a glance: rail-mono "department" eyebrow, large tracking-tight
 * page title, optional right-aligned slot for primary actions (CTAs,
 * filters, etc.) so the action lives in the header, not floating below.
 */

type PageHeaderProps = {
  eyebrow: string;
  title: string;
  sublabel?: ReactNode;
  action?: ReactNode;
};

export function PageHeader({ eyebrow, title, sublabel, action }: PageHeaderProps) {
  return (
    <header className="mb-8 flex items-end justify-between gap-4 flex-wrap">
      <div className="min-w-0">
        <div className="label-eyebrow mb-2">{eyebrow}</div>
        <h1
          className="text-[32px] sm:text-[40px] font-semibold leading-none tracking-tight text-[color:var(--color-text-strong)]"
          style={{ letterSpacing: '-0.02em' }}
        >
          {title}
        </h1>
        {sublabel && (
          <div className="mt-3 text-[13px] text-[color:var(--color-text-faint)]">
            {sublabel}
          </div>
        )}
      </div>
      {action && <div className="pb-1 shrink-0">{action}</div>}
    </header>
  );
}

/**
 * PrimaryButton — the one CTA style used app-wide. Cyan-soft fill with
 * a 1 px cyan border and mono uppercase label. Variants for "secondary"
 * (line only) and "danger".
 */
export function PrimaryButton({
  children,
  onClick,
  href,
  disabled,
  variant = 'primary',
  type = 'button',
  className = '',
}: {
  children: ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  href?: string;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
  type?: 'button' | 'submit';
  className?: string;
}) {
  const styles =
    variant === 'primary'
      ? {
          background: 'var(--color-accent-soft)',
          border: '1px solid color-mix(in srgb, var(--color-accent) 30%, transparent)',
          color: 'var(--color-accent)',
        }
      : variant === 'danger'
        ? {
            background: 'var(--color-danger-soft)',
            border: '1px solid color-mix(in srgb, var(--color-danger) 30%, transparent)',
            color: 'var(--color-danger)',
          }
        : {
            background: 'transparent',
            border: '1px solid var(--color-line-strong)',
            color: 'var(--color-text-default)',
          };

  const cls =
    `inline-flex items-center gap-2 px-3.5 py-2 rounded-md text-[11px] font-mono uppercase tracking-[0.16em] transition-all hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed ${className}`;

  if (href && !disabled) {
    return (
      <a href={href} className={cls} style={styles}>
        {children}
      </a>
    );
  }
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={cls} style={styles}>
      {children}
    </button>
  );
}

/**
 * StatusBadge — token-driven state pill. Used on history listing, session
 * detail, profile rows, etc. — anywhere a discrete state needs a label.
 */
export function StatusBadge({
  label,
  color = 'var(--color-text-faint)',
  pulse = false,
}: {
  label: string;
  color?: string;
  pulse?: boolean;
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-mono uppercase tracking-[0.16em] font-medium"
      style={{
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`,
        color,
      }}
    >
      <span className={pulse ? 'status-orb status-orb-pulse' : 'status-orb'} style={{ color }} />
      {label}
    </span>
  );
}
