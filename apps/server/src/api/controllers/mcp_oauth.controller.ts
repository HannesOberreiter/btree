import { Buffer } from 'node:buffer';

import type { FastifyReply, FastifyRequest } from 'fastify';
import httpErrors from 'http-errors';

import { mcp } from '../../config/environment.config.js';
import { KyselyServer } from '../../servers/kysely.server.js';
import {
  createMcpConsentRequest,
  exchangeMcpAuthorizationCode,
  finishMcpConsent,
  getMcpAuthorizationErrorRedirect,
  getMcpAuthorizationRequest,
  getMcpOAuthLoginRedirect,
  listMcpConnections,
  McpOAuthError,
  refreshMcpAccessToken,
  registerMcpOAuthClient,
  revokeMcpConnection,
  type McpClientCredentials,
} from '../modules/mcp_oauth.module.js';

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

const CONSENT_TRANSLATIONS = {
  en: {
    heading: 'Authorize {client}',
    text: 'Allow this client to use your b.tree tools and beekeeping data.',
    scope: 'Scope',
    redirect: 'Redirect',
    allow: 'Allow',
    deny: 'Deny',
  },
  de: {
    heading: '{client} autorisieren',
    text: 'Erlaube diesem Client, deine b.tree-Werkzeuge und deine Bienendaten zu verwenden.',
    scope: 'Bereich',
    redirect: 'Weiterleitung',
    allow: 'Erlauben',
    deny: 'Ablehnen',
  },
  fr: {
    heading: 'Autoriser {client}',
    text: 'Autorise ce client à utiliser tes outils b.tree et tes données apicoles.',
    scope: 'Portée',
    redirect: 'Redirection',
    allow: 'Autoriser',
    deny: 'Refuser',
  },
  it: {
    heading: 'Autorizza {client}',
    text: 'Consenti a questo client di usare i tuoi strumenti b.tree e i dati del tuo apiario.',
    scope: 'Ambito',
    redirect: 'Reindirizzamento',
    allow: 'Consenti',
    deny: 'Nega',
  },
} as const;

type ConsentLanguage = keyof typeof CONSENT_TRANSLATIONS;

/** Pick the consent page language: the account language, then Accept-Language, then English. */
async function getConsentLanguage(
  request: FastifyRequest,
): Promise<ConsentLanguage> {
  const supported = Object.keys(CONSENT_TRANSLATIONS) as ConsentLanguage[];
  try {
    const beeId = request.session?.user?.bee_id;
    if (beeId) {
      const bee = await KyselyServer.getInstance()
        .db.selectFrom('bees')
        .select('lang')
        .where('id', '=', beeId)
        .executeTakeFirst();
      if (bee?.lang && (supported as string[]).includes(bee.lang)) {
        return bee.lang as ConsentLanguage;
      }
    }
  } catch {
    // Fall through to the Accept-Language header.
  }
  const header = request.headers['accept-language'] ?? '';
  const first = header.split(',')[0]?.split('-')[0]?.trim().toLowerCase() ?? '';
  return (supported as string[]).includes(first)
    ? (first as ConsentLanguage)
    : 'en';
}

function consentPage(
  clientName: string,
  redirectUri: string,
  scope: string,
  token: string,
  lang: ConsentLanguage,
) {
  const t = CONSENT_TRANSLATIONS[lang];
  // Replacer function so $-sequences in the client name are not treated
  // as replacement patterns.
  const heading = t.heading.replace('{client}', () => escapeHtml(clientName));
  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize b.tree MCP</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f4f6f5;
      color: #1f2937;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    main {
      background: #ffffff;
      border-radius: 12px;
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.12);
      padding: 2rem;
      width: calc(100% - 2rem);
      max-width: 32rem;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      color: #2b957a;
      font-size: 1.25rem;
      font-weight: 700;
      margin-bottom: 1rem;
    }
    h1 { font-size: 1.4rem; margin: 0 0 0.5rem; }
    p { font-size: 1.05rem; line-height: 1.5; margin: 0 0 1rem; }
    dl {
      background: #f4f6f5;
      border-radius: 8px;
      padding: 0.75rem 1rem;
      font-size: 0.95rem;
      margin: 0;
    }
    dt { font-weight: 600; margin-top: 0.25rem; }
    dd { margin: 0 0 0.25rem; word-break: break-all; }
    form { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
    button {
      flex: 1;
      font-size: 1.05rem;
      padding: 0.7rem 1rem;
      border-radius: 8px;
      border: 1px solid transparent;
      cursor: pointer;
    }
    button[value="approve"] { background: #2b957a; color: #ffffff; }
    button[value="deny"] { background: #ffffff; color: #b91c1c; border-color: #b91c1c; }
  </style>
</head>
<body>
  <main>
    <div class="brand">
      <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l8.66 5v10L12 22l-8.66-5V7L12 2z" fill="#2b957a"/></svg>
      b.tree
    </div>
    <h1>${heading}</h1>
    <p>${t.text}</p>
    <dl>
      <dt>${t.scope}</dt><dd>${escapeHtml(scope)}</dd>
      <dt>${t.redirect}</dt><dd>${escapeHtml(redirectUri)}</dd>
    </dl>
    <form method="post" action="/api/v1/mcp/oauth/authorize">
      <input type="hidden" name="consent_token" value="${escapeHtml(token)}">
      <button type="submit" name="decision" value="approve">${t.allow}</button>
      <button type="submit" name="decision" value="deny">${t.deny}</button>
    </form>
  </main>
</body>
</html>`;
}

function consentPageContentSecurityPolicy(redirectUri: string) {
  const redirectOrigin = new URL(redirectUri).origin;
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "base-uri 'none'",
    `form-action ${mcp.issuer} ${redirectOrigin}`,
    "frame-ancestors 'self'",
  ].join(';');
}

function requireValidOAuthRequest(request: FastifyRequest) {
  if (request.validationError) {
    throw new McpOAuthError('invalid_request', 'Invalid OAuth request');
  }
}

function sendOAuthError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
) {
  if (error instanceof McpOAuthError) {
    if (
      error.oauthCode === 'invalid_client' &&
      error.statusCode === 401 &&
      /^Basic(?:\s|$)/i.test(request.headers.authorization ?? '')
    ) {
      reply.header('WWW-Authenticate', 'Basic realm="b.tree MCP OAuth"');
    }
    return reply.code(error.statusCode).send({
      error: error.oauthCode,
      error_description: error.message,
    });
  }
  throw error;
}

function parseBasicCredentials(
  authorization: string | undefined,
): McpClientCredentials | undefined {
  if (!authorization) return undefined;
  const [scheme, encoded] = authorization.split(' ', 2);
  if (scheme?.toLowerCase() !== 'basic' || !encoded) return undefined;

  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    throw new McpOAuthError('invalid_client', 'Invalid OAuth client', 401);
  }
  const separator = decoded.indexOf(':');
  if (separator < 0) {
    throw new McpOAuthError('invalid_client', 'Invalid OAuth client', 401);
  }
  return {
    clientId: decoded.slice(0, separator),
    clientSecret: decoded.slice(separator + 1),
    authMethod: 'client_secret_basic',
  };
}

function getClientCredentials(request: FastifyRequest): McpClientCredentials {
  const body = request.body as Record<string, unknown>;
  const basic = parseBasicCredentials(request.headers.authorization);
  const bodyClientId =
    typeof body.client_id === 'string' ? body.client_id : undefined;
  const bodyClientSecret =
    typeof body.client_secret === 'string' ? body.client_secret : undefined;

  if (basic && bodyClientId && basic.clientId !== bodyClientId) {
    throw new McpOAuthError('invalid_client', 'Invalid OAuth client', 401);
  }

  const clientId = basic?.clientId ?? bodyClientId;
  if (!clientId) {
    throw new McpOAuthError('invalid_client', 'Missing OAuth client', 401);
  }
  return {
    clientId,
    clientSecret: basic?.clientSecret ?? bodyClientSecret,
    authMethod: basic
      ? 'client_secret_basic'
      : bodyClientSecret
        ? 'client_secret_post'
        : 'none',
  };
}

export default class McpOAuthController {
  static async connections(request: FastifyRequest, reply: FastifyReply) {
    const user = request.session.user;
    if (!user) throw httpErrors.Unauthorized('Unauthorized');
    return reply.send(
      await listMcpConnections(KyselyServer.getInstance().db, user),
    );
  }

  static async revokeConnection(request: FastifyRequest, reply: FastifyReply) {
    const user = request.session.user;
    if (!user) throw httpErrors.Unauthorized('Unauthorized');
    const { tokenFamily } = request.params as { tokenFamily: string };
    const revoked = await revokeMcpConnection(
      KyselyServer.getInstance().db,
      user,
      tokenFamily,
    );
    if (!revoked) throw httpErrors.NotFound('MCP connection not found');
    return reply.send({ revoked });
  }

  static async revokeConnections(request: FastifyRequest, reply: FastifyReply) {
    const user = request.session.user;
    if (!user) throw httpErrors.Unauthorized('Unauthorized');
    const revoked = await revokeMcpConnection(
      KyselyServer.getInstance().db,
      user,
    );
    return reply.send({ revoked });
  }

  static async register(request: FastifyRequest, reply: FastifyReply) {
    try {
      requireValidOAuthRequest(request);
      const registration = await registerMcpOAuthClient(
        KyselyServer.getInstance().db,
        request.body,
      );
      return reply.code(201).send(registration);
    } catch (error) {
      return sendOAuthError(request, reply, error);
    }
  }

  static async authorize(request: FastifyRequest, reply: FastifyReply) {
    try {
      requireValidOAuthRequest(request);
      const authorization = await getMcpAuthorizationRequest(
        KyselyServer.getInstance().db,
        request.query,
      );
      const sessionUser = request.session?.user;
      if (!sessionUser) {
        return reply.redirect(getMcpOAuthLoginRedirect(request));
      }

      const consent = await createMcpConsentRequest(
        KyselyServer.getInstance().db,
        authorization,
        sessionUser,
      );
      const lang = await getConsentLanguage(request);
      return reply
        .header(
          'Content-Security-Policy',
          consentPageContentSecurityPolicy(consent.pending.redirectUri),
        )
        .type('text/html; charset=utf-8')
        .send(
          consentPage(
            consent.pending.clientName,
            consent.pending.redirectUri,
            consent.pending.scope,
            consent.token,
            lang,
          ),
        );
    } catch (error) {
      const redirect = await getMcpAuthorizationErrorRedirect(
        KyselyServer.getInstance().db,
        request.query,
        error,
      );
      if (redirect) return reply.redirect(redirect);
      return sendOAuthError(request, reply, error);
    }
  }

  static async consent(request: FastifyRequest, reply: FastifyReply) {
    try {
      requireValidOAuthRequest(request);
      const sessionUser = request.session?.user;
      if (!sessionUser) {
        throw new McpOAuthError('access_denied', 'Login required', 401);
      }
      const body = request.body as Record<string, unknown>;
      const token =
        typeof body.consent_token === 'string' ? body.consent_token : '';
      const decision = typeof body.decision === 'string' ? body.decision : '';
      if (!token || !['approve', 'deny'].includes(decision)) {
        throw new McpOAuthError('invalid_request', 'Invalid consent response');
      }

      const redirect = await finishMcpConsent(
        KyselyServer.getInstance().db,
        token,
        decision === 'approve',
        sessionUser,
      );
      return reply.redirect(redirect);
    } catch (error) {
      return sendOAuthError(request, reply, error);
    }
  }

  static async token(request: FastifyRequest, reply: FastifyReply) {
    try {
      requireValidOAuthRequest(request);
      const body = request.body as Record<string, unknown>;
      const credentials = getClientCredentials(request);
      const grantType =
        typeof body.grant_type === 'string' ? body.grant_type : '';
      const token =
        grantType === 'authorization_code'
          ? await exchangeMcpAuthorizationCode(
              KyselyServer.getInstance().db,
              body,
              credentials,
            )
          : await refreshMcpAccessToken(
              KyselyServer.getInstance().db,
              body,
              credentials,
            );
      return reply.send(token);
    } catch (error) {
      return sendOAuthError(request, reply, error);
    }
  }
}
