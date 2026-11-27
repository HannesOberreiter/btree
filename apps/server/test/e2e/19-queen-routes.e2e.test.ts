import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createQueens,
  getQueensByIds,
  updateQueenStatus,
} from '../../src/api/modules/queen.module.js';
import { KyselyServer } from '../../src/servers/kysely.server.js';
import type { TestAgent } from '../utils.js';
import {
  createAgent,
  createAuthenticatedAgent,
  doQueryRequest,
  doRequest,
  expectations,
  withTimeZone,
} from '../utils.js';

// Ten queens cannot move into one hive in one request, so no hive here.
const testInsert = {
  name: 'testQueen',
  hive_id: null,
  date: new Date().toISOString().slice(0, 10),
  race_id: 1,
  mating_id: 1,
  start: 0,
  repeat: 10,
};

describe('queen routes', () => {
  const route = '/api/v1/queen';
  let agent: TestAgent;
  let accessToken: any;
  let insertId: any;

  beforeAll(async () => {
    agent = await createAuthenticatedAgent();
    const res2 = await doRequest(
      agent,
      'post',
      route,
      null,
      accessToken,
      testInsert,
    );
    expect(res2.statusCode).toEqual(200);
    expect(res2.body).toBeInstanceOf(Array);
    insertId = res2.body[0];
  });

  describe('/api/v1/queen/', () => {
    it('get 401 - no header', async () => {
      const res = await doQueryRequest(createAgent(), route, null, null, null);
      expect(res.statusCode).toEqual(401);
      expect(res.errors, 'JsonWebTokenError');
    });
    it('post 401 - no header', async () => {
      const res = await doRequest(
        createAgent(),
        'post',
        route,
        null,
        null,
        testInsert,
      );
      expect(res.statusCode).toEqual(401);
      expect(res.errors, 'JsonWebTokenError');
    });
    it('patch 401 - no header', async () => {
      const res = await doRequest(createAgent(), 'patch', route, null, null, {
        ids: [insertId],
        data: {},
      });
      expect(res.statusCode).toEqual(401);
      expect(res.errors, 'JsonWebTokenError');
    });

    it('get 200 - success', async () => {
      const res = await doQueryRequest(agent, route, null, accessToken, null);
      expect(res.statusCode).toEqual(200);
      expect(res.body.results).toBeInstanceOf(Array);
      expect(res.body.total).toBeTypeOf('number');
    });

    it('get 200 - accepts numeric search text', async () => {
      const res = await doQueryRequest(agent, route, null, accessToken, {
        q: 2603,
      });
      expect(res.statusCode).toBe(200);
    });

    it.each([
      'mark_colour',
      'hive_location.apiary_name',
      'queen_location.queen_id',
      'mother',
      'own_mother.name',
      'mating.name',
      'race.name',
      'modus_date',
      'deleted_at',
    ])('get 200 - orders by %s', async (order) => {
      const res = await doQueryRequest(agent, route, null, accessToken, {
        order,
        direction: 'desc',
        details: true,
      });
      expect(res.statusCode).toBe(200);
    });

    it('applies all queen table filters', async () => {
      for (const filter of [
        { 'queens.mating_id': 999_999 },
        { 'queens.race_id': 999_999 },
        { 'queens.hive_id': '999999' },
        { 'hive_location.apiary_id': 999_999 },
      ]) {
        const res = await doQueryRequest(agent, route, null, accessToken, {
          filters: JSON.stringify([filter]),
        });
        expect(res.statusCode).toBe(200);
        expect(res.body.results).toEqual([]);
        expect(res.body.total).toBe(0);
      }
    });

    it.each([true, false])(
      'get 200 - total respects latest=%s',
      async (latest) => {
        const res = await doQueryRequest(agent, route, null, accessToken, {
          details: true,
          latest,
          limit: 1000,
        });
        expect(res.statusCode).toBe(200);
        expect(res.body.total).toBe(res.body.results.length);
      },
    );

    it('operations enforce company isolation', async () => {
      const db = KyselyServer.getInstance().db;
      expect(await getQueensByIds(db, 999_999, [insertId])).toEqual([]);
      expect(await updateQueenStatus(db, 999_999, 1, [insertId], false)).toBe(
        0,
      );
    });

    it('post 400 - no data', async () => {
      const res = await doRequest(
        agent,
        'post',
        route,
        null,
        accessToken,
        null,
      );
      expect(res.statusCode).toEqual(400);
    });

    it('patch 200 - success', async () => {
      const res = await doRequest(agent, 'patch', route, null, accessToken, {
        ids: [insertId],
        data: {},
      });
      expect(res.statusCode).toEqual(200);
      expect(res.body).toBe(1);
    });

    it('post 200 - missing, null or empty date stores today', async () => {
      for (const date of [undefined, null, '']) {
        const res = await doRequest(agent, 'post', route, null, accessToken, {
          name: 'testQueenNoDate',
          date,
        });
        expect(res.statusCode).toEqual(200);
        const saved = await doRequest(
          agent,
          'post',
          `${route}/batchGet`,
          null,
          accessToken,
          { ids: res.body },
        );
        expect(saved.body[0].date).toBe(new Date().toISOString().slice(0, 10));
      }
    });

    it('patch 400 - null or empty date', async () => {
      for (const date of [null, '']) {
        const res = await doRequest(agent, 'patch', route, null, accessToken, {
          ids: [insertId],
          data: { date },
        });
        expect(res.statusCode).toEqual(400);
        expectations(res, 'date', 'Invalid value');
      }
      const saved = await doRequest(
        agent,
        'post',
        `${route}/batchGet`,
        null,
        accessToken,
        { ids: [insertId] },
      );
      expect(saved.body[0].date).toBe(testInsert.date);
    });

    it('patch 200 - valid date', async () => {
      const res = await doRequest(agent, 'patch', route, null, accessToken, {
        ids: [insertId],
        data: { date: '2020-01-15' },
      });
      expect(res.statusCode).toEqual(200);
      expect(res.body).toBe(1);
      const saved = await doRequest(
        agent,
        'post',
        `${route}/batchGet`,
        null,
        accessToken,
        { ids: [insertId] },
      );
      expect(saved.body[0].date).toBe('2020-01-15');
    });

    describe('patch 404 - foreign references', () => {
      const db = KyselyServer.getInstance().db;
      let foreignCompanyId: number;
      const foreignIds = { race_id: 0, mating_id: 0, mother_id: 0 };

      beforeAll(async () => {
        const company = await db
          .insertInto('companies')
          .values({ name: `Queen foreign ${Date.now()}` })
          .executeTakeFirstOrThrow();
        foreignCompanyId = Number(company.insertId);
        const race = await db
          .insertInto('queen_races')
          .values({ name: 'Foreign race', user_id: foreignCompanyId })
          .executeTakeFirstOrThrow();
        foreignIds.race_id = Number(race.insertId);
        const mating = await db
          .insertInto('queen_matings')
          .values({ name: 'Foreign mating', user_id: foreignCompanyId })
          .executeTakeFirstOrThrow();
        foreignIds.mating_id = Number(mating.insertId);
        const mother = await db
          .insertInto('queens')
          .values({
            name: 'Foreign mother',
            user_id: foreignCompanyId,
            date: new Date(),
          })
          .executeTakeFirstOrThrow();
        foreignIds.mother_id = Number(mother.insertId);
      });

      afterAll(async () => {
        await db
          .deleteFrom('queens')
          .where('id', '=', foreignIds.mother_id)
          .execute();
        await db
          .deleteFrom('queen_matings')
          .where('id', '=', foreignIds.mating_id)
          .execute();
        await db
          .deleteFrom('queen_races')
          .where('id', '=', foreignIds.race_id)
          .execute();
        await db
          .deleteFrom('companies')
          .where('id', '=', foreignCompanyId)
          .execute();
      });

      it.each(['race_id', 'mating_id', 'mother_id'] as const)(
        'rejects a foreign %s',
        async (field) => {
          const res = await doRequest(
            agent,
            'patch',
            route,
            null,
            accessToken,
            { ids: [insertId], data: { [field]: foreignIds[field] } },
          );
          expect(res.statusCode).toEqual(404);
          const queen = await db
            .selectFrom('queens')
            .select(field)
            .where('id', '=', insertId)
            .executeTakeFirstOrThrow();
          expect(queen[field]).not.toBe(foreignIds[field]);
        },
      );
    });

    it('post 200 - hive_id null creates a queen without hive', async () => {
      const res = await doRequest(agent, 'post', route, null, accessToken, {
        name: 'testQueenNoHive',
        hive_id: null,
      });
      expect(res.statusCode).toEqual(200);
      const get = await doRequest(
        agent,
        'post',
        `${route}/batchGet`,
        null,
        accessToken,
        { ids: res.body },
      );
      expect(get.statusCode).toEqual(200);
      expect(get.body[0].hive_id).toBeNull();
    });

    it('patch 200 - hive_id null removes the hive', async () => {
      const res = await doRequest(agent, 'patch', route, null, accessToken, {
        ids: [insertId],
        data: { hive_id: null },
      });
      expect(res.statusCode).toEqual(200);
      expect(res.body).toBe(1);
      const get = await doRequest(
        agent,
        'post',
        `${route}/batchGet`,
        null,
        accessToken,
        { ids: [insertId] },
      );
      expect(get.statusCode).toEqual(200);
      expect(get.body[0].hive_id).toBeNull();
    });

    it('inactivates only the older queen outside UTC', async () => {
      const db = KyselyServer.getInstance().db;
      const hive = await db
        .selectFrom('hives')
        .select(['user_id', 'bee_id'])
        .where('id', '=', 1)
        .executeTakeFirstOrThrow();
      await withTimeZone('Europe/Vienna', async () => {
        const create = (name: string, moveDate: string) =>
          createQueens(db, hive.user_id, hive.bee_id!, {
            name,
            hive_id: 1,
            move_date: moveDate,
            modus: true,
          });
        const [oldId] = await create('testQueenOld', '2024-06-10');
        const [newId] = await create('testQueenNew', '2025-06-10');
        const queens = await getQueensByIds(db, hive.user_id, [oldId, newId]);
        const modus = (id: number) => queens.find((q) => q.id === id)?.modus;
        expect(modus(oldId)).toBe(false);
        expect(modus(newId)).toBe(true);
        await db
          .deleteFrom('queens')
          .where('id', 'in', [oldId, newId])
          .execute();
      });
    });
  });

  describe('derived hive_id and move_date', () => {
    const db = KyselyServer.getInstance().db;
    let hiveId: number;
    let inHive: number;
    let noHive: number;

    async function list(query: Record<string, unknown>) {
      const res = await doQueryRequest(agent, route, null, accessToken, {
        limit: 1000,
        ...query,
      });
      expect(res.statusCode).toBe(200);
      return res.body.results as Record<string, any>[];
    }
    async function batchGet(ids: number[]) {
      const res = await doRequest(
        agent,
        'post',
        `${route}/batchGet`,
        null,
        accessToken,
        { ids },
      );
      expect(res.statusCode).toBe(200);
      return res.body as Record<string, any>[];
    }

    beforeAll(async () => {
      const company = await db
        .selectFrom('hives')
        .select('user_id')
        .where('id', '=', 1)
        .executeTakeFirstOrThrow();
      const apiary = await db
        .selectFrom('apiaries')
        .select('id')
        .where('user_id', '=', company.user_id)
        .executeTakeFirstOrThrow();
      const hive = await db
        .insertInto('hives')
        .values({
          name: `Derived hive ${Date.now()}`,
          user_id: company.user_id,
          modus: true,
        })
        .executeTakeFirstOrThrow();
      hiveId = Number(hive.insertId);
      await db
        .insertInto('movedates')
        .values({
          apiary_id: apiary.id,
          hive_id: hiveId,
          date: new Date('2020-01-01'),
        })
        .execute();
      const create = async (body: Record<string, unknown>) => {
        const res = await doRequest(agent, 'post', route, null, accessToken, {
          name: 'testQueenDerived',
          ...body,
        });
        expect(res.statusCode).toBe(200);
        return res.body[0] as number;
      };
      inHive = await create({ hive_id: hiveId, move_date: '2025-02-03' });
      noHive = await create({ move_date: '2025-02-04' });
    });

    afterAll(async () => {
      await db
        .deleteFrom('queens')
        .where('id', 'in', [inHive, noHive])
        .execute();
      await db.deleteFrom('movedates').where('hive_id', '=', hiveId).execute();
      await db.deleteFrom('hives').where('id', '=', hiveId).execute();
    });

    it('list and batchGet show the hive and move date of the placement', async () => {
      const [row] = await list({
        filters: JSON.stringify([{ 'queens.hive_id': hiveId }]),
      });
      expect(row).toMatchObject({
        id: inHive,
        hive_id: hiveId,
        move_date: '2025-02-03',
        hive_location: expect.objectContaining({ hive_id: hiveId }),
      });
      expect(await batchGet([inHive, noHive])).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: inHive,
            hive_id: hiveId,
            move_date: '2025-02-03',
          }),
          expect.objectContaining({
            id: noHive,
            hive_id: null,
            move_date: null,
          }),
        ]),
      );
    });

    it('filters by hive id and by queens without hive', async () => {
      const byHive = await list({
        filters: JSON.stringify([{ 'queens.hive_id': hiveId }]),
      });
      expect(byHive.map((row) => row.id)).toEqual([inHive]);
      const empty = await list({
        filters: JSON.stringify([{ 'queens.hive_id': 'empty' }]),
      });
      const ids = empty.map((row) => row.id);
      expect(ids).toContain(noHive);
      expect(ids).not.toContain(inHive);
      expect(empty.every((row) => row.hive_id === null)).toBe(true);
    });

    it('latest shows the current queen of the hive', async () => {
      const latest = await list({ details: true, latest: true });
      expect(latest.find((row) => row.id === inHive)).toMatchObject({
        hive_id: hiveId,
        queen_location: expect.objectContaining({
          hive_id: hiveId,
          queen_id: inHive,
          queen_move_date: '2025-02-03',
        }),
      });
      expect(latest.map((row) => row.id)).not.toContain(noHive);
      const others = await list({ details: true, latest: false });
      expect(others.map((row) => row.id)).toContain(noHive);
      expect(others.map((row) => row.id)).not.toContain(inHive);
    });

    it('orders by move_date', async () => {
      const rows = await list({ order: 'move_date', direction: 'desc' });
      const dates = rows
        .map((row) => row.move_date as string | null)
        .filter((date): date is string => date !== null);
      expect(dates.length).toBeGreaterThan(0);
      expect(dates).toEqual(dates.toSorted().toReversed());
    });

    it('a move out shows no hive and the end of the placement', async () => {
      const res = await doRequest(agent, 'patch', route, null, accessToken, {
        ids: [inHive],
        data: { hive_id: 'empty', move_date: '2025-03-01' },
      });
      expect(res.statusCode).toBe(200);
      const [row] = await batchGet([inHive]);
      expect(row).toMatchObject({ hive_id: null, move_date: '2025-03-01' });
    });
  });

  describe('/api/v1/queen/stats', () => {
    it('get 401 - no header', async () => {
      const res = await doQueryRequest(
        createAgent(),
        `${route}/stats`,
        null,
        null,
        null,
      );
      expect(res.statusCode).toEqual(401);
      expect(res.errors, 'JsonWebTokenError');
    });

    it('get 200 - success', async () => {
      const res = await doQueryRequest(
        agent,
        `${route}/stats`,
        null,
        accessToken,
        null,
      );
      expect(res.statusCode).toEqual(200);
      expect(res.body.results).toBeInstanceOf(Array);
      expect(res.body.total).toBeTypeOf('number');
    });

    it('orders queen statistics by movement date', async () => {
      const res = await doQueryRequest(
        agent,
        `${route}/stats`,
        null,
        accessToken,
        { order: 'move_date', direction: 'desc' },
      );
      expect(res.statusCode).toBe(200);
    });

    it('applies all queen statistic filters', async () => {
      for (const filter of [
        { 'queens.mating_id': 999_999 },
        { 'queens.race_id': 999_999 },
        { 'queens.hive_id': '999999' },
        { 'hive_location.apiary_id': 999_999 },
      ]) {
        const res = await doQueryRequest(
          agent,
          `${route}/stats`,
          null,
          accessToken,
          { filters: JSON.stringify([filter]) },
        );
        expect(res.statusCode).toBe(200);
        expect(res.body.results).toEqual([]);
        expect(res.body.total).toBe(0);
      }
    });
  });

  describe('/api/v1/queen/pedigree/:id', () => {
    it('get 401 - no header', async () => {
      const res = await doQueryRequest(
        createAgent(),
        `${route}/pedigree/7850`,
        null,
        null,
        null,
      );
      expect(res.statusCode).toEqual(401);
      expect(res.errors, 'JsonWebTokenError');
    });

    it('get 200 - success', async () => {
      const res = await doQueryRequest(
        agent,
        `${route}/pedigree/7850`,
        null,
        accessToken,
        null,
      );
      expect(res.statusCode).toEqual(200);
      expect(res.body).toBeInstanceOf(Array);
    });
  });

  describe('/api/v1/queen/batchGet', () => {
    it('401 - no header', async () => {
      const res = await doRequest(
        createAgent(),
        'post',
        `${route}/batchGet`,
        null,
        null,
        { ids: [insertId] },
      );
      expect(res.statusCode).toEqual(401);
      expect(res.errors, 'JsonWebTokenError');
    });
    it('400 - missing ids', async () => {
      const res = await doRequest(
        agent,
        'post',
        `${route}/batchGet`,
        null,
        null,
        null,
      );
      expect(res.statusCode).toEqual(400);
      expectations(res, 'ids', 'Invalid value');
    });
    it('200 - success', async () => {
      const res = await doRequest(
        agent,
        'post',
        `${route}/batchGet`,
        null,
        accessToken,
        { ids: [insertId] },
      );
      expect(res.statusCode).toEqual(200);
      expect(res.body).toBeInstanceOf(Array);
    });
  });

  describe('/api/v1/queen/status', () => {
    it('401 - no header', async () => {
      const res = await doRequest(
        createAgent(),
        'patch',
        `${route}/status`,
        null,
        null,
        { ids: [], status: true },
      );
      expect(res.statusCode).toEqual(401);
      expect(res.errors, 'JsonWebTokenError');
    });
    it('400 - missing ids', async () => {
      const res = await doRequest(
        agent,
        'patch',
        `${route}/status`,
        null,
        null,
        null,
      );
      expect(res.statusCode).toEqual(400);
      expectations(res, 'ids', 'Invalid value');
    });
    it('200 - success', async () => {
      const res = await doRequest(
        agent,
        'patch',
        `${route}/status`,
        null,
        accessToken,
        { ids: [insertId], status: false },
      );
      expect(res.statusCode).toEqual(200);
      expect(res.body).toBe(1);
    });
  });

  describe('/api/v1/queen/batchDelete', () => {
    it('401 - no header', async () => {
      const res = await doRequest(
        createAgent(),
        'patch',
        `${route}/batchDelete`,
        null,
        null,
        { ids: [] },
      );
      expect(res.statusCode).toEqual(401);
      expect(res.errors, 'JsonWebTokenError');
    });
    it('400 - missing ids', async () => {
      const res = await doRequest(
        agent,
        'patch',
        `${route}/batchDelete`,
        null,
        null,
        null,
      );
      expect(res.statusCode).toEqual(400);
      expectations(res, 'ids', 'Invalid value');
    });
    it('200 - success', async () => {
      const res = await doRequest(
        agent,
        'patch',
        `${route}/batchDelete`,
        null,
        accessToken,
        { ids: [insertId] },
      );
      expect(res.statusCode).toEqual(200);
      expect(res.body).toBeInstanceOf(Array);
    });
  });
});
