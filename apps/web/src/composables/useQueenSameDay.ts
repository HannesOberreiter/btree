import { escape } from 'lodash-es';
import { useQuasar } from 'quasar';
import { useI18n } from 'vue-i18n';
import { useApiFetch } from '@/composables/useApi';

interface SameDayInput {
  /** Target hives of the move. */
  hiveIds: number[];
  /** Day of the move, `YYYY-MM-DD`. */
  day: string;
  /** Queens that move. Their own placements do not count. */
  queenIds: number[];
}

/**
 * Asks before a move into a hive where another queen moved in on the same
 * day. The server then replaces that queen (she becomes inactive), but the
 * move is more likely a user error.
 */
export function useQueenSameDay() {
  const $q = useQuasar();
  const { t } = useI18n();
  const api = useApiFetch();

  async function sameDayQueens({ hiveIds, day, queenIds }: SameDayInput) {
    if (hiveIds.length === 0 || !day) {
      return [];
    }
    const response = await api.get(
      '/v1/queen_placement',
      {
        filters: JSON.stringify([{ 'queen_placements.hive_id': hiveIds }]),
        order: ['from_date'],
        direction: ['desc'],
        limit: 1000
      },
      false,
      false
    );
    return (response?.results ?? []).filter(
      (row: any) =>
        !row.to_date &&
        row.from_date === day &&
        !row.queen.deleted &&
        !queenIds.includes(row.queen_id)
    );
  }

  /** Resolves true if the save can go on. */
  async function confirmSameDay(input: SameDayInput) {
    let rows: any[];
    try {
      rows = await sameDayQueens(input);
    } catch {
      // The server still checks the move, so a failed check does not block.
      return true;
    }
    if (rows.length === 0) {
      return true;
    }
    // Names are user input, escape them for the HTML message.
    const message = rows
      .map(row =>
        t('queenSameDay', {
          queen: escape(row.queen.name),
          hive: escape(row.hive.name)
        })
      )
      .join('<br/>');
    return new Promise<boolean>(resolve => {
      $q.dialog({
        title: t('warning'),
        message,
        html: true,
        ok: {
          label: t('yes'),
          class: 'btn-confirm',
          'data-cy': 'btn-same-day-confirm'
        },
        cancel: {
          label: t('cancel'),
          flat: true,
          'data-cy': 'btn-same-day-cancel'
        },
        persistent: true
      })
        .onOk(() => resolve(true))
        .onCancel(() => resolve(false));
    });
  }

  return { confirmSameDay };
}
