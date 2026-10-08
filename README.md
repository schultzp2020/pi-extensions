# Pi Extensions

A monorepo for [Pi](https://github.com/badlogic/pi) coding agent extensions.

## Packages

| Package                                        | Description                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| [pi-cursor](packages/pi-cursor/)               | Access Cursor subscription models in Pi via a local OpenAI-compatible proxy |
| [pi-model-advisor](packages/pi-model-advisor/) | Recommend Pi chat models and thinking levels using native classifiers       |

Both extensions require Pi 1.1.0 or later. See the [Pi 1.1.0 migration guide](docs/pi-1.1.0-migration.md) before upgrading.

## Development

```bash
pnpm install          # Install all workspace dependencies
pnpm run build        # Build all packages
pnpm test             # Test all packages
pnpm run lint         # Lint all packages
pnpm run format       # Format all packages
```

## License

[MIT](LICENSE)
