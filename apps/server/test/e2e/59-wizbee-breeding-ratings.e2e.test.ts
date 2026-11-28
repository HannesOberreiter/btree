import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  executeWizBeeTool,
  type WizBeeContext,
} from '../../src/api/modules/wizbee_tools.module.js';
import { ROLES } from '../../src/config/constants.config.js';
import { KyselyServer } from '../../src/servers/kysely.server.js';
import { demoUser } from '../utils.js';

const db = KyselyServer.getInstance().db;

describe('WizBee checkup tools with the breeding ratings', () => {
  let actor: WizBeeContext;
  const ids: number[] = [];

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
    actor = { userId: Number(hive.user_id), beeId: bee.id, rank: ROLES.admin };
  });

  afterAll(async () => {
    if (ids.length > 0) {
      await db.deleteFrom('checkups').where('id', 'in', ids).execute();
    }
  });

  async function stored(id: number) {
    return db
      .selectFrom('checkups')
      .select(['colony_strength', 'spring_development'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }

  it('createCheckup and patchCheckup store both ratings', async () => {
    const created = (await executeWizBeeTool(
      db,
      'createCheckup',
      {
        hiveIds: [1],
        date: '2026-04-10',
        colonyStrength: 3.5,
        springDevelopment: 2,
      },
      actor,
    )) as { ids: number[] };
    ids.push(...created.ids);
    expect(created.ids).toHaveLength(1);
    const id = created.ids[0];
    let row = await stored(id);
    expect(Number(row.colony_strength)).toBe(3.5);
    expect(Number(row.spring_development)).toBe(2);

    await executeWizBeeTool(
      db,
      'patchCheckup',
      { ids: [id], colonyStrength: 4, springDevelopment: 1.5 },
      actor,
    );
    row = await stored(id);
    expect(Number(row.colony_strength)).toBe(4);
    expect(Number(row.spring_development)).toBe(1.5);
  });
});
