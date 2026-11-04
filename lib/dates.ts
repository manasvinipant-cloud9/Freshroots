// Dates are plain 'YYYY-MM-DD' strings handled in UTC, so nothing depends on the server's time zone.
const DAY = 86_400_000;

export const toMs = (d: string) => Date.parse(d + "T00:00:00Z");
export const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => fromMs(toMs(d) + n * DAY);
export const diffDays = (a: string, b: string) => Math.round((toMs(a) - toMs(b)) / DAY);
/** ISO weekday, Monday = 1 */
export const isoDow = (d: string) => new Date(toMs(d)).getUTCDay() || 7;
export const mondayOf = (d: string) => addDays(d, 1 - isoDow(d));
export const validDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(toMs(d)) && fromMs(toMs(d)) === d;

/** '2026-W42' -> Monday of that ISO week. Throws on bad input. */
export function parseIsoWeek(label: string): string {
  const m = /^(\d{4})-W(\d{1,2})$/i.exec(label.trim());
  if (!m) throw new Error(`not an ISO week: ${JSON.stringify(label)}`);
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) throw new Error(`not an ISO week: ${JSON.stringify(label)}`);
  const jan4 = `${year}-01-04`; // always in ISO week 1
  return addDays(mondayOf(jan4), (week - 1) * 7);
}

/** Monday date -> '2026-W42' */
export function isoWeekLabel(monday: string): string {
  const thursday = addDays(monday, 3); // the Thursday decides the ISO year
  const year = Number(thursday.slice(0, 4));
  const week1Monday = mondayOf(`${year}-01-04`);
  const week = Math.floor(diffDays(monday, week1Monday) / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The last fully elapsed ISO week before `asOf`. For Monday 2026-10-19 that is the week starting 2026-10-12 (W42). */
export const lastCompleteWeekStart = (asOf: string) => addDays(mondayOf(asOf), -7);
