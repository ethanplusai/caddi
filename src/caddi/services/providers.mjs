import { createGithubTransport, githubRequest, validateGithubResult } from './github.mjs';
import { createVercelTransport, vercelRequest, validateVercelResult } from './vercel.mjs';
import { createResendTransport, resendRequest, validateResendResult } from './resend.mjs';
import { serviceDefinition, serviceScope } from './scope.mjs';

export { serviceDefinition, serviceScope, serviceScopeIdentity, serviceScopeFields, serviceProvider,
  serviceProviderLabel, servicePublicScope, serviceOperations, serviceOperationScope, sameServiceScope } from './scope.mjs';
export function serviceRequest(input) {
  const scope = serviceDefinition(input, ['operation', 'parameters'], ['operation']);
  const request = { ...scope, operation: input.operation, parameters: input.parameters };
  return scope.provider === 'github' ? githubRequest(request) : scope.provider === 'vercel' ? vercelRequest(request) : resendRequest(request);
}
export function validateServiceResult(input) {
  const scope = serviceScope(input), request = { ...scope, operation: input.operation, result: input.result };
  return scope.provider === 'github' ? validateGithubResult(request) : scope.provider === 'vercel' ? validateVercelResult(request) : validateResendResult(request);
}
/** Dispatch depends only on the captured owner connection scope, never an agent URL. */
export function createServiceTransport({ fetchImpl = globalThis.fetch } = {}) {
  const transports = Object.freeze({ github: createGithubTransport({ fetchImpl }), vercel: createVercelTransport({ fetchImpl }), resend: createResendTransport({ fetchImpl }) });
  return Object.freeze({ send(input) {
    const scope = serviceDefinition(input, ['operation', 'parameters', 'token', 'signal'], ['operation', 'token']);
    return transports[scope.provider].send({ ...scope, operation: input.operation, parameters: input.parameters,
      token: input.token, signal: input.signal });
  } });
}
