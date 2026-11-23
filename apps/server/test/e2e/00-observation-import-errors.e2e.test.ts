import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchObservations } from '../../src/api/adapters/pest.adapter.js';
import * as observations from '../../src/api/modules/observation.module.js';

const mocks = vi.hoisted(() => ({
  insertExecute: vi.fn<() => Promise<unknown>>(),
  log: vi.fn(),
}));

vi.mock('../../src/servers/kysely.server.js', () => ({
  KyselyServer: {
    getInstance: () => ({
      db: {
        insertInto: () => ({
          values: () => ({ execute: mocks.insertExecute }),
        }),
      },
    }),
  },
}));
vi.mock('../../src/servers/redis.server.js', () => {
  throw new Error('Observation imports must not depend on Redis');
});
vi.mock('../../src/services/logger.service.js', () => ({
  Logger: { getInstance: () => ({ log: mocks.log }) },
}));

beforeEach(() => {
  mocks.insertExecute.mockReset().mockResolvedValue({});
  mocks.log.mockReset();
  vi.spyOn(observations, 'getRandomObservationSample').mockResolvedValue([]);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-14T12:00:00Z'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('observation import failures without cache invalidation', () => {
  it('reports a second-batch error in the iNaturalist result after a partially committed batch', async () => {
    const records = Array.from({ length: 501 }, (_, index) => ({
      id: index + 1,
      time_observed_at: '2010-06-01T00:00:00Z',
      location: '47,8',
    }));
    vi.spyOn(observations, 'filterNewObservationExternalIds').mockResolvedValue(
      new Set(records.map((record) => record.id)),
    );
    mocks.insertExecute
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('second batch failed'));
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.hostname === 'api.inaturalist.org') {
          return new Response(JSON.stringify({ results: records }));
        }
        return new Response(JSON.stringify({ results: [], next: null }));
      }),
    );

    const result = await fetchObservations('Vespa velutina');
    expect(result.iNaturalist).toEqual({ error: 'second batch failed' });
    expect(mocks.insertExecute).toHaveBeenCalledTimes(2);
    // The other providers still ran.
    expect(result.observationOrg).toEqual({ newObservations: 0 });
  });

  it('reports each failed provider without rejecting or Redis work', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockRejectedValue(new Error('provider failed')),
    );
    const result = await fetchObservations('Vespa velutina');
    expect(result.iNaturalist).toEqual({ error: 'provider failed' });
    expect(result.observationOrg).toEqual({ error: 'provider failed' });
    expect(result.artenfinderNet).toEqual({ error: 'provider failed' });
    expect(mocks.insertExecute).not.toHaveBeenCalled();
  });

  it('logs provider, url and cause when one provider fetch fails and still runs the others', async () => {
    const cause = Object.assign(
      new Error('getaddrinfo ENOTFOUND www.artenfinder.net'),
      { code: 'ENOTFOUND' },
    );
    const fetchFailed = new TypeError('fetch failed', { cause });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.hostname === 'www.artenfinder.net') {
          throw fetchFailed;
        }
        return new Response(JSON.stringify({ results: [] }));
      }),
    );
    vi.spyOn(observations, 'filterNewObservationExternalIds').mockResolvedValue(
      new Set(),
    );

    const result = await fetchObservations('Aethina tumida');
    expect(result.artenfinderNet).toEqual({ error: 'fetch failed' });
    expect(result.iNaturalist).toEqual({ newObservations: 0 });
    expect(result.observationOrg).toEqual({ newObservations: 0 });
    expect(result.infoFaunaCh).toEqual({ newObservations: 0 });
    expect(mocks.log).toHaveBeenCalledWith(
      'error',
      'Observation provider Artenfinder.net failed',
      expect.objectContaining({
        provider: 'Artenfinder.net',
        url: expect.stringContaining('https://www.artenfinder.net'),
        cause: expect.objectContaining({ code: 'ENOTFOUND' }),
        error: fetchFailed,
      }),
    );
  });

  it('returns the Aethina import result without Redis work', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (
          ![
            'api.inaturalist.org',
            'observation.org',
            'www.artenfinder.net',
            'api.gbif.org',
          ].includes(url.hostname)
        ) {
          throw new Error(`Unexpected feed: ${url.hostname}`);
        }
        return new Response(
          JSON.stringify({ results: [], result: [], next: null }),
        );
      }),
    );

    expect(await fetchObservations('Aethina tumida')).toMatchObject({
      taxa: 'Aethina tumida',
      infoFaunaCh: { newObservations: 0 },
    });
  });
});
