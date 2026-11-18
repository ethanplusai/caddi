// Presentation only. Main rechecks the actual provider, owner review and grants.
const operation = (provider, name, id, label) => Object.freeze({ provider, name, id, label });
export const serviceOperations = Object.freeze([
  operation('github', 'repositoryGet', 'repository:get', 'Read repository metadata'),
  operation('github', 'issuesList', 'issues:list', 'List issues'),
  operation('vercel', 'projectsList', 'projects:list', 'List project metadata'),
  operation('vercel', 'deploymentsList', 'deployments:list', 'List deployment metadata'),
  operation('resend', 'domainsList', 'domains:list', 'List domain metadata'),
]);

export function serviceProviderId(connection) {
  const value = connection?.providerId ?? connection?.provider;
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase();
  return ['github', 'vercel', 'resend'].includes(normalized) ? normalized : null;
}

export function ownerServiceOperations(connection) {
  const provider = serviceProviderId(connection);
  if (!provider || !Array.isArray(connection.operations)) return [];
  return serviceOperations.filter(item => item.provider === provider && connection.operations.includes(item.id)).map(item => item.id);
}

export function scopedServiceOperations(connection, allowed) {
  if (!Array.isArray(allowed)) return [];
  return ownerServiceOperations(connection).filter(id => allowed.includes(id));
}

const label = value => typeof value === 'string' ? value.slice(0, 128) : '';
export function serviceConnectionDescription(connection) {
  switch (serviceProviderId(connection)) {
    case 'github': return 'GitHub · ' + label(connection.owner) + '/' + label(connection.repository);
    case 'vercel': return 'Vercel · ' + (label(connection.teamId) || 'Selected account') +
      (connection.projectId ? ' · ' + label(connection.projectId) : '');
    case 'resend': return 'Resend · Account domains';
    default: return 'Unsupported provider';
  }
}
