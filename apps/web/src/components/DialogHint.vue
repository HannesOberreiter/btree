<script setup lang="ts">
import BtnBase from '@/components/BtnBase.vue';
import BtnCloseDialog from '@/components/BtnCloseDialog.vue';

defineProps({
  hint: {
    type: String,
    required: true
  }
});
</script>

<template>
  <q-dialog data-cy="dialog-hint">
    <q-card>
      <q-card-section>
        <div class="row">
          <div class="text-h6">
            {{ $t('hint') }}
          </div>
          <q-space />
          <BtnCloseDialog />
        </div>
      </q-card-section>
      <q-card-section class="text-body1 break-line">
        {{ $t(hint) }}
      </q-card-section>
      <q-card-actions align="right">
        <BtnBase v-close-popup flat :label="$t('ok')" color="primary" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<style scoped>
.break-line {
  white-space: pre-line;
}
</style>
