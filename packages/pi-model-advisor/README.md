# Pi Model Advisor

A Pi 1.1.0+ extension and reusable core that recommends an eligible chat model and thinking level for an explicitly supplied subtask. It does not switch the parent model, read the parent transcript, approve a recommendation, or launch an agent.

## Requirements

- Pi 1.1.0 or later; package development and tests target exact Pi 1.1.0 dependencies.
- An authenticated Pi classifier and at least one eligible chat model for recommendations.
- For local classification, Pi's built-in `llama.cpp` provider enabled and an authenticated local router. Decision-model classification requires llama.cpp 0.6.0 or later; the Advisor does not start or configure the server.

## Install

After the package is released:

```sh
pi install npm:@schultzp2020/pi-model-advisor
```

The package manifest loads only the Advisor extension. For development, build the package first and load `dist/index.js` as an extension. Installation does not configure a classifier or model policy.

## Configure Pi's classifier

Pi owns classifier discovery, provider registration, authentication, transport, retries, cancellation, and usage accounting. The Advisor selects one exact classifier identity from Pi's authenticated classifier inventory; it does not infer a classifier from model names or make a chat request in place of classification.

Authenticate the provider in Pi with `/login <provider>` or its documented environment variable. For example, OpenRouter supports `/login openrouter` or `OPENROUTER_API_KEY`. Pi exposes available classifiers separately from chat models; configured `provider` and `model` must match one exact authenticated entry. See Pi's [classifier model documentation](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/models.md#use-classifier-models).

### Local classification with Pi's built-in llama.cpp

Use Pi's built-in `llama.cpp` provider. The Advisor does not register a replacement provider or configure authentication or server settings automatically.

Start `llama-server` in router mode (without `--model` or `-m`), then configure Pi with `/login llama.cpp` or `LLAMA_BASE_URL` and optional `LLAMA_API_KEY`. Pi's built-in provider handles model discovery, authentication, chat/classifier dispatch, cancellation, and usage. Ordinary chat models also appear as classifiers; decision-only models appear only as classifiers. llama.cpp 0.6.0+ reports decision models through `architecture.output_modalities: ["decisions"]` and serves typed decisions at `/v1/systemone`. Older servers may omit this metadata, so Pi cannot identify decision-only models correctly. See Pi's [llama.cpp guide](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/llama-cpp.md).

OpenAI's GPT-6 Luna is an optional hosted classifier. It requires OpenAI API-key authentication (`OPENAI_API_KEY`); ChatGPT/Codex login does not authenticate the Decisions API. If `openai` is logged in with ChatGPT credentials, `/logout openai` before relying on `OPENAI_API_KEY`, or sign in with an API key. Configure the exact `openai` classifier identity and authenticate it explicitly. The Advisor does not switch providers automatically or expand image-input support. The Advisor starts no server and never falls back to a hosted classifier. A provider ID alone does not prove endpoint location or data handling.

## Configure the advisor

Create `<getAgentDir()>/model-advisor.json`; Pi's `PI_CODING_AGENT_DIR` environment variable selects the agent directory. Configuration is global-only: project files cannot change the classifier or model classifications. It is strictly validated at extension initialization and Pi's `/reload` boundary. Editing the file alone does not change the active snapshot. An invalid configuration disables recommendations rather than restoring an older snapshot.

```json
{
  "classifier": { "provider": "openrouter", "model": "typesafe/jev-1.13" },
  "models": {
    "light": [
      {
        "provider": "openai",
        "model": "gpt-6-luna",
        "thinking": { "minimum": "max", "maximum": "max" }
      },
      {
        "provider": "openai-codex",
        "model": "gpt-6-luna",
        "thinking": { "minimum": "max", "maximum": "max" }
      }
    ],
    "standard": [
      { "provider": "openai", "model": "gpt-6-sol" },
      { "provider": "openai-codex", "model": "gpt-6-sol" }
    ],
    "advanced": [
      { "provider": "openai", "model": "gpt-6.1-sol" },
      { "provider": "openai-codex", "model": "gpt-6.1-sol" }
    ],
    "frontier": [
      { "provider": "openai", "model": "gpt-6-astra" },
      { "provider": "openai-codex", "model": "gpt-6-astra" }
    ]
  },
  "tasks": {
    "plan": {
      "description": "Design an approach and implementation steps from requirements.",
      "levels": ["advanced", "frontier"]
    },
    "implement": {
      "description": "Change code and tests, including fixes and refactoring.",
      "levels": ["light"]
    },
    "review": { "description": "Assess correctness, security, and regressions.", "levels": ["advanced", "frontier"] },
    "research": {
      "description": "Investigate sources and summarize evidence-backed findings.",
      "levels": ["standard", "advanced"]
    },
    "pull_request": {
      "description": "Prepare a PR title and body from verified changes and test results.",
      "levels": ["standard", "advanced"]
    }
  }
}
```

The `openai` work identity and `openai-codex` personal identity are distinct even when their model IDs match; preserve the provider returned in every selection. Both Luna entries are `light` and pinned to `max` only. A caller ceiling below `max` makes Luna ineligible; the advisor never lowers its effort. These capability assignments are explicit user policy, not judgments inferred from names. Add other chat models only after checking their exact Pi provider/model IDs and deciding their capability.

`models` groups exact `{ "provider", "model" }` chat identities under `light`, `standard`, `advanced`, or `frontier`; optional `priority` and per-model `thinking` bounds override defaults. Omitted models are unclassified and cannot be selected. Duplicate identities and unknown keys are configuration errors. Model availability and classifier availability come from Pi, not an independent catalog.

Task profiles are configuration-only. Any exact configured name is accepted; unknown `taskKind` values are invalid. A profile can be a capability array or an object with required `levels` and optional `description`. Descriptions are explicit classifier data, not permission to override bounds. The profile names above are a starter example, not built-in defaults: omitted `tasks` means no selected profile, and an omitted request `taskKind` never infers one. Empty task or request level arrays block selection, including escalation. Array order does not set model priority.

Defaults when omitted:

- Global thinking range: `off` through `max`; per-model thinking uses the same range unless overridden.
- Capability percentile: `75`; high-consequence floors: `advanced` at `0.70`, `frontier` at `0.90`.
- Overall classifier deadline: `60000` ms, covering Pi's native attempts.
- Persistent advisor logs omit task state (`logging.includeTask: false`).

See the [configuration contract](https://github.com/schultzp2020/pi-extensions/blob/main/docs/pi-model-advisor.openapi.yaml) for every field and default.

## Recommend

Use the ordinary Pi tool `recommend_subagent_model` for structured requests, or `/model-advisor recommend <task>` for a task-only preview. Bare `/model-advisor` shows status. Other forms are `/model-advisor models`, `/model-advisor config`, `/model-advisor doctor`, and `/model-advisor doctor --connectivity`. The models command reports eligible, unclassified, unavailable, and out-of-scope configured chat models. Doctor does not classify by default; `--connectivity` explicitly makes a small native classifier probe. Configuration edits take effect after extension initialization or `/reload`.

The tool accepts explicit task state, optional configured `taskKind`, descriptive `role` and `context`, hard requirements, and hard caller capability `levels`. Supported requirements include image input, minimum context window, provider allowlist, and minimum/maximum thinking. The advisor does not supply candidates from an independent catalog. A nonempty Pi scoped-model list is the candidate boundary; otherwise Pi's authenticated available chat models are used. Virtual models are excluded.

One native classifier call evaluates three ordered `choice` questions (`required_capability`, `reasoning_effort`, `context_demand`) and one `bool` question (`high_consequence`). Calibrate the configured classifier against this policy: capability is the configured percentile of the ordered probability distribution, not a score expectation or confidence; effort and context use the validated choice labels. Consequence floors apply independently. Classifier failures and malformed answers are typed failures. Pi's native retries remain in use; there is no correction call, secondary classifier, generated rationale, fallback, or worker execution.

Selection prefers the lowest sufficient compatible capability in the task profile's normal levels intersected with every hard caller bound. Only if that pool has no sufficient model may a higher sufficient capability be returned as `approval_required`, and then only within all hard bounds. `approval_required` is a proposal: obtain fresh approval of that exact provider/model/thinking tuple before proceeding. A `recommended` result is not universal launch permission; the caller's own launch policy still applies. No eligible model means no recommendation, never a relaxed capability floor or bound.

Thinking uses Pi's supported-level helpers and ordered levels `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Global, per-model, and caller minimum/maximum bounds intersect; incompatible candidates are excluded. Model priority wins among otherwise suitable models, then larger context is preferred for broad or exceptional context demand, followed by output, input, and cache-read price, then exact provider/model identity. Price is a late tie-breaker, not a quality signal.

Results are discriminated by `status`: `recommended`, `approval_required`, `configuration_error`, `no_eligible_model`, `classifier_failed`, or `aborted`. The Pi tool declares a TypeBox output schema and returns matching `structuredContent`, with reported classifier usage forwarded to Pi's session accounting. Invalid requests are rejected by schema/input validation rather than represented as result statuses.

## Orchestrator handoff

Paseo and pure-Pi orchestrators use the same ordinary `recommend_subagent_model` tool; neither needs a Paseo-specific adapter. For example, request `{ "task": "Implement the bounded change.", "taskKind": "implement" }`, then pass the returned selection to the caller's own launch policy. Preserve the provider exactly: work `openai/gpt-6-luna` dispatches as `openai/gpt-6-luna:max`, while personal `openai-codex/gpt-6-luna` dispatches as `openai-codex/gpt-6-luna:max`. The advisor does not own either launch or approval UI.

For a native Pi child workflow, resolve each selection and any required approval before dispatch. Dispatch the exact Pi model string in the launch's `model` field as `provider/id:thinking`; do not rely on a separate top-level child `thinking` field. Do not call a classifier from a sandboxed workflow script: obtain the recommendation through the advisor tool/core boundary, not `models.classify()` inside the script. Do not translate recommendations to external CLI model syntax. If a workflow prepares multiple children, resolve and approve all selections before dispatching them.

### Optional pi-subagents preflight

Import `verifySubagentRecommendation` only from `@schultzp2020/pi-model-advisor/pi-subagents`. Inject the public resolver from the caller's `pi-subagents/preflight` installation. This optional entry has no runtime import of `pi-subagents`; default extension and core imports do not need that package. The example assumes the caller already has the recommendation, intended launch inputs, and current Pi snapshots; include `parentModel` explicitly even when it is `undefined`.

```ts
import { verifySubagentRecommendation } from '@schultzp2020/pi-model-advisor/pi-subagents'
import { resolveSubagentLaunchContract } from 'pi-subagents/preflight'

const launch = { agent: 'worker', cwd, task, context: 'fresh' as const }
const verification = await verifySubagentRecommendation({
  recommendation,
  launch,
  host: {
    parentModel, // include the current value; use undefined explicitly when there is no parent model
    scopedModelIds, // current provider/id scope; [] means unscoped
    availableModels, // current Pi chat-model snapshot
    runtimeSnapshotHost, // supply the calling Pi host when resolving native MCP selectors
  },
  resolveSubagentLaunchContract,
})

if (verification.status !== 'verified') throw new Error(verification.message)
// Obtain fresh approval of this exact selection here; approval_required always requires it.
// Continue only after the caller's approval flow succeeds; verification is not approval.
const approvedSelection = verification.selection
const launchModel = `${approvedSelection.provider}/${approvedSelection.model}:${approvedSelection.thinking}`
// Pass launchModel as `model` to the caller's existing native Pi launcher; launch rechecks policy.
```

Preflight is read-only, neither approval nor reservation. A rejection, missing host fact, unresolved contract, or changed selection blocks this handoff; it does not substitute a model or reclassify. `approval_required` still needs fresh exact user approval after verification. The public-contract compatibility tests target `pi-subagents` 0.76.1. Install and configure that package separately if using this optional integration.

## Privacy and diagnostics

Classification sends the explicit task, selected profile description, role, caller context, and requirements to the configured Pi classifier; hosted providers may receive that data. The advisor does not read the parent transcript. Task state is untrusted input; classifier instructions do not guarantee injection resistance. By default persistent advisor metadata omits task text, role, context, and raw provider errors; `logging.includeTask: true` opts into recording the supplied task state. Pi may separately retain tool arguments and session transcripts. Provider names alone do not establish locality or retention guarantees.

`/model-advisor config` shows the active configuration and reload boundary, not credentials. `/model-advisor doctor` validates configuration and inventory without inference; use `--connectivity` only when you explicitly want a native classifier call. Missing or unavailable configured classifier disables recommendations; local failures never switch to hosted inference.

## Reuse the core

`@schultzp2020/pi-model-advisor/core` exports the injectable `recommendSubagentModel` operation, request/result schemas and types, strict configuration validation, and classifier operation types. Supply a validated configuration snapshot, Pi-derived chat candidate snapshot, injected native-classifier operation, Pi thinking helpers, and optional abort signal. The reusable core does not require `ExtensionContext`; discovery and Pi registration remain adapter responsibilities.

## Development checks

Run checks from the repository root:

```sh
pnpm --filter @schultzp2020/pi-model-advisor build
pnpm --filter @schultzp2020/pi-model-advisor test
pnpm --filter @schultzp2020/pi-model-advisor lint
pnpm --filter @schultzp2020/pi-model-advisor format:check
```

Core tests use injected classifier results and Pi snapshots. The native llama.cpp integration test loads Pi 1.1.0's built-in extension against a localhost mock server. Tests need no credentials, external network, paid inference, or running llama.cpp server. Do not run live classifier or worker calls for normal verification.

## License

MIT. See [LICENSE](LICENSE).
