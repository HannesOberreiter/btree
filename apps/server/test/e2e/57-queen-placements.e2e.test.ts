import { PassThrough } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import { ZipArchive } from 'archiver';
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
    const { rows, skipped } = buildQueenPlacements([
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
  });

  it('ends an inactive queen at the earlier of modus_date and the next start', () => {
    const { rows } = buildQueenPlacements([
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

  it('keeps the higher id of two queens with the same start', () => {
    const { rows, skipped } = buildQueenPlacements([
      queen({ id: 7, move_date: '2024-01-01' }),
      queen({ id: 3, move_date: '2024-01-01 15:00:00' }),
    ]);
    expect(rows.map((row) => row.queen_id)).toEqual([7]);
    expect(skipped).toEqual([
      { queen_id: 3, user_id: 1, reason: 'same_start' },
    ]);
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
  async function state(queenId: number) {
    const row = await db
      .selectFrom('queens')
      .select(['hive_id', 'move_date', 'modus', 'modus_date'])
      .where('id', '=', queenId)
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
    for (let index = 0; index < 8; index++) {
      const result = await db
        .insertInto('hives')
        .values({
          name: `Placement hive ${index}`,
          user_id: companyId,
          modus: true,
        })
        .executeTakeFirstOrThrow();
      const id = Number(result.insertId);
      hives.push(id);
      await db
        .insertInto('movedates')
        .values({
          apiary_id: apiary.id,
          hive_id: id,
          date: new Date('2020-01-01'),
        })
        .execute();
    }
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
    const sameDay = await post({ hive_id: x, move_date: '2025-03-01' });
    expect(sameDay.statusCode).toBe(400);
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

  it('a new move_date of a queen without hive is saved', async () => {
    const t = hives[7];
    const i = await create({ move_date: '2025-01-01' });
    expect((await state(i)).move_date).toBe('2025-01-01');
    expect((await patch([i], { move_date: '2025-01-05' })).statusCode).toBe(
      200,
    );
    expect((await state(i)).move_date).toBe('2025-01-05');
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
      expect(row.checkup).toBeDefined();
    }
  });

  it('company transfer copies placements, also from an old archive', async () => {
    const beeId = await db
      .selectFrom('company_bee')
      .select('bee_id')
      .where('user_id', '=', companyId)
      .executeTakeFirstOrThrow();
    const archive = new ZipArchive();
    const output = new PassThrough();
    archive.pipe(output);
    const contents = buffer(output);
    await downloadCompanyData(db, archive, companyId);
    await archive.finalize();
    const zip = await contents;

    const count = async (userId: number) =>
      (
        await db
          .selectFrom('queen_placements')
          .select(db.fn.countAll<number>().as('total'))
          .where('user_id', '=', userId)
          .executeTakeFirstOrThrow()
      ).total;
    const newCompany = async (name: string) =>
      (
        await db
          .selectFrom('companies')
          .select('id')
          .where('name', '=', name)
          .executeTakeFirstOrThrow()
      ).id;

    const copy = await importCompanyArchive(db, beeId.bee_id as number, zip);
    expect(await count(await newCompany(copy.name))).toBe(
      await count(companyId),
    );

    // An archive from before queen_placements.csv existed.
    const old = new ZipArchive();
    const oldOutput = new PassThrough();
    old.pipe(oldOutput);
    const oldContents = buffer(oldOutput);
    const reader = await yauzl.fromBuffer(zip);
    for await (const entry of reader) {
      if (entry.filename === 'queen_placements.csv') continue;
      old.append(await buffer(await entry.openReadStream()), {
        name: entry.filename,
      });
    }
    await reader.close();
    await old.finalize();
    const fromOld = await importCompanyArchive(
      db,
      beeId.bee_id as number,
      await oldContents,
    );
    // The old archive has only the last hive of each queen, so compare the
    // open placements by queen name, hive name and start.
    const openRows = async (userId: number) =>
      (
        await db
          .selectFrom('queen_placements')
          .innerJoin('queens', 'queens.id', 'queen_placements.queen_id')
          .innerJoin('hives', 'hives.id', 'queen_placements.hive_id')
          .select(['queens.name as queen', 'hives.name as hive', 'from_date'])
          .where('queen_placements.user_id', '=', userId)
          .where(
            'queen_placements.to_date',
            '=',
            new Date(`${OPEN_END}T00:00:00Z`),
          )
          .execute()
      )
        .map((row) => `${row.queen}|${row.hive}|${String(row.from_date)}`)
        .sort();
    const expected = await openRows(companyId);
    expect(expected.length).toBeGreaterThan(0);
    expect(await openRows(await newCompany(fromOld.name))).toEqual(expected);
  });
});
