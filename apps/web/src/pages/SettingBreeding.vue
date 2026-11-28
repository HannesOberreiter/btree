<script setup lang="ts">
import type { CompanyPatchResponse, OptionListItem } from '@/api/types';
import type { BreedingSection, BreedingSystem } from '@/helpers/breeding';
import { storeToRefs } from 'pinia';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useApiFetch } from '@/composables/useApi';
import { useNotification } from '@/composables/useNotification';
import { useOptionsQuery } from '@/composables/useQuery';
import {
  BREEDING_RATING_MAX,
  BREEDING_RATINGS,
  BREEDING_SECTIONS
} from '@/helpers/breeding';
import { useAuthUserStore } from '@/stores/auth';
import { useRefreshStore } from '@/stores/refresh';

const api = useApiFetch();
const notification = useNotification();
const { t } = useI18n();
const storeUser = useAuthUserStore();
const storeRefresh = useRefreshStore();
const { company } = storeToRefs(storeUser);

const isSubmitting = ref(false);
const isLoading = ref(true);

// Other admins can change the mode. Load the current value.
onMounted(() =>
  storeRefresh.refresh().finally(() => (isLoading.value = false))
);

const options = computed(() => [
  { label: t('breeding.off'), value: null },
  { label: 'BeeBreed', value: 'beebreed' }
]);

const ratingNames = computed(() =>
  BREEDING_RATINGS.map(rating => t(`rating.${rating}`)).join(', ')
);

async function onChange(value: BreedingSystem | null) {
  isSubmitting.value = true;
  try {
    await (api.patch('/v1/company', {
      breeding_system: value
    }) as Promise<CompanyPatchResponse>);
    await storeRefresh.refresh();
    notification.open('positive', '');
  } catch (error) {
    notification.open('negative', error);
  } finally {
    isSubmitting.value = false;
  }
}

// Harvest sections: each harvest type has one section or none. A type that
// is added to a section leaves its old section.
const {
  data: harvestTypes,
  isLoading: isLoadingTypes,
  refetch: refetchTypes
} = useOptionsQuery('harvest_types', { modus: null });

const types = computed(
  () => (harvestTypes.value?.results ?? []) as OptionListItem[]
);

const typeOptions = computed(() =>
  types.value.map(type => ({
    label: type.unit ? `${type.name} (${type.unit})` : `${type.name}`,
    value: type.id
  }))
);

function sectionIds(section: BreedingSection) {
  return types.value
    .filter(type => type.breeding_section === section)
    .map(type => type.id);
}

async function patchSection(ids: number[], section: BreedingSection | null) {
  if (ids.length === 0) {
    return;
  }
  await api.patch('/v1/option/harvest_types', {
    ids,
    data: { breeding_section: section }
  });
}

async function onSectionChange(section: BreedingSection, value: number[]) {
  const before = sectionIds(section);
  const added = value.filter(id => !before.includes(id));
  const removed = before.filter(id => !value.includes(id));
  isSubmitting.value = true;
  try {
    await patchSection(added, section);
    await patchSection(removed, null);
    notification.open('positive', '');
  } catch (error) {
    notification.open('negative', error);
  } finally {
    await refetchTypes();
    isSubmitting.value = false;
  }
}
</script>

<template>
  <q-card data-cy="page-setting-breeding" flat>
    <div class="row justify-center q-pa-sm">
      <div class="col-12 col-sm-10 col-md-8">
        <div class="text-body2 q-pb-sm text-center">
          {{ $t('breeding.name') }}
        </div>
        <q-card-section class="q-pa-xs">
          <p>{{ $t('breeding.description') }}</p>
          <q-banner
            v-if="!storeUser.isAdmin"
            dense
            class="bg-grey-3 q-mb-sm"
            data-cy="setting-breeding-admin-only"
          >
            {{ $t('breeding.adminOnly') }}
          </q-banner>
          <q-option-group
            :model-value="company.breeding_system ?? null"
            :options="options"
            type="radio"
            data-cy="setting-breeding-system"
            :disable="!storeUser.isAdmin || isSubmitting || isLoading"
            @update:model-value="onChange"
          />
        </q-card-section>
        <q-card-section
          v-if="company.breeding_system === 'beebreed'"
          class="q-pa-xs"
          data-cy="setting-breeding-beebreed"
        >
          <div class="text-body2 q-pb-sm">BeeBreed</div>
          <p class="q-mb-xs">{{ $t('breeding.beebreed.intro') }}</p>
          <ul class="q-mt-none">
            <li>
              {{ $t('breeding.beebreed.ratings', { ratings: ratingNames }) }}
            </li>
            <li>
              {{ $t('breeding.beebreed.scale', { max: BREEDING_RATING_MAX }) }}
            </li>
            <li>{{ $t('breeding.beebreed.queenCode') }}</li>
            <li>{{ $t('breeding.beebreed.harvest') }}</li>
          </ul>
        </q-card-section>
        <q-card-section
          v-if="company.breeding_system === 'beebreed'"
          class="q-pa-xs"
          data-cy="setting-breeding-sections"
        >
          <div class="text-body2 q-pb-sm">
            {{ $t('breeding.sections') }}
          </div>
          <!-- QSelect puts data-cy on its inner input, so a wrapper has it. -->
          <div
            v-for="section in BREEDING_SECTIONS"
            :key="section"
            :data-cy="`setting-breeding-section-${section}`"
          >
            <q-select
              :model-value="sectionIds(section)"
              :options="typeOptions"
              :label="$t(`breeding.section.${section}`)"
              :disable="!storeUser.isAdmin || isSubmitting || isLoadingTypes"
              class="q-mb-sm"
              emit-value
              map-options
              multiple
              use-chips
              outlined
              dense
              @update:model-value="value => onSectionChange(section, value)"
            />
          </div>
        </q-card-section>
      </div>
    </div>
  </q-card>
</template>
