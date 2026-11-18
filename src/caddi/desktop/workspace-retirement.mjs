/** Host facts only. Unknown site state is protected, never treated as clean. */
export function workspaceReleaseDecision(value) {
  if (!value || value.foreground !== false || value.privateMode !== false ||
      value.downloads !== 0 || value.captureActive !== false || value.printActive !== false ||
      value.feedbackActive !== false || value.leaseActive !== false || value.otherAgents !== 0 || !Array.isArray(value.pages))
    return { release: false, reason: 'OWNER_REVIEW_REQUIRED' };
  if (value.pages.some(page => page.cleanBlank !== true || page.humanTouched !== false || page.busy !== false || page.visible !== false))
    return { release: false, reason: 'OWNER_REVIEW_REQUIRED' };
  return { release: true, reason: null };
}
