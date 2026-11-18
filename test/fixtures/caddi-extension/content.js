(() => {
  'use strict';
  if (location.origin !== 'http://127.0.0.1:38457' ||
      !location.pathname.startsWith('/caddi-extension/') ||
      window.top !== window ||
      document.documentElement?.dataset.caddiExtensionFixture !== 'v1') return;
  document.documentElement.dataset.caddiSyntheticExtension = '1.0.0';
})();
