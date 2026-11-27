import { PassThrough } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import { ZipArchive } from 'archiver';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yauzl from 'yauzl-promise';

import {
  downloadCompanyData,
  importCompanyArchive,
} from '../../src/api/modules/company_transfer.module.js';
import type { BackfillQueen } from '../../src/api/utils/queen_placement.util.js';
import {
  buildQueenPlacements,
  derivePlacement,
  OPEN_END,
  validatePlacements,
} from '../../src/api/utils/queen_placement.util.js';
import { KyselyServer } from '../../src/servers/kysely.server.js';
import type { TestAgent } from '../utils.js';
import { createAgent, createAuthenticatedAgent } from '../utils.js';

function queen(values: Partial<BackfillQueen> & { id: number }): BackfillQueen {
  return {
    hive_id: 1,
    user_id: 1,
    move_date: null,
    created_at: '2020-01-01 10:00:00',
    updated_at: '2020-01-01 10:00:00',
    modus: true,
    modus_date: null,
    ...values,
  };
}

describe('queen placement backfill rules', () => {
  it('keeps the last active queen open and ends the others', () => {
    const { rows, skipped, inactivate } = buildQueenPlacements([
      queen({ id: 1, move_date: '2024-01-01 08:00:00' }),
      queen({ id: 2, move_date: '2024-05-01 00:00:00' }),
    ]);
    expect(skipped).toEqual([]);
    expect(rows).toEqual([
      {
        queen_id: 1,
        hive_id: 1,
        user_id: 1,
        from_date: '2024-01-01',
        to_date: '2024-05-01',
      },
      {
        queen_id: 2,
        hive_id: 1,
        user_id: 1,
        from_date: '2024-05-01',
        to_date: OPEN_END,
      },
    ]);
    // The replaced queen is still active: the migration sets her inactive.
    expect(inactivate).toEqual([{ queen_id: 1, modus_date: '2024-05-01' }]);
  });

  it('ends an inactive queen at the earlier of modus_date and the next start', () => {
    const { rows, inactivate } = buildQueenPlacements([
      // modus_date is the day of the click, after the next queen moved in.
      queen({
        id: 1,
        move_date: '2024-01-01',
        modus: false,
        modus_date: '2024-06-01',
      }),
      queen({ id: 2, move_date: '2024-05-01' }),
      queen({
        id: 3,
        hive_id: 2,
        move_date: '2024-01-01',
        modus: 0,
        modus_date: '2024-03-01',
      }),
    ]);
    const byQueen = Object.fromEntries(rows.map((row) => [row.queen_id, row]));
    expect(byQueen[1].to_date).toBe('2024-05-01');
    expect(byQueen[3].to_date).toBe('2024-03-01');
    expect(inactivate).toEqual([]);
  });

  it('ends the last inactive queen without modus_date at updated_at', () => {
    const { rows } = buildQueenPlacements([
      queen({
        id: 1,
        move_date: '2024-01-01',
        modus: false,
        updated_at: '2024-09-09 12:00:00',
      }),
    ]);
    expect(rows[0].to_date).toBe('2024-09-09');
  });

  it('of two queens with the same start day keeps the queen of the old view', () => {
    const { rows, skipped, inactivate } = buildQueenPlacements([
      // Later move time wins.
      queen({ id: 7, move_date: '2024-01-01' }),
      queen({ id: 3, move_date: '2024-01-01 15:00:00' }),
      // Same time: the active queen wins over a higher id.
      queen({ id: 8, hive_id: 2, move_date: '2024-01-01', modus: true }),
      queen({
        id: 9,
        hive_id: 2,
        move_date: '2024-01-01',
        modus: false,
        modus_date: '2024-01-01',
      }),
      // Same time and status: the higher id wins.
      queen({ id: 10, hive_id: 3, move_date: '2024-01-01' }),
      queen({ id: 11, hive_id: 3, move_date: '2024-01-01' }),
      // A deleted queen always loses.
      queen({ id: 12, hive_id: 4, move_date: '2024-01-01' }),
      queen({ id: 13, hive_id: 4, move_date: '2024-01-02', deleted: 1 }),
      queen({ id: 14, hive_id: 4, move_date: '2024-01-02' }),
    ]);
    expect(rows.map((row) => row.queen_id)).toEqual([3, 8, 11, 12, 14]);
    expect(skipped.map((skip) => skip.queen_id)).toEqual([7, 9, 10, 13]);
    // A skipped active queen becomes inactive on her start day.
    expect(inactivate).toEqual([
      { queen_id: 12, modus_date: '2024-01-02' },
      { queen_id: 7, modus_date: '2024-01-01' },
      { queen_id: 10, modus_date: '2024-01-01' },
    ]);
  });

  it('reads the zero date 0000-00-00 as no date', () => {
    const { rows, skipped, inactivate } = buildQueenPlacements([
      queen({
        id: 1,
        move_date: '2024-01-01',
        modus: false,
        modus_date: '0000-00-00',
        updated_at: '2024-06-01 10:00:00',
      }),
    ]);
    expect(skipped).toEqual([]);
    expect(rows[0].to_date).toBe('2024-06-01');
    // The queen gets the end of her row as modus_date.
    expect(inactivate).toEqual([{ queen_id: 1, modus_date: '2024-06-01' }]);
  });

  it('skips empty periods, queens without hive and without company', () => {
    const { rows, skipped } = buildQueenPlacements([
      // The 2024 migration set such queens inactive with an old modus_date.
      queen({
        id: 1,
        move_date: '2024-05-01',
        modus: false,
        modus_date: '2024-01-01',
      }),
      queen({ id: 2, hive_id: null }),
      queen({ id: 3, hive_id: 3, user_id: null }),
      queen({ id: 4, hive_id: 4, move_date: null }),
    ]);
    expect(rows.map((row) => [row.queen_id, row.from_date])).toEqual([
      [4, '2020-01-01'],
    ]);
    expect(skipped.map((skip) => [skip.queen_id, skip.reason])).toEqual([
      [3, 'no_company'],
      [1, 'empty_period'],
    ]);
  });

  it('a deleted queen does not end a queen that is not deleted', () => {
    const { rows, skipped } = buildQueenPlacements([
      queen({ id: 1, move_date: '2024-01-01', deleted: true }),
      queen({ id: 2, move_date: '2024-02-01' }),
      queen({ id: 3, move_date: '2024-03-01', deleted: 1 }),
      queen({ id: 4, hive_id: 2, move_date: '2024-01-01' }),
      queen({ id: 5, hive_id: 2, move_date: '2024-01-01', deleted: true }),
    ]);
    expect(
      rows.map((row) => [row.queen_id, row.from_date, row.to_date]),
    ).toEqual([
      [1, '2024-01-01', '2024-02-01'],
      [2, '2024-02-01', OPEN_END],
      [4, '2024-01-01', OPEN_END],
    ]);
    expect(skipped.map((skip) => [skip.queen_id, skip.reason])).toEqual([
      [3, 'deleted_overlap'],
      [5, 'same_start'],
    ]);
  });

  it('validates overlaps per queen and per hive', () => {
    const row = { queen_id: 1, hive_id: 1 };
    expect(() =>
      validatePlacements([
        { ...row, from_date: '2024-01-01', to_date: '2024-03-01' },
        { ...row, hive_id: 2, from_date: '2024-02-01', to_date: OPEN_END },
      ]),
    ).toThrow();
    expect(() =>
      validatePlacements([
        { ...row, from_date: '2024-01-01', to_date: '2024-03-01' },
        { ...row, queen_id: 2, from_date: '2024-03-01', to_date: OPEN_END },
      ]),
    ).not.toThrow();
    expect(() =>
      validatePlacements([
        { ...row, from_date: '2024-01-01', to_date: '2024-01-01' },
      ]),
    ).toThrow();
  });

  it('derives hive_id and move_date', () => {
    const rows = [
      {
        id: 1,
        queen_id: 1,
        hive_id: 5,
        from_date: '2024-01-01',
        to_date: '2024-03-01',
      },
    ];
    expect(derivePlacement(false, rows)).toMatchObject({
      hive_id: 5,
      move_date: '2024-01-01',
    });
    expect(derivePlacement(true, rows)).toEqual({
      hive_id: null,
      move_date: '2024-03-01',
    });
    expect(
      derivePlacement(true, [
        ...rows,
        {
          id: 2,
          queen_id: 1,
          hive_id: 6,
          from_date: '2024-03-01',
          to_date: OPEN_END,
        },
      ]),
    ).toMatchObject({ hive_id: 6, move_date: '2024-03-01' });
  });
});

describe('queen placements', () => {
  const db = KyselyServer.getInstance().db;
  let agent: TestAgent;
  let companyId: number;
  const hives: number[] = [];
  const queens: number[] = [];
  /** Queen of the caged queen test, used again by the placement routes. */
  let caged = 0;
  let apiaryId = 0;

  /** Adds an active hive in the apiary of the company. */
  async function addHive() {
    const result = await db
      .insertInto('hives')
      .values({
        name: `Placement hive ${hives.length}`,
        user_id: companyId,
        modus: true,
      })
      .executeTakeFirstOrThrow();
    const id = Number(result.insertId);
    hives.push(id);
    await db
      .insertInto('movedates')
      .values({
        apiary_id: apiaryId,
        hive_id: id,
        date: new Date('2020-01-01'),
      })
      .execute();
    return id;
  }

  async function post(data: Record<string, unknown>) {
    const res = await agent.request('POST', '/api/v1/queen', {
      name: `Placement ${queens.length}`,
      ...data,
    });
    if (res.statusCode === 200) queens.push(...(res.body as number[]));
    return res;
  }
  async function create(data: Record<string, unknown>) {
    const res = await post(data);
    expect(res.statusCode).toBe(200);
    return (res.body as number[])[0];
  }
  function patch(ids: number[], data: Record<string, unknown>) {
    return agent.request('PATCH', '/api/v1/queen', { ids, data });
  }
  async function placements(queenId: number) {
    const rows = await db
      .selectFrom('queen_placements')
      .select(['hive_id', 'from_date', 'to_date'])
      .where('queen_id', '=', queenId)
      .orderBy('from_date')
      .execute();
    return rows.map((row) => [
      row.hive_id,
      String(row.from_date),
      String(row.to_date),
    ]);
  }
  /** The derived hive and move date, and the status of a queen. */
  async function state(queenId: number) {
    const row = await db
      .selectFrom('queens')
      .innerJoin(
        'queen_current_placements',
        'queen_current_placements.queen_id',
        'queens.id',
      )
      .select([
        'queen_current_placements.hive_id',
        'queen_current_placements.move_date',
        'queens.modus',
        'queens.modus_date',
      ])
      .where('queens.id', '=', queenId)
      .executeTakeFirstOrThrow();
    return {
      hive_id: row.hive_id,
      move_date: row.move_date ? String(row.move_date).slice(0, 10) : null,
      modus: row.modus,
      modus_date: row.modus_date ? String(row.modus_date) : null,
    };
  }

  beforeAll(async () => {
    agent = await createAuthenticatedAgent();
    const hive = await db
      .selectFrom('hives')
      .select('user_id')
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    companyId = hive.user_id as number;
    const apiary = await db
      .selectFrom('apiaries')
      .select('id')
      .where('user_id', '=', companyId)
      .executeTakeFirstOrThrow();
    apiaryId = apiary.id;
    for (let index = 0; index < 15; index++) await addHive();
  });

  afterAll(async () => {
    if (queens.length)
      await db.deleteFrom('queens').where('id', 'in', queens).execute();
    await db.deleteFrom('movedates').where('hive_id', 'in', hives).execute();
    await db.deleteFrom('hives').where('id', 'in', hives).execute();
  });

  it('a new queen ends the old queen and sets her inactive', async () => {
    const [x] = hives;
    const a = await create({ hive_id: x, move_date: '2025-01-01' });
    const b = await create({ hive_id: x, move_date: '2025-03-01' });
    expect(await placements(a)).toEqual([[x, '2025-01-01', '2025-03-01']]);
    expect(await placements(b)).toEqual([[x, '2025-03-01', OPEN_END]]);
    expect(await state(a)).toEqual({
      hive_id: x,
      move_date: '2025-01-01',
      modus: false,
      modus_date: '2025-03-01',
    });
    const current = await db
      .selectFrom('queens_locations')
      .select('queen_id')
      .where('hive_id', '=', x)
      .executeTakeFirstOrThrow();
    expect(current.queen_id).toBe(b);
  });

  it('a save with unchanged values changes no placement', async () => {
    const [x] = hives;
    const [a, b] = queens;
    const before = [await placements(a), await placements(b)];
    for (const id of [a, b]) {
      const saved = await agent.request('POST', '/api/v1/queen/batchGet', {
        ids: [id],
      });
      const row = (saved.body as Record<string, unknown>[])[0];
      const res = await patch([id], {
        name: row.name,
        hive_id: row.hive_id,
        move_date: row.move_date,
        modus: row.modus,
        modus_date: row.modus_date,
      });
      expect(res.statusCode).toBe(200);
    }
    expect([await placements(a), await placements(b)]).toEqual(before);
    expect((await state(a)).hive_id).toBe(x);
  });

  it('a new date in the same hive changes the start', async () => {
    const [x] = hives;
    const b = queens[1];
    expect(
      (await patch([b], { hive_id: x, move_date: '2025-03-05' })).statusCode,
    ).toBe(200);
    expect(await placements(b)).toEqual([[x, '2025-03-05', OPEN_END]]);
    const res = await patch([b], { move_date: '2025-02-01' });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('QUEEN_PLACEMENT_OVERLAP');
    expect((await patch([b], { move_date: '2025-03-01' })).statusCode).toBe(
      200,
    );
  });

  it('rejects a backdated move into a hive with a later queen', async () => {
    const [x] = hives;
    const count = queens.length;
    const res = await post({ hive_id: x, move_date: '2025-02-01' });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('QUEEN_PLACEMENT_OVERLAP');
    expect(queens.length).toBe(count);
  });

  it('a new queen on the start day of the old queen replaces her', async () => {
    const s8 = hives[8];
    const k = await create({ hive_id: s8, move_date: '2025-05-01' });
    const l = await create({ hive_id: s8, move_date: '2025-05-01' });
    expect(await placements(k)).toEqual([]);
    expect(await placements(l)).toEqual([[s8, '2025-05-01', OPEN_END]]);
    // The replaced queen has no placement left, so also no move date.
    expect(await state(k)).toEqual({
      hive_id: null,
      move_date: null,
      modus: false,
      modus_date: '2025-05-01',
    });
  });

  it('rejects several queens into one hive in one request', async () => {
    const y = hives[1];
    const repeat = await post({
      hive_id: y,
      move_date: '2025-01-01',
      repeat: 2,
    });
    expect(repeat.statusCode).toBe(400);
    expect(repeat.body.code).toBe('QUEEN_PLACEMENT_HIVE_TWICE');
    const c1 = await create({});
    const c2 = await create({});
    const res = await patch([c1, c2], { hive_id: y, move_date: '2025-01-01' });
    expect(res.statusCode).toBe(400);
    expect(await placements(c1)).toEqual([]);
    const each = await post({
      hive_id: [y, hives[2]],
      move_date: '2025-01-01',
    });
    expect(each.statusCode).toBe(200);
  });

  it('a move out ends the placement and leaves the queen active', async () => {
    const [x] = hives;
    const b = queens[1];
    const res = await patch([b], { hive_id: 'empty', move_date: '2025-06-01' });
    expect(res.statusCode).toBe(200);
    expect(await placements(b)).toEqual([[x, '2025-03-01', '2025-06-01']]);
    expect(await state(b)).toMatchObject({
      hive_id: null,
      move_date: '2025-06-01',
      modus: true,
    });
    // The web app sends the same values again: nothing changes.
    expect(
      (await patch([b], { hive_id: 'empty', move_date: '2025-06-01' }))
        .statusCode,
    ).toBe(200);
    expect(await placements(b)).toEqual([[x, '2025-03-01', '2025-06-01']]);
  });

  it('reinserts a caged queen after the new queen was not accepted', async () => {
    const z = hives[3];
    const d = await create({ hive_id: z, move_date: '2025-01-01' });
    caged = d;
    const e = await create({ hive_id: z, move_date: '2025-04-01' });
    const res = await patch([d], {
      modus: true,
      hive_id: z,
      move_date: '2025-04-10',
    });
    expect(res.statusCode).toBe(200);
    expect(await placements(d)).toEqual([
      [z, '2025-01-01', '2025-04-01'],
      [z, '2025-04-10', OPEN_END],
    ]);
    expect(await placements(e)).toEqual([[z, '2025-04-01', '2025-04-10']]);
    expect(await state(e)).toMatchObject({
      modus: false,
      modus_date: '2025-04-10',
    });
    expect(await state(d)).toMatchObject({ modus: true, hive_id: z });
  });

  it('inactive and back to active reopens the placement', async () => {
    const w = hives[4];
    const f = await create({ hive_id: w, move_date: '2025-01-01' });
    const off = await agent.request('PATCH', '/api/v1/queen/status', {
      ids: [f],
      status: false,
    });
    expect(off.statusCode).toBe(200);
    const day = new Date().toISOString().slice(0, 10);
    expect(await placements(f)).toEqual([[w, '2025-01-01', day]]);
    const current = await db
      .selectFrom('queens_locations')
      .select(['queen_id', 'queen_modus'])
      .where('hive_id', '=', w)
      .executeTakeFirstOrThrow();
    expect(current).toEqual({ queen_id: f, queen_modus: false });
    const on = await agent.request('PATCH', '/api/v1/queen/status', {
      ids: [f],
      status: true,
    });
    expect(on.statusCode).toBe(200);
    expect(await placements(f)).toEqual([[w, '2025-01-01', OPEN_END]]);
  });

  it('a new modus_date moves the end of the placement', async () => {
    const v = hives[5];
    const g = await create({ hive_id: v, move_date: '2025-01-01' });
    expect(
      (await patch([g], { modus: false, modus_date: '2025-05-01' })).statusCode,
    ).toBe(200);
    expect(await placements(g)).toEqual([[v, '2025-01-01', '2025-05-01']]);
    expect((await patch([g], { modus_date: '2025-05-10' })).statusCode).toBe(
      200,
    );
    expect(await placements(g)).toEqual([[v, '2025-01-01', '2025-05-10']]);
    const res = await patch([g], { modus_date: '2024-12-01' });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('QUEEN_PLACEMENT_RANGE');
    const current = await db
      .selectFrom('queens_locations')
      .select('queen_id')
      .where('hive_id', '=', v)
      .executeTakeFirstOrThrow();
    expect(current.queen_id).toBe(g);
  });

  it('inactive on the day of the move deletes the placement', async () => {
    const u = hives[6];
    const day = new Date().toISOString().slice(0, 10);
    const h = await create({ hive_id: u, move_date: day });
    const res = await agent.request('PATCH', '/api/v1/queen/status', {
      ids: [h],
      status: false,
    });
    expect(res.statusCode).toBe(200);
    expect(await placements(h)).toEqual([]);
    expect(await state(h)).toMatchObject({ hive_id: null, modus: false });
  });

  it('inactive on the day of the move with the resent form values', async () => {
    const [a, b] = [hives[11], hives[12]];
    const day = new Date().toISOString().slice(0, 10);
    const q = await create({ hive_id: b, move_date: '2025-01-01' });
    expect((await patch([q], { hive_id: a, move_date: day })).statusCode).toBe(
      200,
    );
    // The form sends the old hive and move date again with the new status.
    const res = await patch([q], {
      modus: false,
      modus_date: day,
      hive_id: a,
      move_date: day,
    });
    expect(res.statusCode).toBe(200);
    expect(await placements(q)).toEqual([[b, '2025-01-01', day]]);
    expect(await state(q)).toMatchObject({ hive_id: b, modus: false });
  });

  it('a status change uses the day of the client', async () => {
    const h = hives[13];
    const q = await create({ hive_id: h, move_date: '2025-01-01' });
    const status = (body: Record<string, unknown>) =>
      agent.request('PATCH', '/api/v1/queen/status', { ids: [q], ...body });
    expect(
      (await status({ status: false, modus_date: '01.02.2025' })).statusCode,
    ).toBe(400);
    expect(
      (await status({ status: false, modus_date: '2025-02-01' })).statusCode,
    ).toBe(200);
    expect(await placements(q)).toEqual([[h, '2025-01-01', '2025-02-01']]);
    expect(await state(q)).toMatchObject({
      modus: false,
      modus_date: '2025-02-01',
    });
    expect(
      (await status({ status: true, modus_date: '2025-03-01' })).statusCode,
    ).toBe(200);
    expect(await placements(q)).toEqual([[h, '2025-01-01', OPEN_END]]);
    expect(await state(q)).toMatchObject({
      modus: true,
      modus_date: '2025-03-01',
    });
  });

  it('a queen without placements has no move_date', async () => {
    const t = hives[7];
    // Old clients send a move date also for a queen without hive.
    const i = await create({ move_date: '2025-01-01' });
    expect((await state(i)).move_date).toBeNull();
    expect((await patch([i], { move_date: '2025-01-05' })).statusCode).toBe(
      200,
    );
    expect(await state(i)).toMatchObject({ hive_id: null, move_date: null });
    expect(await placements(i)).toEqual([]);
    // Moved out of her last hive: the date is the end of that placement.
    await patch([i], { hive_id: t, move_date: '2025-02-01' });
    await patch([i], { hive_id: 'empty', move_date: '2025-03-01' });
    expect((await patch([i], { move_date: '2025-03-10' })).statusCode).toBe(
      200,
    );
    expect(await placements(i)).toEqual([[t, '2025-02-01', '2025-03-10']]);
    expect((await state(i)).move_date).toBe('2025-03-10');
    const res = await patch([i], { move_date: '2025-01-10' });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('QUEEN_PLACEMENT_RANGE');
  });

  it('a server day before the start uses the start day', async () => {
    // The client saved a local day that is after the UTC day of the server,
    // for example after local midnight in Europe.
    const tomorrow = new Date(Date.now() + 86_400_000)
      .toISOString()
      .slice(0, 10);
    const [r9, r10] = [hives[9], hives[10]];
    const m = await create({ hive_id: r9, move_date: tomorrow });
    const off = await agent.request('PATCH', '/api/v1/queen/status', {
      ids: [m],
      status: false,
    });
    expect(off.statusCode).toBe(200);
    expect(await placements(m)).toEqual([]);
    expect(await state(m)).toMatchObject({
      modus: false,
      modus_date: tomorrow,
    });

    const n = await create({ hive_id: r10, move_date: tomorrow });
    const o = await create({ hive_id: r10 });
    expect(await placements(o)).toEqual([[r10, tomorrow, OPEN_END]]);
    expect(await placements(n)).toEqual([]);
    expect(await state(n)).toMatchObject({
      modus: false,
      modus_date: tomorrow,
    });
  });

  describe('/api/v1/queen_placement', () => {
    const route = '/api/v1/queen_placement';

    it('401 - no session', async () => {
      const res = await createAgent().request('GET', route);
      expect(res.statusCode).toBe(401);
    });

    it('lists the placements of a queen, open placements without to_date', async () => {
      const d = caged;
      const res = await agent.request('GET', route, undefined, {
        filters: JSON.stringify([{ 'queen_placements.queen_id': d }]),
        order: 'from_date',
        direction: 'asc',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.total).toBe(2);
      expect(res.body.results.map((row: any) => row.to_date)).toEqual([
        '2025-04-01',
        null,
      ]);
      expect(res.body.results[0].queen.id).toBe(d);
      expect(res.body.results[0].hive.id).toBe(hives[3]);
    });

    it('filters by a list of hive ids', async () => {
      const list = (ids: number[]) =>
        agent.request('GET', route, undefined, {
          filters: JSON.stringify([{ 'queen_placements.hive_id': ids }]),
          limit: 1000,
        });
      const one = await list([hives[3]]);
      const two = await list([hives[3], hives[12]]);
      expect(one.statusCode).toBe(200);
      expect(one.body.total).toBeGreaterThan(0);
      expect(
        one.body.results.every((row: any) => row.hive_id === hives[3]),
      ).toBe(true);
      expect(two.body.total).toBeGreaterThan(one.body.total);
      expect(
        two.body.results.every((row: any) =>
          [hives[3], hives[12]].includes(row.hive_id),
        ),
      ).toBe(true);
    });

    it('validates and saves date edits', async () => {
      const d = caged;
      const rows = await db
        .selectFrom('queen_placements')
        .select('id')
        .where('queen_id', '=', d)
        .orderBy('from_date')
        .execute();
      const [first, open] = rows.map((row) => row.id);
      const range = await agent.request('PATCH', route, {
        ids: [first],
        data: { to_date: '2024-12-01' },
      });
      expect(range.statusCode).toBe(400);
      expect(range.body.code).toBe('QUEEN_PLACEMENT_RANGE');
      // An edit cannot open or close a placement.
      for (const [id, to_date] of [
        [first, null],
        [open, '2025-06-01'],
      ] as const) {
        const res = await agent.request('PATCH', route, {
          ids: [id],
          data: { to_date },
        });
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('QUEEN_PLACEMENT_STATE');
      }
      const keepOpen = await agent.request('PATCH', route, {
        ids: [open],
        data: { to_date: null },
      });
      expect(keepOpen.statusCode).toBe(200);
      const overlap = await agent.request('PATCH', route, {
        ids: [open],
        data: { from_date: '2025-03-01' },
      });
      expect(overlap.statusCode).toBe(400);
      expect(overlap.body.code).toBe('QUEEN_PLACEMENT_OVERLAP');
      const ok = await agent.request('PATCH', route, {
        ids: [open],
        data: { from_date: '2025-04-12' },
      });
      expect(ok.statusCode).toBe(200);
      expect((await state(d)).move_date).toBe('2025-04-12');
    });

    it('a new end of the last placement moves the modus_date', async () => {
      const w = hives[14];
      const h = await create({ hive_id: w, move_date: '2025-01-01' });
      expect(
        (await patch([h], { modus: false, modus_date: '2025-05-01' }))
          .statusCode,
      ).toBe(200);
      const row = await db
        .selectFrom('queen_placements')
        .select('id')
        .where('queen_id', '=', h)
        .executeTakeFirstOrThrow();
      const res = await agent.request('PATCH', route, {
        ids: [row.id],
        data: { to_date: '2025-05-20' },
      });
      expect(res.statusCode).toBe(200);
      expect(await placements(h)).toEqual([[w, '2025-01-01', '2025-05-20']]);
      expect(await state(h)).toMatchObject({
        modus: false,
        modus_date: '2025-05-20',
      });
      const current = await db
        .selectFrom('queens_locations')
        .select('queen_id')
        .where('hive_id', '=', w)
        .executeTakeFirstOrThrow();
      expect(current.queen_id).toBe(h);
      // A new start does not change the modus_date.
      await agent.request('PATCH', route, {
        ids: [row.id],
        data: { from_date: '2025-01-05' },
      });
      expect((await state(h)).modus_date).toBe('2025-05-20');
    });

    it('deletes the open placement, the queen has no hive', async () => {
      const d = caged;
      const open = await db
        .selectFrom('queen_placements')
        .select('id')
        .where('queen_id', '=', d)
        .where('to_date', '=', new Date(`${OPEN_END}T00:00:00Z`))
        .executeTakeFirstOrThrow();
      const res = await agent.request('PATCH', `${route}/batchDelete`, {
        ids: [open.id],
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(1);
      expect(await state(d)).toMatchObject({ hive_id: null, modus: true });
    });

    it('ignores placements of another company', async () => {
      const company = await db
        .insertInto('companies')
        .values({ name: `Placement foreign ${Date.now()}` })
        .executeTakeFirstOrThrow();
      const foreignCompany = Number(company.insertId);
      const hive = await db
        .insertInto('hives')
        .values({ name: 'Foreign hive', user_id: foreignCompany, modus: true })
        .executeTakeFirstOrThrow();
      const foreignQueen = await db
        .insertInto('queens')
        .values({ name: 'Foreign', user_id: foreignCompany, date: new Date() })
        .executeTakeFirstOrThrow();
      const placement = await db
        .insertInto('queen_placements')
        .values({
          queen_id: Number(foreignQueen.insertId),
          hive_id: Number(hive.insertId),
          user_id: foreignCompany,
          from_date: new Date('2025-01-01'),
          to_date: new Date(`${OPEN_END}T00:00:00Z`),
        })
        .executeTakeFirstOrThrow();
      const id = Number(placement.insertId);
      try {
        const get = await agent.request('POST', `${route}/batchGet`, {
          ids: [id],
        });
        expect(get.statusCode).toBe(200);
        expect(get.body).toEqual([]);
        await agent.request('PATCH', route, {
          ids: [id],
          data: { from_date: '2025-01-02' },
        });
        await agent.request('PATCH', `${route}/batchDelete`, { ids: [id] });
        const row = await db
          .selectFrom('queen_placements')
          .select('from_date')
          .where('id', '=', id)
          .executeTakeFirst();
        expect(String(row?.from_date)).toBe('2025-01-01');
      } finally {
        await db
          .deleteFrom('queens')
          .where('id', '=', Number(foreignQueen.insertId))
          .execute();
        await db
          .deleteFrom('hives')
          .where('id', '=', Number(hive.insertId))
          .execute();
        await db
          .deleteFrom('companies')
          .where('id', '=', foreignCompany)
          .execute();
      }
    });
  });

  it('queen statistics have one row per placement', async () => {
    const z = hives[3];
    const res = await agent.request('GET', '/api/v1/queen/stats', undefined, {
      filters: JSON.stringify([{ 'queens.hive_id': z }]),
      limit: 100,
    });
    expect(res.statusCode).toBe(200);
    const ids = res.body.results.map((row: any) => row.placement_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(res.body.results.length).toBe(2);
    for (const row of res.body.results) {
      expect(row.queen.name).toEqual(expect.any(String));
    }
    // The caged queen lived in z from 2025-01-01 to 2025-04-01, the next
    // queen from 2025-04-01. A checkup on 2025-04-01 belongs to the next one.
    for (const [date, brood] of [
      ['2025-02-01', 4],
      ['2025-04-01', 2],
    ] as const) {
      const checkup = await agent.request('POST', '/api/v1/checkup', {
        hive_ids: [z],
        date,
        type_id: 1,
        brood,
        repeat: 1,
        interval: 0,
      });
      expect(checkup.statusCode).toBe(200);
    }
    const after = await agent.request('GET', '/api/v1/queen/stats', undefined, {
      filters: JSON.stringify([{ 'queens.hive_id': z }]),
      limit: 100,
    });
    const brood = Object.fromEntries(
      after.body.results.map((row: any) => [
        row.move_date,
        Number(row.checkup.brood),
      ]),
    );
    expect(brood).toEqual({ '2025-01-01': 4, '2025-04-01': 2 });
  });

  it('queen_current_placements derives the same values as derivePlacement', async () => {
    const [h1, h2] = [await addHive(), await addHive()];
    const addQueen = async (modus: boolean) => {
      const result = await db
        .insertInto('queens')
        .values({
          name: `Placement view ${queens.length}`,
          user_id: companyId,
          date: new Date('2023-01-01'),
          modus,
          modus_date: modus ? null : new Date('2025-03-01'),
        })
        .executeTakeFirstOrThrow();
      const id = Number(result.insertId);
      queens.push(id);
      return id;
    };
    const addPlacement = (
      queen_id: number,
      hive_id: number,
      from: string,
      to: string,
    ) =>
      db
        .insertInto('queen_placements')
        .values({
          queen_id,
          hive_id,
          user_id: companyId,
          from_date: new Date(`${from}T00:00:00Z`),
          to_date: new Date(`${to}T00:00:00Z`),
        })
        .execute();
    const open = await addQueen(true);
    await addPlacement(open, h2, '2023-01-01', '2023-06-01');
    await addPlacement(open, h1, '2025-01-01', OPEN_END);
    const inactive = await addQueen(false);
    await addPlacement(inactive, h2, '2024-01-01', '2024-03-01');
    await addPlacement(inactive, h2, '2024-05-01', '2025-03-01');
    const movedOut = await addQueen(true);
    await addPlacement(movedOut, h1, '2024-01-01', '2024-12-01');
    const none = await addQueen(true);
    expect(
      await Promise.all([open, inactive, movedOut, none].map(state)),
    ).toMatchObject([
      { hive_id: h1, move_date: '2025-01-01' },
      { hive_id: h2, move_date: '2024-05-01' },
      { hive_id: null, move_date: '2024-12-01' },
      { hive_id: null, move_date: null },
    ]);

    // All queens of the company, also from the tests before.
    const rows = await db
      .selectFrom('queens')
      .innerJoin(
        'queen_current_placements',
        'queen_current_placements.queen_id',
        'queens.id',
      )
      .select([
        'queens.id',
        'queens.modus',
        'queen_current_placements.hive_id',
        'queen_current_placements.move_date',
      ])
      .where('queens.user_id', '=', companyId)
      .execute();
    const periods = await db
      .selectFrom('queen_placements')
      .select(['id', 'queen_id', 'hive_id', 'from_date', 'to_date'])
      .where('user_id', '=', companyId)
      .execute();
    expect(rows.length).toBeGreaterThan(4);
    for (const row of rows) {
      const derived = derivePlacement(
        row.modus,
        periods
          .filter((period) => period.queen_id === row.id)
          .map((period) => ({
            id: period.id,
            queen_id: period.queen_id,
            hive_id: period.hive_id,
            from_date: String(period.from_date),
            to_date: String(period.to_date),
          })),
      );
      expect({
        id: row.id,
        hive_id: row.hive_id,
        move_date: row.move_date === null ? null : String(row.move_date),
      }).toEqual({
        id: row.id,
        hive_id: derived.hive_id,
        move_date: derived.move_date,
      });
    }
  });

  it('counts has the queens without hive and the current queens', async () => {
    const counts = async () => {
      const rows = await db
        .selectFrom('counts')
        .select(['kind', 'count'])
        .where('user_id', '=', companyId)
        .where('kind', 'in', ['virgin', 'queen'])
        .execute();
      const value = (kind: string) =>
        Number(rows.find((row) => row.kind === kind)?.count ?? 0);
      return { virgin: value('virgin'), queen: value('queen') };
    };
    const expected = async () => {
      const open = await db
        .selectFrom('queen_placements')
        .select('queen_id')
        .where('user_id', '=', companyId)
        .where('to_date', '=', new Date(`${OPEN_END}T00:00:00Z`))
        .execute();
      const inHive = new Set(open.map((row) => row.queen_id));
      const active = await db
        .selectFrom('queens')
        .select('id')
        .where('user_id', '=', companyId)
        .where('modus', '=', true)
        .where('deleted', '=', false)
        .execute();
      // The current queen of a hive, without the view `queens_locations`:
      // the last placement of a queen that is not deleted, in an active hive
      // that is not deleted. It counts when it is open, or when the queen is
      // inactive and the placement ends on her `modus_date`.
      const rows = await db
        .selectFrom('queen_placements')
        .innerJoin('queens', 'queens.id', 'queen_placements.queen_id')
        .innerJoin('hives', 'hives.id', 'queen_placements.hive_id')
        .select([
          'queen_placements.hive_id',
          'queen_placements.to_date',
          'queens.modus',
          'queens.modus_date',
        ])
        .where('hives.user_id', '=', companyId)
        .where('hives.modus', '=', true)
        .where('hives.deleted', '=', false)
        .where('queens.deleted', '=', false)
        .orderBy('queen_placements.from_date', 'desc')
        .orderBy('queen_placements.id', 'desc')
        .execute();
      const last = new Map<number, (typeof rows)[number]>();
      for (const row of rows)
        if (!last.has(row.hive_id)) last.set(row.hive_id, row);
      const queen = [...last.values()].filter(
        (row) =>
          String(row.to_date) === OPEN_END ||
          (!row.modus && String(row.to_date) === String(row.modus_date)),
      ).length;
      return {
        virgin: active.filter((row) => !inHive.has(row.id)).length,
        queen,
      };
    };
    const before = await counts();
    expect(before).toEqual(await expected());
    const hive = await addHive();
    const queen = await create({});
    expect(await counts()).toEqual({
      virgin: before.virgin + 1,
      queen: before.queen,
    });
    expect(
      (await patch([queen], { hive_id: hive, move_date: '2025-01-01' }))
        .statusCode,
    ).toBe(200);
    expect(await counts()).toEqual({
      virgin: before.virgin,
      queen: before.queen + 1,
    });
    expect(await counts()).toEqual(await expected());
  });

  describe('company transfer', () => {
    let beeId: number;
    let source: Map<string, Buffer>;

    async function unzip(zip: Buffer) {
      const files = new Map<string, Buffer>();
      const reader = await yauzl.fromBuffer(zip);
      for await (const entry of reader)
        files.set(entry.filename, await buffer(await entry.openReadStream()));
      await reader.close();
      return files;
    }
    async function zip(files: Map<string, Buffer | string>) {
      const archive = new ZipArchive();
      const output = new PassThrough();
      archive.pipe(output);
      const contents = buffer(output);
      for (const [name, data] of files) archive.append(data, { name });
      await archive.finalize();
      return contents;
    }
    async function companyOf(name: string) {
      const row = await db
        .selectFrom('companies')
        .select('id')
        .where('name', '=', name)
        .executeTakeFirstOrThrow();
      return row.id;
    }
    async function importFiles(files: Map<string, Buffer | string>) {
      const copy = await importCompanyArchive(db, beeId, await zip(files));
      return companyOf(copy.name);
    }
    /** Placements of a company by queen name, hive name and period. */
    async function placementRows(userId: number, onlyOpen = false) {
      let query = db
        .selectFrom('queen_placements')
        .innerJoin('queens', 'queens.id', 'queen_placements.queen_id')
        .innerJoin('hives', 'hives.id', 'queen_placements.hive_id')
        .select([
          'queens.name as queen',
          'hives.name as hive',
          'queen_placements.from_date',
          'queen_placements.to_date',
        ])
        .where('queen_placements.user_id', '=', userId);
      if (onlyOpen)
        query = query.where(
          'queen_placements.to_date',
          '=',
          new Date(`${OPEN_END}T00:00:00Z`),
        );
      return (await query.execute())
        .map(
          (row) =>
            `${row.queen}|${row.hive}|${String(row.from_date)}|${String(row.to_date)}`,
        )
        .sort();
    }
    /**
     * The files of a version 1 archive: no format.json, and queens.csv with
     * the derived `hive_id` and `move_date` of each queen.
     */
    async function versionOne(withPlacements: boolean) {
      const derived = await db
        .selectFrom('queen_current_placements')
        .innerJoin('queens', 'queens.id', 'queen_current_placements.queen_id')
        .select([
          'queens.id',
          'queen_current_placements.hive_id',
          'queen_current_placements.move_date',
        ])
        .where('queens.user_id', '=', companyId)
        .execute();
      const byId = new Map(derived.map((row) => [String(row.id), row]));
      const queensCsv: Record<string, string>[] = parse(
        source.get('queens.csv') as Buffer,
        { columns: true },
      );
      const files = new Map<string, Buffer | string>(source);
      files.delete('format.json');
      if (!withPlacements) files.delete('queen_placements.csv');
      files.set(
        'queens.csv',
        stringify(
          queensCsv.map((row) =>
            Object.assign(row, {
              hive_id: byId.get(row.id)?.hive_id ?? '',
              move_date: byId.get(row.id)?.move_date ?? '',
            }),
          ),
          { header: true, record_delimiter: 'windows' },
        ),
      );
      return files;
    }

    beforeAll(async () => {
      const bee = await db
        .selectFrom('company_bee')
        .select('bee_id')
        .where('user_id', '=', companyId)
        .executeTakeFirstOrThrow();
      beeId = bee.bee_id as number;
      const archive = new ZipArchive();
      const output = new PassThrough();
      archive.pipe(output);
      const contents = buffer(output);
      await downloadCompanyData(db, archive, companyId);
      await archive.finalize();
      source = await unzip(await contents);
    });

    it('the export has format.json and no old queen columns', () => {
      const format = JSON.parse(String(source.get('format.json')));
      expect(format).toEqual({
        format: 'btree-company-export',
        version: 2,
        server_version: expect.any(String),
        exported_at: expect.any(String),
      });
      expect(new Date(format.exported_at).toISOString()).toBe(
        format.exported_at,
      );
      const header = String(source.get('queens.csv')).split('\r\n')[0];
      expect(header.split(',')).toContain('modus_date');
      expect(header.split(',')).not.toContain('hive_id');
      expect(header.split(',')).not.toContain('move_date');
    });

    it('a version 2 archive copies the placements and the derived values', async () => {
      const copy = await importFiles(source);
      const expected = await placementRows(companyId);
      expect(expected.length).toBeGreaterThan(0);
      expect(await placementRows(copy)).toEqual(expected);
      const derived = async (userId: number) =>
        (
          await db
            .selectFrom('queens')
            .innerJoin(
              'queen_current_placements',
              'queen_current_placements.queen_id',
              'queens.id',
            )
            .leftJoin('hives', 'hives.id', 'queen_current_placements.hive_id')
            .select([
              'queens.name',
              'hives.name as hive',
              'queen_current_placements.move_date',
            ])
            .where('queens.user_id', '=', userId)
            .execute()
        )
          .map((row) => `${row.name}|${row.hive}|${String(row.move_date)}`)
          .sort();
      expect(await derived(copy)).toEqual(await derived(companyId));
    });

    it('a version 2 archive reads the placements only from queen_placements.csv', async () => {
      const files = await versionOne(false);
      files.set('format.json', source.get('format.json') as Buffer);
      const copy = await importFiles(files);
      expect(await placementRows(copy)).toEqual([]);
    });

    it('a version 1 archive with queen_placements.csv copies the placements', async () => {
      const copy = await importFiles(await versionOne(true));
      expect(await placementRows(copy)).toEqual(await placementRows(companyId));
    });

    it('a version 1 archive without queen_placements.csv builds them from queens.csv', async () => {
      const copy = await importFiles(await versionOne(false));
      // The old archive has only the last hive of each queen, so compare
      // the open placements.
      const expected = await placementRows(companyId, true);
      expect(expected.length).toBeGreaterThan(0);
      expect(await placementRows(copy, true)).toEqual(expected);
    });

    it('rejects an unknown archive version or format', async () => {
      for (const format of [
        { format: 'btree-company-export', version: 3 },
        { format: 'other', version: 2 },
        { format: 'btree-company-export', version: '2' },
      ]) {
        const files = new Map<string, Buffer | string>(source);
        files.set('format.json', JSON.stringify(format));
        await expect(
          importCompanyArchive(db, beeId, await zip(files)),
        ).rejects.toMatchObject({ statusCode: 400 });
      }
    });
  });
});
