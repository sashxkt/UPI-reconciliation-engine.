// India has no daylight saving, so IST is always UTC+05:30.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

// The calendar date in India for a moment in time, as 'YYYY-MM-DD'.
export function istDate(when: Date): string {
  return new Date(when.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// Like toISOString(), but in IST: '2026-10-16T10:15:00+05:30'
export function istTimestamp(when: Date): string {
  return new Date(when.getTime() + IST_OFFSET_MS).toISOString().slice(0, 19) + '+05:30';
}

// The Indian financial year runs from 1 April to 31 March.
// 16 Oct 2026 -> '2026-27', 15 Feb 2027 -> '2026-27', 1 Apr 2027 -> '2027-28'.
export function financialYear(when: Date): string {
  const [year, month] = istDate(when).split('-').map(Number);
  const startYear = month >= 4 ? year : year - 1;
  const endYear = String((startYear + 1) % 100).padStart(2, '0');
  return `${startYear}-${endYear}`;
}
