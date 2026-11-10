import { beforeAll, describe, expect, it } from 'vitest';

import {
  executeWizBeeTool,
  type WizBeeContext,
} from '../../src/api/modules/wizbee_tools.module.js';
import { ROLES } from '../../src/config/constants.config.js';
import { KyselyServer } from '../../src/servers/kysely.server.js';
import { demoUser } from '../utils.js';

const db = KyselyServer.getInstance().db;

describe('WizBee listCompanyUsers', () => {
  let actor: WizBeeContext;

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
  });

  it('lists company users to read-only members', async () => {
    const result = await executeWizBeeTool(
      db,
      'listCompanyUsers',
      {},
      {
        ...actor,
        rank: ROLES.read,
      },
    );

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bee_id: actor.beeId,
          email: demoUser.email,
          rank: 'admin',
          company_id: actor.userId,
          company_name: expect.any(String),
        }),
      ]),
    );
  });

  it('denies listCompanyUsers to ghost members', async () => {
    const result = await executeWizBeeTool(
      db,
      'listCompanyUsers',
      {},
      {
        ...actor,
        rank: ROLES.ghost,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'forbidden', status: 403 },
    });
  });
});
