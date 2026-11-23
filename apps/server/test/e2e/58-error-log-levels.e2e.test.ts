/**
 * The global error handler logs client-caused 4xx responses at info without
 * a stack trace, and keeps error level for 5xx and unexpected errors.
 * Requests use Fastify.inject in-process with mocked routes, without
 * databases or Redis connections.
 */
import type { FastifyInstance } from 'fastify';
import httpErrors from 'http-errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Application } from '../../src/config/app.config.js';
import { Logger } from '../../src/services/logger.service.js';

vi.mock('../../src/config/environment.config.js', () => ({
  env: 'staging',
  authorized: 'https://beta.btree.at',
  sessionSecret: 'isolated-test-session-secret-at-least-32-characters',
}));
vi.mock('../../src/servers/redis.server.js', () => ({
  RedisServer: {
    client: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      expire: vi.fn(async () => 1),
      del: vi.fn(async () => 1),
    },
  },
}));
vi.mock('../../src/api/routes/index.js', () => ({
  default(server: FastifyInstance, _options: unknown, done: () => void) {
    server.get('/v1/throws/unauthorized', () => {
      throw httpErrors.Unauthorized('Unauthorized');
    });
    server.get('/v1/throws/payment-required', () => {
      throw httpErrors.PaymentRequired('premium required');
    });
    server.get('/v1/throws/not-found', () => {
      throw httpErrors.NotFound('nope');
    });
    server.get('/v1/throws/server-error', () => {
      throw httpErrors.InternalServerError('boom');
    });
    server.get('/v1/throws/deadlock', () => {
      // Shaped like a MySQL deadlock error; checkMySQLError maps it to a 409.
      throw Object.assign(
        new Error(
          'Deadlock found when trying to get lock; try restarting transaction',
        ),
        { code: 'ER_LOCK_DEADLOCK' },
      );
    });
    done();
  },
}));
vi.mock('../../src/api/routes/mcp.route.js', () => ({
  default(_server: FastifyInstance, _options: unknown, done: () => void) {
    done();
  },
}));

const origin = { origin: 'https://beta.btree.at' };
let server: FastifyInstance;

beforeEach(async () => {
  Logger.getInstance().pino.level = 'silent';
  server = new Application().app;
  await server.ready();
});

afterEach(async () => {
  await server.close();
  vi.restoreAllMocks();
});

async function injectAndSpy(url: string) {
  const info = vi.spyOn(Logger.getInstance().pino, 'info');
  const error = vi.spyOn(Logger.getInstance().pino, 'error');
  const response = await server.inject({ url, headers: origin });
  return { response, info, error };
}

function callsWithStatusCode(
  spy: ReturnType<typeof vi.spyOn>,
  statusCode: number,
) {
  return spy.mock.calls.filter(
    ([context]) =>
      (context as { statusCode?: number })?.statusCode === statusCode,
  );
}

describe('error handler log levels', () => {
  it.each([
    ['/api/v1/throws/unauthorized', 401],
    ['/api/v1/throws/payment-required', 402],
    ['/api/v1/throws/not-found', 404],
  ])(
    'logs expected client error %s (%i) at info without an error object',
    async (url, statusCode) => {
      const { response, info, error } = await injectAndSpy(url);
      expect(response.statusCode).toBe(statusCode);

      const infoCalls = callsWithStatusCode(info, statusCode);
      expect(infoCalls).toHaveLength(1);
      expect(
        (infoCalls[0]![0] as Record<string, unknown>).error,
      ).toBeUndefined();
      // No error-level entry may carry this failure: match by the error
      // message, because the error branch logs no statusCode field.
      expect(
        error.mock.calls.filter(
          ([context]) =>
            (context as { error?: { message?: string } })?.error?.message ===
            response.json().message,
        ),
      ).toHaveLength(0);
    },
  );

  it('logs a 5xx at error level with the error and stack', async () => {
    const { response, info, error } = await injectAndSpy(
      '/api/v1/throws/server-error',
    );
    expect(response.statusCode).toBe(500);

    const errorEntries = error.mock.calls
      .map((call) => call[0])
      .filter(
        (context): context is { error: { stack?: string } } =>
          typeof context === 'object' && context !== null && 'error' in context,
      );
    expect(errorEntries).toHaveLength(1);
    expect(errorEntries[0].error.stack).toBeTruthy();
    expect(callsWithStatusCode(info, 500)).toHaveLength(0);
  });

  it('logs a mapped database 409 deadlock at error level with the stack', async () => {
    const { response, info, error } = await injectAndSpy(
      '/api/v1/throws/deadlock',
    );
    expect(response.statusCode).toBe(409);

    // The mapped error stays at error level even though it is a 4xx.
    expect(callsWithStatusCode(info, 409)).toHaveLength(0);
    const errorEntries = error.mock.calls
      .map((call) => call[0])
      .filter(
        (context): context is { error: { message?: string; stack?: string } } =>
          typeof context === 'object' && context !== null && 'error' in context,
      );
    expect(errorEntries).toHaveLength(1);
    expect(errorEntries[0].error.message).toBe('concurrentUpdate');
    expect(errorEntries[0].error.stack).toBeTruthy();
  });
});
