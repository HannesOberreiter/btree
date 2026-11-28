import type { Knex } from 'knex';
import knex from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deleteOwnedCompany } from '../../src/api/modules/company.module.js';
import { knexConfig } from '../../src/config/environment.config.js';
import { KyselyServer } from '../../src/servers/kysely.server.js';
import type { TestAgent } from '../utils.js';
import {
  createAgent,
  createAuthenticatedAgent,
  demoUser,
  doQueryRequest,
  doRequest,
  expectations,
} from '../utils.js';

const patchCompanyName = 'newName';
const newCompanyName = 'testCompany';

describe('company routes', () => {
  const route = '/api/v1/company';
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

  describe('/api/v1/company/apikey', () => {
    it('401 - no header', async () => {
      const res = await doQueryRequest(
        createAgent(),
        `${route}/apikey`,
        null,
        null,
        null,
      );
      expect(res.statusCode).toEqual(401);
      expect(res.errors, 'JsonWebTokenError');
    });

    it('200 - get', async () => {
      const res = await doQueryRequest(
        agent,
        `${route}/apikey`,
        null,
        accessToken,
        null,
      );
      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('api_key');
    });
  });

  describe('/api/v1/company/coupon', () => {
    it('429 - promo code cooldown blocks a second coupon within 48 hours', async () => {
      const couponOne = `COOLDOWN_${Date.now()}_1`;
      const couponTwo = `COOLDOWN_${Date.now()}_2`;
      await db('promos').insert([
        { code: couponOne, months: 1, used: false },
        { code: couponTwo, months: 1, used: false },
      ]);

      const first = await doRequest(
        agent,
        'post',
        `${route}/coupon`,
        null,
        accessToken,
        { coupon: couponOne },
      );
      expect(first.statusCode).toEqual(200);
      expect(first.body).toHaveProperty('paid');

      const second = await doRequest(
        agent,
        'post',
        `${route}/coupon`,
        null,
        accessToken,
        { coupon: couponTwo },
      );
      expect(second.statusCode).toEqual(429);
      expect(second.body.message).toEqual('promoCooldown');
    });
  });

  describe('/api/v1/company/', () => {
    it('patch 400 - name too short', async () => {
      const res = await doRequest(agent, 'patch', route, null, null, {
        name: 'a',
      });
      expect(res.statusCode).toEqual(400);
      expectations(res, 'name', 'Invalid value');
    });

    it('patch 401 - no header', async () => {
      const res = await doRequest(createAgent(), 'patch', route, null, null, {
        name: 'newName',
      });
      expect(res.statusCode).toEqual(401);
      expect(res.errors, 'JsonWebTokenError');
    });

    it('patch 200 - success', async () => {
      const res = await doRequest(agent, 'patch', route, null, accessToken, {
        name: patchCompanyName,
        api_change: true,
      });
      expect(res.statusCode).toEqual(200);
      expect(res.body.name, patchCompanyName);
    });

    it('patch 200 - switch the API on and off', async () => {
      const off = await doRequest(agent, 'patch', route, null, accessToken, {
        password: demoUser.password,
        api_active: false,
      });
      expect(off.statusCode).toEqual(200);
      expect(off.body.api_active).toBe(false);
      await db('companies').where('id', off.body.id).update({ api_key: null });

      const on = await doRequest(agent, 'patch', route, null, accessToken, {
        password: demoUser.password,
        api_active: true,
      });
      expect(on.statusCode).toEqual(200);
      expect(on.body.api_active).toBe(true);
      expect(on.body).not.toHaveProperty('api_key');

      const key = await doQueryRequest(
        agent,
        `${route}/apikey`,
        null,
        accessToken,
        null,
      );
      expect(key.statusCode).toEqual(200);
      expect(key.body.api_key).toMatch(/^[0-9a-f]{50}$/);
      const icalRoute = `/api/v1/external/ical/todo/${key.body.api_key}`;
      const ical = await doQueryRequest(createAgent(), icalRoute, null, null, {
        format: 'ics',
      });
      expect(ical.statusCode).toEqual(200);

      const offAgain = await doRequest(
        agent,
        'patch',
        route,
        null,
        accessToken,
        { password: demoUser.password, api_active: false },
      );
      expect(offAgain.statusCode).toEqual(200);
      expect(offAgain.body.api_active).toBe(false);
      const icalOff = await doQueryRequest(
        createAgent(),
        icalRoute,
        null,
        null,
        { format: 'ics' },
      );
      expect(icalOff.statusCode).toEqual(404);
    });

    it('patch - only switch the API off without premium', async () => {
      const current = await doRequest(
        agent,
        'patch',
        route,
        null,
        accessToken,
        {
          api_active: false,
        },
      );
      const company = () => db('companies').where('id', current.body.id);
      const { paid } = await company().first('paid');
      await company().update({ paid: '2000-01-01' });
      try {
        const on = await doRequest(agent, 'patch', route, null, accessToken, {
          api_active: true,
        });
        expect(on.statusCode).toEqual(402);
        const stored = await company().first('api_active');
        expect(Boolean(stored.api_active)).toBe(false);

        await company().update({ api_active: true });
        const off = await doRequest(agent, 'patch', route, null, accessToken, {
          api_active: false,
          api_change: false,
        });
        expect(off.statusCode).toEqual(200);
        expect(off.body.api_active).toBe(false);
      } finally {
        await company().update({ paid });
      }
    });

    it('patch - switch the breeding mode on and off', async () => {
      const invalid = await doRequest(agent, 'patch', route, null, null, {
        breeding_system: 'beedata',
      });
      expect(invalid.statusCode).toEqual(400);

      const on = await doRequest(agent, 'patch', route, null, null, {
        breeding_system: 'beebreed',
      });
      expect(on.statusCode).toEqual(200);
      expect(on.body.breeding_system).toBe('beebreed');
      const user = await doQueryRequest(agent, '/api/v1/user', null, null, {});
      expect(user.statusCode).toEqual(200);
      const active = user.body.company.find(
        (row: { id: number }) => row.id === on.body.id,
      );
      expect(active.breeding_system).toBe('beebreed');

      // A patch without the field keeps the mode.
      const name = await doRequest(agent, 'patch', route, null, null, {
        name: patchCompanyName,
      });
      expect(name.body.breeding_system).toBe('beebreed');

      const off = await doRequest(agent, 'patch', route, null, null, {
        breeding_system: null,
      });
      expect(off.statusCode).toEqual(200);
      expect(off.body.breeding_system).toBeNull();
    });

    it('post 200 - success', async () => {
      const res = await doRequest(agent, 'post', route, null, accessToken, {
        name: newCompanyName + new Date().toISOString(),
      });
      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('name');
      expect(res.body).toHaveProperty('id');
      const newCompanyId = res.body.id;
      const responseName = res.body.name;
      const res2 = await doRequest(agent, 'post', route, null, accessToken, {
        name: responseName,
      });
      expect(res2.statusCode).toEqual(409);
      const res3 = await doRequest(
        agent,
        'delete',
        route,
        newCompanyId,
        accessToken,
        {},
      );
      expect(res3.statusCode).toEqual(200);
      // the new company is not the active one, so the active company stays
      expect(res3.body.result).toBe(0);
      expect(res3.body.data).toBeTypeOf('object');
    });
  });

  describe('delete /:id active company handling', () => {
    let activeId: number;

    beforeAll(async () => {
      const user = await doQueryRequest(
        agent,
        '/api/v1/user',
        null,
        accessToken,
        null,
      );
      expect(user.statusCode).toEqual(200);
      activeId = user.body.company[0].id;
      // persist the active company, so the tests can assert on saved_company
      const patch = await doRequest(
        agent,
        'patch',
        '/api/v1/user/company',
        null,
        accessToken,
        { saved_company: activeId },
      );
      expect(patch.statusCode).toEqual(200);
    });

    it('200 - deleting a non-active company keeps the active company', async () => {
      const temp = await doRequest(agent, 'post', route, null, accessToken, {
        name: `TempDelete${Date.now()}`,
      });
      expect(temp.statusCode).toEqual(200);
      const res = await doRequest(
        agent,
        'delete',
        route,
        temp.body.id,
        accessToken,
        {},
      );
      expect(res.statusCode).toEqual(200);
      expect(res.body.result).toBe(0);
      expect(res.body.data.saved_company).toBe(activeId);
      const gone = await db('companies').where('id', temp.body.id).first();
      expect(gone).toBeUndefined();
    });

    it('200 - repairs saved_company when it pointed at the deleted company', async () => {
      const temp = await doRequest(agent, 'post', route, null, accessToken, {
        name: `TempSaved${Date.now()}`,
      });
      expect(temp.statusCode).toEqual(200);
      const bee = await db('bees').where('email', demoUser.email).first('id');
      // another session moved saved_company to the temp company
      await db('bees')
        .where('id', bee.id)
        .update({ saved_company: temp.body.id });
      try {
        const res = await doRequest(
          agent,
          'delete',
          route,
          temp.body.id,
          accessToken,
          {},
        );
        expect(res.statusCode).toEqual(200);
        // the session still has the active company, but saved_company is
        // repaired instead of dangling (the FK set it to null)
        expect(res.body.result).toBe(1);
        expect(res.body.data.saved_company).toBe(activeId);
        const stored = await db('bees')
          .where('id', bee.id)
          .first('saved_company');
        expect(stored.saved_company).toBe(activeId);
      } finally {
        await db('bees')
          .where('id', bee.id)
          .update({ saved_company: activeId });
      }
    });

    it('200 - deleting the active company switches to the next company', async () => {
      const alpha = await doRequest(agent, 'post', route, null, accessToken, {
        name: `Alpha${Date.now()}`,
      });
      const mike = await doRequest(agent, 'post', route, null, accessToken, {
        name: `Mike${Date.now()}`,
      });
      expect(alpha.statusCode).toEqual(200);
      expect(mike.statusCode).toEqual(200);
      // Alpha was created first, so its membership is the older one
      expect(alpha.body.id).toBeLessThan(mike.body.id);
      const switchRes = await doRequest(
        agent,
        'patch',
        '/api/v1/user/company',
        null,
        accessToken,
        { saved_company: alpha.body.id },
      );
      expect(switchRes.statusCode).toEqual(200);
      const res = await doRequest(
        agent,
        'delete',
        route,
        alpha.body.id,
        accessToken,
        {},
      );
      expect(res.statusCode).toEqual(200);
      expect(res.body.result).toBe(1);
      // the oldest remaining membership is the original active company
      expect(res.body.data.saved_company).toBe(activeId);
      // cleanup: remove the helper company, the active company stays
      const del = await doRequest(
        agent,
        'delete',
        route,
        mike.body.id,
        accessToken,
        {},
      );
      expect(del.statusCode).toEqual(200);
      expect(del.body.result).toBe(0);
      expect(del.body.data.saved_company).toBe(activeId);
    });

    it('403 - not admin in the deleted company', async () => {
      const bee = await db('bees').where('email', demoUser.email).first('id');
      const insert = await db('companies').insert({
        name: `ReadOnly${Date.now()}`,
      });
      const companyId = insert[0];
      await db('company_bee').insert({
        bee_id: bee.id,
        user_id: companyId,
        rank: 3,
      });
      try {
        const res = await doRequest(
          agent,
          'delete',
          route,
          companyId,
          accessToken,
          {},
        );
        expect(res.statusCode).toEqual(403);
      } finally {
        await db('company_bee')
          .where('user_id', companyId)
          .where('bee_id', bee.id)
          .del();
        await db('companies').where('id', companyId).del();
      }
    });
  });

  describe('delete /:id error codes', () => {
    it('403 COMPANY_HAS_OTHER_USERS - other users in the company', async () => {
      const temp = await doRequest(agent, 'post', route, null, accessToken, {
        name: `TempShared${Date.now()}`,
      });
      expect(temp.statusCode).toEqual(200);
      const [otherBeeId] = await db('bees').insert({
        email: `other${Date.now()}@demo.at`,
      });
      await db('company_bee').insert({
        bee_id: otherBeeId,
        user_id: temp.body.id,
        rank: 2,
      });
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
        expect(res.body.code).toEqual('COMPANY_HAS_OTHER_USERS');
      } finally {
        await db('bees').where('id', otherBeeId).del();
        const del = await doRequest(
          agent,
          'delete',
          route,
          temp.body.id,
          accessToken,
          {},
        );
        expect(del.statusCode).toEqual(200);
      }
    });

    it('403 LAST_COMPANY - last company of the user', async () => {
      const [beeId] = await db('bees').insert({
        email: `single${Date.now()}@demo.at`,
      });
      const [companyId] = await db('companies').insert({
        name: `Single${Date.now()}`,
      });
      await db('company_bee').insert({
        bee_id: beeId,
        user_id: companyId,
        rank: 1,
      });
      try {
        await expect(
          deleteOwnedCompany(KyselyServer.getInstance().db, beeId, companyId),
        ).rejects.toMatchObject({ statusCode: 403, code: 'LAST_COMPANY' });
      } finally {
        await db('bees').where('id', beeId).del();
        await db('companies').where('id', companyId).del();
      }
    });
  });
});
