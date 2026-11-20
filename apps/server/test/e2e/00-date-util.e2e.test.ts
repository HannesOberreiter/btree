import { describe, expect, it } from 'vitest';

import {
  isPaidDayValid,
  parseDbDateTime,
} from '../../src/api/utils/date.util.js';
import { withTimeZone } from '../utils.js';

describe('database date helpers outside UTC', () => {
  const vienna = (fn: () => void) => withTimeZone('Europe/Vienna', fn);

  it('parses DATETIME text as UTC', () =>
    vienna(() => {
      expect(parseDbDateTime('2026-01-10 08:00:00').toISOString()).toBe(
        '2026-01-10T08:00:00.000Z',
      );
      expect(parseDbDateTime('2026-07-10 23:30:00').toISOString()).toBe(
        '2026-07-10T23:30:00.000Z',
      );
    }));

  it('keeps Date values and ISO text with a zone', () =>
    vienna(() => {
      const date = new Date('2026-01-10T08:00:00.000Z');
      expect(parseDbDateTime(date).toISOString()).toBe(date.toISOString());
      expect(parseDbDateTime('2026-01-10T09:00:00+01:00').toISOString()).toBe(
        '2026-01-10T08:00:00.000Z',
      );
    }));

  it('counts the paid day as valid', () =>
    vienna(() => {
      const day = (offset: number) =>
        new Date(Date.now() + offset * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);
      expect(isPaidDayValid(day(1))).toBe(true);
      expect(isPaidDayValid(day(0))).toBe(true);
      expect(isPaidDayValid(day(-1))).toBe(false);
      expect(isPaidDayValid(null)).toBe(false);
    }));
});
