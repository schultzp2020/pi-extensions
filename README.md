# Pi Extensions

A monorepo for [Pi](https://github.com/badlogic/pi) coding agent extensions.

## Packages

| Package                                        | Description                                                           |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| [pi-model-advisor](packages/pi-model-advisor/) | Recommend Pi chat models and thinking levels using native classifiers |

Model Advisor requires Pi 1.1.0 or later. See the [native Pi integration notes](docs/pi-1.1.0.md).

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
