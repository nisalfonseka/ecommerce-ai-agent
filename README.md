# AI Commerce Engine (ACE)

A multi-tenant AI sales and support assistant for online stores. The agent talks to a universal commerce contract;
each store platform plugs in through an adapter.

- Rules for contributors and AI agents: [AGENTS.md](AGENTS.md)
- How the system works end to end: [docs/workflow.md](docs/workflow.md)
- Design: [docs/superpowers/specs/2026-10-08-ai-commerce-engine-design.md](docs/superpowers/specs/2026-10-08-ai-commerce-engine-design.md)
- Roadmap: [docs/superpowers/plans/2026-10-08-roadmap.md](docs/superpowers/plans/2026-10-08-roadmap.md)

## Quick start

```bash
corepack enable
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

## Packages

| Package | Purpose |
|---|---|
| `@ace/contracts` | Commerce contract: schemas, `CommerceProvider`, errors, capabilities, conformance suite |
| `@ace/adapter-memory` | In-memory LKR clothing store used by tests, evals and local development |

Product name is a placeholder (not final); hosting target is a VPS with Docker Compose.
