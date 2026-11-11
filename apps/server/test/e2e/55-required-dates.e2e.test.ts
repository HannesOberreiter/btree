import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  executeWizBeeTool,
  type WizBeeContext,
} from '../../src/api/modules/wizbee_tools.module.js';
import { ROLES } from '../../src/config/constants.config.js';
import { KyselyServer } from '../../src/servers/kysely.server.js';
import type { TestAgent } from '../utils.js';
import { createAuthenticatedAgent, demoUser, expectations } from '../utils.js';

const db = KyselyServer.getInstance().db;
const today = new Date().toISOString().slice(0, 10);

const tasks = [
  { route: 'feed', table: 'feeds', body: { amount: 1, type_id: 1 } },
  { route: 'treatment', table: 'treatments', body: { amount: 1, type_id: 1 } },
  { route: 'harvest', table: 'harvests', body: { amount: 1, type_id: 1 } },
  {
    route: 'checkup',
    table: 'checkups',
    body: { type_id: 1, interval: 0, repeat: 0 },
  },
] as const;
type Table = (typeof tasks)[number]['table'] | 'todos' | 'movedates';

describe('required dates on tasks, todos and movements', () => {
  let agent: TestAgent;
  const created: Record<Table, number[]> = {
    feeds: [],
    treatments: [],
    harvests: [],
    checkups: [],
    todos: [],
    movedates: [],
  };

  async function post(route: string, body: unknown) {
    const res = await agent.request('POST', `/api/v1/${route}`, body);
    expect(res.statusCode).toEqual(200);
    return res.body as number[];
  }
  async function dates(table: Table, ids: number[]) {
    const rows = await db
      .selectFrom(table)
      .selectAll()
      .where('id', 'in', ids)
      .execute();
    return rows.map((row) => ({
      date: String(row.date).slice(0, 10),
      ...('enddate' in row && { enddate: String(row.enddate).slice(0, 10) }),
    }));
  }

  beforeAll(async () => {
    agent = await createAuthenticatedAgent();
  });

  afterAll(async () => {
    for (const [table, ids] of Object.entries(created))
      if (ids.length)
        await db
          .deleteFrom(table as Table)
          .where('id', 'in', ids)
          .execute();
  });

  describe.each(tasks)('$route', ({ route, table, body }) => {
    it('post 200 - missing or empty date stores today', async () => {
      const withDate = route === 'checkup' ? [''] : [undefined, ''];
      for (const date of withDate) {
        const ids = await post(route, { ...body, hive_ids: [1], date });
        created[table].push(...ids);
        expect(await dates(table, ids)).toEqual([
          { date: today, enddate: today },
        ]);
      }
    });

    it('patch 400 - null or empty date or enddate', async () => {
      for (const data of [
        { date: null },
        { date: '' },
        { enddate: null },
        { enddate: '' },
      ]) {
        const res = await agent.request('PATCH', `/api/v1/${route}`, {
          ids: created[table],
          data,
        });
        expect(res.statusCode).toEqual(400);
        expectations(res, Object.keys(data)[0], 'Invalid value');
      }
    });

    it('patch date 400 - empty start or end', async () => {
      const res = await agent.request('PATCH', `/api/v1/${route}/date`, {
        ids: created[table],
        start: '',
        end: '',
      });
      expect(res.statusCode).toEqual(400);
    });
  });

  describe.each([
    {
      route: 'todo',
      table: 'todos',
      body: { name: 'requiredDateTodo' },
    },
    {
      route: 'movedate',
      table: 'movedates',
      body: { hive_ids: [2], apiary_id: 1 },
    },
  ] as const)('$route', ({ route, table, body }) => {
    it('post 200 - empty date stores today', async () => {
      const ids = await post(route, { ...body, date: '' });
      created[table].push(...ids);
      expect(await dates(table, ids)).toEqual([{ date: today }]);
    });

    it('patch 400 - null or empty date', async () => {
      for (const date of [null, '']) {
        const res = await agent.request('PATCH', `/api/v1/${route}`, {
          ids: created[table],
          data: { date },
        });
        expect(res.statusCode).toEqual(400);
        expectations(res, 'date', 'Invalid value');
      }
    });

    it('patch date 400 - empty start', async () => {
      const res = await agent.request('PATCH', `/api/v1/${route}/date`, {
        ids: created[table],
        start: '',
      });
      expect(res.statusCode).toEqual(400);
    });
  });

  it('hive post 200 - empty date moves the hive today', async () => {
    const [hiveId] = await post('hive', {
      name: `RequiredDateHive${Date.now()}`,
      apiary_id: 1,
      date: '',
      source_id: 1,
      type_id: 1,
      start: 0,
      repeat: 1,
    });
    const movements = await db
      .selectFrom('movedates')
      .select('id')
      .where('hive_id', '=', hiveId)
      .execute();
    const ids = movements.map((row) => row.id);
    expect(await dates('movedates', ids)).toEqual([{ date: today }]);
    await db.deleteFrom('movedates').where('id', 'in', ids).execute();
    await db.deleteFrom('hives').where('id', '=', hiveId).execute();
  });

  it('WizBee patchFeed ignores an empty date and enddate', async () => {
    const bee = await db
      .selectFrom('bees')
      .select('id')
      .where('email', '=', demoUser.email)
      .executeTakeFirstOrThrow();
    const hive = await db
      .selectFrom('hives')
      .select('user_id')
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    const actor: WizBeeContext = {
      userId: Number(hive.user_id),
      beeId: bee.id,
      rank: ROLES.admin,
    };
    const ids = await post('feed', {
      hive_ids: [1],
      date: '2020-01-15',
      amount: 1,
      type_id: 1,
    });
    created.feeds.push(...ids);
    const result = await executeWizBeeTool(
      db,
      'patchFeed',
      { ids, date: '', enddate: '', note: 'empty dates' },
      actor,
    );
    expect(result).toMatchObject({ success: true, updatedCount: 1 });
    expect(await dates('feeds', ids)).toEqual([
      { date: '2020-01-15', enddate: '2020-01-15' },
    ]);
  });
});
