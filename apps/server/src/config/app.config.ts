import { randomUUID } from 'node:crypto';

import fastifyCompress from '@fastify/compress';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifySession from '@fastify/session';
import { RedisStore } from 'connect-redis';
import type { FastifyInstance } from 'fastify';
import fastify from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import queryString from 'query-string';

import {
  checkMySQLError,
  isMappedDatabaseError,
} from '../api/adapters/mysql_error.adapter.js';
import routes from '../api/routes/index.js';
import mcpRoutes from '../api/routes/mcp.route.js';
import {
  authorized,
  env,
  sessionSecret,
} from '../config/environment.config.js';
import { RedisServer } from '../servers/redis.server.js';
import { Logger, redactApiKeyFromUrl } from '../services/logger.service.js';
import { ENVIRONMENT } from './constants.config.js';

/**
 * Parses the comma-separated AUTHORIZED value into exact origins and their
 * hostnames. Throws for an entry that is not an http or https origin, so that
 * a wrong value stops the server at startup.
 */
export function parseAuthorized(value: string | undefined) {
  const origins = new Set<string>();
  const hostnames = new Set<string>();
  for (const entry of (value ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    let url: URL | undefined;
    try {
      url = new URL(trimmed);
    } catch {
      url = undefined;
    }
    if (
      !url ||
      !['http:', 'https:'].includes(url.protocol) ||
      trimmed.includes('*') ||
      url.origin !== trimmed.replace(/\/$/, '')
    ) {
      throw new Error(`AUTHORIZED entry is not an origin: ${trimmed}`);
    }
    origins.add(url.origin);
    hostnames.add(url.hostname);
  }
  return { origins, hostnames };
}

/** The hostname of a Host header value without its port, or '' if invalid. */
function hostHostname(host: string) {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return '';
  }
}

const authorizedList = parseAuthorized(authorized);

/** Paths that any origin can call, without credentials. */
const EXTERNAL_PATHS = new Set([
  '/api/v1/auth/google/callback',
  '/api/v1/auth/apple/callback',
  '/api/v1/openapi.json',
  '/api/v1/agent/openapi.json',
  '/api/v1/chatgpt/openapi.json',
]);
const EXTERNAL_PATH_PREFIXES = ['/api/v1/external/', '/api/v1/chatgpt/oauth/'];

/**
 * @description Instantiate server application.
 */
export class Application {
  public app: FastifyInstance;
  private sessionStore: RedisStore;
  private logger: Logger;

  constructor() {
    this.logger = Logger.getInstance();
    this.app = fastify({
      loggerInstance: this.logger.pino,
      trustProxy: true,
      bodyLimit: 1048576 * 50, // 50 MB
      routerOptions: {
        maxParamLength: 10000,
        querystringParser: (str) =>
          queryString.parse(str, {
            arrayFormat: 'bracket',
            parseBooleans: true,
            parseNumbers: true,
            types: { q: 'string', state: 'string', note: 'string' },
          }),
      },
      ajv: {
        customOptions: {
          removeAdditional: false, // Refer to [ajv options](https://ajv.js.org/options.html#removeadditional)
          // coerceTypes: 'array',
        },
      },
    });

    const redis = RedisServer.client;
    this.sessionStore = new RedisStore({
      client: redis,
      prefix: 'btree_sess:',
    });

    this.plug();
  }

  private plug(): void {
    /**
     * @description GZIP compression
     * @see https://www.npmjs.com/package/@fastify/compress
     */
    this.app.register(fastifyCompress);

    /**
     * @description Important security headers for Fastify. It is a tiny wrapper around helmet.
     * @see https://github.com/fastify/fastify-helmet
     */
    this.app.register(fastifyHelmet, {
      hidePoweredBy: true,
      noSniff: true,
      referrerPolicy: { policy: 'no-referrer' },
    });

    /**
     * @description Enable CORS - Cross Origin Resource Sharing
     */
    this.app.addHook('onRequest', (req, reply, done) => {
      const requestOrigin = req.headers.origin;
      const path = req.url.split('?', 1)[0];
      const isMcp =
        path === '/api/v1/mcp' ||
        path.startsWith('/api/v1/mcp/oauth/') ||
        path.startsWith('/.well-known/oauth-');

      // Preserve the existing Referer/Host fallback for origin authorization,
      // but only reflect a real Origin header in the CORS response.
      // MCP clients commonly omit Origin; keep it absent for MCP Origin checks.
      // https://github.com/expressjs/cors/issues/262
      // The Host value has no scheme, so it is compared by hostname only.
      let originIsHost = false;
      if (!req.headers.origin && !isMcp) {
        if (req.headers.referer) {
          try {
            const url = new URL(req.headers.referer);
            req.headers.origin = url.origin;
          } catch (error) {
            Logger.getInstance().pino.error(error, 'Error parsing referer');
            req.headers.origin = req.headers?.host ?? '';
            originIsHost = true;
          }
        } else if (req.headers.host) {
          req.headers.origin = req.headers.host;
          originIsHost = true;
        }
      }

      const origin = req.headers.origin ?? '';
      const isAuthorized = originIsHost
        ? authorizedList.hostnames.has(hostHostname(origin))
        : authorizedList.origins.has(origin);

      const isExternal =
        isMcp ||
        EXTERNAL_PATHS.has(path) ||
        EXTERNAL_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));

      if (!isExternal) {
        // Both headers can affect the response, including its rejection status.
        // A CDN must also explicitly include them in its cache key.
        reply.header('Vary', 'Origin, Referer');
      }

      if (!isExternal && env !== ENVIRONMENT.development && !isAuthorized) {
        reply.status(406).send();
        return;
      }

      if (isExternal || env === ENVIRONMENT.development) {
        reply.header('Access-Control-Allow-Origin', '*');
      } else if (requestOrigin) {
        reply.header('Access-Control-Allow-Origin', requestOrigin);
        reply.header('Access-Control-Allow-Credentials', 'true');
      }

      reply.header(
        'Access-Control-Allow-Headers',
        'Origin, Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID',
      );
      reply.header(
        'Access-Control-Allow-Methods',
        'GET, POST, PATCH, DELETE, OPTIONS',
      );
      reply.header(
        'Access-Control-Expose-Headers',
        'Access-Control-Allow-Origin, Access-Control-Allow-Methods, Access-Control-Allow-Headers, WWW-Authenticate, MCP-Protocol-Version, Mcp-Session-Id',
      );

      if (req.method.toLowerCase() === 'options') {
        reply.send();
        return;
      }

      done();
    });

    this.app.register(fastifyCookie);

    this.app.register(fastifySession, {
      idGenerator(req) {
        let id = randomUUID();
        if (req && 'bee_id' in req) {
          id = `${String(req.bee_id)}:${id}`;
        }
        return id;
      },
      cookieName:
        env === ENVIRONMENT.staging
          ? '_auth-btree-session-staging'
          : '_auth-btree-session',
      cookiePrefix: 's:',
      secret: sessionSecret,
      saveUninitialized: false,
      rolling: false,
      store: this.sessionStore,
      cookie: {
        sameSite: 'strict',
        maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
        secure: env === ENVIRONMENT.production,
        domain: env === ENVIRONMENT.production ? 'btree.at' : '',
        path: '/',
      },
    });

    /**
     * @description Configure API Rate limit
     * @see https://github.com/fastify/fastify-rate-limit
     */
    this.app.register(fastifyRateLimit, {
      timeWindow: 1000 * 60, // 1 minute
      // The e2e suites send all requests from one IP and come near 1000 per
      // minute. Route limits, such as the agent API limit, keep their max.
      max: env === ENVIRONMENT.test || env === ENVIRONMENT.ci ? 10_000 : 1000,
    });

    /**
     * @description Global validator and serializer compiler using Zod
     */
    this.app.setValidatorCompiler(validatorCompiler);
    this.app.setSerializerCompiler(serializerCompiler);

    /**
     * @description Global logger
     */
    this.app.setErrorHandler(function (error, request, reply) {
      if (hasZodFastifySchemaValidationErrors(error)) {
        request.log.error(
          {
            user: request?.session?.user,
            req: request,
            error: error.validation,
            path: redactApiKeyFromUrl(request.url),
          },
          'Zod validation error',
        );
        return reply.code(400).send({
          error: 'Bad Request',
          message: "Request doesn't match the schema",
          statusCode: 400,
          issues: error.validation,
          details: {
            issues: error.validation,
            method: request.method,
            url: request.url,
          },
        });
      }

      if (isResponseSerializationError(error)) {
        request.log.error(
          {
            user: request?.session?.user,
            req: request,
            error: error.cause,
            path: redactApiKeyFromUrl(request.url),
            method: error.method,
          },
          'Zod serialization error',
        );
        return reply.code(500).send({
          error: 'Internal Server Error',
          message: "Response doesn't match the schema",
          statusCode: 500,
          issues: error.cause.issues,
          details: {
            issues: error.cause.issues,
            method: error.method,
            url: error.url,
          },
        });
      }

      const e = checkMySQLError(error);
      const path = redactApiKeyFromUrl(request.url);
      // Database errors stay at error level with the stack, also when a module
      // already mapped and rethrew them: a deadlock maps to a 409, but it is
      // a server-side fault, not a client mistake.
      // Client-caused 4xx responses are expected in normal use (401 on
      // auth/ping, 402 on premium calendar subscriptions, 404 on external
      // feeds). Log them at info without a stack trace, so the error log
      // keeps only 5xx and unexpected errors.
      const statusCode =
        typeof e.statusCode === 'number' ? e.statusCode : undefined;
      if (
        !isMappedDatabaseError(e) &&
        statusCode !== undefined &&
        statusCode >= 400 &&
        statusCode < 500
      ) {
        this.log.info(
          {
            user: request?.session?.user,
            req: request,
            path,
            statusCode,
            code: e.code,
          },
          e.message || 'HTTP error',
        );
      } else {
        this.log.error(
          {
            user: request?.session?.user,
            req: request,
            error: e,
            path,
          },
          e.message || 'Unhandled error',
        );
      }
      if (e.statusCode) {
        reply.status(e.statusCode).send({
          statusCode: e.statusCode,
          code: e.code ?? 'HTTP_ERROR',
          message: e.message,
          ...(e.details && { details: e.details }),
        });
        return;
      }
      throw e;
    });

    /**
     * @description Register multipart plugin
     */
    this.app.register(fastifyMultipart, {
      limits: {
        fileSize: 1048576 * 10, // 10 MB
        files: 1, // Max number of file fields
      },
      attachFieldsToBody: 'keyValues',
    });

    this.app.register(mcpRoutes);
    this.app.register(routes, {
      prefix: '/api/',
    });

    this.app.ready();
  }
}
