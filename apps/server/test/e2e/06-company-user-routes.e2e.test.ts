import type { Knex } from 'knex';
import knex from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { leaveCompany } from '../../src/api/modules/company_user.module.js';
import { knexConfig } from '../../src/config/environment.config.js';
import { KyselyServer } from '../../src/servers/kysely.server.js';
import type { TestAgent } from '../utils.js';
import {
  createAgent,
  createAuthenticatedAgent,
  doQueryRequest,
  doRequest,
  expectations,
} from '../utils.js';

const newUser = 'newUser@demo.at';

describe('company User routes', () => {
  const route = '/api/v1/company_user';
  let agent: TestAgent;
  let accessToken: any;
  let db: Knex;

  beforeAll(async () => {
    db = knex(knexConfig);
    agent = await createAuthenticatedAgent();
  });

  afterAll(async () => {
    await db.destroy();
  });

  describe('/api/v1/company_user/user', () => {
    it('401 - no header', async () => {
      const res = await doQueryRequest(
        createAgent(),
        `${route}/user`,
        null,
        null,
        null,
      );
      expect(res.statusCode).toEqual(401);
      expect(res.errors, 'JsonWebTokenError');
    });

    it('add_user 401 - no header', async () => {
      const res = await doRequest(
        createAgent(),
        'post',
        `${route}/add_user`,
        null,
        null,
        { email: newUser },
      );
      expect(res.statusCode).toEqual(401);
      expect(res.errors, 'JsonWebTokenError');
    });

    it('200 - get', async () => {
      const res = await doQueryRequest(
        agent,
        `${route}/user`,
        null,
        accessToken,
        null,
      );
      expect(res.statusCode).toEqual(200);
      expect(res.body).toBeInstanceOf(Array);
    });

    it('add_user 200 - success', async () => {
      const res = await doRequest(
        agent,
        'post',
        `${route}/add_user`,
        null,
        accessToken,
        { email: newUser },
      );
      expect(res.statusCode).toEqual(200);
      expect(res.body.email, newUser);
      expect(res.body).toHaveProperty('id');
      const newId = res.body.id;
      const res2 = await doRequest(
        agent,
        'delete',
        `${route}/remove_user`,
        newId,
        accessToken,
        {},
      );
      expect(res2.statusCode).toEqual(200);
      expect(res2.body).toBe(1);
    });
  });

  describe('/api/v1/company_user/', () => {
    it('delete 401 - no header', async () => {
      const res = await doRequest(
        createAgent(),
        'delete',
        `${route}/1`,
        null,
        null,
        {},
      );
      expect(res.statusCode).toEqual(401);
      expect(res.errors, 'JsonWebTokenError');
    });

    it('patch 401 - no header', async () => {
      const res = await doRequest(
        createAgent(),
        'patch',
        `${route}/1`,
        null,
        null,
        { rank: 1 },
      );
      expect(res.statusCode).toEqual(401);
      expect(res.errors, 'JsonWebTokenError');
    });

    it('patch 400 - missing rank', async () => {
      const res = await doRequest(agent, 'patch', `${route}/1`, null, null, {});
      expect(res.statusCode).toEqual(400);
      expectations(res, 'rank', 'requiredField');
    });

    it('patch 200 - success', async () => {
      const res = await doRequest(agent, 'patch', route, 1, accessToken, {
        rank: 1,
      });
      expect(res.statusCode).toEqual(200);
      expect(res.body).toBe(1);
    });
  });

  describe('delete /:company_id error codes', () => {
    it('403 COMPANY_HAS_NO_OTHER_USERS - only user of the company', async () => {
      const temp = await doRequest(
        agent,
        'post',
        '/api/v1/company',
        null,
        accessToken,
        { name: `TempLeave${Date.now()}` },
      );
      expect(temp.statusCode).toEqual(200);
      try {
        const res = await doRequest(
          agent,
          'delete',
          route,
          temp.body.id,
          accessToken,
          {},
        );
        expect(res.statusCode).toEqual(403);
        expect(res.body.code).toEqual('COMPANY_HAS_NO_OTHER_USERS');
      } finally {
        const del = await doRequest(
          agent,
          'delete',
          '/api/v1/company',
          temp.body.id,
          accessToken,
          {},
        );
        expect(del.statusCode).toEqual(200);
      }
    });

    it('403 LAST_COMPANY - last company of the user', async () => {
      const now = Date.now();
      const [beeId] = await db('bees').insert({
        email: `leave${now}@demo.at`,
      });
      const [otherBeeId] = await db('bees').insert({
        email: `stay${now}@demo.at`,
      });
      const [companyId] = await db('companies').insert({
        name: `Leave${now}`,
      });
      await db('company_bee').insert([
        { bee_id: beeId, user_id: companyId, rank: 2 },
        { bee_id: otherBeeId, user_id: companyId, rank: 1 },
      ]);
      try {
        await expect(
          leaveCompany(KyselyServer.getInstance().db, beeId, companyId),
        ).rejects.toMatchObject({ statusCode: 403, code: 'LAST_COMPANY' });
      } finally {
        await db('bees').whereIn('id', [beeId, otherBeeId]).del();
        await db('companies').where('id', companyId).del();
      }
    });
  });
});
