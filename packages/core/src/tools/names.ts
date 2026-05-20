const SINGULAR_EXCEPTIONS = new Set([
  'analytics',
  'status',
  'stats',
  'settings',
  'media',
  'progress',
  'news',
]);

function singularize(name: string): string {
  if (SINGULAR_EXCEPTIONS.has(name)) return name;
  if (name.endsWith('ies')) return `${name.slice(0, -3)}y`;
  if (name.endsWith('s') && !name.endsWith('ss')) return name.slice(0, -1);
  return name;
}

export function toToolName(serviceName: string, methodName: string): string {
  const normalized = serviceName.replace(/-/g, '_');
  const singular = singularize(normalized);

  if (methodName === 'list') return `list_${normalized}`;
  if (methodName === 'get') return `get_${singular}`;
  if (methodName === 'create') return `create_${singular}`;
  if (methodName === 'update') return `update_${singular}`;
  if (methodName === 'delete') return `delete_${singular}`;

  const snake = methodName.replace(/([A-Z])/g, '_$1').toLowerCase();
  return `${snake}_${singular}`.replace(/^_/, '');
}
