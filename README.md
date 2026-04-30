<div align="center">

<img src="assets/seedy.png" alt="Seedy - PulSeed mascot" width="120" />

# PulSeed

Keep a goal moving until it is actually done.

[![Website](https://img.shields.io/badge/Website-pulseed.dev-blue?style=for-the-badge)](https://pulseed.dev)
[![npm](https://img.shields.io/npm/v/pulseed.svg?style=for-the-badge)](https://www.npmjs.com/package/pulseed)
[![Downloads](https://img.shields.io/npm/dm/pulseed.svg?style=for-the-badge)](https://www.npmjs.com/package/pulseed)
[![CI](https://img.shields.io/github/actions/workflow/status/my-name-is-yu/PulSeed/ci.yml?branch=main&style=for-the-badge&label=CI)](https://github.com/my-name-is-yu/PulSeed/actions/workflows/ci.yml)
[![Node.js 22/24](https://img.shields.io/badge/node-22%20%2F%2024-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![MIT License](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

</div>

PulSeed is an AI orchestrator for work that does not finish in one chat turn.
Tell it the outcome you want, and it keeps observing, delegating, verifying, and
looping until the goal is reached or the plan needs to change.

The primary entry point is `pulseed`. The normal flow is natural language, not a
menu of subcommands.

## Get Started

PulSeed supports Node.js 22 or 24.

Quick install (macOS / Linux):

```bash
curl -fsSL https://raw.githubusercontent.com/my-name-is-yu/PulSeed/main/scripts/install.sh | bash
```

Quick install (Windows / PowerShell):

```powershell
irm https://raw.githubusercontent.com/my-name-is-yu/PulSeed/main/scripts/install.ps1 | iex
```

Then start PulSeed:

```bash
pulseed
```

For pinned-tag installs, fallback npm installs, and installer flags, see [Getting Started](docs/getting-started.md).

Then describe the goal in natural language:

- `Increase test coverage to 90%.`
- `Show me the current progress.`
- `Keep this goal moving in the background.`

PulSeed will guide provider and adapter setup when needed.

## Links

- [Get Started](docs/getting-started.md)
- [Docs Index](docs/index.md)
- [Runtime](docs/runtime.md)
- [Configuration](docs/configuration.md)
- [Status](docs/status.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

## Why PulSeed?

- Goal-first orchestration for long-running work
- Honest goal negotiation when a target is not realistic as stated
- Bounded agent execution with verification around delegated work
- Verified playbook memory that turns successful runs into reusable planning hints
- Local persistent state under `~/.pulseed/`
- Multiple runtime surfaces: CLI, chat, TUI, daemon, and cron
- Support for OpenAI, Anthropic, Ollama, and adapter-based execution paths

## What It Does

- `CoreLoop` keeps a goal moving and decides whether to continue, refine,
  verify, or stop
- `AgentLoop` handles bounded tool-using work for task execution, chat, and
  selected runtime phases
- Centralized AgentLoop profiles keep task execution isolated by default,
  narrow chat permissions, and run `/review` through a dedicated read-only
  review posture
- Dream-backed playbooks can feed verified workflow hints into later task
  generation without auto-writing executable skills
- State, reports, schedules, and local memory live under `~/.pulseed/`
- Software-level approval and verification gates protect delegated work

## Common Surfaces

- `pulseed` for the primary interactive workflow
- `pulseed tui` for the terminal UI
- `pulseed start` and `pulseed stop` for daemon control
- `pulseed schedule ...` for schedule management
- Lower-level commands for scripting, diagnostics, and compatibility

## Achievements

PulSeed joined [Kaggle Playground Series S6E4](https://www.kaggle.com/competitions/playground-series-s6e4).

| Area | Result |
| --- | --- |
| Long-running workflow | It has been running straight over 10 hours and made decent progress. |
| Local OOF balanced accuracy | Improved from early 0.45-level baselines to `0.970413051791`. |
| Exploration path | CatBoost-focused ensembles, probability adjustment, and post-OOF calibration. |
| Current best local artifact | Preserved full OOF predictions and per-class recall. |

Current best per-class recall:

- High: `0.957351611214`
- Low: `0.994598788377`
- Medium: `0.959288755783`

## Docs and Community

Start with the public doc map:

- [Getting Started](docs/getting-started.md)
- [Runtime](docs/runtime.md)
- [Mechanism](docs/mechanism.md)
- [Configuration](docs/configuration.md)
- [Architecture Map](docs/architecture-map.md)

For project participation:

- read [Contributing](CONTRIBUTING.md) before opening a pull request
- use [Issues](https://github.com/my-name-is-yu/PulSeed/issues) for bugs and
  feature proposals
- follow the [Code of Conduct](CODE_OF_CONDUCT.md)

## Safety Boundary

PulSeed uses approval gates and verification around delegated work. Native
`agent_loop` task execution can use isolated git worktrees, and supported CLI
adapters can be wrapped with a Docker terminal backend. These reduce blast
radius, but local backends and plugins still run with the user's privileges. See
[Security](SECURITY.md).

## License

MIT
