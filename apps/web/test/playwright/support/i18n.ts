import en from '../../../src/i18n/en/index.json' with { type: 'json' };

type Message = keyof typeof en;

// English text of a message, like $t(key, count) for count 1 or 2.
export function t(key: Message, count: 1 | 2 = 1): string {
  const value = en[key];
  if (typeof value !== 'string') {
    throw new Error(`No message: ${key}`);
  }
  const forms = value.split('|').map(form => form.trim());
  return forms[Math.min(count, forms.length) - 1] ?? value;
}

// FullCalendar names a view tab "<button text> view".
export function calendarViewTab(buttonText: string): string {
  return `${buttonText} view`;
}
