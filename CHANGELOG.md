# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Features

- Programmatic provider preload: async factory preloads enabled servers with cached `lastKnownModels`
  before Pi model resolution. Enables `--list-models`, print/JSON/RPC, CLI selection, and `--offline`
  from persisted catalogue with no network or `/crossbar` session. (`src/preload.ts`,
  `registerCachedServer`, `setLastKnownModels`, `catalogueChanged`).
- Discovery settings UI: `/crossbar → ⚙ Discovery settings` toggles LAN discovery and edits the LAN
  host / probe-port lists, persisted to `crossbar.json` and applied on the next scan.
- LAN subnet auto-scan: enabling LAN discovery with no explicit hosts now auto-detects the machine's
  own private subnet(s) at runtime (`src/discovery/subnet.ts`) and sweeps them; host entries accept
  CIDR (`10.0.1.0/24`) and ranges (`10.0.1.10-50`), expanded and capped at 1024 addresses.
- Faster LAN sweep: a `livenessFirst` gate in `discoverLan` does one cheap probe per address before the
  adapter fan-out, so dead IPs cost a single socket and concurrency can run at 128. A full `/24` sweep
  drops from ~44 s to ~3 s.

### Documentation

- Updated README, ARCHITECTURE, CHANGELOG, and RESEARCH notes for two-phase startup (factory preload
  from cache; `session_start` live), cold-start limitation, and removal of the temporary "No models
  available" text.
- Added regression coverage and CLI integration tests.

### Bug Fixes

- Register keyless local providers with a resolved non-secret placeholder so Pi can send requests.
- Make `/crossbar` navigation persistent, add Back/rescan paths, and show loaded models in a detail view.
- Register newly added servers immediately and select models through Pi's extension API.
- Persist `CrossbarSettings` (LAN discovery, hosts, probe ports) across server mutations — the registry
  now round-trips settings in `flush()`, so adding/toggling a server no longer wipes them from `crossbar.json`.

## [0.3.0](https://github.com/Hypabolic/Crossbar/releases/tag/v0.3.0) — 2026-06-21

### Features
- Enable/disable action, LAN discovery wiring, doc sync (#9) ([9db6c8b](https://github.com/Hypabolic/Crossbar/commit/9db6c8bd91d36d4dae176e2d52cdde18eff56e66))
- Wire health poll, model refresh, and shutdown cleanup (#8) ([9a2706f](https://github.com/Hypabolic/Crossbar/commit/9a2706f5bb9c017ae913c9a140c23250c309c523))

### Documentation
- V0.2.0 [skip ci] ([bcae342](https://github.com/Hypabolic/Crossbar/commit/bcae342392983a09df6dc117cd057922bae2b582))

### Build & CI
- Correct git-cliff notes per trigger; link hypabolic.com (#7) ([4515950](https://github.com/Hypabolic/Crossbar/commit/45159500c59085a50afb8f654ab68e87fb0bfec2))

## [0.2.0](https://github.com/Hypabolic/Crossbar/releases/tag/v0.2.0) — 2026-06-21

### Features
- Wire capability-driven manage overlay into /crossbar (#2) ([c52657c](https://github.com/Hypabolic/Crossbar/commit/c52657ca4886c2215806a9887df9c127b0b9a718))
- Register operative context window + record cache hits (#1) ([48abcbd](https://github.com/Hypabolic/Crossbar/commit/48abcbdee011892b64796040b26530a7a5ba1987))

### Documentation
- Trim release/OIDC details and demo section from README (#5) ([1ea7395](https://github.com/Hypabolic/Crossbar/commit/1ea739594e8cf63b5dc5c615a93d9e2d30bd7768))
- Add onboarding demo GIF + fake LM Studio server (#3) ([566af9b](https://github.com/Hypabolic/Crossbar/commit/566af9b2961826a8ec3bd0525db831f05fc2d70e))
- Add CHANGELOG + git-cliff release notes ([b38653d](https://github.com/Hypabolic/Crossbar/commit/b38653d5efcfa65901ac8dee6bc6763979595c53))

### Build & CI
- Tag-input workflow_dispatch (mirror Hypa), no auto-bump (#6) ([5c013c3](https://github.com/Hypabolic/Crossbar/commit/5c013c3a4d50d8ab3af4595382b3e764a9ea460b))
- Create a GitHub Release per version ([ee77122](https://github.com/Hypabolic/Crossbar/commit/ee77122479173eea38051538a8fa9f067ba5fa03))

## [0.1.1](https://github.com/Hypabolic/Crossbar/releases/tag/v0.1.1) — 2026-06-21

### Features
- Crossbar — local/self-hosted inference connector for Pi ([3440963](https://github.com/Hypabolic/Crossbar/commit/34409638103b9114a71a66dd7cfdbc095c571ed5))

### Bug Fixes
- Provenance repository field + LM Studio native v1 API ([d44e789](https://github.com/Hypabolic/Crossbar/commit/d44e7897e11c435058942548c94dd45841eaa956))

### Build & CI
- Publish via npm OIDC trusted publishing (drop NPM_TOKEN) ([4c33586](https://github.com/Hypabolic/Crossbar/commit/4c3358664e82cac2b38fd684c9db66e109d42c4e))
- Bump actions/checkout & setup-node to v5 ([9b3d33f](https://github.com/Hypabolic/Crossbar/commit/9b3d33f76d63a4dcb6eb1a03eb7f74d14ba2c4f6))
- GitHub Actions for test + provenance npm release ([e1d9859](https://github.com/Hypabolic/Crossbar/commit/e1d9859f46b2c1673a2819804d986017bbf4ace6))

<!-- v0.1.0 was an initial manual seed publish; automated releases start at v0.1.1. -->
