import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';

dayjs.extend(utc);

/**
 * Parses a DATETIME or TIMESTAMP value from the database. The connection
 * returns these values as UTC text without a zone, for example
 * '2026-01-10 08:00:00'. `new Date()` and `dayjs()` read such text as local
 * time, so the result would depend on the time zone of the process.
 */
export function parseDbDateTime(value: Date | string): Date {
  return dayjs.utc(value).toDate();
}

/**
 * Tells if a paid until date (DATE column `companies.paid`) is still valid.
 * The paid day itself counts as valid, the same as `paid < CURDATE()` in SQL.
 */
export function isPaidDayValid(paid: Date | string | null | undefined) {
  if (!paid) return false;
  return !dayjs.utc(paid).isBefore(dayjs.utc(), 'day');
}
