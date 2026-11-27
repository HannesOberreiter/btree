import httpErrors from 'http-errors';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { Database } from '../../types/database.types.js';
import type { DB } from '../../types/db.types.js';
import type { CompatibilityQuery } from '../schemas/common.schema.js';
import type { PatchBody, PostBody } from '../schemas/queen.schema.js';
import { OPEN_END, toDay, today } from '../utils/queen_placement.util.js';
import { actorProjection } from './actor_projection.module.js';
import {
  applyQueenWrite,
  asDate,
  defaultDay,
  hiveTwiceError,
  lockRows,
  moveQueen,
} from './queen_placement.module.js';

const queenBaseOrderFields: Record<string, string> = {
  id: 'queens.id',
  name: 'queens.name',
  date: 'queens.date',
  mark_colour: 'queens.mark_colour',
  move_date: 'queen_current_placements.move_date',
  mother: 'queens.mother',
  modus: 'queens.modus',
  modus_date: 'queens.modus_date',
  created_at: 'queens.created_at',
  updated_at: 'queens.updated_at',
  deleted_at: 'queens.deleted_at',
  'queens.id': 'queens.id',
  'queens.name': 'queens.name',
  'queens.date': 'queens.date',
  'hive_location.hive_name': 'hives_locations.hive_name',
  'hive_location.apiary_name': 'hives_locations.apiary_name',
};
const queenDetailOrderFields: Record<string, string> = {
  ...queenBaseOrderFields,
  'queen_location.queen_id': 'queens_locations.queen_id',
  'own_mother.name': 'own_mother.name',
  'mating.name': 'queen_matings.name',
  'race.name': 'queen_races.name',
};
const queenStatsOrderFields: Record<string, string> = {
  id: 'queens.id',
  'queens.name': 'queens.name',
  'hive_location.hive_name': 'hives_locations.hive_name',
  move_date: 'queen_placements.from_date',
};
function direction(value: unknown): 'asc' | 'desc' {
  return String(value).toLowerCase() === 'desc' ? 'desc' : 'asc';
}
function applyOrder<Q>(
  query: Q,
  order: unknown,
  directions: unknown,
  allowed: Record<string, string>,
): Q {
  const fields = Array.isArray(order) ? order : order ? [order] : [];
  const dirs = Array.isArray(directions) ? directions : [directions];
  let result = query;
  fields.forEach((field, index) => {
    const column = allowed[String(field)];
    if (column)
      result = (
        result as Q & {
          orderBy: (field: string, direction: 'asc' | 'desc') => Q;
        }
      ).orderBy(column, direction(dirs[index]));
  });
  return result;
}
function hiveLocationProjection() {
  return sql<Record<
    string,
    unknown
  > | null>`CASE WHEN hives_locations.hive_id IS NULL THEN NULL ELSE JSON_OBJECT('hive_id', hives_locations.hive_id, 'hive_name', hives_locations.hive_name, 'apiary_id', hives_locations.apiary_id, 'apiary_name', hives_locations.apiary_name, 'hive_modus', IF(hives_locations.hive_modus = 1, TRUE, FALSE), 'hive_deleted', IF(hives_locations.hive_deleted = 1, TRUE, FALSE), 'user_id', hives_locations.user_id) END`.as(
    'hive_location',
  );
}
function optionProjection(
  table: 'queen_races' | 'queen_matings',
  alias: 'race' | 'mating',
) {
  return sql<Record<
    string,
    unknown
  > | null>`CASE WHEN ${sql.table(table)}.id IS NULL THEN NULL ELSE JSON_OBJECT('id', ${sql.ref(`${table}.id`)}, 'name', ${sql.ref(`${table}.name`)}, 'modus', IF(${sql.ref(`${table}.modus`)} = 1, TRUE, FALSE), 'favorite', IF(${sql.ref(`${table}.favorite`)} = 1, TRUE, FALSE), 'user_id', ${sql.ref(`${table}.user_id`)}) END`.as(
    alias,
  );
}
/**
 * Queens with the derived `hive_id` and `move_date` from the view
 * `queen_current_placements`, and the location of that hive.
 */
function fromQueens(db: Database) {
  return db
    .selectFrom('queens')
    .leftJoin(
      'queen_current_placements',
      'queen_current_placements.queen_id',
      'queens.id',
    )
    .leftJoin(
      'hives_locations',
      'hives_locations.hive_id',
      'queen_current_placements.hive_id',
    );
}
const placementColumns = [
  'queen_current_placements.hive_id',
  'queen_current_placements.move_date',
] as const;
function selectQueens(db: Database, companyId: number, details: boolean) {
  let query = fromQueens(db)
    .selectAll('queens')
    .select(placementColumns)
    .select(hiveLocationProjection())
    .where('queens.user_id', '=', companyId);
  if (details)
    query = query
      .leftJoin('queens_locations', 'queens_locations.queen_id', 'queens.id')
      .leftJoin('queen_races', 'queen_races.id', 'queens.race_id')
      .leftJoin('queen_matings', 'queen_matings.id', 'queens.mating_id')
      .leftJoin('queens as own_mother', 'own_mother.id', 'queens.mother_id')
      .leftJoin('bees as creator', 'creator.id', 'queens.bee_id')
      .leftJoin('bees as editor', 'editor.id', 'queens.edit_id')
      .select([
        sql<Record<
          string,
          unknown
        > | null>`CASE WHEN queens_locations.queen_id IS NULL THEN NULL ELSE JSON_OBJECT('queen_id', queens_locations.queen_id, 'hive_id', queens_locations.hive_id, 'hive_name', queens_locations.hive_name, 'queen_name', queens_locations.queen_name, 'queen_mark_colour', queens_locations.queen_mark_colour, 'queen_modus', IF(queens_locations.queen_modus = 1, TRUE, FALSE), 'queen_modus_date', queens_locations.queen_modus_date, 'queen_move_date', queens_locations.queen_move_date) END`.as(
          'queen_location',
        ),
        optionProjection('queen_races', 'race'),
        optionProjection('queen_matings', 'mating'),
        sql<Record<
          string,
          unknown
        > | null>`CASE WHEN own_mother.id IS NULL THEN NULL ELSE JSON_OBJECT('id', own_mother.id, 'name', own_mother.name, 'date', own_mother.date, 'mother', own_mother.mother, 'mark_colour', own_mother.mark_colour) END`.as(
          'own_mother',
        ),
        actorProjection('creator'),
        actorProjection('editor'),
      ]);
  return query;
}
/** Last queen of a page in the order birth date, then id. */
export interface QueenKeyset {
  date: string;
  id: number;
}

export async function listQueens(
  db: Database,
  companyId: number,
  input: CompatibilityQuery,
  options: { birthOrder?: boolean; keyset?: QueenKeyset } = {},
) {
  const limit = input.limit === 0 || !input.limit ? 10 : input.limit;
  const offset = input.offset ?? 0;
  const details = input.details === true;
  let query = selectQueens(db, companyId, details).where(
    'queens.deleted',
    '=',
    input.deleted === true,
  );
  let count = fromQueens(db)
    .select(db.fn.countAll<number>().as('total'))
    .where('queens.user_id', '=', companyId)
    .where('queens.deleted', '=', input.deleted === true);
  if (input.modus !== undefined && input.modus !== null) {
    query = query.where('queens.modus', '=', input.modus);
    count = count.where('modus', '=', input.modus);
  }
  if (details && input.latest !== undefined) {
    query = input.latest
      ? query.where(sql<boolean>`queens_locations.queen_id IS NOT NULL`)
      : query.where(sql<boolean>`queens_locations.queen_id IS NULL`);
    count = count
      .leftJoin('queens_locations', 'queens_locations.queen_id', 'queens.id')
      .where('queens_locations.queen_id', input.latest ? 'is not' : 'is', null);
  }
  if (input.filters) {
    try {
      const filters: unknown = JSON.parse(input.filters);
      if (Array.isArray(filters)) {
        for (const filter of filters) {
          if (typeof filter !== 'object' || filter === null) continue;
          const value = filter as Record<string, unknown>;
          const date = value['queens.date'];
          if (typeof date === 'object' && date !== null) {
            const range = date as Record<string, string>;
            query = query
              .where('queens.date', '>=', new Date(range.from))
              .where('queens.date', '<=', new Date(range.to));
            count = count
              .where('queens.date', '>=', new Date(range.from))
              .where('queens.date', '<=', new Date(range.to));
          }
          const matingId = Number(value['queens.mating_id']);
          if (Number.isFinite(matingId)) {
            query = query.where('queens.mating_id', '=', matingId);
            count = count.where('queens.mating_id', '=', matingId);
          }
          const raceId = Number(value['queens.race_id']);
          if (Number.isFinite(raceId)) {
            query = query.where('queens.race_id', '=', raceId);
            count = count.where('queens.race_id', '=', raceId);
          }
          const apiaryId = Number(value['hive_location.apiary_id']);
          if (Number.isFinite(apiaryId)) {
            query = query.where('hives_locations.apiary_id', '=', apiaryId);
            count = count.where('hives_locations.apiary_id', '=', apiaryId);
          }
          const hive = value['queens.hive_id'];
          // `empty` and `notEmpty` split the queens into the virgin table
          // and the queen table, so every queen is in exactly one of them.
          if (hive === 'empty') {
            query = query.where('hives_locations.hive_id', 'is', null);
            count = count.where('hives_locations.hive_id', 'is', null);
          } else if (hive === 'notEmpty') {
            query = query.where('hives_locations.hive_id', 'is not', null);
            count = count.where('hives_locations.hive_id', 'is not', null);
          } else if (Number.isFinite(Number(hive))) {
            query = query.where(
              'queen_current_placements.hive_id',
              '=',
              Number(hive),
            );
            count = count.where(
              'queen_current_placements.hive_id',
              '=',
              Number(hive),
            );
          }
        }
      }
    } catch {
      /* preserve ignored malformed filters */
    }
  }
  if (input.q?.trim()) {
    const search = `%${input.q}%`;
    query = query.where((eb) =>
      eb.or([
        eb('queens.name', 'like', search),
        eb('hives_locations.hive_name', 'like', search),
      ]),
    );
    count = count.where((eb) =>
      eb.or([
        eb('queens.name', 'like', search),
        eb('hives_locations.hive_name', 'like', search),
      ]),
    );
  }
  if (options.birthOrder) {
    const birth = sql.ref('queens.date');
    query = query.orderBy(birth).orderBy('queens.id');
    // After the count, so the total still counts all matches.
    if (options.keyset) {
      const { date, id } = options.keyset;
      query = query.where(
        sql<boolean>`(${birth} > ${date} OR (${birth} = ${date} AND queens.id > ${id}))`,
      );
    }
  } else {
    query = applyOrder(
      query,
      input.order,
      input.direction,
      details ? queenDetailOrderFields : queenBaseOrderFields,
    ).orderBy('queens.id');
  }
  const [results, total] = await Promise.all([
    query
      .limit(limit)
      .offset(offset * limit)
      .execute(),
    count.executeTakeFirstOrThrow(),
  ]);
  return { results, total: total.total };
}
export async function getQueenPedigree(
  db: Database,
  companyId: number,
  id: number,
) {
  const result = await sql<{
    id: number;
    name: string | null;
    mother_id: number | null;
    date: Date | null;
    mark_colour: string | null;
    mother: string | null;
    mating: string | null;
    race: string | null;
  }>`WITH RECURSIVE mothers AS (
    SELECT q.name,q.id,q.mother_id,q.date,q.mark_colour,q.mother,qm.name mating,qr.name race FROM queens q LEFT JOIN queen_matings qm ON q.mating_id=qm.id LEFT JOIN queen_races qr ON q.race_id=qr.id WHERE q.user_id=${companyId} AND q.id=${id}
    UNION ALL SELECT q.name,q.id,q.mother_id,q.date,q.mark_colour,q.mother,qm.name mating,qr.name race FROM queens q LEFT JOIN queen_matings qm ON q.mating_id=qm.id LEFT JOIN queen_races qr ON q.race_id=qr.id INNER JOIN mothers m ON q.id=m.mother_id WHERE q.user_id=${companyId}
  ) SELECT * FROM mothers`.execute(db);
  return result.rows;
}
function statsPlacements(db: Database, companyId: number) {
  return db
    .selectFrom('queen_placements')
    .innerJoin('queens', 'queens.id', 'queen_placements.queen_id')
    .leftJoin(
      'queen_current_placements',
      'queen_current_placements.queen_id',
      'queens.id',
    )
    .leftJoin(
      'hives_locations',
      'hives_locations.hive_id',
      'queen_placements.hive_id',
    )
    .where('queen_placements.user_id', '=', companyId)
    .where('queens.deleted', '=', false);
}
/**
 * One row per placement of a queen, with the mean checkup ratings and the
 * harvest sums of the hive in the placement period `[move_date, to_date)`.
 * `id` is the queen id, `placement_id` is unique per row.
 */
export async function listQueenStats(
  db: Database,
  companyId: number,
  input: CompatibilityQuery,
) {
  const limit = input.limit === 0 || !input.limit ? 10 : input.limit;
  const offset = input.offset ?? 0;
  let query = statsPlacements(db, companyId).select([
    'queens.id as id',
    'queen_placements.id as placement_id',
    'queen_placements.hive_id',
    'queen_placements.user_id',
    'queen_placements.from_date as move_date',
    sql<string | null>`NULLIF(queen_placements.to_date, ${OPEN_END})`.as(
      'to_date',
    ),
    sql<
      number | null
    >`IF(queen_placements.to_date = ${OPEN_END}, NULL, DATEDIFF(queen_placements.to_date, queen_placements.from_date))`.as(
      'duration',
    ),
    sql<string>`IF(queen_placements.to_date = ${OPEN_END}, CURDATE(), queen_placements.to_date)`.as(
      'last_date',
    ),
    sql<
      Record<string, unknown>
    >`JSON_OBJECT('id', queens.id, 'name', queens.name, 'date', queens.date, 'move_date', queen_current_placements.move_date, 'hive_id', queen_current_placements.hive_id)`.as(
      'queen',
    ),
    hiveLocationProjection(),
  ]);
  let count = statsPlacements(db, companyId).select(
    db.fn.countAll<number>().as('total'),
  );
  if (input.filters) {
    try {
      const filters: unknown = JSON.parse(input.filters);
      if (Array.isArray(filters)) {
        for (const filter of filters) {
          if (typeof filter !== 'object' || filter === null) continue;
          const value = filter as Record<string, unknown>;
          const moveDate = value['queens.move_date'];
          if (typeof moveDate === 'object' && moveDate !== null) {
            const range = moveDate as Record<string, string>;
            query = query
              .where('queen_placements.from_date', '>=', new Date(range.from))
              .where('queen_placements.from_date', '<=', new Date(range.to));
            count = count
              .where('queen_placements.from_date', '>=', new Date(range.from))
              .where('queen_placements.from_date', '<=', new Date(range.to));
          }
          const matingId = Number(value['queens.mating_id']);
          if (Number.isFinite(matingId)) {
            query = query.where('queens.mating_id', '=', matingId);
            count = count.where('queens.mating_id', '=', matingId);
          }
          const raceId = Number(value['queens.race_id']);
          if (Number.isFinite(raceId)) {
            query = query.where('queens.race_id', '=', raceId);
            count = count.where('queens.race_id', '=', raceId);
          }
          const apiaryId = Number(value['hive_location.apiary_id']);
          if (Number.isFinite(apiaryId)) {
            query = query.where('hives_locations.apiary_id', '=', apiaryId);
            count = count.where('hives_locations.apiary_id', '=', apiaryId);
          }
          const hive = value['queens.hive_id'];
          if (hive === 'empty') {
            query = query.where('hives_locations.hive_id', 'is', null);
            count = count.where('hives_locations.hive_id', 'is', null);
          } else if (Number.isFinite(Number(hive))) {
            query = query.where('queen_placements.hive_id', '=', Number(hive));
            count = count.where('queen_placements.hive_id', '=', Number(hive));
          }
        }
      }
    } catch {
      /* preserve ignored malformed filters */
    }
  }
  if (input.q?.trim()) {
    const search = `%${input.q}%`;
    query = query.where((eb) =>
      eb.or([
        eb('queens.name', 'like', search),
        eb('hives_locations.hive_name', 'like', search),
      ]),
    );
    count = count.where((eb) =>
      eb.or([
        eb('queens.name', 'like', search),
        eb('hives_locations.hive_name', 'like', search),
      ]),
    );
  }
  query = applyOrder(
    query,
    input.order,
    input.direction,
    queenStatsOrderFields,
  );
  const [rows, total] = await Promise.all([
    query
      .orderBy('queen_placements.id')
      .limit(limit)
      .offset(offset * limit)
      .execute(),
    count.executeTakeFirstOrThrow(),
  ]);
  const results = await Promise.all(
    rows.map(async (row) => {
      const end = asDate(toDay(row.to_date) ?? OPEN_END);
      return {
        ...row,
        checkup: await db
          .selectFrom('checkups')
          .select([
            sql<string | null>`AVG(NULLIF(brood,0))`.as('brood'),
            sql<string | null>`AVG(NULLIF(pollen,0))`.as('pollen'),
            sql<string | null>`AVG(NULLIF(comb,0))`.as('comb'),
            sql<string | null>`AVG(NULLIF(temper,0))`.as('temper'),
            sql<string | null>`AVG(NULLIF(calm_comb,0))`.as('calm_comb'),
            sql<string | null>`AVG(NULLIF(swarm,0))`.as('swarm'),
            sql<string | null>`AVG(NULLIF(varroa,0))`.as('varroa'),
            sql<string | null>`AVG(NULLIF(strong,0))`.as('strong'),
          ])
          .where('hive_id', '=', row.hive_id)
          .where('date', '>=', row.move_date)
          .where('date', '<', end)
          .executeTakeFirst(),
        harvest: await db
          .selectFrom('harvests')
          .select([
            db.fn.sum('frames').as('frames'),
            db.fn.sum('amount').as('amount'),
          ])
          .where('hive_id', '=', row.hive_id)
          .where('date', '>=', row.move_date)
          .where('date', '<', end)
          .executeTakeFirst(),
      };
    }),
  );
  return { results, total: total.total };
}
async function requireOwned(
  db: Database,
  table: 'hives' | 'queen_races' | 'queen_matings' | 'queens',
  id: number,
  companyId: number,
) {
  const row = await db
    .selectFrom(table)
    .select('id')
    .where('id', '=', id)
    .where('user_id', '=', companyId)
    .executeTakeFirst();
  if (!row) throw httpErrors.NotFound();
}
/** Fields of a queen write that are not about the placement. */
function queenValues(data: PatchBody['data']) {
  return {
    ...(data.name !== undefined && { name: data.name }),
    ...(data.mark_colour !== undefined && { mark_colour: data.mark_colour }),
    ...(data.mother !== undefined && { mother: data.mother }),
    ...(data.date && { date: new Date(data.date) }),
    ...(data.url !== undefined && { url: data.url }),
    ...(data.note !== undefined && { note: data.note }),
    ...(data.race_id !== undefined && { race_id: data.race_id }),
    ...(data.mating_id !== undefined && { mating_id: data.mating_id }),
    ...(data.mother_id !== undefined && { mother_id: data.mother_id }),
  };
}
export async function createQueens(
  db: Kysely<DB>,
  companyId: number,
  beeId: number,
  body: PostBody,
) {
  return db.transaction().execute(async (trx) => {
    if (body.race_id)
      await requireOwned(trx, 'queen_races', body.race_id, companyId);
    if (body.mating_id)
      await requireOwned(trx, 'queen_matings', body.mating_id, companyId);
    if (body.mother_id)
      await requireOwned(trx, 'queens', body.mother_id, companyId);
    const repeat = body.repeat && body.repeat > 1 ? body.repeat : 1;
    const hiveIds = Array.isArray(body.hive_id)
      ? body.hive_id
      : body.hive_id
        ? [body.hive_id]
        : [];
    for (const hiveId of new Set(hiveIds))
      await requireOwned(trx, 'hives', hiveId, companyId);
    await lockRows(trx, hiveIds, []);
    const ctx = { companyId, beeId };
    const sentDay = toDay(body.move_date);
    const movedInto = new Set<number>();
    const ids: number[] = [];
    for (let index = 0; index < repeat; index++) {
      const hiveId = Array.isArray(body.hive_id)
        ? (body.hive_id[index] ?? null)
        : (body.hive_id ?? null);
      const result = await trx
        .insertInto('queens')
        .values({
          ...queenValues({ ...body, date: undefined, hive_id: undefined }),
          // Old clients can send no birth date, the queen then gets today.
          date: body.date ? new Date(body.date) : new Date(),
          name:
            repeat > 1 ? `${body.name}${(body.start ?? 0) + index}` : body.name,
          user_id: companyId,
          bee_id: beeId,
        })
        .executeTakeFirstOrThrow();
      const id = Number(result.insertId);
      ids.push(id);
      if (hiveId) {
        if (movedInto.has(hiveId)) throw hiveTwiceError();
        movedInto.add(hiveId);
        await moveQueen(
          trx,
          ctx,
          id,
          hiveId,
          sentDay ?? (await defaultDay(trx, null, hiveId, today())),
        );
      }
      if (body.modus === false || body.modus_date !== undefined)
        await applyQueenWrite(
          trx,
          ctx,
          id,
          { modus: body.modus, modus_date: body.modus_date },
          movedInto,
          today(),
        );
    }
    return ids;
  });
}
async function ownedQueenIds(db: Database, companyId: number, ids: number[]) {
  const rows = await db
    .selectFrom('queens')
    .select('id')
    .where('user_id', '=', companyId)
    .where('id', 'in', ids)
    .orderBy('id')
    .execute();
  return rows.map((row) => row.id);
}
export async function updateQueens(
  db: Kysely<DB>,
  companyId: number,
  beeId: number,
  body: PatchBody,
) {
  return db.transaction().execute(async (trx) => {
    if (body.data.race_id)
      await requireOwned(trx, 'queen_races', body.data.race_id, companyId);
    if (body.data.mating_id)
      await requireOwned(trx, 'queen_matings', body.data.mating_id, companyId);
    if (body.data.mother_id)
      await requireOwned(trx, 'queens', body.data.mother_id, companyId);
    const hiveId = body.data.hive_id === 'empty' ? null : body.data.hive_id;
    if (hiveId) await requireOwned(trx, 'hives', hiveId, companyId);
    const ids = await ownedQueenIds(trx, companyId, body.ids);
    if (!ids.length) return 0;
    await lockRows(trx, hiveId ? [hiveId] : [], ids);
    const result = await trx
      .updateTable('queens')
      .set({ ...queenValues(body.data), edit_id: beeId })
      .where('id', 'in', ids)
      .executeTakeFirst();
    const ctx = { companyId, beeId };
    const movedInto = new Set<number>();
    for (const id of ids)
      await applyQueenWrite(trx, ctx, id, body.data, movedInto, today());
    return Number(result.numUpdatedRows);
  });
}
/**
 * Sets queens active or inactive with today as `modus_date`. A queen that
 * has the status already does not change.
 */
export async function updateQueenStatus(
  db: Kysely<DB>,
  companyId: number,
  beeId: number,
  ids: number[],
  status: boolean,
  modusDate?: string,
) {
  return db.transaction().execute(async (trx) => {
    const owned = await ownedQueenIds(trx, companyId, ids);
    if (!owned.length) return 0;
    await lockRows(trx, [], owned);
    await trx
      .updateTable('queens')
      .set({ edit_id: beeId })
      .where('id', 'in', owned)
      .execute();
    const ctx = { companyId, beeId };
    const day = today();
    for (const id of owned) {
      const queen = await trx
        .selectFrom('queens')
        .select('modus')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      if ((queen.modus !== false) === status) continue;
      // Without a day from the client, inactive gets no day, so that the
      // server can use the start of the placement after local midnight
      // (see defaultDay).
      await applyQueenWrite(
        trx,
        ctx,
        id,
        modusDate
          ? { modus: status, modus_date: modusDate }
          : status
            ? { modus: status, modus_date: day }
            : { modus: status },
        new Set(),
        day,
      );
    }
    return owned.length;
  });
}
export function getQueensByIds(db: Database, companyId: number, ids: number[]) {
  return db
    .selectFrom('queens')
    .leftJoin(
      'queen_current_placements',
      'queen_current_placements.queen_id',
      'queens.id',
    )
    .selectAll('queens')
    .select(placementColumns)
    .where('queens.user_id', '=', companyId)
    .where('queens.id', 'in', ids)
    .execute();
}
export async function deleteQueens(
  db: Kysely<DB>,
  companyId: number,
  beeId: number,
  ids: number[],
  hard: boolean,
  restore: boolean,
) {
  return db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom('queens')
      .select(['id', 'deleted'])
      .where('user_id', '=', companyId)
      .where('id', 'in', ids)
      .execute();
    const hardIds = rows
      .filter((r) => (r.deleted || hard) && !restore)
      .map((r) => r.id);
    const softIds = rows
      .filter((r) => !hardIds.includes(r.id))
      .map((r) => r.id);
    if (hardIds.length)
      await trx.deleteFrom('queens').where('id', 'in', hardIds).execute();
    if (softIds.length)
      await trx
        .updateTable('queens')
        .set({
          deleted: !restore,
          deleted_at: restore ? null : sql<Date>`UTC_TIMESTAMP()`,
          edit_id: beeId,
        })
        .where('id', 'in', softIds)
        .execute();
    return rows;
  });
}
