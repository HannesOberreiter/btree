import { beforeAll, describe, expect, it } from 'vitest';

import {
  executeWizBeeTool,
  type WizBeeContext,
} from '../../src/api/modules/wizbee_tools.module.js';
import { ROLES } from '../../src/config/constants.config.js';
import { KyselyServer } from '../../src/servers/kysely.server.js';
import type { TestAgent } from '../utils.js';
import { createAuthenticatedAgent, demoUser } from '../utils.js';

const db = KyselyServer.getInstance().db;

interface TaskPage {
  format: string;
  sort: string;
  total: number;
  count: number;
  hasMore: boolean;
  nextCursor: string | null;
  items?: Record<string, unknown>[];
  csv?: string;
}

describe('WizBee fetchTasks pages and formats', () => {
  let agent: TestAgent;
  let actor: WizBeeContext;
  let hiveIds: number[];

  async function post(path: string, body: unknown) {
    const res = await agent.request('POST', `/api/v1${path}`, body);
    expect(res.statusCode).toEqual(200);
    return res.body as number[];
  }

  async function fetchTasks(input: Record<string, unknown>, context = actor) {
    return (await executeWizBeeTool(
      db,
      'fetchTasks',
      input,
      context,
    )) as TaskPage;
  }

  async function readAllPages(input: Record<string, unknown>) {
    const pages: TaskPage[] = [];
    let cursor: string | undefined;
    do {
      const page = await fetchTasks({ ...input, cursor });
      pages.push(page);
      cursor = page.nextCursor ?? undefined;
    } while (cursor && pages.length < 20);
    return pages;
  }

  beforeAll(async () => {
    agent = await createAuthenticatedAgent();
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
    const companyId = Number(hive.user_id);
    actor = { userId: companyId, beeId: bee.id, rank: ROLES.admin };
    const hives = await db
      .selectFrom('hives')
      .select('id')
      .where('user_id', '=', companyId)
      .where('deleted', '=', false)
      .orderBy('id')
      .limit(2)
      .execute();
    hiveIds = hives.map((row) => row.id);
    expect(hiveIds).toHaveLength(2);

    // 2 hives x 3 days in March 2031.
    await post('/treatment', {
      hive_ids: hiveIds,
      date: '2031-03-01',
      note: 'paging',
      repeat: 2,
      interval: 1,
    });
    // 2 hives x 16 days in May 2031 with notes of 2000 characters.
    await post('/treatment', {
      hive_ids: hiveIds,
      date: '2031-05-01',
      note: 'x'.repeat(2000),
      repeat: 15,
      interval: 1,
    });
    await post('/feed', { hive_ids: hiveIds, date: '2031-03-01' });
    await post('/harvest', { hive_ids: hiveIds, date: '2031-03-01' });
    await post('/checkup', {
      hive_ids: hiveIds,
      date: '2031-03-01',
      note: 'a, "b"\nc',
      repeat: 0,
      interval: 0,
    });
    for (const date of ['2031-03-01', '2031-03-02', '2031-03-03']) {
      await post('/todo', { name: `Todo ${date}`, date });
    }
  });

  it.each([
    ['newest', 'desc'],
    ['oldest', 'asc'],
  ])('returns all rows once in pages sorted %s', async (sort, direction) => {
    const pages = await readAllPages({
      task: 'treatment',
      dateStart: '2031-03-01',
      dateEnd: '2031-03-31',
      sort,
      limit: 4,
    });

    expect(pages.map((page) => page.count)).toEqual([4, 2]);
    expect(pages.map((page) => page.hasMore)).toEqual([true, false]);
    expect(pages.every((page) => page.total === 6)).toBe(true);
    expect(pages[1].nextCursor).toBeNull();
    const rows = pages.flatMap((page) => page.items ?? []);
    const keys = rows.map((row) => `${String(row.date)} ${Number(row.id)}`);
    const sorted = [...rows]
      .sort(
        (a, b) =>
          String(a.date).localeCompare(String(b.date)) ||
          Number(a.id) - Number(b.id),
      )
      .map((row) => `${String(row.date)} ${Number(row.id)}`);
    expect(keys).toEqual(direction === 'asc' ? sorted : sorted.toReversed());
    expect(new Set(keys).size).toEqual(6);
  });

  it('pages todos by date and id', async () => {
    const pages = await readAllPages({
      task: 'todo',
      dateStart: '2031-03-01',
      dateEnd: '2031-03-31',
      limit: 2,
    });

    expect(
      pages.flatMap((page) => (page.items ?? []).map((row) => row.name)),
    ).toEqual(['Todo 2031-03-03', 'Todo 2031-03-02', 'Todo 2031-03-01']);
  });

  it('rejects a cursor from the other sort order', async () => {
    const first = await fetchTasks({
      task: 'treatment',
      dateStart: '2031-03-01',
      dateEnd: '2031-03-31',
      limit: 1,
    });

    const result = await fetchTasks({
      task: 'treatment',
      dateStart: '2031-03-01',
      dateEnd: '2031-03-31',
      sort: 'oldest',
      cursor: first.nextCursor,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'validation_error', status: 400 },
    });
  });

  it.each(['full', 'compact', 'csv'])(
    'stops a %s page at the result size limit',
    async (format) => {
      const page = await fetchTasks({
        task: 'treatment',
        dateStart: '2031-05-01',
        dateEnd: '2031-05-31',
        format,
      });

      expect(page.total).toEqual(32);
      expect(page.count).toBeGreaterThan(0);
      expect(page.count).toBeLessThan(32);
      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).toEqual(expect.any(String));
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(60_000);
      const rows =
        format === 'csv'
          ? (page.csv?.split('\n').length ?? 0) - 1
          : (page.items?.length ?? 0);
      expect(rows).toEqual(page.count);
    },
  );

  it.each(['feed', 'treatment', 'harvest', 'checkup', 'todo'])(
    'returns flat compact %s rows with ids and names',
    async (task) => {
      const page = await fetchTasks({
        task,
        dateStart: '2031-03-01',
        dateEnd: '2031-03-01',
      });

      expect(page.format).toEqual('compact');
      expect(page.count).toBeGreaterThan(0);
      for (const row of page.items ?? []) {
        for (const value of Object.values(row)) {
          expect(typeof value === 'object' ? value : null).toBeNull();
        }
        expect(row).toMatchObject({
          user_id: actor.userId,
          bee_id: actor.beeId,
        });
        expect(row).toHaveProperty('creator_name');
        expect(row).toHaveProperty('editor_name');
        if (task === 'todo') {
          expect(row).toHaveProperty('apiary_name');
        } else {
          expect(row).toMatchObject({
            hive_id: expect.any(Number),
            hive_name: expect.any(String),
          });
          expect(row).toHaveProperty('apiary_id');
          expect(row).toHaveProperty('apiary_name');
          expect(row).toHaveProperty('type_name');
        }
      }
    },
  );

  it('keeps the nested objects in full rows', async () => {
    const page = await fetchTasks({
      task: 'treatment',
      dateStart: '2031-03-01',
      dateEnd: '2031-03-01',
      format: 'full',
    });

    expect(page.items?.[0]).toMatchObject({
      hive: { id: expect.any(Number), name: expect.any(String) },
      creator: { id: actor.beeId },
    });
  });

  it('returns CSV by default in the WizBee chat', async () => {
    const page = await fetchTasks(
      { task: 'checkup', dateStart: '2031-03-01', dateEnd: '2031-03-01' },
      { ...actor, chat: true },
    );

    expect(page.format).toEqual('csv');
    expect(page.items).toBeUndefined();
    const header = page.csv?.split('\n')[0].split(',') ?? [];
    expect(header).toEqual(expect.arrayContaining(['id', 'note', 'hive_name']));
    expect(page.csv).toContain('"a, ""b""\nc"');
    expect(page.count).toEqual(2);
  });

  it('returns compact getHiveTasks rows', async () => {
    const result = (await executeWizBeeTool(
      db,
      'getHiveTasks',
      { id: hiveIds[0], year: 2031 },
      actor,
    )) as Record<string, Record<string, unknown>[]>;

    expect(result.treatment.length).toBeGreaterThan(0);
    expect(result.treatment[0]).toMatchObject({
      hive_name: expect.any(String),
      kind: 'treatment',
    });
    expect(result.treatment[0]).not.toHaveProperty('hive');
  });
});
