import type { MatomoTracker } from '@certible/use-matomo';
import { hasInjectionContext, inject } from 'vue';

// Keys of events that were already sent in this page load.
const sentOnce = new Set<string>();

/**
 * Matomo events for features that only run in the browser.
 * Do not put free text, names or IDs into the event name.
 */
export function useTrackEvent() {
  const matomo = hasInjectionContext()
    ? inject<MatomoTracker | undefined>('matomo', undefined)
    : undefined;

  function track(
    category: string,
    action: string,
    name?: string,
    value?: number
  ) {
    try {
      matomo?.trackEvent(category, action, name, value);
    } catch (e) {
      console.error(e);
    }
  }

  // Sends the event only once per page load.
  function trackOnce(category: string, action: string, name?: string) {
    const key = `${category}/${action}/${name ?? ''}`;
    if (sentOnce.has(key)) {
      return;
    }
    sentOnce.add(key);
    track(category, action, name);
  }

  // Sends the device settings and the display mode once per page load.
  function trackSessionState() {
    trackOnce('App', 'display-mode', getDisplayMode());
    trackOnce(
      'Setting',
      'color-scheme',
      localStorage.getItem('colorScheme') ?? 'auto'
    );
    trackOnce(
      'Setting',
      'varroa-days',
      localStorage.getItem('varroa-days') ?? '1'
    );
    for (const [key, value] of Object.entries(getPrefLocal())) {
      if (typeof value === 'boolean') {
        trackOnce('Setting', key, value ? 'on' : 'off');
      }
    }
  }

  return { track, trackOnce, trackSessionState };
}

// Defaults of the `pref-local` keys, as in the components that use them.
const PREF_LOCAL_DEFAULTS: Record<string, boolean> = {
  'date-auto-close': false,
  'hive-clear-after-saving': false,
  'calendar-show-weeknumber': true,
  'show-qr-scanner': false,
  'show-voice-recognition': false,
  'hive-use-input': false,
  'charge-use-input': false
};

function getPrefLocal(): Record<string, unknown> {
  try {
    const stored = JSON.parse(localStorage.getItem('pref-local') ?? '{}');
    return { ...PREF_LOCAL_DEFAULTS, ...stored };
  } catch {
    return { ...PREF_LOCAL_DEFAULTS };
  }
}

function getDisplayMode() {
  // The iOS wrapper (btree_ios) adds PWAShell to the user agent.
  if (navigator.userAgent.includes('PWAShell')) {
    return 'ios-app';
  }
  // A TWA (btree_native) opens the app with an android-app:// referrer.
  if (document.referrer.startsWith('android-app://')) {
    return 'twa';
  }
  if (window.matchMedia('(display-mode: standalone)').matches) {
    return 'standalone';
  }
  return 'browser';
}
