<script setup lang="ts">
import { computed, toRef } from 'vue';
import { useDateFormat } from '@/composables/useDate';
import { useQueenPlacementsQuery } from '@/composables/useQuery';
import GlobalLoading from '@/components/GlobalLoading.vue';

const props = defineProps({
  id: {
    required: true
  }
});
const useDate = useDateFormat();
const id = toRef(props, 'id');
const filters = computed(() =>
  JSON.stringify([{ 'queen_placements.hive_id': id.value }])
);

const { isLoading, data } = useQueenPlacementsQuery({
  limit: 5,
  order: ['from_date'],
  direction: ['desc'],
  filters
});

// Deleted queens are not part of the hive history.
const results = computed(() =>
  (data.value?.results ?? []).filter((row: any) => !row.queen.deleted)
);

/** A dead queen whose stay ended on the day she became inactive. */
function isDead(row: any) {
  return (
    !row.queen.modus && row.to_date && row.to_date === row.queen.modus_date
  );
}
</script>

<template>
  <GlobalLoading v-if="isLoading" />
  <div v-else-if="data?.results" data-cy="hive-info-queens">
    <div>
      <b>{{ $t('queen', 2) }}</b>
      <span v-if="data.total > 5"> ({{ $t('max') }} 5)</span>
    </div>
    <ul>
      <li v-for="item in results" :key="item.id">
        <b>{{ item.queen.name }}</b
        >&nbsp;
        <template v-if="!item.to_date">
          ({{ $t('since') }} {{ useDate.displayFormat(item.from_date) }})
        </template>
        <template v-else>
          ({{ useDate.displayFormat(item.from_date) }} -
          {{ useDate.displayFormat(item.to_date)
          }}<template v-if="isDead(item)">, RIP</template>)
        </template>
      </li>
    </ul>
  </div>
</template>
