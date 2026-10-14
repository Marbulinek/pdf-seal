// Display formatting helpers shared across the sections. Pure -- no DOM.

export function formatFileSize(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unitIndex]}`;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatByteDelta(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '±0 B';
  const sign = n > 0 ? '+' : '−';
  return `${sign}${formatBytes(Math.abs(n))}`;
}

export function formatDisplayDate(value: unknown): string {
  if (!value) return '—';
  const d = new Date(value as string);
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(d);
}

export function ovShortDate(value: unknown): string {
  if (!value) return '';
  const d = new Date(value as string);
  return Number.isNaN(d.getTime())
    ? ''
    : new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(d);
}

export function ovTime(value: unknown): string {
  const d = new Date(value as string);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(d);
}

export function certFormatDate(iso: unknown): string | null {
  if (!iso) return null;
  const date = new Date(iso as string);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** "s" when `count` isn't 1 -- for the many "N field(s)" labels. */
export function plural(count: number, suffix = 's'): string {
  return count === 1 ? '' : suffix;
}

export function stripPdfExt(name: string): string {
  return name.replace(/\.pdf$/i, '');
}

/** Trims the trailing ".0" off whole numbers so 200pt reads "200", while 120.5 keeps its half point. */
export function formatTemplateNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

export function ovInitials(name: unknown): string {
  return (
    String(name || '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join('') || '?'
  );
}
