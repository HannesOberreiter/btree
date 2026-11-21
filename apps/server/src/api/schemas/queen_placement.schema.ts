import { z } from 'zod';

import { numberSchema } from '../utils/zod.util.js';
import { actorResponseSchema, jsonDateSchema } from './common.schema.js';

const nullableNumber = z.number().nullable().optional();
const nullableDate = jsonDateSchema.nullable().optional();

export const queenPlacementResponseSchema = z.looseObject({
  id: z.number(),
  queen_id: z.number(),
  hive_id: z.number(),
  from_date: jsonDateSchema,
  /** Null for an open placement: the queen is still in the hive. */
  to_date: nullableDate,
  user_id: nullableNumber,
  bee_id: nullableNumber,
  edit_id: nullableNumber,
  created_at: nullableDate,
  updated_at: nullableDate,
  queen: z.looseObject({ id: z.number() }).nullable().optional(),
  hive: z.looseObject({ id: z.number() }).nullable().optional(),
  creator: actorResponseSchema.optional(),
  editor: actorResponseSchema.optional(),
});
export const queenPlacementPaginatedResponseSchema = z.object({
  results: z.array(queenPlacementResponseSchema),
  total: z.number(),
});
export const queenPlacementsResponseSchema = z.array(
  queenPlacementResponseSchema,
);

const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}/);

export const patchBodySchema = z.object({
  ids: z.array(numberSchema).min(1),
  data: z.object({
    from_date: daySchema.optional(),
    /** Null opens the placement. */
    to_date: daySchema.nullable().optional(),
  }),
});
export type PatchBody = z.infer<typeof patchBodySchema>;

export const batchIdsBodySchema = z.object({
  ids: z.array(numberSchema),
});
