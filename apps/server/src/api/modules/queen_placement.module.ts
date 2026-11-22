import httpErrors from 'http-errors';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { Database } from '../../types/database.types.js';
import type { DB } from '../../types/db.types.js';
import type { CompatibilityQuery } from '../schemas/common.schema.js';
import type { PatchBody } from '../schemas/queen_placement.schema.js';
import type { Day, PlacementPeriod } from '../utils/queen_placement.util.js';
import {
  derivePlacement,
  isOpen,
  OPEN_END,
  toDay,
} from '../utils/queen_placement.util.js';
import { actorProjection } from './actor_projection.module.js';

/** Error codes, so the web app can show a translated message. */
export const PLACEMENT_ERRORS = {
  overlap: 'QUEEN_PLACEMENT_OVERLAP',
  range: 'QUEEN_PLACEMENT_RANGE',
  hiveTwice: 'QUEEN_PLACEMENT_HIVE_TWICE',
  state: 'QUEEN_PLACEMENT_STATE',
} as const;

function overlapError() {
  return httpErrors(
    400,
    'The queen placement overlaps another placement of this queen or hive.',
    { code: PLACEMENT_ERRORS.overlap },
  );
}
function rangeError() {
  return httpErrors(
    400,
    'The end of a queen placement must be after its start.',
    { code: PLACEMENT_ERRORS.range },
  );
}
function stateError() {
  return httpErrors(
    400,
    'An edit cannot open or close a queen placement. Move the queen or change her status.',
    { code: PLACEMENT_ERRORS.state },
  );
}
export function hiveTwiceError() {
  return httpErrors(
    400,
    'Only one queen can move into a hive in one request.',
    { code: PLACEMENT_ERRORS.hiveTwice },
  );
}

/** DATE value for a day. The pool writes dates in UTC. */
export function asDate(day: Day) {
  return new Date(`${day}T00:00:00.000Z`);
}

export interface PlacementContext {
  companyId: number;
  beeId: number;
}

function toPeriod(row: {
  id: number;
  queen_id: number;
  hive_id: number;
  from_date: unknown;
  to_date: unknown;
}): PlacementPeriod & { id: number } {
  return {
    id: row.id,
    queen_id: row.queen_id,
    hive_id: row.hive_id,
    from_date: toDay(row.from_date) as Day,
    to_date: toDay(row.to_date) as Day,
  };
}

const periodColumns = [
  'id',
  'queen_id',
  'hive_id',
  'from_date',
  'to_date',
] as const;

export async function queenPeriods(db: Database, queenId: number) {
  const rows = await db
    .selectFrom('queen_placements')
    .select(periodColumns)
    .where('queen_id', '=', queenId)
    .orderBy('from_date')
    .orderBy('id')
    .execute();
  return rows.map(toPeriod);
}

async function hivePeriods(db: Database, hiveId: number) {
  const rows = await db
    .selectFrom('queen_placements')
    .select(periodColumns)
    .where('hive_id', '=', hiveId)
    .orderBy('from_date')
    .orderBy('id')
    .execute();
  return rows.map(toPeriod);
}

/**
 * The day of a move or of an inactive status when the client sends no day.
 * The server day is UTC, so after local midnight in Europe it can be one day
 * before the start of a placement that the client saved with its local day.
 * Then the latest start of the open placements of the queen and of the hive
 * is used.
 */
export async function defaultDay(
  db: Database,
  queenId: number | null,
  hiveId: number | null,
  day: Day,
) {
  const rows = [
    ...(queenId === null ? [] : await queenPeriods(db, queenId)),
    ...(hiveId === null ? [] : await hivePeriods(db, hiveId)),
  ];
  return rows
    .filter(isOpen)
    .reduce(
      (latest, row) => (row.from_date > latest ? row.from_date : latest),
      day,
    );
}

/**
 * Locks the hives, then the queens, in ascending id order. Concurrent
 * requests for the same hive or queen then wait instead of both passing the
 * overlap check.
 */
export async function lockRows(
  db: Database,
  hiveIds: number[],
  queenIds: number[],
) {
  const hives = [...new Set(hiveIds)].sort((a, b) => a - b);
  const queens = [...new Set(queenIds)].sort((a, b) => a - b);
  if (hives.length)
    await db
      .selectFrom('hives')
      .select('id')
      .where('id', 'in', hives)
      .orderBy('id')
      .forUpdate()
      .execute();
  if (queens.length)
    await db
      .selectFrom('queens')
      .select('id')
      .where('id', 'in', queens)
      .orderBy('id')
      .forUpdate()
      .execute();
}

/** Throws if the period overlaps another placement of the queen or hive. */
async function assertFree(
  db: Database,
  period: { queen_id: number; hive_id: number; from_date: Day; to_date: Day },
  ignoreId?: number,
) {
  if (period.to_date <= period.from_date) throw rangeError();
  if (await hasOverlap(db, period, ignoreId)) throw overlapError();
}

async function hasOverlap(
  db: Database,
  period: { queen_id: number; hive_id: number; from_date: Day; to_date: Day },
  ignoreId?: number,
) {
  let query = db
    .selectFrom('queen_placements')
    .select('id')
    .where((eb) =>
      eb.or([
        eb('queen_id', '=', period.queen_id),
        eb('hive_id', '=', period.hive_id),
      ]),
    )
    .where('from_date', '<', asDate(period.to_date))
    .where('to_date', '>', asDate(period.from_date));
  if (ignoreId !== undefined) query = query.where('id', '!=', ignoreId);
  return Boolean(await query.executeTakeFirst());
}

async function setPeriod(
  db: Database,
  ctx: PlacementContext,
  id: number,
  values: { from_date?: Day; to_date?: Day; hive_id?: number },
) {
  await db
    .updateTable('queen_placements')
    .set({
      ...(values.from_date && { from_date: asDate(values.from_date) }),
      ...(values.to_date && { to_date: asDate(values.to_date) }),
      ...(values.hive_id !== undefined && { hive_id: values.hive_id }),
      edit_id: ctx.beeId,
    })
    .where('id', '=', id)
    .execute();
}

/**
 * Writes the derived `hive_id` and `move_date` to `queens`. The old columns
 * stay until the cleanup, so that a rollback of the server still works.
 * A queen without placements keeps the stored `move_date`.
 */
export async function syncQueen(db: Database, queenId: number) {
  const queen = await db
    .selectFrom('queens')
    .select('modus')
    .where('id', '=', queenId)
    .executeTakeFirst();
  if (!queen) return;
  const rows = await queenPeriods(db, queenId);
  if (!rows.length) {
    await db
      .updateTable('queens')
      .set({ hive_id: null })
      .where('id', '=', queenId)
      .execute();
    return;
  }
  const derived = derivePlacement(queen.modus, rows);
  await db
    .updateTable('queens')
    .set({
      hive_id: derived.hive_id,
      move_date: derived.move_date ? asDate(derived.move_date) : null,
    })
    .where('id', '=', queenId)
    .execute();
}

/**
 * Moves an active queen into a hive on a day, or out of her hive when
 * `hiveId` is null.
 * - The open placement of the queen ends on the day. On the same day as its
 *   start, the move changes that placement instead.
 * - Other queens in the target hive end on the day and become inactive. A
 *   placement of another queen that starts on the same day has no days
 *   left, so it is deleted.
 * - The move must not overlap a later placement of the queen or the hive.
 */
export async function moveQueen(
  db: Database,
  ctx: PlacementContext,
  queenId: number,
  hiveId: number | null,
  day: Day,
) {
  const rows = await queenPeriods(db, queenId);
  const open = rows.find(isOpen);
  if (hiveId === null) {
    if (!open) return;
    if (day < open.from_date) throw rangeError();
    if (day === open.from_date)
      await db
        .deleteFrom('queen_placements')
        .where('id', '=', open.id)
        .execute();
    else await setPeriod(db, ctx, open.id, { to_date: day });
    return;
  }
  if (open?.hive_id === hiveId) return;
  if (rows.some((row) => !isOpen(row) && row.to_date > day))
    throw overlapError();
  if (open && open.from_date > day) throw overlapError();

  const others = await hivePeriods(db, hiveId);
  if (others.some((row) => !isOpen(row) && row.to_date > day))
    throw overlapError();
  for (const row of others.filter(isOpen)) {
    if (row.from_date > day) throw overlapError();
    if (row.from_date === day)
      await db
        .deleteFrom('queen_placements')
        .where('id', '=', row.id)
        .execute();
    else await setPeriod(db, ctx, row.id, { to_date: day });
    await db
      .updateTable('queens')
      .set({ modus: false, modus_date: asDate(day), edit_id: ctx.beeId })
      .where('id', '=', row.queen_id)
      .execute();
    await syncQueen(db, row.queen_id);
  }

  if (open && open.from_date === day) {
    await setPeriod(db, ctx, open.id, { hive_id: hiveId });
    return;
  }
  if (open) await setPeriod(db, ctx, open.id, { to_date: day });
  await db
    .insertInto('queen_placements')
    .values({
      queen_id: queenId,
      hive_id: hiveId,
      from_date: asDate(day),
      to_date: asDate(OPEN_END),
      user_id: ctx.companyId,
      bee_id: ctx.beeId,
    })
    .execute();
}

/**
 * Ends the open placement when the queen becomes inactive on a day. On the
 * same day as its start, the placement has no days and is deleted, the same
 * as in `moveQueen`. Returns true if it deleted the placement.
 */
export async function endOnInactive(
  db: Database,
  ctx: PlacementContext,
  queenId: number,
  day: Day,
) {
  const open = (await queenPeriods(db, queenId)).find(isOpen);
  if (!open) return false;
  if (day < open.from_date) throw rangeError();
  if (day === open.from_date) {
    await db.deleteFrom('queen_placements').where('id', '=', open.id).execute();
    return true;
  }
  await setPeriod(db, ctx, open.id, { to_date: day });
  return false;
}

/**
 * Reopens the last placement when an inactive queen becomes active again.
 * Only if the placement ended on the old `modus_date` and the hive is free.
 * Else the queen is active without a hive.
 */
export async function reopenOnActive(
  db: Database,
  ctx: PlacementContext,
  queenId: number,
  oldModusDay: Day | null,
) {
  const last = (await queenPeriods(db, queenId)).at(-1);
  if (!last || isOpen(last) || !oldModusDay || last.to_date !== oldModusDay)
    return;
  const period = { ...last, to_date: OPEN_END };
  if (await hasOverlap(db, period, last.id)) return;
  await setPeriod(db, ctx, last.id, { to_date: OPEN_END });
}

/**
 * Moves the end of the last placement with a changed `modus_date`, if the
 * placement ended on the old `modus_date`.
 */
export async function moveEndWithModusDate(
  db: Database,
  ctx: PlacementContext,
  queenId: number,
  oldDay: Day | null,
  newDay: Day,
) {
  const last = (await queenPeriods(db, queenId)).at(-1);
  if (!last || isOpen(last) || !oldDay || last.to_date !== oldDay) return;
  await assertFree(db, { ...last, to_date: newDay }, last.id);
  await setPeriod(db, ctx, last.id, { to_date: newDay });
}

/**
 * Changes the current placement (the one the API shows as `hive_id` and
 * `move_date`): its start, or its hive. A null hive deletes the placement.
 */
export async function editCurrent(
  db: Database,
  ctx: PlacementContext,
  row: PlacementPeriod & { id?: number },
  values: { hive_id?: number | null; from_date?: Day },
) {
  if (!row.id) return;
  if (values.hive_id === null) {
    await db.deleteFrom('queen_placements').where('id', '=', row.id).execute();
    return;
  }
  const next = {
    ...row,
    ...(values.hive_id !== undefined && { hive_id: values.hive_id }),
    ...(values.from_date && { from_date: values.from_date }),
  };
  await assertFree(db, next, row.id);
  await setPeriod(db, ctx, row.id, {
    from_date: next.from_date,
    hive_id: next.hive_id,
  });
}

/**
 * Changes the `move_date` of a queen whose hive stays the same.
 * - Queen in a hive: the start of the current placement.
 * - Active queen moved out of her last hive: the end of that placement.
 * - Queen without placements: `queens.move_date`.
 */
async function editDate(
  db: Database,
  ctx: PlacementContext,
  queenId: number,
  current: PlacementPeriod | undefined,
  day: Day,
) {
  if (current) {
    await editCurrent(db, ctx, current, { from_date: day });
    return;
  }
  const last = (await queenPeriods(db, queenId)).at(-1);
  if (!last) {
    await db
      .updateTable('queens')
      .set({ move_date: asDate(day) })
      .where('id', '=', queenId)
      .execute();
    return;
  }
  if (!last.id) return;
  await assertFree(db, { ...last, to_date: day }, last.id);
  await setPeriod(db, ctx, last.id, { to_date: day });
}

/**
 * Applies `modus`, `modus_date`, `hive_id` and `move_date` of a queen write
 * to the placements. The web app sends these fields with every save, so the
 * values are compared with the current state first:
 * 1. `modus` and `modus_date`.
 * 2. Same hive, other date: change the start of the current placement.
 * 3. Other hive: a move. An inactive queen changes her last placement.
 */
export async function applyQueenWrite(
  db: Database,
  ctx: PlacementContext,
  queenId: number,
  data: {
    hive_id?: number | null | 'empty';
    move_date?: string | null;
    modus?: boolean;
    modus_date?: string | null;
  },
  movedInto: Set<number>,
  today: Day,
) {
  const queen = await db
    .selectFrom('queens')
    .select(['modus', 'modus_date'])
    .where('id', '=', queenId)
    .executeTakeFirstOrThrow();
  const oldModus = queen.modus !== false;
  const oldModusDay = toDay(queen.modus_date);
  const modus = data.modus ?? oldModus;
  const sentModusDay =
    data.modus_date === undefined ? undefined : toDay(data.modus_date);

  let modusDay: Day | null = sentModusDay ?? oldModusDay;
  // The web form resends the hive and move date of the deleted placement.
  // They belong to no placement now, so the hive and date step is skipped.
  let deletedOpen = false;
  if (oldModus && !modus) {
    modusDay = sentModusDay ?? (await defaultDay(db, queenId, null, today));
    deletedOpen = await endOnInactive(db, ctx, queenId, modusDay);
  } else if (!oldModus && modus) {
    await reopenOnActive(db, ctx, queenId, oldModusDay);
    modusDay = sentModusDay === undefined ? oldModusDay : sentModusDay;
  } else if (!modus && sentModusDay && sentModusDay !== oldModusDay) {
    await moveEndWithModusDate(db, ctx, queenId, oldModusDay, sentModusDay);
  }
  if (data.modus !== undefined || data.modus_date !== undefined)
    await db
      .updateTable('queens')
      .set({
        modus,
        modus_date: modusDay ? asDate(modusDay) : null,
      })
      .where('id', '=', queenId)
      .execute();

  if (
    !deletedOpen &&
    (data.hive_id !== undefined || data.move_date !== undefined)
  ) {
    const derived = derivePlacement(modus, await queenPeriods(db, queenId));
    const target =
      data.hive_id === undefined
        ? derived.hive_id
        : data.hive_id === 'empty'
          ? null
          : data.hive_id;
    const day =
      data.move_date === undefined ? undefined : toDay(data.move_date);
    if (target === derived.hive_id) {
      if (day && day !== derived.move_date)
        await editDate(db, ctx, queenId, derived.row, day);
    } else if (!modus) {
      if (derived.row)
        await editCurrent(db, ctx, derived.row, {
          hive_id: target,
          from_date: day ?? undefined,
        });
    } else {
      if (target !== null) {
        if (movedInto.has(target)) throw hiveTwiceError();
        movedInto.add(target);
      }
      await moveQueen(
        db,
        ctx,
        queenId,
        target,
        day ?? (await defaultDay(db, queenId, target, today)),
      );
    }
  }
  await syncQueen(db, queenId);
}

interface RelationResponse {
  [key: string]: unknown;
  id: number;
}

const orderColumns: Record<string, string> = {
  id: 'queen_placements.id',
  from_date: 'queen_placements.from_date',
  to_date: 'queen_placements.to_date',
  created_at: 'queen_placements.created_at',
  updated_at: 'queen_placements.updated_at',
  'queen.name': 'queens.name',
  'hive.name': 'hives.name',
};

function selectPlacements(db: Database, companyId: number) {
  return db
    .selectFrom('queen_placements')
    .innerJoin('queens', 'queens.id', 'queen_placements.queen_id')
    .innerJoin('hives', 'hives.id', 'queen_placements.hive_id')
    .leftJoin('bees as creator', 'creator.id', 'queen_placements.bee_id')
    .leftJoin('bees as editor', 'editor.id', 'queen_placements.edit_id')
    .where('queen_placements.user_id', '=', companyId);
}

function placementColumns() {
  return [
    'queen_placements.id',
    'queen_placements.queen_id',
    'queen_placements.hive_id',
    'queen_placements.from_date',
    sql<string | null>`NULLIF(queen_placements.to_date, ${OPEN_END})`.as(
      'to_date',
    ),
    'queen_placements.user_id',
    'queen_placements.bee_id',
    'queen_placements.edit_id',
    'queen_placements.created_at',
    'queen_placements.updated_at',
    sql<RelationResponse>`JSON_OBJECT('id', queens.id, 'name', queens.name, 'mark_colour', queens.mark_colour, 'date', queens.date, 'modus', IF(queens.modus = 1, TRUE, FALSE), 'modus_date', queens.modus_date, 'deleted', IF(queens.deleted = 1, TRUE, FALSE))`.as(
      'queen',
    ),
    sql<RelationResponse>`JSON_OBJECT('id', hives.id, 'name', hives.name, 'modus', IF(hives.modus = 1, TRUE, FALSE), 'deleted', IF(hives.deleted = 1, TRUE, FALSE))`.as(
      'hive',
    ),
    actorProjection('creator'),
    actorProjection('editor'),
  ] as const;
}

/**
 * Lists placements. Filters: `queen_placements.queen_id` and
 * `queen_placements.hive_id` in `filters`. `to_date` is null for an open
 * placement.
 */
export async function listPlacements(
  db: Database,
  companyId: number,
  input: CompatibilityQuery,
) {
  const limit = input.limit === 0 || !input.limit ? 10 : input.limit;
  const offset = input.offset ?? 0;
  let query = selectPlacements(db, companyId).select(placementColumns());
  let count = selectPlacements(db, companyId).select(
    db.fn.countAll<number>().as('total'),
  );
  if (input.filters) {
    try {
      const filters: unknown = JSON.parse(input.filters);
      if (Array.isArray(filters)) {
        for (const filter of filters) {
          if (typeof filter !== 'object' || filter === null) continue;
          const value = filter as Record<string, unknown>;
          for (const column of ['queen_id', 'hive_id'] as const) {
            const id = Number(value[`queen_placements.${column}`]);
            if (Number.isFinite(id) && id > 0) {
              query = query.where(`queen_placements.${column}`, '=', id);
              count = count.where(`queen_placements.${column}`, '=', id);
            }
          }
        }
      }
    } catch {
      /* ignore malformed filters, like the other lists */
    }
  }
  if (input.q?.trim()) {
    const search = `%${input.q}%`;
    query = query.where((eb) =>
      eb.or([
        eb('queens.name', 'like', search),
        eb('hives.name', 'like', search),
      ]),
    );
    count = count.where((eb) =>
      eb.or([
        eb('queens.name', 'like', search),
        eb('hives.name', 'like', search),
      ]),
    );
  }
  const fields = Array.isArray(input.order)
    ? input.order
    : input.order
      ? [input.order]
      : [];
  const directions = Array.isArray(input.direction)
    ? input.direction
    : [input.direction];
  fields.forEach((field, index) => {
    const column = orderColumns[field];
    if (column)
      query = query.orderBy(
        sql.ref(column),
        String(directions[index]).toLowerCase() === 'desc' ? 'desc' : 'asc',
      );
  });
  if (!fields.length)
    query = query.orderBy('queen_placements.from_date', 'desc');
  const [results, total] = await Promise.all([
    query
      .orderBy('queen_placements.id')
      .limit(limit)
      .offset(offset * limit)
      .execute(),
    count.executeTakeFirstOrThrow(),
  ]);
  return { results, total: total.total };
}

export function getPlacementsByIds(
  db: Database,
  companyId: number,
  ids: number[],
) {
  return selectPlacements(db, companyId)
    .select(placementColumns())
    .where('queen_placements.id', 'in', ids)
    .execute();
}

async function ownedPeriods(db: Database, companyId: number, ids: number[]) {
  const rows = await db
    .selectFrom('queen_placements')
    .select(periodColumns)
    .where('user_id', '=', companyId)
    .where('id', 'in', ids)
    .orderBy('id')
    .execute();
  return rows.map(toPeriod);
}

/**
 * Changes `from_date` and `to_date` of placements. An edit cannot open or
 * close a placement, because the queen state (`modus`) does not change: a
 * move or a status change does that.
 */
export function updatePlacements(
  db: Kysely<DB>,
  companyId: number,
  beeId: number,
  body: PatchBody,
) {
  return db.transaction().execute(async (trx) => {
    const ctx = { companyId, beeId };
    const rows = await ownedPeriods(trx, companyId, body.ids);
    await lockRows(
      trx,
      rows.map((row) => row.hive_id),
      rows.map((row) => row.queen_id),
    );
    for (const row of rows) {
      const fromDate =
        body.data.from_date === undefined
          ? row.from_date
          : toDay(body.data.from_date);
      const toDate =
        body.data.to_date === undefined
          ? row.to_date
          : body.data.to_date === null
            ? OPEN_END
            : toDay(body.data.to_date);
      if (!fromDate || !toDate) throw rangeError();
      if (isOpen(row) !== (toDate === OPEN_END)) throw stateError();
      const next = { ...row, from_date: fromDate, to_date: toDate };
      await assertFree(trx, next, row.id);
      await setPeriod(trx, ctx, row.id, next);
      await syncQueen(trx, row.queen_id);
    }
    return rows.length;
  });
}

export function deletePlacements(
  db: Kysely<DB>,
  companyId: number,
  ids: number[],
) {
  return db.transaction().execute(async (trx) => {
    const rows = await ownedPeriods(trx, companyId, ids);
    if (!rows.length) return 0;
    await lockRows(
      trx,
      rows.map((row) => row.hive_id),
      rows.map((row) => row.queen_id),
    );
    await trx
      .deleteFrom('queen_placements')
      .where(
        'id',
        'in',
        rows.map((row) => row.id),
      )
      .execute();
    for (const queenId of new Set(rows.map((row) => row.queen_id)))
      await syncQueen(trx, queenId);
    return rows.length;
  });
}
