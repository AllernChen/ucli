export async function initializeSessionDetail({ sessions, settings, gateway, aiProfiles }) {
  void Promise.resolve()
    .then(() => aiProfiles.load())
    .catch(() => {})
  await Promise.all([
    sessions.init(),
    settings.load(),
    gateway.init()
  ])
  await sessions.loadWorkbench()
}
