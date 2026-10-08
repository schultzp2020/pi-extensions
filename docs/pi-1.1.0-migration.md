# Migrate extensions to Pi 1.1.0

Both Pi Cursor and Pi Model Advisor require Pi 1.1.0 or later. Development and compatibility checks target Pi 1.1.0.

## Model Advisor

Before upgrading Model Advisor, remove any extension shim that imports `@schultzp2020/pi-model-advisor/llama-cpp-provider` or its `dist/llama-cpp-provider.js` file. That export and implementation are removed. Restart Pi after upgrading.

Keep Pi's built-in `llama.cpp` extension enabled. Configure the router through Pi's `/login llama.cpp` or `LLAMA_BASE_URL` and optional `LLAMA_API_KEY`. Existing router configuration remains yours; this migration does not change credentials, server settings, model loading policy, or the configured Advisor classifier.

Pi 1.1.0 discovers decision models from `architecture.output_modalities`, exposes them as classifiers, and routes their requests to `/v1/systemone`. Decision-only models do not appear as chat choices. This requires llama.cpp 0.6.0 or later; older servers do not provide the decision metadata. Ordinary chat models remain available as next-token classifiers.

Classifier selection remains explicit in `model-advisor.json`. OpenAI's `openai/gpt-6-luna` is an optional classifier; it requires API-key authentication rather than ChatGPT/Codex login. Pi's documentation notes that an `openai` login can take precedence over `OPENAI_API_KEY`; resolve that authentication choice explicitly before configuring Luna. The Advisor does not switch classifiers, rewrite provider identities, or add image input.

Invalid candidate context or output token limits exclude the affected model with a diagnostic. Other valid candidates remain usable. The Advisor never invents replacement limits.

## Pi Cursor

Cursor continues using Pi's supported provider registration interface and current public streaming APIs. Compatibility branches for older Pi versions are removed. Cursor proxy transport, authentication and model-variant compatibility remain in scope; this is not a rewrite onto a different provider architecture.

## Native-provider validation gaps

Pi 1.1.0's native provider matches the removed provider's core discovery and classification routing, but not all defensive checks. Source inspection found:

- Native router catalog validation checks model IDs and status values, but does not validate every modality array or status-argument element.
- Native context-window extraction and offline catalog restoration are less strict about positive safe-integer token limits than the removed provider.

Advisor rejects invalid candidate token limits at its own recommendation interface. It cannot prevent failures inside Pi's catalog parsing, or guarantee that native classifier metadata is sanitized before inference. Treat router responses and cached catalogs accordingly. These gaps are recorded here for upstream follow-up; no runtime patch or replacement provider is installed, and no upstream report was posted.

Historical Pi 1.0.4 specs and tickets describe the previous implementation, not this migration's compatibility baseline.

References: [Pi 1.1.0 release](https://pi.dev/changelog/releases/1.1.0), [native llama.cpp classification](https://pi.dev/docs/latest/llama-cpp#classification), [classifier models](https://pi.dev/docs/latest/models#use-classifier-models).
