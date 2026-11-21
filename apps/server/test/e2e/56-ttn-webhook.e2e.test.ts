import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { listCalendarScaleData } from '../../src/api/modules/calendar.module.js';
import { ingestScaleReading } from '../../src/api/modules/scale_data.module.js';
import { KyselyServer } from '../../src/servers/kysely.server.js';
import type { TestAgent } from '../utils.js';
import {
  createAgent,
  createAuthenticatedAgent,
  doQueryRequest,
  doRequest,
  withTimeZone,
} from '../utils.js';

const devEui = '70B3D57ED0012345';
const apiKey = 'ttn-webhook-e2e-key';
const receivedAt = new Date('2026-01-10T08:00:00.123456789Z');

function uplink(
  decodedPayload: Record<string, unknown> | undefined,
  date = receivedAt,
  eui = devEui,
) {
  return {
    end_device_ids: {
      device_id: 'tanen-001',
      application_ids: { application_id: 'btree-scales' },
      dev_eui: eui,
    },
    received_at: date.toISOString(),
    uplink_message: {
      f_port: 1,
      received_at: date.toISOString(),
      ...(decodedPayload && { decoded_payload: decodedPayload }),
    },
  };
}

describe('TTN webhook', () => {
  const db = KyselyServer.getInstance().db;
  const route = `/api/v1/external/ttn/${apiKey}`;
  let agent: TestAgent;
  let scaleId: number;
  let companyId: number;

  async function readings() {
    return db
      .selectFrom('scale_data')
      .selectAll()
      .where('scale_id', '=', scaleId)
      .orderBy('datetime', 'asc')
      .execute();
  }

  beforeAll(async () => {
    agent = await createAuthenticatedAgent();
    const hive = await db
      .selectFrom('hives')
      .select('user_id')
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    companyId = Number(hive.user_id);
    await db
      .updateTable('companies')
      .set({
        api_key: apiKey,
        api_active: true,
        paid: new Date('2099-01-01T00:00:00Z'),
      })
      .where('id', '=', companyId)
      .executeTakeFirst();
    const res = await doRequest(agent, 'post', '/api/v1/scale', null, null, {
      name: 'ttnScale',
      hive_id: 1,
      dev_eui: '70-b3-d5-7e-d0-01-23-45',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.dev_eui).toBe(devEui);
    scaleId = res.body.id;
  });

  afterAll(async () => {
    await doRequest(agent, 'delete', '/api/v1/scale', scaleId, null, null);
  });

  it('scale 400 - invalid DevEUI', async () => {
    const res = await doRequest(agent, 'patch', '/api/v1/scale', null, null, {
      ids: [scaleId],
      data: { dev_eui: '70B3D57ED00123' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('scale 409 - duplicate DevEUI in the same company', async () => {
    const res = await doRequest(agent, 'post', '/api/v1/scale', null, null, {
      name: 'ttnScaleDuplicate',
      hive_id: 1,
      dev_eui: devEui,
    });
    expect(res.statusCode).toBe(409);
  });

  it('200 - stores the BEEP keys of an uplink', async () => {
    const res = await doRequest(
      createAgent(),
      'post',
      route,
      null,
      null,
      uplink(
        { weight_kg: 42.5, t: 12.3, h: 55, t_i: 30.1, h_i: 70, bv: 3.7 },
        receivedAt,
        '70:b3:d5:7e:d0:01:23:45',
      ),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ stored: true });
    expect(res.body.id).toBeTypeOf('number');

    const rows = await readings();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: res.body.id,
      weight: '42.50',
      temp1: '12.30',
      humidity: '55.00',
      temp2: '30.10',
      humidity2: '70.00',
    });
    expect(String(rows[0].datetime)).toBe('2026-01-10 08:00:00');
  });

  it('200 - drops an uplink within 1 hour of the previous reading', async () => {
    const res = await doRequest(
      createAgent(),
      'post',
      route,
      null,
      null,
      uplink(
        { weight_kg: 43 },
        new Date(receivedAt.getTime() + 10 * 60 * 1000),
      ),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ stored: false, reason: 'rate_limit' });
    expect(await readings()).toHaveLength(1);
  });

  it('429 - applies the 1-hour limit outside UTC', async () => {
    await withTimeZone('Europe/Vienna', async () => {
      await expect(
        ingestScaleReading(
          db,
          { api: apiKey, devEui },
          {
            action: 'CREATE',
            datetime: new Date(
              receivedAt.getTime() + 20 * 60 * 1000,
            ).toISOString(),
            weight: 43,
          },
        ),
      ).rejects.toMatchObject({ statusCode: 429 });
    });
    expect(await readings()).toHaveLength(1);
  });

  it('200 - drops an uplink without known keys', async () => {
    const later = new Date(receivedAt.getTime() + 2 * 60 * 60 * 1000);
    for (const payload of [undefined, { bv: 3.7, foo: 'bar' }]) {
      const res = await doRequest(
        createAgent(),
        'post',
        route,
        null,
        null,
        uplink(payload, later),
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ stored: false, reason: 'no_values' });
    }
    expect(await readings()).toHaveLength(1);
  });

  it('404 - unknown DevEUI', async () => {
    const res = await doRequest(
      createAgent(),
      'post',
      route,
      null,
      null,
      uplink({ weight_kg: 1 }, receivedAt, '0004A30B001C0530'),
    );
    expect(res.statusCode).toBe(404);
  });

  it('404 - unknown API key', async () => {
    const res = await doRequest(
      createAgent(),
      'post',
      '/api/v1/external/ttn/unknown-key',
      null,
      null,
      uplink({ weight_kg: 1 }),
    );
    expect(res.statusCode).toBe(404);
  });

  it('404 - API is switched off', async () => {
    await db
      .updateTable('companies')
      .set({ api_active: false })
      .where('id', '=', companyId)
      .executeTakeFirst();
    try {
      const res = await doRequest(
        createAgent(),
        'post',
        route,
        null,
        null,
        uplink({ weight_kg: 1 }),
      );
      expect(res.statusCode).toBe(404);
    } finally {
      await db
        .updateTable('companies')
        .set({ api_active: true })
        .where('id', '=', companyId)
        .executeTakeFirst();
    }
  });

  it('400 - uplink without DevEUI', async () => {
    const body = uplink({ weight_kg: 1 });
    const { dev_eui: _devEui, ...ids } = body.end_device_ids;
    const res = await doRequest(createAgent(), 'post', route, null, null, {
      ...body,
      end_device_ids: ids,
    });
    expect(res.statusCode).toBe(400);
  });

  it('402 - company without premium', async () => {
    await db
      .updateTable('companies')
      .set({ paid: new Date('2000-01-01T00:00:00Z') })
      .where('id', '=', companyId)
      .executeTakeFirst();
    try {
      const res = await doRequest(
        createAgent(),
        'post',
        route,
        null,
        null,
        uplink({ weight_kg: 1 }, new Date('2026-02-01T00:00:00Z')),
      );
      expect(res.statusCode).toBe(402);
    } finally {
      await db
        .updateTable('companies')
        .set({ paid: new Date('2099-01-01T00:00:00Z') })
        .where('id', '=', companyId)
        .executeTakeFirst();
    }
  });

  it('scale data 200 - finds readings by DevEUI or scale name', async () => {
    for (const q of [devEui.slice(4, 12), 'ttnScale']) {
      const res = await doQueryRequest(
        agent,
        '/api/v1/scale_data',
        null,
        null,
        { q },
      );
      expect(res.statusCode).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.results[0].scale).toMatchObject({
        id: scaleId,
        dev_eui: devEui,
      });
    }
  });

  it('scale data 200 - sorts by the DevEUI', async () => {
    const other = await doRequest(agent, 'post', '/api/v1/scale', null, null, {
      name: 'ttnScaleSort',
      hive_id: 1,
      dev_eui: '0000000000000001',
    });
    expect(other.statusCode).toBe(200);
    try {
      await db
        .insertInto('scale_data')
        .values({ datetime: receivedAt, weight: 1, scale_id: other.body.id })
        .execute();
      for (const [direction, first] of [
        ['asc', '0000000000000001'],
        ['desc', devEui],
      ]) {
        const res = await doQueryRequest(
          agent,
          '/api/v1/scale_data',
          null,
          null,
          { q: 'ttnScale', order: 'scale.dev_eui', direction },
        );
        expect(res.statusCode).toBe(200);
        expect(
          res.body.results.map(
            (row: { scale: { dev_eui: string } }) => row.scale.dev_eui,
          )[0],
        ).toBe(first);
      }
    } finally {
      await doRequest(
        agent,
        'delete',
        '/api/v1/scale',
        other.body.id,
        null,
        null,
      );
    }
  });

  describe('readings without values', () => {
    const name = 'emptyValues';
    const eui = 'A0B1C2D3E4F50001';
    const start = new Date('2026-03-01T00:00:00Z');
    const at = (hours: number) =>
      new Date(start.getTime() + hours * 60 * 60 * 1000);
    let emptyScaleId: number;

    async function latest() {
      return db
        .selectFrom('scale_data')
        .selectAll()
        .where('scale_id', '=', emptyScaleId)
        .orderBy('datetime', 'desc')
        .executeTakeFirstOrThrow();
    }

    async function warningFor(hours: number, weight?: number) {
      const { warning } = await ingestScaleReading(
        db,
        { api: apiKey, ident: name },
        { action: 'CREATE', datetime: at(hours).toISOString(), weight },
      );
      return warning;
    }

    beforeAll(async () => {
      const res = await doRequest(agent, 'post', '/api/v1/scale', null, null, {
        name,
        hive_id: 1,
        dev_eui: eui,
      });
      expect(res.statusCode).toBe(200);
      emptyScaleId = res.body.id;
    });

    afterAll(async () => {
      await doRequest(
        agent,
        'delete',
        '/api/v1/scale',
        emptyScaleId,
        null,
        null,
      );
    });

    it('200 - stores null for a key without a number', async () => {
      for (const [hours, payload, temp1] of [
        [0, { weight_kg: null, t: 5 }, '5.00'],
        [2, { weight_kg: null, t: null }, null],
      ] as const) {
        const res = await doRequest(
          createAgent(),
          'post',
          route,
          null,
          null,
          uplink(payload, at(hours), eui),
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({ stored: true });
        expect(await latest()).toMatchObject({
          id: res.body.id,
          weight: null,
          temp1,
          temp2: null,
          humidity: null,
          humidity2: null,
          rain: null,
        });
      }
    });

    it('scale 200 - stores null for a value that is empty or not sent', async () => {
      const res = await doQueryRequest(
        createAgent(),
        `/api/v1/external/scale/${name}/${apiKey}`,
        null,
        null,
        {
          action: 'CREATE',
          datetime: at(4).toISOString(),
          weight: '',
          temp1: 'null',
          hum: 40,
        },
      );
      expect(res.statusCode).toBe(200);
      const expected = {
        weight: null,
        temp1: null,
        temp2: null,
        humidity2: null,
        rain: null,
      };
      expect(res.body).toMatchObject({ ...expected, humidity: 40 });
      expect(await latest()).toMatchObject({
        ...expected,
        id: res.body.id,
        humidity: '40.00',
      });
    });

    it('warns about a weight change and about the first missing weight', async () => {
      // The readings before this test have no weight.
      expect(await warningFor(6, 40)).toBeUndefined();
      expect(await warningFor(8)).toMatchObject({
        scaleName: name,
        previousWeight: 40,
        currentWeight: null,
      });
      expect(await warningFor(10)).toBeUndefined();
      // Compares with the latest reading that has a weight.
      expect(await warningFor(12, 30)).toMatchObject({
        previousWeight: 40,
        currentWeight: 30,
      });
      expect(await warningFor(14, 27)).toBeUndefined();
      expect(await warningFor(16, 0)).toMatchObject({
        previousWeight: 27,
        currentWeight: 0,
      });
      // Old readings hold 0 for a missing weight.
      expect(await warningFor(18)).toBeUndefined();
      expect(await warningFor(20, 6)).toMatchObject({
        previousWeight: 0,
        currentWeight: 6,
      });
    });

    it('calendar - skips a day without a weight', async () => {
      await db
        .insertInto('scale_data')
        .values([
          { datetime: at(48), weight: null, scale_id: emptyScaleId },
          { datetime: at(72), weight: null, scale_id: emptyScaleId },
          { datetime: at(74), weight: 20, scale_id: emptyScaleId },
        ])
        .execute();
      const days = await listCalendarScaleData(db, companyId, {
        start: at(24).toISOString(),
        end: at(96).toISOString(),
      });
      expect(
        days
          .filter((day) => day.scale_id === emptyScaleId)
          .map((day) => [day.start, Number(day.average)]),
      ).toEqual([['2026-03-04', 20]]);
    });
  });

  it('scale 200 - removes the DevEUI with an empty value', async () => {
    const res = await doRequest(agent, 'patch', '/api/v1/scale', null, null, {
      ids: [scaleId],
      data: { dev_eui: '' },
    });
    expect(res.statusCode).toBe(200);
    const scale = await db
      .selectFrom('scales')
      .select('dev_eui')
      .where('id', '=', scaleId)
      .executeTakeFirstOrThrow();
    expect(scale.dev_eui).toBeNull();
  });
});
