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
/** Far enough ahead that rows of other test files do not fall into it. */
const year = new Date().getUTCFullYear() + 10;

interface ChargePage {
  format: string;
  total: number;
  count: number;
  hasMore: boolean;
  nextCursor: string | null;
  items?: Record<string, unknown>[];
  csv?: string;
  stockSummary: { count: number; items: unknown[] };
}

interface WaxList {
  total: number;
  count: number;
  hasMore: boolean;
  nextCursor: string | null;
  items: Record<string, unknown>[];
}

interface WaxPage {
  lots?: WaxList;
  operations?: WaxList;
  productSummary?: { lotCount: number; stockKg: number }[];
}

function daysAgo(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

describe('WizBee warehouse tools pages and formats', () => {
  const tag = String(Date.now());
  const chargeName = `Short${tag}`;
  const longChargeName = `LongCharge${tag}`;
  const waxReference = `Wax${tag}`;
  let agent: TestAgent;
  let actor: WizBeeContext;
  let deletedChargeId: number;
  const waxLotIds: number[] = [];

  async function post(path: string, body: unknown) {
    const res = await agent.request('POST', `/api/v1${path}`, body);
    expect(res.statusCode).toEqual(200);
    return res.body as unknown;
  }

  async function createCharge(body: Record<string, unknown>) {
    const ids = (await post('/charge', {
      price: 1,
      amount: 1,
      type_id: 1,
      kind: 'in',
      ...body,
    })) as number[];
    return ids[0];
  }

  async function fetchCharges(input: Record<string, unknown>, context = actor) {
    return (await executeWizBeeTool(
      db,
      'fetchCharges',
      input,
      context,
    )) as ChargePage;
  }

  async function fetchWaxLedger(input: Record<string, unknown>) {
    return (await executeWizBeeTool(
      db,
      'fetchWaxLedger',
      { q: waxReference, ...input },
      actor,
    )) as WaxPage;
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

    for (const date of [
      `${year}-01-01`,
      `${year}-01-02`,
      `${year}-01-02`,
      `${year}-01-03`,
    ]) {
      await createCharge({ name: chargeName, date });
    }
    deletedChargeId = await createCharge({
      name: chargeName,
      date: `${year}-01-04`,
    });
    const deleted = await agent.request('PATCH', '/api/v1/charge/batchDelete', {
      ids: [deletedChargeId],
    });
    expect(deleted.statusCode).toEqual(200);

    for (let index = 0; index < 40; index++) {
      await createCharge({
        name: longChargeName,
        date: `${year}-02-01`,
        note: 'x'.repeat(2000),
      });
    }

    const products = await agent.request('GET', '/api/v1/option/wax_products');
    const origins = await agent.request(
      'GET',
      '/api/v1/option/wax_origin_types',
    );
    const productId = (products.body as { id: number }[])[0].id;
    const originTypeId = (origins.body as { id: number }[])[0].id;
    for (const days of [4, 3, 3]) {
      const operation = (await post('/wax/operations', {
        date: daysAgo(days),
        type: 'production',
        origin_type_id: originTypeId,
        reference: waxReference,
        hive_ids: [],
        inputs: [],
        outputs: [
          { product_id: productId, quantity_kg: 1 },
          { product_id: productId, quantity_kg: 2 },
        ],
      })) as { lines: { lot_id: number }[] };
      waxLotIds.push(...operation.lines.map((line) => line.lot_id));
    }
    // Empties the first lot.
    await post('/wax/operations', {
      date: daysAgo(1),
      type: 'use',
      reference: waxReference,
      hive_ids: [],
      inputs: [{ lot_id: waxLotIds[0], quantity_kg: 1 }],
      outputs: [],
    });
  });

  it.each([
    [
      'newest',
      [`${year}-01-03`, `${year}-01-02`, `${year}-01-02`, `${year}-01-01`],
    ],
    [
      'oldest',
      [`${year}-01-01`, `${year}-01-02`, `${year}-01-02`, `${year}-01-03`],
    ],
  ])('pages charges %s by date and id', async (sort, dates) => {
    const items: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    do {
      const page = await fetchCharges({
        q: chargeName,
        sort,
        limit: 2,
        cursor,
      });
      expect(page.total).toEqual(4);
      expect(page.stockSummary.count).toBeGreaterThan(0);
      items.push(...(page.items ?? []));
      cursor = page.nextCursor ?? undefined;
    } while (cursor && items.length < 20);

    expect(items.map((item) => item.date)).toEqual(dates);
    const ids = items.map((item) => Number(item.id));
    expect(new Set(ids).size).toEqual(4);
    const sameDate = ids.slice(
      dates.indexOf(`${year}-01-02`),
      dates.indexOf(`${year}-01-02`) + 2,
    );
    expect(sameDate).toEqual(
      sort === 'newest'
        ? sameDate.toSorted((a, b) => b - a)
        : sameDate.toSorted((a, b) => a - b),
    );
  });

  it('filters charges by date and includes deleted charges on request', async () => {
    const ranged = await fetchCharges({
      q: chargeName,
      dateStart: `${year}-01-02`,
      dateEnd: `${year}-01-03`,
      // Without dateEnd, the deleted charge on day 4 would match too.
      includeDeleted: true,
    });
    expect(ranged.total).toEqual(3);

    const withDeleted = await fetchCharges({
      q: chargeName,
      includeDeleted: true,
    });
    expect(withDeleted.total).toEqual(5);
    expect(withDeleted.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: deletedChargeId, deleted: true }),
      ]),
    );
  });

  it('returns flat compact charges and nested full charges', async () => {
    const compact = await fetchCharges({ q: chargeName, limit: 1 });
    expect(compact.format).toEqual('compact');
    expect(compact.items?.[0]).toMatchObject({
      type_id: 1,
      type_name: expect.any(String),
      source_task: null,
    });
    expect(compact.items?.[0]).toHaveProperty('unit');
    expect(compact.items?.[0]).toHaveProperty('creator_name');
    for (const key of ['type', 'creator', 'editor', 'source']) {
      expect(compact.items?.[0]).not.toHaveProperty(key);
    }

    const full = await fetchCharges({
      q: chargeName,
      limit: 1,
      format: 'full',
    });
    expect(full.items?.[0]).toHaveProperty('type.stock');
  });

  it('returns charges as CSV by default in the WizBee chat', async () => {
    const page = await fetchCharges(
      { q: chargeName },
      { ...actor, chat: true },
    );

    expect(page.format).toEqual('csv');
    expect(page.csv?.split('\n')).toHaveLength(5);
    expect(page.stockSummary.count).toBeGreaterThan(0);
  });

  it.each(['full', 'compact', 'csv'])(
    'stops a %s charge page with long notes at the size limit',
    async (format) => {
      const page = await fetchCharges({ q: longChargeName, format });

      expect(page.total).toEqual(40);
      expect(page.count).toBeLessThan(40);
      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).toEqual(expect.any(String));
      const size = JSON.stringify(page).length;
      expect(size).toBeLessThanOrEqual(60_000);
      // A row has 2,000 to 3,000 characters, so a filled page has no room for one more.
      expect(size).toBeGreaterThan(55_000);
    },
  );

  it('rejects a charge cursor from the other sort order', async () => {
    const page = await fetchCharges({ q: chargeName, limit: 1 });

    const result = await fetchCharges({
      q: chargeName,
      sort: 'oldest',
      cursor: page.nextCursor,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        status: 400,
        message: expect.stringContaining('Invalid cursor'),
      },
    });
  });

  it('returns the first page of lots and operations with a full summary', async () => {
    const page = await fetchWaxLedger({ limit: 2 });

    expect(page.lots).toMatchObject({ total: 5, count: 2, hasMore: true });
    expect(page.operations).toMatchObject({
      total: 4,
      count: 2,
      hasMore: true,
    });
    expect(
      page.productSummary?.reduce((sum, row) => sum + row.lotCount, 0),
    ).toEqual(5);
    expect(
      page.productSummary?.reduce((sum, row) => sum + row.stockKg, 0),
    ).toBeCloseTo(8);
  });

  it.each([
    [false, 5],
    [true, 6],
  ])('pages wax lots with includeEmpty %s', async (includeEmpty, lots) => {
    const ids: number[] = [];
    let page = await fetchWaxLedger({ limit: 2, includeEmpty });
    while (page.lots) {
      ids.push(...page.lots.items.map((lot) => Number(lot.id)));
      if (!page.lots.nextCursor) break;
      page = await fetchWaxLedger({
        limit: 2,
        includeEmpty,
        cursor: page.lots.nextCursor,
      });
      expect(page.operations).toBeUndefined();
    }

    expect(ids).toEqual(ids.toSorted((a, b) => b - a));
    expect(new Set(ids).size).toEqual(lots);
    expect(ids.includes(waxLotIds[0])).toBe(includeEmpty);
  });

  it('pages wax operations by date and id', async () => {
    const items: Record<string, unknown>[] = [];
    let page = await fetchWaxLedger({ limit: 1 });
    while (page.operations) {
      items.push(...page.operations.items);
      if (!page.operations.nextCursor) break;
      page = await fetchWaxLedger({
        limit: 1,
        cursor: page.operations.nextCursor,
      });
      expect(page.lots).toBeUndefined();
    }

    expect(items.map((item) => item.type)).toEqual([
      'use',
      'production',
      'production',
      'production',
    ]);
    expect(items[0]).toHaveProperty('creator_name');
    expect(items[0]).not.toHaveProperty('creator');
    const sameDate = items.slice(1, 3).map((item) => Number(item.id));
    expect(sameDate).toEqual(sameDate.toSorted((a, b) => b - a));
  });

  it('keeps the actor objects in full wax operations', async () => {
    const page = await fetchWaxLedger({ limit: 1, format: 'full' });

    expect(page.operations?.items[0]).toHaveProperty('creator');
  });

  it('rejects a malformed wax cursor', async () => {
    const result = await fetchWaxLedger({ cursor: 'abc' });

    expect(result).toMatchObject({
      ok: false,
      error: {
        status: 400,
        message: expect.stringContaining('Invalid cursor'),
      },
    });
  });
});
