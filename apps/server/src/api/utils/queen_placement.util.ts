/**
 * Pure helpers for queen placements (table `queen_placements`).
 *
 * A placement is the period of a queen in a hive. The period is half-open:
 * `[from_date, to_date)`. An open placement has `to_date` = `OPEN_END`.
 * The migration, the seed, the company import and the queen module use these
 * helpers, so the rules stay in one place.
 */

/** `to_date` of an open placement. */
export const OPEN_END = '9999-12-31';

/** A calendar day as `YYYY-MM-DD`. */
export type Day = string;

export interface PlacementPeriod {
  id?: number;
  queen_id: number;
  hive_id: number;
  from_date: Day;
  to_date: Day;
}

/**
 * Converts a DATE, DATETIME, ISO text or Date to a day. The time zone is
 * ignored: the result is the UTC day, the same as `DATE()` on a stored value.
 */
export function toDay(value: unknown): Day | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date)
    return Number.isNaN(value.getTime())
      ? null
      : value.toISOString().slice(0, 10);
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/** Today as a UTC day. */
export function today(): Day {
  return new Date().toISOString().slice(0, 10);
}

export function isOpen(row: { to_date: Day }) {
  return row.to_date === OPEN_END;
}

/** Tells if two half-open periods have at least one day in common. */
export function overlaps(
  a: { from_date: Day; to_date: Day },
  b: { from_date: Day; to_date: Day },
) {
  return a.from_date < b.to_date && b.from_date < a.to_date;
}

/**
 * The values that the API shows as `queens.hive_id` and `queens.move_date`.
 * - Open placement: its hive and start.
 * - No open placement, queen inactive: the last placement.
 * - No open placement, queen active: no hive, `move_date` = end of the last
 *   placement.
 */
export function derivePlacement(
  modus: boolean | null,
  rows: PlacementPeriod[],
): { hive_id: number | null; move_date: Day | null; row?: PlacementPeriod } {
  const open = rows.find(isOpen);
  if (open)
    return { hive_id: open.hive_id, move_date: open.from_date, row: open };
  const last = [...rows].sort(byStart).at(-1);
  if (!last) return { hive_id: null, move_date: null };
  if (modus === false)
    return { hive_id: last.hive_id, move_date: last.from_date, row: last };
  return { hive_id: null, move_date: last.to_date };
}

function byStart(a: PlacementPeriod, b: PlacementPeriod) {
  if (a.from_date !== b.from_date) return a.from_date < b.from_date ? -1 : 1;
  return (a.id ?? 0) - (b.id ?? 0);
}

/** A queen as the backfill reads it from `queens`. */
export interface BackfillQueen {
  id: number;
  hive_id: number | null;
  user_id: number | null;
  move_date: unknown;
  created_at: unknown;
  updated_at: unknown;
  modus: boolean | number | null;
  modus_date: unknown;
}

export interface BackfillRow extends PlacementPeriod {
  user_id: number;
}

export interface BackfillSkip {
  queen_id: number;
  user_id: number | null;
  reason: 'no_company' | 'no_start' | 'same_start' | 'empty_period';
}

/**
 * Builds placements from the old columns `hive_id`, `move_date` and
 * `modus_date`. Each queen gets at most one placement, in her last hive.
 *
 * Rules:
 * - Start: `move_date`, else `created_at`.
 * - Rows of one hive are sorted by start, then id. Of two rows with the same
 *   start, only the row with the higher id stays.
 * - End: the start of the next row in the hive. An inactive queen ends at
 *   `modus_date` when it is earlier. The last active queen stays open. The
 *   last inactive queen without `modus_date` ends at `updated_at`.
 * - A row whose end is not after its start is skipped.
 */
export function buildQueenPlacements(queens: BackfillQueen[]): {
  rows: BackfillRow[];
  skipped: BackfillSkip[];
} {
  const skipped: BackfillSkip[] = [];
  const byHive = new Map<number, (BackfillQueen & { start: Day })[]>();
  for (const queen of queens) {
    if (queen.hive_id === null || queen.hive_id === undefined) continue;
    if (!queen.user_id) {
      skipped.push({ queen_id: queen.id, user_id: null, reason: 'no_company' });
      continue;
    }
    const start = toDay(queen.move_date) ?? toDay(queen.created_at);
    if (!start) {
      skipped.push({
        queen_id: queen.id,
        user_id: queen.user_id,
        reason: 'no_start',
      });
      continue;
    }
    const list = byHive.get(queen.hive_id) ?? [];
    list.push({ ...queen, start });
    byHive.set(queen.hive_id, list);
  }

  const rows: BackfillRow[] = [];
  for (const [hiveId, list] of byHive) {
    list.sort((a, b) =>
      a.start !== b.start ? (a.start < b.start ? -1 : 1) : a.id - b.id,
    );
    const kept: (BackfillQueen & { start: Day })[] = [];
    for (const queen of list) {
      const previous = kept.at(-1);
      if (previous && previous.start === queen.start) {
        skipped.push({
          queen_id: previous.id,
          user_id: previous.user_id,
          reason: 'same_start',
        });
        kept[kept.length - 1] = queen;
      } else kept.push(queen);
    }
    kept.forEach((queen, index) => {
      const next = kept[index + 1];
      const inactive = queen.modus === false || queen.modus === 0;
      const modusDay = inactive ? toDay(queen.modus_date) : null;
      let end: Day;
      if (next) end = modusDay && modusDay < next.start ? modusDay : next.start;
      else if (!inactive) end = OPEN_END;
      else end = modusDay ?? toDay(queen.updated_at) ?? queen.start;
      if (end <= queen.start) {
        skipped.push({
          queen_id: queen.id,
          user_id: queen.user_id,
          reason: 'empty_period',
        });
        return;
      }
      rows.push({
        queen_id: queen.id,
        hive_id: hiveId,
        user_id: queen.user_id as number,
        from_date: queen.start,
        to_date: end,
      });
    });
  }
  validatePlacements(rows);
  return { rows, skipped };
}

/**
 * Throws if two placements of one queen or of one hive overlap, or if a
 * placement does not end after its start.
 */
export function validatePlacements(rows: PlacementPeriod[]) {
  const groups = new Map<string, PlacementPeriod[]>();
  for (const row of rows) {
    if (row.to_date <= row.from_date)
      throw new Error(`Placement of queen ${row.queen_id} has no days`);
    for (const key of [`q${row.queen_id}`, `h${row.hive_id}`]) {
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }
  }
  for (const [key, list] of groups) {
    list.sort(byStart);
    for (let index = 1; index < list.length; index++)
      if (list[index].from_date < list[index - 1].to_date)
        throw new Error(`Placements overlap for ${key}`);
  }
}
