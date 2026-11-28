<script setup lang="ts">
import type { PropType } from 'vue';
import type { Option } from '@/types';
import dayjs from 'dayjs';
import { useDialogPluginComponent } from 'quasar';
import { computed, defineAsyncComponent } from 'vue';
import BtnCloseDialog from '@/components/BtnCloseDialog.vue';
import GlobalLoading from '@/components/GlobalLoading.vue';

const props = defineProps({
  title: {
    type: String,
    required: true
  },
  form: {
    type: String,
    required: true
  },
  ids: {
    type: Array,
    default: null
  },
  maximized: {
    type: Boolean,
    default: false
  },
  selected: {
    type: Array,
    default: null
  },
  date: {
    type: String,
    default: dayjs().format('YYYY-MM-DD')
  },
  latlng: {
    type: Object,
    default: null
  },
  option: {
    type: String as PropType<Option>,
    default: ''
  },
  copy: {
    type: Boolean,
    default: false
  }
});
defineEmits([...useDialogPluginComponent.emits, 'success']);
const FormMainApiary = defineAsyncComponent(
  () => import('@/components/FormMainApiary.vue')
);
const FormMainTodo = defineAsyncComponent(
  () => import('@/components/FormMainTodo.vue')
);
const FormMainHive = defineAsyncComponent(
  () => import('@/components/FormMainHive.vue')
);
const FormMainMovement = defineAsyncComponent(
  () => import('@/components/FormMainMovement.vue')
);
const FormMainTask = defineAsyncComponent(
  () => import('@/components/FormMainTask.vue')
);
const FormMainQueen = defineAsyncComponent(
  () => import('@/components/FormMainQueen.vue')
);
const FormMainQueenHive = defineAsyncComponent(
  () => import('@/components/FormMainQueenHive.vue')
);
const FormMainScaleData = defineAsyncComponent(
  () => import('@/components/FormMainScaleData.vue')
);
const FormMainOption = defineAsyncComponent(
  () => import('@/components/FormMainOption.vue')
);
const FormMainCharge = defineAsyncComponent(
  () => import('@/components/FormMainCharge.vue')
);
const FormMainScale = defineAsyncComponent(
  () => import('@/components/FormMainScale.vue')
);
const FormMainQueenPlacement = defineAsyncComponent(
  () => import('@/components/FormMainQueenPlacement.vue')
);
const FormMainRearing = defineAsyncComponent(
  () => import('@/components/FormMainRearing.vue')
);
const FormMainRearingMethod = defineAsyncComponent(
  () => import('@/components/FormMainRearingMethod.vue')
);
const FormMainRearingDetail = defineAsyncComponent(
  () => import('@/components/FormMainRearingDetail.vue')
);

const { dialogRef, onDialogHide, onDialogOK } = useDialogPluginComponent();

const layouts = {
  todo: {
    comp: FormMainTodo,
    props: {
      date: props.date
    }
  },
  apiary: {
    comp: FormMainApiary,
    props: {
      latlng: props.latlng
    }
  },
  hive: {
    comp: FormMainHive,
    props: {
      copy: props.copy
    }
  },
  queen: {
    comp: FormMainQueen,
    props: {
      selected: props.selected,
      copy: props.copy
    }
  },
  queen_hive: {
    comp: FormMainQueenHive,
    props: {
      selected: props.selected
    }
  },
  virgin: {
    comp: FormMainQueen,
    props: {
      selected: props.selected,
      copy: props.copy
    }
  },
  movedate: {
    comp: FormMainMovement,
    props: {
      selected: props.selected
    }
  },
  queen_placement: {
    comp: FormMainQueenPlacement,
    props: {}
  },
  feed: {
    comp: FormMainTask,
    props: {
      task: props.form
    }
  },
  harvest: {
    comp: FormMainTask,
    props: {
      task: props.form
    }
  },
  checkup: {
    comp: FormMainTask,
    props: {
      task: props.form
    }
  },
  treatment: {
    comp: FormMainTask,
    props: {
      task: props.form
    }
  },
  charge: {
    comp: FormMainCharge,
    props: {
      copy: props.copy
    }
  },
  scale_data: {
    comp: FormMainScaleData,
    props: {}
  },
  scale: {
    comp: FormMainScale,
    props: {}
  },
  option: {
    comp: FormMainOption,
    props: {
      option: props.option
    }
  },
  rearing: {
    comp: FormMainRearing,
    props: {}
  },
  rearing_type: {
    comp: FormMainRearingMethod,
    props: {}
  },
  rearing_detail: {
    comp: FormMainRearingDetail,
    props: {}
  }
} as any;

const layout = computed(() => layouts[props.form]);
</script>

<template>
  <q-dialog
    ref="dialogRef"
    :maximized="maximized || $q.platform.is.mobile"
    @hide="onDialogHide"
  >
    <q-card style="width: 700px">
      <q-card-section>
        <div class="row">
          <div class="text-h6">
            {{ $t(title) }}
          </div>
          <q-space />
          <BtnCloseDialog />
        </div>
        <div class="row full-width">
          <suspense>
            <template #fallback>
              <GlobalLoading />
            </template>
            <component
              :is="layout.comp"
              :ids="ids"
              v-bind="layout.props"
              @success="(value: any) => onDialogOK(value)"
            />
          </suspense>
        </div>
      </q-card-section>
    </q-card>
  </q-dialog>
</template>
