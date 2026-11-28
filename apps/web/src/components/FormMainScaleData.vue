<script setup lang="ts">
import type { FormScaleData } from '@/types';
import useVuelidate from '@vuelidate/core';
import { flatten, map, merge } from 'lodash-es';
import { computed, ref, unref } from 'vue';
import { useApiFetch } from '@/composables/useApi';
import { useDateFormat } from '@/composables/useDate';
import { useNotification } from '@/composables/useNotification';
import { formCheckMultipleValues } from '@/helpers';
import FormButtons from '@/components/FormButtons.vue';
import FormDropdownEdit from '@/components/FormDropdownEdit.vue';
import FormDropdownOption from '@/components/FormDropdownOption.vue';
import FormInputDate from '@/components/FormInputDate.vue';
import FormInputNote from '@/components/FormInputNote.vue';
import FormInputNumeric from '@/components/FormInputNumeric.vue';

const props = defineProps({
  ids: {
    type: Array,
    default: null
  }
});
const emit = defineEmits<{
  (e: 'success', value: boolean): void;
}>();
const notification = useNotification();
const useDate = useDateFormat();
const values = ref({});
const api = useApiFetch();
const reset = ref(0);
const ids = ref(props.ids);
const isEdit = computed(() => {
  if (ids.value === null) {
    return false;
  }
  if (ids.value.length === 0) {
    return false;
  }
  return true;
});
if (isEdit.value) {
  getEdit(unref(ids.value));
}

const v = useVuelidate();

const editOptions = ref([]) as any;
const editOptionsCopy = ref([]) as any;

// A scale does not have every sensor, so a value without input stays empty.
const stateDefault = {
  datetime: useDate.isoFormat(useDate.getCurrent(), 'date-time-seconds'),
  weight: null,
  temp1: null,
  temp2: null,
  humidity: null,
  humidity2: null,
  rain: null,
  note: ''
};
const sensorFields = [
  'weight',
  'temp1',
  'temp2',
  'humidity',
  'humidity2',
  'rain'
] as const;

const state = ref<FormScaleData>({
  scale: undefined as any,
  ...stateDefault
});

// An empty sensor field removes the stored value. The exception is a field
// that is empty because the selected rows have different values: it keeps
// the value of each row.
const submitState = computed(() => {
  const result: Partial<FormScaleData> = { ...state.value };
  for (const field of sensorFields) {
    if (
      result[field] === null &&
      formCheckMultipleValues(values.value, field)
    ) {
      delete result[field];
    }
  }
  return result;
});

async function getEdit(id: unknown[]) {
  return await api.post('/v1/scale_data/batchGet', { ids: id }).then(
    (response: any) => {
      const editIds = map(response, (row: any) => [
        { value: row.id, label: `ID: ${row.id} / (${row.scale.name})` }
      ]);
      editOptions.value = flatten(editIds);
      editOptionsCopy.value = flatten(editIds);
      values.value = response;
    },
    error => {
      notification.open('negative', error);
    }
  );
}

function onReset() {
  if (!isEdit.value) {
    merge(state.value, stateDefault);
  }
  notification.open('positive', 'successReset');
  reset.value++;
}
</script>

<template>
  <q-form class="full-width" data-cy="form-scale-data" @submit.prevent.stop="">
    <FormDropdownEdit
      v-if="isEdit"
      v-model="editOptions"
      :options="editOptionsCopy"
      off-label="name"
    />
    <FormInputDate
      v-model="state.datetime"
      :readonly="false"
      :values="values"
      :reset="reset"
      label="datetime"
      date-format="YYYY-MM-DD HH:mm:ss"
    />

    <FormDropdownOption
      v-model="state.scale"
      table="scale"
      label="scale.name"
      :values="values"
      :reset="reset"
    />

    <FormInputNumeric
      v-model="state.weight"
      nullable
      label="weight"
      icon="fas fa-weight"
      numeric-valid="decimal"
      :max-valid="1000"
      :values="values"
      :reset="reset"
    />
    <FormInputNumeric
      v-model="state.temp1"
      nullable
      label="scale.temperature1"
      table-id="temp1"
      icon="fas fa-temperature-high"
      numeric-valid="decimal"
      :min-valid="-100"
      :values="values"
      :reset="reset"
    />
    <FormInputNumeric
      v-model="state.temp2"
      nullable
      label="scale.temperature2"
      table-id="temp2"
      icon="fas fa-temperature-low"
      numeric-valid="decimal"
      :min-valid="-100"
      :values="values"
      :reset="reset"
    />
    <FormInputNumeric
      v-model="state.humidity"
      nullable
      label="scale.humidity1"
      table-id="humidity"
      icon="fas fa-percent"
      numeric-valid="decimal"
      :values="values"
      :reset="reset"
    />
    <FormInputNumeric
      v-model="state.humidity2"
      nullable
      label="scale.humidity2"
      table-id="humidity2"
      icon="fas fa-percent"
      numeric-valid="decimal"
      :values="values"
      :reset="reset"
    />
    <FormInputNumeric
      v-model="state.rain"
      nullable
      label="rain"
      icon="fas fa-cloud-rain"
      numeric-valid="decimal"
      :values="values"
      :reset="reset"
    />
    <FormInputNote v-model="state.note" :values="values" :reset="reset" />
  </q-form>
  <FormButtons
    class="q-pt-md"
    :state="submitState"
    :is-edit="isEdit"
    :edit-ids="editOptions"
    :v="v"
    form="scale_data"
    @reset="onReset"
    @change="emit('success', true)"
  />
</template>
