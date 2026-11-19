import { z } from 'zod';

import { devEuiValueSchema } from './scale.schema.js';

export const externalCalendarParamsSchema = z.object({
  source: z.string().min(1),
  api: z.string().min(1),
});

export const externalScaleParamsSchema = z.object({
  ident: z.string().min(1),
  api: z.string().min(1),
});

export const mollieWebhookBodySchema = z.looseObject({
  id: z.string().min(1),
});

/**
 * A value of a scale reading. An empty value and `null` count as not sent,
 * so a device with a fixed URL can report a failed sensor.
 */
const readingValueSchema = z
  .union([z.number(), z.literal(''), z.literal('null'), z.null()])
  .transform((value) => (typeof value === 'number' ? value : undefined))
  .optional();

export const externalScaleQuerySchema = z.object({
  action: z.enum(['CREATE', 'CREATE_DEMO']),
  datetime: z.string().datetime().optional(),
  weight: readingValueSchema,
  temp1: readingValueSchema,
  temp2: readingValueSchema,
  hum: readingValueSchema,
  hum2: readingValueSchema,
  rain: readingValueSchema,
  note: z.string().max(300).optional(),
});

export const externalTtnParamsSchema = z.object({
  api: z.string().min(1),
});

/**
 * TTN v3 webhook uplink message. Only the parts that b.tree reads are
 * validated; TTN sends many more fields.
 */
export const externalTtnBodySchema = z.looseObject({
  end_device_ids: z.looseObject({
    device_id: z.string().optional(),
    dev_eui: devEuiValueSchema,
  }),
  uplink_message: z.looseObject({
    received_at: z.iso.datetime({ offset: true }).optional(),
    decoded_payload: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const externalTtnResponseSchema = z.object({
  stored: z.boolean(),
  reason: z.enum(['no_values', 'rate_limit']).optional(),
  id: z.number().optional(),
});

export type ExternalCalendarParams = z.infer<
  typeof externalCalendarParamsSchema
>;
export type ExternalScaleParams = z.infer<typeof externalScaleParamsSchema>;
export type MollieWebhookBody = z.infer<typeof mollieWebhookBodySchema>;
export type ExternalScaleQuery = z.infer<typeof externalScaleQuerySchema>;
export type ExternalTtnParams = z.infer<typeof externalTtnParamsSchema>;
export type ExternalTtnBody = z.infer<typeof externalTtnBodySchema>;
export type ExternalTtnResponse = z.infer<typeof externalTtnResponseSchema>;
