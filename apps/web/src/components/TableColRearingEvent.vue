<script setup lang="ts">
import { useQuasar } from 'quasar';
import BtnBase from '@/components/BtnBase.vue';
import DialogRearingEvent from '@/components/DialogRearingEvent.vue';

defineProps({
  id: {
    type: Number,
    required: true
  }
});
const $q = useQuasar();
function dialogEvent(id: number) {
  $q.dialog({
    component: DialogRearingEvent,
    componentProps: {
      id
    }
  });
}
</script>

<template>
  <q-td>
    <BtnBase icon="far fa-calendar-xmark" @click="dialogEvent(id)" />
  </q-td>
</template>
