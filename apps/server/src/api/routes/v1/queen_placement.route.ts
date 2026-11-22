import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { ROLES } from '../../../config/constants.config.js';
import { KyselyServer } from '../../../servers/kysely.server.js';
import { Guard } from '../../hooks/guard.hook.js';
import {
  deletePlacements,
  getPlacementsByIds,
  listPlacements,
  updatePlacements,
} from '../../modules/queen_placement.module.js';
import { compatibilityQuerySchema } from '../../schemas/common.schema.js';
import {
  batchIdsBodySchema,
  patchBodySchema,
  queenPlacementPaginatedResponseSchema,
  queenPlacementsResponseSchema,
} from '../../schemas/queen_placement.schema.js';

/**
 * Periods of queens in hives. A queen write (`/v1/queen`) creates and ends
 * placements; these routes list them and correct dates.
 */
export default function routes(
  instance: FastifyInstance,
  _options: unknown,
  done: () => void,
) {
  const server = instance.withTypeProvider<ZodTypeProvider>();
  const db = KyselyServer.getInstance().db;
  server.get(
    '/',
    {
      schema: {
        querystring: compatibilityQuerySchema,
        response: { 200: queenPlacementPaginatedResponseSchema },
      },
      preHandler: Guard.authorize([ROLES.read, ROLES.admin, ROLES.user]),
    },
    (req) => listPlacements(db, req.session.user.user_id, req.query),
  );
  server.patch(
    '/',
    {
      preHandler: Guard.authorize([ROLES.admin, ROLES.user]),
      schema: {
        response: { 200: z.number() },
        body: patchBodySchema,
      },
    },
    (req) =>
      updatePlacements(
        db,
        req.session.user.user_id,
        req.session.user.bee_id,
        req.body,
      ),
  );
  server.patch(
    '/batchDelete',
    {
      preHandler: Guard.authorize([ROLES.admin, ROLES.user]),
      schema: {
        response: { 200: z.number() },
        body: batchIdsBodySchema,
      },
    },
    (req) => deletePlacements(db, req.session.user.user_id, req.body.ids),
  );
  server.post(
    '/batchGet',
    {
      preHandler: Guard.authorize([ROLES.admin, ROLES.user]),
      schema: {
        response: { 200: queenPlacementsResponseSchema },
        body: batchIdsBodySchema,
      },
    },
    (req) => getPlacementsByIds(db, req.session.user.user_id, req.body.ids),
  );
  done();
}
