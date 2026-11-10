import { beforeAll, describe, expect, it } from 'vitest';

import {
  executeWizBeeTool,
  wizBeeToolDefinitions,
  type WizBeeContext,
} from '../../src/api/modules/wizbee_tools.module.js';
import { ROLES } from '../../src/config/constants.config.js';
import { KyselyServer } from '../../src/servers/kysely.server.js';
import type { TestAgent } from '../utils.js';
import { createAuthenticatedAgent, demoUser } from '../utils.js';

const db = KyselyServer.getInstance().db;

interface FindHivesResult {
  total: number;
  returned: number;
  hives: { hiveId: number; deleted: boolean }[];
}

describe('WizBee findHives', () => {
  const name = `FindHive${Date.now()}`;
  let agent: TestAgent;
  let actor: WizBeeContext;
  let activeId: number;
  let deletedId: number;

  async function findHives(input: Record<string, unknown>) {
    return (await executeWizBeeTool(
      db,
      'findHives',
      input,
      actor,
    )) as FindHivesResult;
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
    actor = {
      userId: Number(hive.user_id),
      beeId: bee.id,
      rank: ROLES.admin,
    };

    const created = await agent.request('POST', '/api/v1/hive', {
      name,
      apiary_id: 1,
      date: '2031-01-01',
      source_id: 1,
      type_id: 1,
      start: 0,
      repeat: 2,
    });
    expect(created.statusCode).toEqual(200);
    [activeId, deletedId] = created.body as number[];

    const deleted = await agent.request('PATCH', '/api/v1/hive/batchDelete', {
      ids: [deletedId],
    });
    expect(deleted.statusCode).toEqual(200);
  });

  it('returns only active hives by default', async () => {
    const result = await findHives({ q: name });

    expect(result.total).toEqual(1);
    expect(result.hives).toEqual([
      expect.objectContaining({ hiveId: activeId, deleted: false }),
    ]);
  });

  it('returns active and deleted hives with includeDeleted', async () => {
    const result = await findHives({ q: name, includeDeleted: true });

    expect(result.total).toEqual(2);
    expect(result.hives.map((hive) => [hive.hiveId, hive.deleted])).toEqual(
      expect.arrayContaining([
        [activeId, false],
        [deletedId, true],
      ]),
    );
  });

  it('rejects a limit outside 1 to 1000', async () => {
    for (const limit of [0, 1001]) {
      await expect(findHives({ q: name, limit })).rejects.toThrow('limit');
    }
  });

  it('is in the agent tool definitions', () => {
    expect(wizBeeToolDefinitions.map((tool) => tool.name)).toContain(
      'findHives',
    );
  });
});
