import { z } from 'zod';

import { numberSchema } from '../utils/zod.util.js';

const devEuiPattern = /^[0-9A-F]{16}$/;
const devEuiMessage = 'DevEUI must be 16 hex characters';

function normalizeDevEui(value: string) {
  return value.replace(/[\s:-]/g, '').toUpperCase();
}

/**
 * LoRaWAN DevEUI: 16 hex characters. Accepts separators and lowercase, and
 * gives uppercase without separators.
 */
export const devEuiValueSchema = z
  .string()
  .transform(normalizeDevEui)
  .pipe(z.string().regex(devEuiPattern, devEuiMessage));

/** Optional DevEUI of a scale. An empty value removes the DevEUI. */
export const devEuiSchema = z
  .string()
  .transform(normalizeDevEui)
  .pipe(
    z.string().refine((value) => value === '' || devEuiPattern.test(value), {
      message: devEuiMessage,
    }),
  )
  .transform((value) => value || null)
  .nullable();

export const getParamsSchema = z.object({ id: numberSchema.optional() });

export const scaleDataSchema = z.object({
  name: z.string().min(1).max(45).trim().optional(),
  hive_id: numberSchema.optional(),
  dev_eui: devEuiSchema.optional(),
});

export const patchBodySchema = z.object({
  ids: z.array(numberSchema),
  data: scaleDataSchema,
});

export const postBodySchema = z.object({
  name: z.string().min(1).max(45).trim(),
  hive_id: numberSchema,
  dev_eui: devEuiSchema.optional(),
});

export const deleteParamsSchema = z.object({ id: numberSchema });

export const scaleResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  hive_id: z.number().nullable(),
  user_id: z.number().nullable(),
  dev_eui: z.string().nullable(),
  hive: z.looseObject({}).nullable(),
});

export const scaleCreateResponseSchema = scaleResponseSchema.omit({
  hive: true,
});
export const scaleListResponseSchema = z.array(scaleResponseSchema);

export type PatchBody = z.infer<typeof patchBodySchema>;
export type PostBody = z.infer<typeof postBodySchema>;
