import { isPromise } from 'node:util/types';
import { CaddiError } from '../contracts.mjs';

const codes = new Set([
  'INVALID_ARGUMENT', 'PERSISTENCE_UNAVAILABLE', 'PERSISTENCE_LOCKED', 'PERSISTENCE_CLOSED',
  'PERSISTENCE_BUSY', 'PERSISTENCE_CANCELLED', 'PERSISTENCE_TIMEOUT', 'PERSISTENCE_KEY_UNAVAILABLE',
  'PERSISTENCE_CORRUPT', 'PERSISTENCE_FUTURE_VERSION', 'PERSISTENCE_NOT_FOUND',
  'PERSISTENCE_CONFLICT', 'PERSISTENCE_CAPACITY', 'PERSISTENCE_IDENTITY_CHANGED',
  'PERSISTENCE_RECOVERY_REQUIRED', 'PERSISTENCE_COMMIT_UNKNOWN', 'PERSISTENCE_SCOPE_DENIED',
  'PERSISTENCE_RESULT_INVALID', 'PERSISTENCE_REVIEW_REQUIRED',
  'UNSAFE_STORAGE_PATH', 'STORAGE_PATH_CHANGED', 'STORE_LIMIT_EXCEEDED', 'STORE_CONFLICT',
  'STORE_RECOVERY_REQUIRED', 'STORE_BUSY', 'STORAGE_LOCK_CHANGED',
]);
export const fail = code => { throw new CaddiError(codes.has(code) ? code : 'PERSISTENCE_UNAVAILABLE', 'Protected local storage is unavailable for this action.'); };
export function safeError(error, fallback = 'PERSISTENCE_UNAVAILABLE') {
  const result = new CaddiError(codes.has(error?.code) ? error.code : fallback, 'Protected local storage is unavailable for this action.');
  if (error?.commitOutcomeUnknown === true) result.commitOutcomeUnknown = true;
  return result;
}
export function strictDecision(value, code = 'PERSISTENCE_SCOPE_DENIED', positive = false) {
  if (value === true || (!positive && value === undefined)) return true;
  if (isPromise(value)) void value.catch(() => {});
  fail(code);
}
export function fence(callback, code = 'PERSISTENCE_SCOPE_DENIED') {
  if (typeof callback !== 'function') fail(code);
  return strictDecision(callback(), code);
}
export function synchronous(value, code = 'PERSISTENCE_UNAVAILABLE') {
  if (isPromise(value)) { void value.catch(() => {}); fail(code); }
  if (value && typeof value.then === 'function') fail(code);
  return value;
}
export function signalValid(signal) {
  if (signal !== undefined && (!(signal instanceof AbortSignal))) fail('INVALID_ARGUMENT');
}
