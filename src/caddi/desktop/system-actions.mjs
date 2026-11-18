// Safe cleanup remains available in trusted chrome while ordinary work is paused.
// This is presentation-neutral; the host still validates every exact action receipt.
const cleanup = new Set(['system.continue', 'system.retry-stop', 'default-browser.status', 'connections.acquire.cancel', 'overlay.set', 'window.close', 'tab.close',
  'permission.media.end', 'permission.media.revoke', 'preview.close', 'popup.close', 'popup.cancel',
  'agent.reject', 'agent.revoke', 'admission.cancel', 'service.connection.remove', 'service.workspace.revoke', 'service.grant.revoke',
  'review.close', 'review.cancel-pick', 'review.cancel', 'review.invalidate-local', 'moments.cancel', 'moments.stop',
  'voice.cancel', 'find.stop', 'portability.cancel', 'external-links.close', 'external-links.dismiss', 'attention.dismiss', 'privacy.enter']);
export function systemCleanupAction(input) {
  if (!input || typeof input !== 'object') return false;
  if (input.type === 'permission.respond') return input.allow === false;
  if (input.type === 'shortcuts.recording') return input.active === false;
  if (input.type === 'download.control') return input.operation === 'cancel';
  return cleanup.has(input.type);
}
