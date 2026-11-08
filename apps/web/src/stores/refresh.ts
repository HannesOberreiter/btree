import { useStorage } from '@vueuse/core';
import dayjs from 'dayjs';
import { defineStore } from 'pinia';
import refreshService from '../services/refresh.service';

export const useRefreshStore = defineStore('refresh', {
  state: () => ({
    last: useStorage('refresh', dayjs('1989-05-01'))
  }),
  actions: {
    // Not a getter: getters are cached and dayjs() is not reactive
    hoursSinceLast() {
      return dayjs().diff(dayjs(this.last), 'hour');
    },
    isOutdated() {
      const hours = this.hoursSinceLast();
      return hours > 1 || Number.isNaN(hours);
    },
    indicatorColor() {
      const hours = this.hoursSinceLast();
      if (hours > 24 || Number.isNaN(hours)) {
        return 'text-red';
      }
      if (hours > 5) {
        return 'text-orange';
      }
      return 'text-green';
    },
    async refresh(user = true) {
      if (this.isOutdated() || user) {
        this.last = dayjs();
        return await refreshService.refresh(user);
      }
    }
  }
});
