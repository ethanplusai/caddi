import test from 'node:test';
import assert from 'node:assert/strict';
import { ADMISSION_PAGE_OPERATIONS } from '../src/caddi/desktop/admission.mjs';
import { DISPATCH_PAGE_OPERATIONS } from '../src/caddi/access/dispatcher.mjs';

// A page operation the dispatcher runs but admission does not know is refused in the real app (INVALID_ARGUMENT),
// while unit tests without admission pass. That is how agent saved-login fills broke.
test('page admission accepts every page operation the dispatcher can execute', () => {
  const missing = DISPATCH_PAGE_OPERATIONS.filter(operation => !ADMISSION_PAGE_OPERATIONS.includes(operation));
  assert.deepEqual(missing, []);
});
