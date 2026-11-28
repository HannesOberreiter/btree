import type { ComposerTranslation } from 'vue-i18n';
import { Notify } from 'quasar';
import { reactive } from 'vue';
import { useI18n } from 'vue-i18n';
import { sleep } from '@/helpers';

type Type = 'positive' | 'negative' | 'warning' | 'info' | 'ongoing';

type ApiError = {
  statusCode: number;
  code?: string;
  message?: string;
};

function isApiError(value: unknown): value is ApiError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'statusCode' in value &&
    typeof value.statusCode === 'number'
  );
}

const state = reactive({
  show: false,
  error: false
});

let notificationId = 0;

/** Server error codes of queen placements and their translation keys. */
const QUEEN_PLACEMENT_ERRORS: Record<string, string> = {
  QUEEN_PLACEMENT_OVERLAP: 'error.queenPlacementOverlap',
  QUEEN_PLACEMENT_RANGE: 'error.queenPlacementRange',
  QUEEN_PLACEMENT_HIVE_TWICE: 'error.queenPlacementHiveTwice',
  QUEEN_PLACEMENT_STATE: 'error.queenPlacementState'
};

function useNotification(t?: ComposerTranslation) {
  const $t = t || useI18n().t;

  function useHandleSuccess(value: any) {
    const displayMessage = value ? $t(value) : '';
    return displayMessage;
  }

  function useHandleError(error: unknown) {
    let displayMessage = '';
    if (typeof error === 'string') {
      return $t(error);
    }
    if (!isApiError(error)) {
      return $t('error.unknown');
    }

    displayMessage = checkStatus(
      error.statusCode,
      error.message ?? '',
      error.code
    );
    if (displayMessage === '') {
      displayMessage = $t('error.unknown');
    }

    return displayMessage;
  }

  function checkStatus(
    statusCode: number,
    errorField = '',
    errorCode?: string
  ) {
    let displayMessage = '';
    if (statusCode === 400) {
      if (errorCode && errorCode in QUEEN_PLACEMENT_ERRORS) {
        displayMessage = $t(QUEEN_PLACEMENT_ERRORS[errorCode]!);
      } else {
        displayMessage = `${$t('error.unknown')} ${errorField}`;
      }
    } else if (statusCode === 401) {
      if (errorField === 'mail') {
        displayMessage = $t('error.mailError');
      } else {
        displayMessage = $t('error.access');
      }
    } else if (statusCode === 402) {
      displayMessage = $t('error.premium');
    } else if (statusCode === 403) {
      if (errorField === 'lastMovement') {
        displayMessage = $t('error.lastMovement');
      } else if (errorCode === 'LAST_COMPANY') {
        displayMessage = $t('company.lastCompany');
      } else if (errorCode === 'COMPANY_HAS_OTHER_USERS') {
        displayMessage = $t('error.companyHasOtherUsers');
      } else if (errorCode === 'COMPANY_HAS_NO_OTHER_USERS') {
        displayMessage = $t('error.companyHasNoOtherUsers');
      } else {
        displayMessage = $t('error.forbidden');
      }
    } else if (statusCode === 404) {
      displayMessage = $t('error.notFound');
    } else if (statusCode === 409) {
      if (errorCode === 'FOREIGN_KEY_VIOLATION') {
        displayMessage = $t('error.unknown');
      } else if (errorCode === 'CONCURRENT_UPDATE') {
        displayMessage = $t('error.concurrentUpdate');
      } else if (errorField && errorField !== 'duplicate') {
        displayMessage = `${$t('error.duplicate')} (${$t(errorField)})`;
      } else {
        displayMessage = $t('error.duplicate');
      }
    } else if (statusCode === 423) {
      displayMessage = $t('error.locked');
    } else if (statusCode === 429) {
      displayMessage = $t('error.tooManyRequest');
    }

    return displayMessage;
  }

  function open(type: Type, message: any, isTranslated = false) {
    state.show = true;
    state.error = type === 'negative';
    let m = '';

    if (isTranslated) {
      // We already received a translated message, not need to translate it.
      m = message;
    } else {
      if (!message) {
        if (type === 'negative') {
          m = $t('error.unknown');
        } else if (type === 'positive') {
          m = $t('success');
        }
      } else {
        if (type === 'negative' && message) {
          m = useHandleError(message);
        } else if (type === 'positive' && message) {
          m = useHandleSuccess(message);
        } else {
          m = $t(message);
        }
      }
    }

    const id = String(++notificationId);
    const dismiss = Notify.create({
      message: m,
      type,
      position: 'top',
      attrs: {
        'data-cy': 'notification',
        'data-notification-id': id,
        'data-notification-type': type
      },
      actions: [
        {
          label: 'X',
          color: 'white',
          handler: () => {
            state.show = false;
          }
        }
      ]
    });
    void sleep(100).then(() => {
      // Only the element of this notification must close it.
      document
        .querySelector(`[data-notification-id="${id}"]`)
        ?.addEventListener(
          'click',
          () => {
            dismiss();
          },
          true
        );
    });
    return dismiss;
  }
  function close() {
    state.show = false;
    state.error = false;
  }
  return {
    state,
    open,
    close
  };
}

export { useNotification };
