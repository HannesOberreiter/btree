<script setup lang="ts">
import { useWakeLock } from '@vueuse/core';
import { useTrackEvent } from '../composables/useTrackEvent';
import BtnBase from './BtnBase.vue';
import TooltipBase from './TooltipBase.vue';

const { isSupported, isActive, request, release } = useWakeLock();
const { track } = useTrackEvent();

function onToggle() {
  if (isActive.value) {
    release();
  } else {
    track('App', 'wake-lock');
    request('screen');
  }
}
</script>

<template>
  <BtnBase
    v-if="isSupported"
    flat
    dense
    color="white"
    size="md"
    :icon="isActive ? 'fas fa-eye' : 'far fa-eye'"
    :aria-label="$t('keepAwake')"
    @click="onToggle"
  >
    <TooltipBase anchor="bottom middle" self="top middle">
      {{ $t('keepAwake') }} {{ $t(`${isActive}`) }}
    </TooltipBase>
  </BtnBase>
</template>
