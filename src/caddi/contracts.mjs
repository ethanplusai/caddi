import { Buffer } from 'node:buffer';

export const PROTOCOL_VERSION = 1;

export class CaddiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CaddiError';
    this.code = code;
  }
}

const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const reservedIds = new Set([...forbiddenKeys, 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);

function invalid(message) { throw new CaddiError('INVALID_ARGUMENT', message); }

export function assertRecord(value, label = 'value') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(label + ' must be a plain record');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) invalid(label + ' must be a plain record');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || forbiddenKeys.has(key)) invalid(label + ' has an unsafe field');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid(label + ' must contain only enumerable data fields');
  }
  return value;
}

export function assertKeys(record, allowed, required = []) {
  assertRecord(record);
  const accepted = new Set(allowed);
  for (const key of Object.keys(record)) if (!accepted.has(key)) invalid('Unknown field');
  for (const key of required) if (!Object.hasOwn(record, key)) invalid('Required field is missing');
  return record;
}

export function assertId(value, label = 'id') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value) || reservedIds.has(value)) invalid(label + ' is not a valid identifier');
  return value;
}

export function assertInteger(value, label = 'value', { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(label + ' is outside its integer bounds');
  return value;
}

export function assertString(value, label = 'value', { min = 0, max = 4096 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max || value.includes('\0')) invalid(label + ' is outside its string bounds');
  return value;
}

export function normalizeOrigin(value) {
  assertString(value, 'origin', { min: 1, max: 8192 });
  let url;
  try { url = new URL(value); } catch { invalid('origin is invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.origin === 'null') invalid('origin must be an HTTP(S) origin without credentials, path, query or fragment');
  return url.origin;
}

// Clone untrusted JSON data without invoking getters or accepting prototype fields.
// Transport limits must also reject oversized bytes before parsing requests.
export function cloneData(value, { maxBytes = 1_048_576 } = {}) {
  assertInteger(maxBytes, 'maxBytes', { min: 1, max: 64 * 1024 * 1024 });
  const active = new Set();
  let nodes = 0;
  const clone = (item, depth) => {
    if (++nodes > 100_000 || depth > 32) invalid('Data structure exceeds bounds');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) invalid('Data contains a nonfinite number');
      return item;
    }
    if (typeof item === 'string') {
      if (Buffer.byteLength(item, 'utf8') > maxBytes) invalid('Data exceeds byte bound');
      return item;
    }
    if (typeof item !== 'object') invalid('Data must be JSON serializable');
    if (active.has(item)) invalid('Data contains a cycle');
    active.add(item);
    let result;
    if (Array.isArray(item)) {
      if (item.length > 10_000) invalid('Array exceeds bounds');
      const keys = Reflect.ownKeys(item);
      if (keys.length !== item.length + 1) invalid('Sparse or extended arrays are unsupported');
      result = [];
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid('Array must contain data items');
        result.push(clone(descriptor.value, depth + 1));
      }
    } else {
      assertRecord(item, 'data');
      const keys = Object.keys(item);
      if (keys.length > 512) invalid('Record exceeds bounds');
      result = {};
      for (const key of keys) result[key] = clone(item[key], depth + 1);
    }
    active.delete(item);
    return result;
  };
  const copied = clone(value, 0);
  if (Buffer.byteLength(JSON.stringify(copied), 'utf8') > maxBytes) invalid('Data exceeds byte bound');
  return copied;
}
