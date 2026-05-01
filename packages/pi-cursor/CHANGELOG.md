# @schultzp2020/pi-cursor

## 0.1.3

### Patch Changes

- [#6](https://github.com/schultzp2020/pi-extensions/pull/6) [`2a1414a`](https://github.com/schultzp2020/pi-extensions/commit/2a1414aa4e5197cf540ec97ffce36f547a39fcc6) Thanks [@schultzp2020](https://github.com/schultzp2020)! - Fix duplicate model discovery on proxy startup

  When connecting to an existing proxy, `connectToProxy` called `/internal/refresh-models` which triggered a full `discoverCursorModels()` round-trip to Cursor's API — even though the proxy already had fresh models cached from startup. This caused the `Discovered N models via AvailableModels` log to appear twice.

  Added a `GET /internal/models` endpoint that returns cached models without re-discovering, and switched `connectToProxy` to use it. The `/internal/refresh-models` POST endpoint is preserved for explicit refresh scenarios.

## 0.1.2

### Patch Changes

- [#4](https://github.com/schultzp2020/pi-extensions/pull/4) [`8e4b481`](https://github.com/schultzp2020/pi-extensions/commit/8e4b4811a2f2ac65dd4f44dc491730fb6b7b7b38) Thanks [@schultzp2020](https://github.com/schultzp2020)! - Updated README login instructions: clarified provider dropdown selection, simplified install command, and added Windows note about console window during OAuth.

## 0.1.1

### Patch Changes

- [#2](https://github.com/schultzp2020/pi-extensions/pull/2) [`93092ee`](https://github.com/schultzp2020/pi-extensions/commit/93092eed7d8f4f56b0d169c5a2cec47ecda6ba06) Thanks [@schultzp2020](https://github.com/schultzp2020)! - Fix npm install command in README to use scoped package name.
