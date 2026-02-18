# Contributing to Open-Inspect

Thank you for your interest in contributing to Open-Inspect! This document provides guidelines for
contributing to the project.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR-USERNAME/open-inspect.git`
3. Run the setup script: `bash .openinspect/setup.sh`
4. Create a branch for your changes: `git checkout -b feature/your-feature-name`

## Development Setup

The quickest way to get a working environment:

```bash
bash .openinspect/setup.sh
```

This handles npm dependencies, builds the shared package, configures git hooks (husky +
lint-staged), and optionally sets up a Python virtualenv for `packages/modal-infra`.

See [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) for full deployment instructions.

For manual setup or individual steps:

```bash
# Install dependencies
npm install

# Build shared package
npm run build -w @open-inspect/shared

# Run type checking
npm run typecheck

# Run linting
npm run lint

# Run tests
npm test
```

## Project Structure

| Package                  | Description                          |
| ------------------------ | ------------------------------------ |
| `packages/control-plane` | Cloudflare Workers + Durable Objects |
| `packages/web`           | Next.js web application              |
| `packages/modal-infra`   | Modal sandbox infrastructure         |
| `packages/shared`        | Shared types and utilities           |

## Making Changes

### Code Style

- Run `npm run lint` before committing
- Run `npm run typecheck` to ensure type safety
- Follow existing code patterns in the codebase

### Commit Messages

Use clear, descriptive commit messages:

- `feat: add new feature`
- `fix: resolve issue with X`
- `docs: update documentation`
- `refactor: restructure module`

### Pull Requests

1. Ensure all tests pass: `npm test`
2. Ensure linting passes: `npm run lint`
3. Ensure type checking passes: `npm run typecheck`
4. Update documentation if needed
5. Provide a clear description of your changes

### Source Control Provider Contributions

For SCM/provider changes, follow:

- `docs/adr/0001-single-provider-scm-boundaries.md`
- `docs/provider-contribution-checklist.md`

## Reporting Issues

When reporting issues, please include:

- A clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Node version, etc.)

## Questions

If you have questions, please open a GitHub issue with the "question" label.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
