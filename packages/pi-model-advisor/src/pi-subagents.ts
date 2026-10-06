import type { RecommendationResult, Selection } from './core.ts'

interface PreflightInputLike {
  agent: string
  cwd: string
  model?: string
  thinking?: string | false
}

type ResolveSubagentLaunchContract = (input: PreflightInputLike) => Promise<unknown>
type HostSnapshotKeys = 'parentModel' | 'scopedModelIds' | 'availableModels' | 'runtimeSnapshotHost'

interface CurrentHostSnapshots<Input> {
  /** Current Pi parent model; provide `undefined` explicitly when the session has none. */
  parentModel: Input extends { parentModel?: infer Value } ? Value | undefined : never
  /** Current `ctx.scopedModels` as provider/id strings; an empty array means unscoped. */
  scopedModelIds: Input extends { scopedModelIds?: infer Value } ? NonNullable<Value> : never
  /** Current `ctx.modelRegistry.getAvailable()` snapshot. */
  availableModels: Input extends { availableModels?: infer Value } ? NonNullable<Value> : never
  /** The calling `pi` host when the intended child resolves native MCP selectors. */
  runtimeSnapshotHost?: Input extends { runtimeSnapshotHost?: infer Value } ? Value : never
}

type VerificationResult =
  | { status: 'verified'; selection: Selection }
  | {
      status: 'verification_failed'
      category: 'preflight_rejected' | 'host_required' | 'selection_conflict' | 'unresolved_contract'
      message: string
      missingHostFacts?: string[]
    }

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function hasModelIdentity(value: unknown): boolean {
  const identity = record(value)
  return Boolean(identity && isNonemptyString(identity.provider) && isNonemptyString(identity.id))
}

function isRuntimeSnapshotHost(value: unknown): boolean {
  const host = record(value)
  const events = record(host?.events)
  return typeof events?.emit === 'function' && typeof host?.getCommands === 'function'
}

function isMcpSelection(value: unknown): boolean {
  const selection = record(value)
  return Boolean(selection && isNonemptyString(selection.name) && isNonemptyString(selection.selector))
}

function invalidHostSnapshots(host: unknown): string[] {
  const snapshots = record(host)
  if (!snapshots) {
    return ['parentModel', 'scopedModelIds', 'availableModels']
  }

  const missing: string[] = []
  if (!Object.hasOwn(snapshots, 'parentModel')) {
    missing.push('parentModel')
  } else if (snapshots.parentModel !== undefined && !hasModelIdentity(snapshots.parentModel)) {
    missing.push('parentModel')
  }
  if (!Array.isArray(snapshots.scopedModelIds) || !snapshots.scopedModelIds.every(isNonemptyString)) {
    missing.push('scopedModelIds')
  }
  if (!Array.isArray(snapshots.availableModels) || !snapshots.availableModels.every(hasModelIdentity)) {
    missing.push('availableModels')
  }
  return missing
}

function isDiagnostic(value: unknown): boolean {
  const diagnostic = record(value)
  return Boolean(
    diagnostic &&
    isNonemptyString(diagnostic.code) &&
    isNonemptyString(diagnostic.message) &&
    (diagnostic.severity === 'error' || diagnostic.severity === 'warning' || diagnostic.severity === 'host-required'),
  )
}

function missingHostFacts(diagnostics: unknown[]): string[] | undefined {
  const facts = diagnostics
    .map(record)
    .filter(
      (diagnostic): diagnostic is Record<string, unknown> =>
        diagnostic !== undefined && (diagnostic.code === 'host_required' || diagnostic.severity === 'host-required'),
    )
    .map((diagnostic) =>
      typeof diagnostic.message === 'string' && diagnostic.message.trim() ? diagnostic.message : 'host_required',
    )
  return facts.length > 0 ? [...new Set(facts)] : undefined
}

/**
 * Read-only check before approval; verified is neither approval nor reservation.
 * Approve the exact returned selection, then use the existing launcher and its authoritative recheck.
 * Pass current parent/scope/model snapshots and runtimeSnapshotHost when resolving native MCP selectors.
 * Native Pi dispatch uses model: "provider/id:thinking"; do not set a separate child thinking field.
 * Resolve every workflow selection before dispatch, approve exact selections, then pass them unchanged to child steps.
 */
export async function verifySubagentRecommendation<Resolver extends ResolveSubagentLaunchContract>(input: {
  recommendation: RecommendationResult
  launch: Omit<Parameters<Resolver>[0], 'model' | 'thinking' | HostSnapshotKeys>
  host: CurrentHostSnapshots<Parameters<Resolver>[0]>
  resolveSubagentLaunchContract: Resolver
}): Promise<VerificationResult> {
  const { recommendation } = input
  if (recommendation.status !== 'recommended' && recommendation.status !== 'approval_required') {
    return {
      status: 'verification_failed',
      category: 'unresolved_contract',
      message: 'A recommendation with a selected model is required for launch verification.',
    }
  }

  if (record(input.launch)?.machine !== undefined) {
    return {
      status: 'verification_failed',
      category: 'unresolved_contract',
      message: 'Machine placement is outside native Pi launch preflight.',
    }
  }

  const missingSnapshots = invalidHostSnapshots(input.host)
  if (missingSnapshots.length > 0) {
    return {
      status: 'verification_failed',
      category: 'host_required',
      message: `Current host snapshots are required: ${missingSnapshots.join(', ')}.`,
      missingHostFacts: missingSnapshots,
    }
  }

  const { selection } = recommendation
  const launchModel = `${selection.provider}/${selection.model}:${selection.thinking}`
  const launchInputs = { ...input.launch } as Parameters<Resolver>[0]
  delete launchInputs.model
  delete launchInputs.thinking

  let resolved: Record<string, unknown> | undefined
  try {
    resolved = record(
      await input.resolveSubagentLaunchContract({
        ...launchInputs,
        ...input.host,
        model: launchModel,
      }),
    )
  } catch {
    return {
      status: 'verification_failed',
      category: 'unresolved_contract',
      message: 'The launch preflight could not resolve a contract.',
    }
  }

  if (!resolved || typeof resolved.ok !== 'boolean') {
    return {
      status: 'verification_failed',
      category: 'unresolved_contract',
      message: 'The launch preflight did not return a valid result.',
    }
  }
  if (!resolved.ok) {
    if (
      !isNonemptyString(resolved.code) ||
      !isNonemptyString(resolved.message) ||
      !Array.isArray(resolved.diagnostics) ||
      !resolved.diagnostics.every(isDiagnostic)
    ) {
      return {
        status: 'verification_failed',
        category: 'unresolved_contract',
        message: 'The launch preflight did not return a complete rejection.',
      }
    }

    const missingFacts = missingHostFacts(resolved.diagnostics)
    if (missingFacts) {
      return {
        status: 'verification_failed',
        category: 'host_required',
        message: missingFacts.join(' '),
        missingHostFacts: missingFacts,
      }
    }

    return {
      status: 'verification_failed',
      category: 'preflight_rejected',
      message: resolved.message,
    }
  }

  const contract = record(resolved.contract)
  const tools = record(contract?.tools)
  if (
    !contract ||
    !Array.isArray(contract.diagnostics) ||
    !contract.diagnostics.every(isDiagnostic) ||
    !tools ||
    !Array.isArray(tools.mcp) ||
    !tools.mcp.every(isMcpSelection)
  ) {
    return {
      status: 'verification_failed',
      category: 'unresolved_contract',
      message: 'The launch preflight did not return a complete launch contract.',
    }
  }

  const missingFacts = missingHostFacts(contract.diagnostics)
  if (missingFacts) {
    return {
      status: 'verification_failed',
      category: 'host_required',
      message: missingFacts.join(' '),
      missingHostFacts: missingFacts,
    }
  }

  const blockingMessages = contract.diagnostics
    .map(record)
    .filter((diagnostic): diagnostic is Record<string, unknown> => diagnostic?.severity === 'error')
    .map((diagnostic) => diagnostic.message)
    .filter(isNonemptyString)
  if (blockingMessages.length > 0) {
    return {
      status: 'verification_failed',
      category: 'preflight_rejected',
      message: blockingMessages.join(' '),
    }
  }

  if (tools.mcp.length > 0 && !isRuntimeSnapshotHost(input.host.runtimeSnapshotHost)) {
    return {
      status: 'verification_failed',
      category: 'host_required',
      message: 'Current host snapshots are required: runtimeSnapshotHost.',
      missingHostFacts: ['runtimeSnapshotHost'],
    }
  }

  if (typeof contract.model !== 'string' || typeof contract.thinking !== 'string') {
    return {
      status: 'verification_failed',
      category: 'unresolved_contract',
      message: 'The launch preflight did not resolve a native Pi model and thinking level.',
    }
  }

  if (contract.model !== launchModel || contract.thinking !== selection.thinking) {
    return {
      status: 'verification_failed',
      category: 'selection_conflict',
      message: 'The resolved provider, model, or thinking level differs from the recommendation.',
    }
  }

  return { status: 'verified', selection: { ...selection } }
}
