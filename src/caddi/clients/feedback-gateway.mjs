import { CaddiError, assertKeys, assertId, assertInteger, cloneData } from '../contracts.mjs';
import { assertAuthenticatedContext } from '../access/policy.mjs';

const operations = new Set(['feedback:receive', 'artifact:read']);
const fail = code => { throw new CaddiError(code, 'Feedback request rejected'); };

/** Agent read boundary only. Review, recipient rebinding and host receipts stay trusted-local. */
export function createFeedbackGateway({ store, policy, privacy, now = Date.now } = {}) {
  if (!store?.acceptClientDelivery || !policy?.authorize || !privacy?.captureGuard) fail('INTEGRATION_REQUIRED');
  return Object.freeze({
    accepts: operation => operations.has(operation),
    dispatch(context, raw, { signal, registerReplyGuard } = {}) {
      try {
        if (signal?.aborted) fail('CANCELLED');
        assertAuthenticatedContext(context, now());
        const request = cloneData(raw, { maxBytes: 16384 });
        assertKeys(request, ['operation', 'grantId', 'workspaceId', 'deadlineAt', 'payload'], ['operation', 'grantId', 'workspaceId', 'deadlineAt', 'payload']);
        if (!operations.has(request.operation)) fail('UNSUPPORTED_OPERATION');
        assertId(request.workspaceId); assertId(request.grantId);
        assertInteger(request.deadlineAt, 'deadlineAt', { min: now() + 1, max: now() + 30000 });
        const payload = request.payload;
        const fields = request.operation === 'feedback:receive' ? ['deliveryId', 'feedbackId', 'revision'] : ['feedbackId', 'revision', 'artifactId', 'offset', 'length'];
        assertKeys(payload, fields, fields);
        for (const key of fields.filter(key => !['revision', 'offset', 'length'].includes(key))) assertId(payload[key]);
        assertInteger(payload.revision, 'revision', { min: 1 });
        const check = () => {
          if (signal?.aborted) fail('CANCELLED');
          if (request.deadlineAt <= now()) fail('DEADLINE');
          assertAuthenticatedContext(context, now());
          policy.authorize(context, { ...request, ...payload });
        };
        check();
        const guard = privacy.captureGuard(request.workspaceId);
        let result, readGuard;
        if (request.operation === 'feedback:receive') {
          readGuard = store.guardDeliveryRead({ workspaceId: request.workspaceId, deliveryId: payload.deliveryId, context });
          const current = store.getDelivery({ workspaceId: request.workspaceId, deliveryId: payload.deliveryId, context });
          if (current.feedbackId !== payload.feedbackId || current.revision !== payload.revision) fail('ACCESS_DENIED');
          result = store.acceptClientDelivery({ workspaceId: request.workspaceId, deliveryId: payload.deliveryId, context });
        } else {
          assertInteger(payload.offset, 'offset', { min: 0, max: 16_777_216 });
          assertInteger(payload.length, 'length', { min: 1, max: 49_152 });
          readGuard = store.guardArtifactRead({ workspaceId: request.workspaceId, grantId: request.grantId, context, ...payload });
          const bytes = store.readArtifact({ workspaceId: request.workspaceId, grantId: request.grantId, context, ...payload });
          try {
            if (payload.offset > bytes.length) fail('INVALID_ARGUMENT');
            const end = Math.min(bytes.length, payload.offset + payload.length);
            result = { artifactId: payload.artifactId, encoding: 'base64', offset: payload.offset,
              totalBytes: bytes.length, nextOffset: end, done: end === bytes.length,
              data: bytes.subarray(payload.offset, end).toString('base64') };
          } finally { bytes.fill(0); }
        }
        const finalGuard = () => { check(); guard.assertValid(); readGuard.assertValid(); return true; };
        finalGuard();
        if (registerReplyGuard !== undefined) {
          if (typeof registerReplyGuard !== 'function') fail('INTEGRATION_REQUIRED');
          registerReplyGuard(finalGuard);
        }
        return { status: 'completed', result: cloneData(result, { maxBytes: 262144 }) };
      } catch (error) {
        const code = ['CANCELLED', 'DEADLINE', 'PRIVACY_BLOCKED', 'WORKSPACE_LOCKED', 'INVALID_ARGUMENT', 'UNSUPPORTED_OPERATION'].includes(error.code) ? error.code : 'ACCESS_DENIED';
        return { status: signal?.aborted ? 'cancelled' : 'rejected', code };
      }
    },
  });
}
