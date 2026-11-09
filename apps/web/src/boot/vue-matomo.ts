import { initMatomo } from '@certible/use-matomo';
import { defineBoot } from '#q-app';
import { setBootTracker } from '../composables/useTrackEvent';
import { useAuthUserStore } from '../stores/auth';

export default defineBoot(({ app, router, store }) => {
  const storeUser = useAuthUserStore(store);

  const matomo = initMatomo({
    host: import.meta.env.MATOMO_HOST ?? '',
    siteId: import.meta.env.MATOMO_SITE_ID ?? '',
    requireCookieConsent: false,
    disableCookies: true,
    requireConsent: false,
    // The router hook below tracks all page views, also the first one,
    // so that each page view has the current user ID and the route title.
    trackInitialView: false,
    trackRouter: false
  });

  let userId = '';

  router.afterEach((to, _from, failure) => {
    if (failure) {
      return;
    }
    const currentUserId = getUserId(storeUser.user?.id, storeUser.company?.id);
    if (currentUserId !== userId) {
      matomo.setUserId(currentUserId || null);
      userId = currentUserId;
    }
    // The route name is the same in all languages and has no hive or apiary names.
    matomo.trackPageView(window.location.href, {
      documentTitle: to.name ? String(to.name) : to.path
    });
  });

  app.provide('matomo', matomo);
  setBootTracker(matomo);
});

function getUserId(userId?: number, companyId?: number) {
  let identifier = '';
  if (userId) {
    identifier += `bee_id:${userId}`;
  }
  if (companyId) {
    identifier += `.user_id:${companyId}`;
  }
  return identifier;
}
