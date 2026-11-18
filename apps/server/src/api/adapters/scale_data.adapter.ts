import httpErrors from 'http-errors';
import type { Kysely } from 'kysely';

import { MailService } from '../../services/mail.service.js';
import type { MailLang } from '../../services/mail.service.js';
import { MailLangs } from '../../services/mail.service.js';
import type { DB } from '../../types/db.types.js';
import type {
  ExternalScaleTarget,
  WeightWarning,
} from '../modules/scale_data.module.js';
import {
  ingestScaleReading,
  readingFromTtnUplink,
} from '../modules/scale_data.module.js';
import type {
  ExternalScaleQuery,
  ExternalTtnBody,
  ExternalTtnParams,
  ExternalTtnResponse,
} from '../schemas/external.schema.js';

function mailLanguage(value: string | null): MailLang {
  return MailLangs.includes(value as MailLang) ? (value as MailLang) : 'en';
}

async function sendWeightWarning(warning: WeightWarning) {
  await Promise.allSettled(
    warning.recipients
      .filter((recipient) => recipient.email)
      .map((recipient) =>
        MailService.getInstance().sendMail({
          to: recipient.email!,
          lang: mailLanguage(recipient.lang),
          subject: 'weight_warning',
          key: `${warning.scaleName}: ${warning.difference} (${warning.previousWeight} - ${warning.currentWeight})`,
          name: recipient.username ?? undefined,
        }),
      ),
  );
}

export async function ingestExternalScaleReading(
  db: Kysely<DB>,
  target: ExternalScaleTarget,
  input: ExternalScaleQuery,
) {
  const { result, warning } = await ingestScaleReading(db, target, input);
  if (warning) await sendWeightWarning(warning);
  return result;
}

/**
 * Stores the reading of a TTN webhook uplink. TTN sends uplinks without a
 * fixed interval, so a reading within the 1-hour limit or without known
 * values is dropped with a success response instead of an error.
 */
export async function ingestTtnUplink(
  db: Kysely<DB>,
  params: ExternalTtnParams,
  body: ExternalTtnBody,
): Promise<ExternalTtnResponse> {
  const input = readingFromTtnUplink(body);
  if (!input) return { stored: false, reason: 'no_values' };
  try {
    const result = await ingestExternalScaleReading(
      db,
      { api: params.api, devEui: body.end_device_ids.dev_eui },
      input,
    );
    return { stored: true, id: Number(result.id) };
  } catch (error) {
    if (httpErrors.isHttpError(error) && error.statusCode === 429) {
      return { stored: false, reason: 'rate_limit' };
    }
    throw error;
  }
}
