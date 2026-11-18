import { createHash } from 'node:crypto';
import { CaddiError, assertRecord, assertKeys, assertId, assertInteger, assertString, cloneData, normalizeOrigin } from '../contracts.mjs';

export const FEEDBACK_LIMITS = Object.freeze({
  artifactBytes: 2 * 1024 * 1024,
  imageBytes: 1024 * 1024,
  captureBytes: 8 * 1024 * 1024,
  transcriptCharacters: 16000,
  timelineEvents: 512,
  stateBytes: 32 * 1024 * 1024,
  journalBytes: 128 * 1024 * 1024,
});
const targetFields = ['workspaceId', 'tabId', 'frameId', 'runtimeIncarnation', 'documentGeneration', 'observationId', 'viewportRevision', 'capturePrivacyEpoch'];
const ids = ['workspaceId', 'tabId', 'frameId', 'runtimeIncarnation', 'observationId'];
const integers = ['documentGeneration', 'viewportRevision', 'capturePrivacyEpoch'];
const fail = message => { throw new CaddiError('INVALID_FEEDBACK', message); };
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const revisionKey = (feedbackId, revision) => assertId(feedbackId) + '/' + assertInteger(revision, 'revision', { min: 1 });

export function freezeData(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}
export function detached(value) { return freezeData(cloneData(value, { maxBytes: FEEDBACK_LIMITS.stateBytes })); }

export function validateCaptureTarget(input) {
  const value = cloneData(input, { maxBytes: 4096 });
  assertKeys(value, [...targetFields, 'origin'], targetFields);
  for (const field of ids) assertId(value[field], field);
  for (const field of integers) assertInteger(value[field], field);
  if (value.origin !== undefined && normalizeOrigin(value.origin) !== value.origin) fail('Origin must be canonical');
  return freezeData(value);
}
export function sameCapturedTarget(left, right) {
  return targetFields.every(field => left[field] === right[field]) && left.origin === right.origin;
}
function rect(input) {
  assertKeys(input, ['x', 'y', 'width', 'height'], ['x', 'y', 'width', 'height']);
  for (const field of ['x', 'y', 'width', 'height']) {
    const value = input[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e7) fail('Invalid target rectangle');
  }
  if (input.width <= 0 || input.height <= 0) fail('Target rectangle must have positive area');
}
function interval(value) {
  assertInteger(value.startMs, 'startMs', { max: 3600000 });
  assertInteger(value.endMs, 'endMs', { max: 3600000 });
  if (value.endMs < value.startMs) fail('Invalid time interval');
}
export function validateSelection(input) {
  const value = cloneData(input, { maxBytes: 8192 });
  assertKeys(value, ['kind', 'captureTargetId', 'confidence', 'stale', 'rect', 'locator', 'screenshotRef'], ['kind', 'captureTargetId', 'confidence', 'stale']);
  if (!['element', 'region', 'page'].includes(value.kind)) fail('Unknown selection kind');
  assertId(value.captureTargetId, 'captureTargetId');
  if (!['explicit', 'inferred', 'ambiguous', 'unresolved'].includes(value.confidence)) fail('Invalid target confidence');
  if (typeof value.stale !== 'boolean') fail('Target staleness must be explicit');
  if (value.rect !== undefined) rect(value.rect);
  if (value.kind === 'region' && (!value.rect || !value.screenshotRef)) fail('Regions require a rectangle and frozen screenshot');
  if (value.screenshotRef !== undefined) assertId(value.screenshotRef, 'screenshotRef');
  if (value.locator !== undefined) {
    if (value.kind !== 'element') fail('Only element selections have locators');
    assertKeys(value.locator, ['css', 'role', 'accessibleName', 'adapter']);
    for (const [name, text] of Object.entries(value.locator)) assertString(text, name, { max: 2048 });
    if (value.locator.adapter && !['dom', 'shadow-open', 'same-origin-frame', 'react-development', 'opaque'].includes(value.locator.adapter)) fail('Unknown locator adapter');
  }
  return freezeData(value);
}

const sameDocument = (left, right) => ['workspaceId', 'tabId', 'frameId', 'runtimeIncarnation', 'documentGeneration', 'capturePrivacyEpoch', 'origin']
  .every(field => left[field] === right[field]);
const unit = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail('Invalid ' + label + ' coordinate');
  return value;
};
export function validateEvidenceMoments(input, capturedTarget, artifactIds) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 6) fail('Moment count exceeds bounds');
  const seenMoments = new Set(), seenArtifacts = new Set();
  let prior = -1;
  return freezeData(input.map(raw => {
    const moment = cloneData(raw, { maxBytes: 32768 });
    assertKeys(moment, ['momentId', 'atMs', 'capturedTarget', 'artifactId', 'note', 'marks'],
      ['momentId', 'atMs', 'capturedTarget', 'artifactId', 'note', 'marks']);
    assertId(moment.momentId, 'momentId'); assertId(moment.artifactId, 'artifactId');
    if (seenMoments.has(moment.momentId) || seenArtifacts.has(moment.artifactId) || !artifactIds.includes(moment.artifactId)) fail('Moment artifact identity is invalid');
    seenMoments.add(moment.momentId); seenArtifacts.add(moment.artifactId);
    assertInteger(moment.atMs, 'atMs', { min: 0, max: 60000 });
    if (moment.atMs < prior) fail('Moments must follow capture time');
    prior = moment.atMs;
    moment.capturedTarget = validateCaptureTarget(moment.capturedTarget);
    if (!sameDocument(moment.capturedTarget, capturedTarget)) fail('Moment belongs to another document or privacy epoch');
    assertString(moment.note, 'moment note', { max: 2000 });
    if (!Array.isArray(moment.marks) || moment.marks.length > 32) fail('Moment marks exceed bounds');
    moment.marks = moment.marks.map(rawMark => {
      const mark = cloneData(rawMark, { maxBytes: 1024 });
      if (mark.kind === 'rectangle') {
        assertKeys(mark, ['kind', 'x', 'y', 'width', 'height', 'color'], ['kind', 'x', 'y', 'width', 'height', 'color']);
        for (const key of ['x', 'y', 'width', 'height']) unit(mark[key], key);
        if (mark.width <= 0 || mark.height <= 0 || mark.x + mark.width > 1 || mark.y + mark.height > 1) fail('Invalid rectangle');
      } else if (mark.kind === 'arrow') {
        assertKeys(mark, ['kind', 'x', 'y', 'x2', 'y2', 'color'], ['kind', 'x', 'y', 'x2', 'y2', 'color']);
        for (const key of ['x', 'y', 'x2', 'y2']) unit(mark[key], key);
        if (mark.x === mark.x2 && mark.y === mark.y2) fail('Invalid arrow');
      } else fail('Unknown moment mark');
      if (!['teal', 'coral', 'gold'].includes(mark.color)) fail('Unknown mark color');
      return mark;
    });
    return moment;
  }));
}

export function validateEnvelope(input) {
  const value = cloneData(input, { maxBytes: 128 * 1024 });
  const required = ['schemaVersion', 'captureSource', 'feedbackId', 'revision', 'captureId', 'workspaceId', 'capturedTarget', 'selection', 'utterances', 'timeline', 'artifactIds'];
  assertKeys(value, [...required, 'projectId', 'logicalTaskId', 'build', 'sourceContext', 'supersedesRevision', 'evidenceMoments'], required);
  if (value.schemaVersion !== 1 || !['fixture', 'electron-development'].includes(value.captureSource)) fail('Unsupported schema-1 capture source');
  for (const field of ['feedbackId', 'captureId', 'workspaceId', 'projectId', 'logicalTaskId']) if (value[field] !== undefined) assertId(value[field], field);
  assertInteger(value.revision, 'revision', { min: 1 });
  if (value.supersedesRevision !== undefined && value.supersedesRevision !== null) {
    assertInteger(value.supersedesRevision, 'supersedesRevision', { min: 1 });
    if (value.supersedesRevision >= value.revision) fail('A revision must supersede an older revision');
  }
  value.capturedTarget = validateCaptureTarget(value.capturedTarget);
  if (value.capturedTarget.workspaceId !== value.workspaceId) fail('Captured target belongs to another workspace');
  value.selection = validateSelection(value.selection);
  if (!Array.isArray(value.utterances) || value.utterances.length > 64) fail('Utterance count exceeds bounds');
  const utteranceIds = new Set();
  let characters = 0;
  for (const utterance of value.utterances) {
    assertKeys(utterance, ['utteranceId', 'startMs', 'endMs', 'text', 'receivedMs'], ['utteranceId', 'startMs', 'endMs', 'text']);
    assertId(utterance.utteranceId, 'utteranceId');
    if (utteranceIds.has(utterance.utteranceId)) fail('Repeated utterance identifier');
    utteranceIds.add(utterance.utteranceId);
    interval(utterance);
    assertString(utterance.text, 'transcript', { max: FEEDBACK_LIMITS.transcriptCharacters });
    characters += utterance.text.length;
    if (utterance.receivedMs !== undefined) assertInteger(utterance.receivedMs, 'receivedMs');
  }
  if (characters > FEEDBACK_LIMITS.transcriptCharacters) fail('Transcript exceeds its text budget');
  if (!Array.isArray(value.timeline) || value.timeline.length > FEEDBACK_LIMITS.timelineEvents) fail('Timeline exceeds bounds');
  let previousTime = -1;
  for (const event of value.timeline) {
    assertKeys(event, ['eventId', 'kind', 'startMs', 'endMs', 'captureTargetId', 'capturedTarget', 'rect'], ['eventId', 'kind', 'startMs', 'endMs', 'capturedTarget']);
    assertId(event.eventId, 'eventId');
    if (!['pointer', 'selection', 'region', 'utterance'].includes(event.kind)) fail('Unknown timeline event');
    interval(event);
    if (event.startMs < previousTime) fail('Timeline must be ordered by observation time');
    previousTime = event.startMs;
    validateCaptureTarget(event.capturedTarget);
    if (event.capturedTarget.workspaceId !== value.workspaceId) fail('Cross-workspace timeline is forbidden');
    if (event.captureTargetId !== undefined) assertId(event.captureTargetId, 'captureTargetId');
    if (event.rect !== undefined) rect(event.rect);
  }
  if (!Array.isArray(value.artifactIds) || value.artifactIds.length > 8 || new Set(value.artifactIds).size !== value.artifactIds.length) fail('Invalid artifact references');
  for (const id of value.artifactIds) assertId(id, 'artifactId');
  if (value.selection.screenshotRef && !value.artifactIds.includes(value.selection.screenshotRef)) fail('Screenshot is absent from revision artifacts');
  if (value.evidenceMoments !== undefined) {
    value.evidenceMoments = validateEvidenceMoments(value.evidenceMoments, value.capturedTarget, value.artifactIds);
    if (value.evidenceMoments.length !== value.artifactIds.length) fail('Moment screenshots must exactly match revision artifacts');
    if (characters + value.evidenceMoments.reduce((sum, moment) => sum + moment.note.length, 0) > FEEDBACK_LIMITS.transcriptCharacters) fail('Moment notes exceed text budget');
  }
  for (const field of ['build', 'sourceContext']) {
    if (value[field] !== undefined && value[field] !== null) {
      assertRecord(value[field], field);
      if (Buffer.byteLength(JSON.stringify(value[field])) > 8192) fail('Source or build context exceeds bounds');
    }
  }
  return freezeData(value);
}

export function encodeArtifacts(input) {
  if (!Array.isArray(input) || input.length > 8) fail('Too many artifacts');
  const seen = new Set();
  let total = 0;
  return input.map(item => {
    assertKeys(item, ['artifactId', 'kind', 'mediaType', 'data'], ['artifactId', 'kind', 'mediaType', 'data']);
    assertId(item.artifactId, 'artifactId');
    if (seen.has(item.artifactId)) fail('Repeated artifact identifier');
    seen.add(item.artifactId);
    const media = {
      screenshot: ['image/png', 'image/jpeg', 'image/webp'],
      audio: ['audio/pcm', 'audio/wav'],
      transcript: ['text/plain'],
      metadata: ['application/json'],
    };
    if (!Object.hasOwn(media, item.kind) || !media[item.kind].includes(item.mediaType)) fail('Unsupported artifact type');
    if (!(item.data instanceof Uint8Array)) fail('Artifact data must be bytes');
    const maximum = item.kind === 'screenshot' ? FEEDBACK_LIMITS.imageBytes : FEEDBACK_LIMITS.artifactBytes;
    if (item.data.byteLength === 0 || item.data.byteLength > maximum) fail('Artifact exceeds byte bounds');
    const copy = Buffer.from(item.data);
    total += copy.length;
    if (total > FEEDBACK_LIMITS.captureBytes) { copy.fill(0); fail('Capture exceeds byte budget'); }
    const result = { artifactId: item.artifactId, kind: item.kind, mediaType: item.mediaType, size: copy.length, sha256: digest(copy), data: copy.toString('base64') };
    copy.fill(0);
    return result;
  });
}

// Arrival time is deliberately irrelevant. A phrase spanning two explicit targets
// is ambiguous, and a selection from another observation is retained as stale.
export function associateTimeline(envelopeInput) {
  const envelope = validateEnvelope(envelopeInput);
  return detached(envelope.utterances.map(utterance => {
    const overlaps = envelope.timeline.filter(event =>
      event.captureTargetId && event.startMs <= utterance.endMs && event.endMs >= utterance.startMs);
    const explicit = overlaps.filter(event => ['selection', 'region'].includes(event.kind));
    const candidates = explicit.length ? explicit : overlaps.filter(event => event.kind === 'pointer');
    const targetIds = [...new Set(candidates.map(event => event.captureTargetId))];
    return {
      utteranceId: utterance.utteranceId,
      targetIds,
      confidence: targetIds.length === 0 ? 'unresolved' : targetIds.length > 1 ? 'ambiguous' : explicit.length ? 'explicit' : 'inferred',
      stale: candidates.some(event => !sameCapturedTarget(event.capturedTarget, envelope.capturedTarget)),
    };
  }));
}
