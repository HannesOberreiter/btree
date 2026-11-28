import { useStorage } from '@vueuse/core';
import cloneDeep from 'lodash-es/cloneDeep';
import defaultsDeep from 'lodash-es/defaultsDeep';
import { defineStore } from 'pinia';
import { useApiFetch } from '@/composables/useApi';
import { BREEDING_RATING_MAX, BREEDING_RATINGS } from '@/helpers/breeding';
import refreshService from '@/services/refresh.service';
import { useAuthUserStore } from '@/stores/auth';

interface Rating {
  brood: boolean;
  calm_comb: boolean;
  comb: boolean;
  pollen: boolean;
  swarm: boolean;
  temper: boolean;
  colony_strength: boolean;
  spring_development: boolean;
  max: number;
}

interface Checkbox {
  queen: boolean;
  queencells: boolean;
  capped_brood: boolean;
  eggs: boolean;
}

interface Frame {
  broodframes: boolean;
  honeyframes: boolean;
  foundation: boolean;
  emptyframes: boolean;
}

interface Checkup {
  ratings: Rating;
  rating?: boolean;
  queen?: boolean;
  checkboxes: Checkbox;
  strength: boolean;
  weight: boolean;
  temperature: boolean;
  varroa: boolean;
  frames?: boolean;
  frame: Frame;
}

interface Harvest {
  water: boolean;
  frames: boolean;
}

interface Treatment {
  wait: boolean;
  vet: boolean;
  temperature: boolean;
}

interface Charge {
  price: boolean;
  bestbefore: boolean;
}

interface General {
  url: boolean;
}

interface Fieldsetting {
  checkup: Checkup;
  harvest: Harvest;
  treatment: Treatment;
  charge: Charge;
  general: General;
}

const resetSettings = {
  checkup: {
    ratings: {
      brood: false,
      calm_comb: false,
      comb: false,
      pollen: false,
      swarm: false,
      temper: false,
      colony_strength: false,
      spring_development: false,
      max: 5
    },
    checkboxes: {
      queen: false,
      queencells: false,
      capped_brood: false,
      eggs: false
    },
    frame: {
      broodframes: false,
      honeyframes: false,
      foundation: false,
      emptyframes: false
    },
    strength: false,
    weight: false,
    temperature: false,
    varroa: false
  },
  harvest: {
    water: false,
    frames: false
  },
  treatment: {
    wait: false,
    vet: false,
    temperature: false
  },
  charge: {
    price: false,
    bestbefore: false
  },
  general: {
    url: false
  }
};

export const useFieldsettingStore = defineStore('fieldsetting', {
  state: () => ({
    settings: useStorage<Fieldsetting>('fieldsetting', cloneDeep(resetSettings))
  }),
  getters: {
    get: state => state.settings,
    // True when the breeding mode of the company is on.
    breedingLocked: () => Boolean(useAuthUserStore().company.breeding_system),
    // The settings that the forms use: the personal settings with the
    // overrides of the breeding mode. The personal settings stay unchanged.
    active(state): Fieldsetting {
      if (!this.breedingLocked) {
        return state.settings;
      }
      const settings = cloneDeep(state.settings);
      for (const rating of BREEDING_RATINGS) {
        settings.checkup.ratings[rating] = true;
      }
      settings.checkup.ratings.max = BREEDING_RATING_MAX;
      return settings;
    },
    someRatingTrue(): boolean {
      return Object.values(this.active.checkup.ratings).includes(true);
    },
    someCheckboxTrue: state =>
      Object.values(state.settings.checkup.checkboxes).includes(true),
    someFrameTrue: state =>
      Object.values(state.settings.checkup.frame).includes(true)
  },
  actions: {
    patch(_payload: any) {
      // console.log(payload);
    },
    reset() {
      // Copy, so later changes do not change the defaults.
      const settings = cloneDeep(resetSettings);
      this.settings = settings;
      return settings;
    },
    refresh(data: any) {
      if (data) {
        // Migrate old field settings to new separate ratings
        if (data.settings.checkup?.rating) {
          data.settings.checkup.ratings = {
            brood: true,
            calm_comb: true,
            comb: true,
            pollen: true,
            swarm: true,
            temper: true
          };
          delete data.settings.checkup.rating;
        }
        // Migrate old field settings to new separate queens checkboxes
        if (data.settings.checkup?.queen) {
          data.settings.checkup.checkboxes = {
            queen: true,
            queencells: true,
            capped_brood: true,
            eggs: true
          };
          delete data.settings.checkup.queen;
        }
        // Migrate old field settings to new separate frames
        if (data.settings.checkup?.frames) {
          data.settings.checkup.frame = {
            broodframes: true,
            honeyframes: true,
            foundation: true,
            emptyframes: true
          };
          delete data.settings.checkup.frames;
        }
        if ('rating' in data.settings.checkup) {
          delete data.settings.checkup.rating;
        }
        if ('queen' in data.settings.checkup) {
          delete data.settings.checkup.queen;
        }
        if ('frames' in data.settings.checkup) {
          delete data.settings.checkup.frames;
        }
        this.settings = defaultsDeep(data.settings, resetSettings);
      } else {
        this.settings = defaultsDeep(this.settings, resetSettings);
      }
    },
    async reload() {
      const api = useApiFetch();
      return await refreshService.fieldsetting(api);
    }
  }
});

export type UseFieldsettingStore = ReturnType<typeof useFieldsettingStore>;
export type { Fieldsetting };
