export async function enforcePermissions({ toolName, args, enabled, authToken, getPermissions }) {
  if (!enabled) {
    throw new Error('permission verification unavailable in inert mode');
  }
  if (!authToken) {
    throw new Error('agent auth token is unavailable; permission verification is blocked');
  }

  let permissions;
  try {
    permissions = await getPermissions();
  } catch {
    throw new Error('permission verification unavailable; tool execution is blocked');
  }

  return permissions;
}
