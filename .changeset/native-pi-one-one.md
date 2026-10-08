---
'@schultzp2020/pi-model-advisor': major
---

Require Pi 1.1.0 or later and use its current native APIs.

Model Advisor uses Pi's built-in llama.cpp provider for discovery, authentication and classification. Decision-model support requires llama.cpp 0.6.0 or later. Classifier configuration remains explicit. Invalid candidate token limits exclude only the affected model, with diagnostics.
