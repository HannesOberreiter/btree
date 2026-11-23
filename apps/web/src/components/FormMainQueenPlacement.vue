<script setup lang="ts">
import useVuelidate from '@vuelidate/core';
import { flatten, map } from 'lodash-es';
import { computed, ref, unref } from 'vue';
import { useApiFetch } from '../composables/useApi';
import { useNotification } from '../composables/useNotification';
import FormButtons from './FormButtons.vue';
import FormDropdownEdit from './FormDropdownEdit.vue';
import FormInputDate from './FormInputDate.vue';

// Edit only: the server creates placements with moves and status changes.
const props = defineProps({
  ids: {
    type: Array,
    default: null
  }
});
const emit = defineEmits(['success']);
const notification = useNotification();
const api = useApiFetch();
const values = ref<any[]>([]);
const reset = ref(0);
const editOptions = ref([]) as any;
const editOptionsCopy = ref([]) as any;

const state = ref({
  from_date: null as string | null,
  to_date: null as string | null
});
const v = useVuelidate({}, state, { $autoDirty: true });

// An edit cannot end an open placement, so the end is only shown when all
// selected placements are closed. v-show keeps the input mounted, because
// it reads the loaded values only on a change.
const allClosed = computed(
  () => values.value.length > 0 && values.value.every((row: any) => row.to_date)
);

if (props.ids && props.ids.length > 0) {
  getEdit(unref(props.ids));
}

async function getEdit(id: unknown[]) {
  return await api.post('/v1/queen_placement/batchGet', { ids: id }).then(
    (response: any) => {
      const editIds = map(response, (row: any) => [
        {
          value: row.id,
          label: `ID: ${row.id} / (${row.queen.name}, ${row.hive.name})`
        }
      ]);
      editOptions.value = flatten(editIds);
      editOptionsCopy.value = [...unref(editOptions.value)];
      values.value = response;
    },
    error => {
      notification.open('negative', error);
    }
  );
}

function onReset() {
  reset.value++;
  notification.open('positive', 'successReset');
}
</script>

<template>
  <q-form
    class="full-width"
    data-cy="form-queen-placement"
    @submit.prevent.stop=""
  >
    <FormDropdownEdit v-model="editOptions" :options="editOptionsCopy" />
    <FormInputDate
      v-model="state.from_date"
      label="from"
      table-id="from_date"
      :values="values"
      :reset="reset"
      data-cy="input-placement-from"
    />
    <FormInputDate
      v-show="allClosed"
      v-model="state.to_date"
      label="to"
      table-id="to_date"
      :values="values"
      :reset="reset"
      data-cy="input-placement-to"
    />
  </q-form>

  <FormButtons
    class="q-pt-md"
    :state="state"
    :is-edit="true"
    :edit-ids="editOptions"
    :v="v"
    form="queen_placement"
    @reset="onReset"
    @change="emit('success', true)"
  />
</template>
