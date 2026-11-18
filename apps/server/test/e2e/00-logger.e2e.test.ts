import { describe, expect, it } from 'vitest';

import { redactApiKeyFromUrl } from '../../src/services/logger.service.js';

describe('logger', () => {
  it('replaces iCal API keys with stable fingerprints', () => {
    const apiKey = 'calendar-secret-key';
    const url = `/api/v1/external/ical/checkup/${apiKey}?format=ics`;

    const redacted = redactApiKeyFromUrl(url);

    expect(redacted).toMatch(
      /^\/api\/v1\/external\/ical\/checkup\/\[key:[a-f0-9]{12}\]\?format=ics$/,
    );
    expect(redacted).not.toContain(apiKey);
    expect(redactApiKeyFromUrl(url)).toBe(redacted);
  });

  it('replaces scale and TTN API keys with stable fingerprints', () => {
    const apiKey = 'scale-secret-key';
    const scaleUrl = `/api/v1/external/scale/my-scale/${apiKey}?action=CREATE`;
    const ttnUrl = `/api/v1/external/ttn/${apiKey}`;

    expect(redactApiKeyFromUrl(scaleUrl)).toMatch(
      /^\/api\/v1\/external\/scale\/my-scale\/\[key:[a-f0-9]{12}\]\?action=CREATE$/,
    );
    expect(redactApiKeyFromUrl(ttnUrl)).toMatch(
      /^\/api\/v1\/external\/ttn\/\[key:[a-f0-9]{12}\]$/,
    );
  });

  it('leaves unrelated URLs unchanged', () => {
    const url = '/api/v1/status';

    expect(redactApiKeyFromUrl(url)).toBe(url);
  });
});
