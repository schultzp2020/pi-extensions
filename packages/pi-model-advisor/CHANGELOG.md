# @schultzp2020/pi-model-advisor

## 1.0.0

### Major Changes

- [#53](https://github.com/schultzp2020/pi-extensions/pull/53) [`110fc05`](https://github.com/schultzp2020/pi-extensions/commit/110fc055cf13436275ce76bb6097bf6308d9e5a7) Thanks [@schultzp2020](https://github.com/schultzp2020)! - Require Pi 1.1.0 or later and use its current native APIs.

  Model Advisor uses Pi's built-in llama.cpp provider for discovery, authentication and classification. Decision-model support requires llama.cpp 0.6.0 or later. Classifier configuration remains explicit. Invalid candidate token limits exclude only the affected model, with diagnostics.
