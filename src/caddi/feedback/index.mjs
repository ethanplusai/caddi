import { constructFeedbackStore } from './store.mjs';

// This ordinary entry never enables memory keys, crash hooks, live microphone
// capture, or arbitrary browser capture. Native integrations remain prerequisites.
export function openFeedbackStore(options) {
  return constructFeedbackStore(options, { allowTestProvider: false });
}
export { FEEDBACK_LIMITS, validateEnvelope, validateCaptureTarget, validateSelection, associateTimeline } from './model.mjs';
