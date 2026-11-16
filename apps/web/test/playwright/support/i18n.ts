import en from '../../../src/i18n/en/index.json' with { type: 'json' };

// Message keys, with a dot for nested keys, like "sugarHelper.threeToTwo".
type Key<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${Key<T[K]>}`;
}[keyof T & string];

type Message = Key<typeof en>;

// English text of a message, like $t(key, count) for count 1 or 2.
export function t(key: Message, count: 1 | 2 = 1): string {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      en
    );
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
