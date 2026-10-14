import {
  formatByteDelta,
  formatBytes,
  formatDisplayDate,
  formatFileSize,
  formatTemplateNumber,
  ovInitials,
  ovShortDate,
  plural,
  pluralize,
  stripPdfExt,
} from './format';

describe('format helpers', () => {
  it('formats file sizes with one decimal under 100 and none above', () => {
    expect(formatFileSize(null)).toBeNull();
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(150 * 1024)).toBe('150 KB');
    expect(formatFileSize(3 * 1024 * 1024)).toBe('3 MB');
  });

  it('formats byte counts and signed deltas', () => {
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.00 MB');
    expect(formatByteDelta(0)).toBe('±0 B');
    expect(formatByteDelta(10)).toBe('+10 B');
    expect(formatByteDelta(-2048)).toBe('−2.0 KB');
  });

  it('passes unparseable dates through and blanks missing ones', () => {
    expect(formatDisplayDate(null)).toBe('—');
    expect(formatDisplayDate('not a date')).toBe('not a date');
    expect(ovShortDate('')).toBe('');
    expect(ovShortDate('2024-01-02T03:04:05Z')).toMatch(/2024/);
  });

  it('pluralizes counts', () => {
    expect(pluralize(1, 'field')).toBe('1 field');
    expect(pluralize(2, 'field')).toBe('2 fields');
    expect(pluralize(2, 'entry', 'entries')).toBe('2 entries');
    expect(plural(1)).toBe('');
    expect(plural(0)).toBe('s');
  });

  it('strips a .pdf extension case-insensitively', () => {
    expect(stripPdfExt('contract.PDF')).toBe('contract');
    expect(stripPdfExt('notes.txt')).toBe('notes.txt');
  });

  it('trims trailing .0 off whole template numbers', () => {
    expect(formatTemplateNumber(200)).toBe('200');
    expect(formatTemplateNumber(120.54)).toBe('120.5');
  });

  it('builds up to two initials', () => {
    expect(ovInitials('Alex Morgan Smith')).toBe('AM');
    expect(ovInitials('')).toBe('?');
  });
});
