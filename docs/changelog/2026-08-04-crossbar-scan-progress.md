# Feature: Animated progress indicator during `/crossbar` rescan

## Problem

When the user triggers a `/crossbar` rescan, the UI shows the server selector and nothing else — no visual feedback that scanning is in progress. On a LAN with many hosts this can take several seconds, leaving the user wondering if the action worked.

## Proposed solution

Replace the static footer text with an animated overlay that shows:

- **Spinner** — auto-animated via `CancellableLoader` from `@earendil-works/pi-tui`
- **Progress** — percentage of origins probed (e.g. `27%`)
- **Servers found** — live count of discovered servers (e.g. `2 servers found`)
- **Abort support** — `ESC` to cancel the scan mid-flight

Message format:

```
Crossbar: scanning for model servers… 27% — 2 servers found — ESC to abort
```

## Implementation notes

- `ProgressCallback` type added to discovery engine: `(completed, total, serversFound) => void`
- `discoverLocalhost()` and `discoverLan()` call the progress callback after each origin probe
- `CancellableLoader` from `@earendil-works/pi-tui` handles Escape → `AbortController` → stops scan
- `AbortError` caught and reported as "Crossbar: scan aborted."
