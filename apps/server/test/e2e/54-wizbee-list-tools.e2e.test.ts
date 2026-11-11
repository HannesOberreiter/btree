import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApiary } from '../../src/api/modules/apiary.module.js';
import { createHives } from '../../src/api/modules/hive.module.js';
import { createMovedates } from '../../src/api/modules/movedate.module.js';
import { createQueens } from '../../src/api/modules/queen.module.js';
import {
  executeWizBeeTool,
  type WizBeeContext,
} from '../../src/api/modules/wizbee_tools.module.js';
import { hiveCreateBodySchema } from '../../src/api/schemas/hive.schema.js';
import { ROLES } from '../../src/config/constants.config.js';
import { KyselyServer } from '../../src/servers/kysely.server.js';
import { demoUser } from '../utils.js';

const db = KyselyServer.getInstance().db;
/** Far enough ahead that rows of other test files do not fall into it. */
const year = new Date().getUTCFullYear() + 10;

interface Page {
  format?: string;
  total: number;
  count: number;
  hasMore: boolean;
  nextCursor: string | null;
  items?: Record<string, unknown>[];
  csv?: string;
}

describe('WizBee movement, queen and apiary list pages', () => {
  const tag = String(Date.now());
  let actor: WizBeeContext;
  let apiaryIds: number[];
  let hiveIds: number[];
  /** Movements of hiveIds[0], newest first by date, then id. */
  let movementIds: number[];
  let queenIds: number[];

  async function run(
    tool: string,
    input: Record<string, unknown>,
    context = actor,
  ) {
    return (await executeWizBeeTool(db, tool, input, context)) as Page;
  }

  /** All records of all pages, following nextCursor. */
  async function readAll(tool: string, input: Record<string, unknown>) {
    let page = await run(tool, input);
    const items = [...(page.items ?? [])];
    while (page.nextCursor) {
      page = await run(tool, { ...input, cursor: page.nextCursor });
      items.push(...(page.items ?? []));
    }
    return { total: page.total, items };
  }

  // Fixtures use the modules, because HTTP calls here can reach the rate
  // limit of the whole suite.
  beforeAll(async () => {
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
    actor = {
      userId: Number(hive.user_id),
      beeId: bee.id,
      rank: ROLES.admin,
    };

    const { userId, beeId } = actor;
    apiaryIds = [];
    for (const index of [1, 2, 3]) {
      const apiary = await createApiary(db, userId, beeId, {
        name: `ListApiary${tag}-${index}`,
      });
      apiaryIds.push(apiary.id);
    }
    hiveIds = await createHives(
      db,
      userId,
      beeId,
      hiveCreateBodySchema.parse({
        name: `ListHive${tag}`,
        apiary_id: apiaryIds[0],
        date: `${year}-01-01`,
        source_id: 1,
        type_id: 1,
        start: 0,
        repeat: 2,
      }),
    );

    // The hive creation added the movement of hiveIds[0] on January 1.
    for (const [apiaryId, date] of [
      [apiaryIds[1], `${year}-03-05`],
      [apiaryIds[0], `${year}-03-05`],
      [apiaryIds[1], `${year}-06-01`],
    ] as const) {
      await createMovedates(db, userId, beeId, {
        hive_ids: [hiveIds[0]],
        apiary_id: apiaryId,
        date,
      });
    }
    const rows = await db
      .selectFrom('movedates')
      .select(['id', 'date'])
      .where('hive_id', '=', hiveIds[0])
      .orderBy('date', 'desc')
      .orderBy('id', 'desc')
      .execute();
    movementIds = rows.map((row) => row.id);
    // A time later on March 5, as old movements have.
    await db
      .updateTable('movedates')
      .set({ date: sql`${`${year}-03-05 18:30:00`}` })
      .where('id', '=', movementIds[1])
      .execute();

    queenIds = [];
    // Two queens share one birth date, so the id decides.
    for (const date of [
      `${year}-05-01`,
      `${year}-03-01`,
      `${year}-02-01`,
      `${year}-03-01`,
    ]) {
      const ids = await createQueens(db, userId, beeId, {
        name: `ListQueen${tag}`,
        hive_id: null,
        date,
      });
      queenIds.push(ids[0]);
    }
  });

  it('pages movements newest first by date, then id', async () => {
    const result = await readAll('listMovements', {
      hiveId: hiveIds[0],
      limit: 1,
    });

    expect(result.total).toEqual(4);
    expect(result.items.map((row) => row.id)).toEqual(movementIds);
  });

  it('pages movements oldest first with sort oldest', async () => {
    const result = await readAll('listMovements', {
      hiveId: hiveIds[0],
      sort: 'oldest',
      limit: 3,
    });

    expect(result.items.map((row) => row.id)).toEqual(movementIds.toReversed());
  });

  it('filters movements with dateStart or dateEnd alone', async () => {
    const fromJune = await run('listMovements', {
      hiveId: hiveIds[0],
      dateStart: `${year}-06-01`,
    });
    const untilMarch = await run('listMovements', {
      hiveId: hiveIds[0],
      dateEnd: `${year}-03-05`,
    });

    expect(fromJune.items?.map((row) => row.id)).toEqual([movementIds[0]]);
    // dateEnd includes the movement at 18:30 on that day.
    expect(untilMarch.items?.map((row) => row.id)).toEqual(
      movementIds.slice(1),
    );
  });

  it('returns flat movement records by default', async () => {
    const page = await run('listMovements', {
      hiveId: hiveIds[0],
      limit: 1,
    });

    expect(page.format).toEqual('compact');
    expect(page.items?.[0]).toMatchObject({
      id: movementIds[0],
      hive_id: hiveIds[0],
      hive_name: expect.stringContaining(`ListHive${tag}`),
      apiary_id: apiaryIds[1],
      apiary_name: `ListApiary${tag}-2`,
      previous_apiary_id: apiaryIds[0],
      previous_apiary_name: `ListApiary${tag}-1`,
    });
    expect(page.items?.[0]).toHaveProperty('creator_name');
    expect(page.items?.[0]).not.toHaveProperty('hive');
    expect(page.items?.[0]).not.toHaveProperty('creator');
  });

  it('keeps nested movement objects in format full', async () => {
    const page = await run('listMovements', {
      hiveId: hiveIds[0],
      limit: 1,
      format: 'full',
    });

    expect(page.items?.[0]).toMatchObject({
      hive: { id: hiveIds[0] },
      apiary: { id: apiaryIds[1] },
      creator: { id: actor.beeId },
    });
  });

  it('returns movements as CSV in WizBee chat', async () => {
    const page = await run(
      'listMovements',
      { hiveId: hiveIds[0] },
      { ...actor, chat: true },
    );

    const lines = page.csv?.split('\n') ?? [];
    expect(page.format).toEqual('csv');
    expect(lines[0]).toContain('hive_name');
    expect(lines).toHaveLength(5);
  });

  it('rejects a movement cursor of the other sort', async () => {
    const page = await run('listMovements', {
      hiveId: hiveIds[0],
      limit: 1,
    });
    const result = await executeWizBeeTool(
      db,
      'listMovements',
      { hiveId: hiveIds[0], sort: 'oldest', cursor: page.nextCursor },
      actor,
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        status: 400,
        message: expect.stringContaining('Invalid cursor'),
      },
    });
  });

  it('pages queens by birth date, then id', async () => {
    const result = await readAll('listQueens', {
      location: 'all',
      q: `ListQueen${tag}`,
      limit: 1,
    });

    expect(result.total).toEqual(4);
    expect(result.items.map((row) => row.queenId)).toEqual([
      queenIds[2],
      queenIds[1],
      queenIds[3],
      queenIds[0],
    ]);
  });

  it('rejects a malformed queen cursor', async () => {
    const result = await executeWizBeeTool(
      db,
      'listQueens',
      { location: 'all', cursor: 'not-a-cursor' },
      actor,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { status: 400 },
    });
  });

  it('pages apiaries by id with their active hives', async () => {
    const result = await readAll('listApiariesHives', {
      q: `ListApiary${tag}`,
      limit: 1,
    });

    expect(result.total).toEqual(3);
    expect(result.items.map((row) => row.id)).toEqual(apiaryIds);
    const [first, second, third] = result.items;
    // hiveIds[0] moved to the second apiary; hiveIds[1] stayed.
    expect(first.hives).toEqual([
      expect.objectContaining({
        id: hiveIds[1],
        name: expect.stringContaining(`ListHive${tag}`),
      }),
    ]);
    expect(second.hives).toEqual([expect.objectContaining({ id: hiveIds[0] })]);
    expect(third.hives).toEqual([]);
    expect(second.firstMovedate).toMatchObject({ id: movementIds[0] });
    expect(first).not.toHaveProperty('sameLocation');
    expect(first).not.toHaveProperty('creator');
    expect(first).not.toHaveProperty('editor');
  });
});
