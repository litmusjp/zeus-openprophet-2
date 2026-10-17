export async function savePluginAndApplyRuntime({ sandboxId, pluginName, pluginBody, getRunningRuntime, canRestart, persist, restart }) {
  const runtime = pluginName === 'alphadesk' ? getRunningRuntime(sandboxId) : null;
  if (runtime && (typeof restart !== 'function' || (canRestart && !canRestart(sandboxId, runtime)))) {
    throw Object.assign(new Error('This connection is running; stop it before saving, then restart it to apply the new policy'), { status: 503 });
  }
  await persist(sandboxId, pluginName, pluginBody);
  if (!runtime) return { applied: false };
  try {
    const restarted = await restart(sandboxId, runtime);
    if (restarted === false || (restarted && restarted.goReady === false)) throw new Error('backend did not become ready');
    return { applied: true };
  } catch {
    throw Object.assign(new Error('Connection settings were saved, but the running backend did not restart successfully. Start or restart this sandbox before relying on its settings.'), { status: 503, saved: true });
  }
}
