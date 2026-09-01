import { skillError } from './contracts.js'

function assertOperations(operations) {
  const required = [
    'loadSnapshot', 'plan', 'ensureDirect', 'verifyDirect', 'disableDirect',
    'commitDesired', 'flush', 'rescan', 'restoreDirect', 'removeCreatedDirect',
    'revertActivatedDirect', 'markRecovery', 'packageView'
  ]
  if (!operations || typeof operations !== 'object' || required.some((name) => typeof operations[name] !== 'function')) {
    throw new TypeError('Skill state coordinator operations are invalid')
  }
}

function requestForPlan(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
    typeof request.packageId !== 'string' || !request.packageId ||
    typeof request.scopeType !== 'string' || typeof request.scopeKey !== 'string' ||
    !Array.isArray(request.changes)) {
    throw skillError('Skill projection request is invalid', 'SKILL_CLI_DESIRED_STATE_INVALID')
  }
  return request
}

export function createSkillStateCoordinator(operations) {
  assertOperations(operations)

  function currentPlan(request) {
    const input = requestForPlan(request)
    const snapshot = operations.loadSnapshot(input)
    return operations.plan(snapshot, input.changes)
  }

  async function rollback(created, activated, disabled) {
    let failed = false
    for (const item of [...disabled].reverse()) {
      try { await operations.restoreDirect(item) } catch { failed = true }
    }
    for (const item of [...created].reverse()) {
      try {
        await operations.removeCreatedDirect({
          ...item,
          expectedSha256: item.sha256
        })
      } catch { failed = true }
    }
    for (const item of [...activated].reverse()) {
      try { await operations.revertActivatedDirect(item) } catch { failed = true }
    }
    return !failed
  }

  return {
    preview(request) {
      return currentPlan(request)
    },

    async apply(request) {
      const input = requestForPlan(request)
      const expectedRevision = input.expectedRevision
      const plan = currentPlan(input)
      if (plan.revision !== expectedRevision) {
        throw skillError('Skill projection plan is stale', 'SKILL_PROJECTION_PLAN_STALE')
      }
      if (plan.classification === 'blocked') {
        throw skillError('CLI isolation is unsupported', plan.reasonCode)
      }
      if (plan.classification === 'noop') {
        return {
          package: await operations.packageView(input.packageId),
          plan,
          affectedInstallationIds: [],
          affectedSessions: []
        }
      }

      const created = []
      const activated = []
      const disabled = []
      let committed = false
      try {
        for (const step of plan.steps) {
          if (step.type === 'ensure_direct') {
            const result = await operations.ensureDirect({ request: input, adapterId: step.adapterId })
            if (result?.created) created.push({
              adapterId: step.adapterId,
              installationId: result.installationId,
              sha256: result.sha256
            })
            if (result?.activated) activated.push({ adapterId: step.adapterId, installationId: result.installationId })
            const verified = await operations.verifyDirect({
              request: input,
              adapterId: step.adapterId,
              expectedSha256: result?.sha256
            })
            if (!verified || verified.sha256 !== result?.sha256) {
              throw skillError('Created skill projection failed verification', 'SKILL_DRIFTED')
            }
          }
        }
        for (const step of plan.steps) {
          if (step.type !== 'disable_direct') continue
          const result = await operations.disableDirect({ request: input, adapterId: step.adapterId })
          disabled.push({ adapterId: step.adapterId, installationId: result?.installationId })
        }
        const desiredChanges = plan.steps
          .filter((step) => step.type === 'set_desired')
          .map(({ adapterId, desiredState }) => ({ adapterId, desiredState }))
        await operations.commitDesired({ request: input, changes: desiredChanges })
        committed = true
        await operations.flush()
        const rescanned = await operations.rescan({ request: input, packageId: input.packageId })
        return {
          package: await operations.packageView(input.packageId),
          plan,
          affectedInstallationIds: rescanned?.affectedInstallationIds || [],
          affectedSessions: rescanned?.affectedSessions || []
        }
      } catch (error) {
        if (committed) {
          try { await operations.markRecovery({ request: input, packageId: input.packageId }) } catch { /* recovery error is safely collapsed */ }
          throw skillError('Skill projection recovery is required', 'SKILL_PROJECTION_RECOVERY_REQUIRED')
        }
        if (!await rollback(created, activated, disabled)) {
          try { await operations.markRecovery({ request: input, packageId: input.packageId }) } catch { /* recovery error is safely collapsed */ }
          throw skillError('Skill projection recovery is required', 'SKILL_PROJECTION_RECOVERY_REQUIRED')
        }
        throw error
      }
    }
  }
}
