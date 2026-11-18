// Transient, human-only review material. No feedback revision or delivery is mutated here.
import { createHash, randomUUID } from 'node:crypto';
import { CaddiError, assertId, assertInteger } from '../contracts.mjs';
import { FEEDBACK_LIMITS, validateEvidenceMoments } from '../feedback/model.mjs';
import { validateImagePreview } from './image-preview.mjs';

const fail = (code, message = 'Local evidence preparation is unavailable') => { throw new CaddiError(code, message); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX_DERIVED = 8;
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const metadata = item => ({ role:item.role, momentId:item.momentId ?? null, sourceArtifactId:item.sourceArtifactId ?? null,
  sourceSha256:item.sourceSha256 ?? null, sha256:item.sha256, size:item.bytes.length, width:item.width,
  height:item.height, atMs:item.atMs ?? null });

export function createPreparedEvidence({ privacy, current, readSource, rasterize, onChange = () => {} }) {
  if (!privacy?.registerObserver || typeof current !== 'function' || typeof readSource !== 'function' || typeof rasterize !== 'function') fail('INTEGRATION_REQUIRED');
  let item = null, pending = null, generation = 0, closed = false;
  const emit = () => { try { onChange(); } catch {} };
  function wipe(value) { if (!value) return; for (const part of value.derived ?? []) part.bytes.fill(0); value.derived = []; value.observer?.unregister(); }
  function invalidate(filter = {}) {
    if (filter.ownerWindowId && item?.binding.ownerWindowId !== filter.ownerWindowId && pending?.binding.ownerWindowId !== filter.ownerWindowId) return false;
    if (filter.workspaceId && item?.binding.workspaceId !== filter.workspaceId && pending?.binding.workspaceId !== filter.workspaceId) return false;
    generation++;
    const old = item; item = null; wipe(old); emit(); return !!old || !!pending;
  }
  function assertBinding(binding, token) {
    if (closed || generation !== token) fail('PREPARE_INVALIDATED');
    const draft = current(binding);
    if (!draft?.evidenceMoments || draft.feedbackId !== binding.feedbackId || draft.revision !== binding.revision || draft.workspaceId !== binding.workspaceId) fail('PREPARE_INVALIDATED');
    return draft;
  }
  const view = binding => {
    if (!item || !binding || item.binding.ownerWindowId !== binding.ownerWindowId ||
        item.binding.workspaceId !== binding.workspaceId || item.binding.feedbackId !== binding.feedbackId ||
        item.binding.revision !== binding.revision) return null;
    try { assertBinding(binding, item.token); item.observer.assertCurrent(); }
    catch { invalidate(); return null; }
    return { feedbackId:binding.feedbackId, revision:binding.revision, localOnly:true, summary:item.summary,
      sources:item.sources.map(value => ({...value})), derived:item.derived.map(metadata) };
  };
  function preview(binding, role, momentId) {
    const info = view(binding);
    if (!info) fail('PREPARE_UNAVAILABLE');
    if (!['marked-frame','contact-sheet'].includes(role)) fail('PREPARE_UNAVAILABLE');
    const found = item.derived.find(value => value.role === role && (role !== 'marked-frame' || value.momentId === momentId));
    if (!found) fail('PREPARE_UNAVAILABLE');
    return { ...metadata(found), mediaType:'image/png', base64:found.bytes.toString('base64') };
  }
  async function prepare(rawBinding) {
    if (closed || pending) fail('PREPARE_BUSY');
    const binding = { ownerWindowId: assertInteger(rawBinding.ownerWindowId,'ownerWindowId',{min:1}),
      workspaceId:assertId(rawBinding.workspaceId), feedbackId:assertId(rawBinding.feedbackId),
      revision:assertInteger(rawBinding.revision,'revision',{min:1}) };
    invalidate();
    const token = generation;
    const draft = assertBinding(binding, token);
    const moments = validateEvidenceMoments(draft.evidenceMoments, draft.capturedTarget, draft.artifacts.map(value => value.artifactId));
    if (moments.length + 1 > MAX_DERIVED) fail('PREPARE_CAPACITY');
    const staged = { binding, token, sources:[], derived:[], summary:'', observer:null };
    let work;
    staged.observer = privacy.registerObserver({ workspaceIds:[binding.workspaceId], connectionId:'prepared-'+randomUUID(),
      stop:async () => { invalidate({workspaceId:binding.workspaceId}); await work?.catch(() => {}); return {stopped:true}; } });
    work = (async () => {
      let originalTotal = 0, derivedTotal = 0, sourceBytes;
      try {
        const marked = [];
        for (let index = 0; index < moments.length; index++) {
          assertBinding(binding, token); staged.observer.assertCurrent();
          const moment = moments[index];
          const raw = readSource(binding, moment.artifactId);
          if (!raw || !['image/png','image/jpeg','image/webp'].includes(raw.mediaType) || typeof raw.base64 !== 'string' || raw.base64.length > 1_400_000) fail('PREPARE_SOURCE');
          sourceBytes = Buffer.from(raw.base64, 'base64');
          const size = validateImagePreview(sourceBytes, raw.mediaType);
          if (sourceBytes.length !== raw.size && raw.size !== undefined) fail('PREPARE_SOURCE');
          originalTotal += sourceBytes.length;
          if (originalTotal > FEEDBACK_LIMITS.captureBytes) fail('PREPARE_CAPACITY');
          const sourceSha256 = hash(sourceBytes);
          staged.sources.push({momentId:moment.momentId,artifactId:moment.artifactId,sha256:sourceSha256,
            size:sourceBytes.length,mediaType:raw.mediaType,width:size.width,height:size.height,atMs:moment.atMs,
            capturedTarget:moment.capturedTarget});
          const rendered = await rasterize({type:'frame',source:raw.base64,mediaType:raw.mediaType,
            width:size.width,height:size.height,marks:moment.marks});
          sourceBytes.fill(0); sourceBytes = null;
          assertBinding(binding, token); staged.observer.assertCurrent();
          const bytes = Buffer.from(rendered, 'base64');
          const image = validateImagePreview(bytes, 'image/png');
          if (!bytes.subarray(0,8).equals(png) || image.width !== size.width || image.height !== size.height || bytes.length > FEEDBACK_LIMITS.imageBytes) { bytes.fill(0); fail('PREPARE_SIZE'); }
          derivedTotal += bytes.length;
          if (originalTotal + derivedTotal > FEEDBACK_LIMITS.captureBytes) { bytes.fill(0); fail('PREPARE_CAPACITY'); }
          const part = {role:'marked-frame',momentId:moment.momentId,sourceArtifactId:moment.artifactId,
            sourceSha256,sha256:hash(bytes),bytes,width:image.width,height:image.height,atMs:moment.atMs};
          staged.derived.push(part);
          marked.push({base64:bytes.toString('base64'),atMs:moment.atMs,index:index+1});
        }
        assertBinding(binding, token); staged.observer.assertCurrent();
        const sheetBytes = Buffer.from(await rasterize({type:'sheet',frames:marked}), 'base64');
        const sheetSize = validateImagePreview(sheetBytes, 'image/png');
        if (!sheetBytes.subarray(0,8).equals(png) || sheetBytes.length > FEEDBACK_LIMITS.imageBytes) { sheetBytes.fill(0); fail('PREPARE_SIZE'); }
        derivedTotal += sheetBytes.length;
        if (originalTotal + derivedTotal > FEEDBACK_LIMITS.captureBytes) { sheetBytes.fill(0); fail('PREPARE_CAPACITY'); }
        staged.derived.push({role:'contact-sheet',sha256:hash(sheetBytes),bytes:sheetBytes,width:sheetSize.width,height:sheetSize.height});
        staged.summary = ['Local evidence review — '+moments.length+' manual still moment'+(moments.length===1?'':'s'),
          'Captured site: '+(draft.capturedTarget.origin ?? 'Unknown'),
          'Instructions: '+(draft.text?.trim() ? draft.text : 'No narration yet.'),
          ...moments.map((moment,index) => 'Moment '+(index+1)+' · '+moment.atMs+' ms · '+(moment.note || 'No note'))].join('\n');
        assertBinding(binding, token); staged.observer.assertCurrent();
        item = staged; emit(); return view(binding);
      } catch (error) { wipe(staged); throw error; }
      finally { sourceBytes?.fill(0); }
    })();
    pending = {binding,work};
    try { return await work; }
    finally { if (pending?.work === work) pending = null; }
  }
  async function close() { closed = true; invalidate(); await pending?.work.catch(() => {}); }
  return Object.freeze({ prepare, preview, view, invalidate, close });
}
