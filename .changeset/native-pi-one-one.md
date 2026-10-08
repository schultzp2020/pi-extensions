---
'@schultzp2020/pi-cursor': major
'@schultzp2020/pi-model-advisor': major
---

Require Pi 1.1.0 or later and use its current native APIs.

Model Advisor no longer supplies a separate llama.cpp provider. Remove any loading shim that imports its `llama-cpp-provider` export or build file before upgrading, and leave Pi's built-in llama.cpp extension enabled. Decision-model support requires llama.cpp 0.6.0 or later. Classifier configuration remains explicit. Invalid candidate token limits exclude only the affected model, with diagnostics.

Pi Cursor drops compatibility branches for older Pi versions while retaining its supported provider registration, authentication and proxy behavior.
