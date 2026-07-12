# Pi Scope Extension

A lightweight, local-first pi agent extension that observes agent lifecycle hooks and streams telemetry in real-time to a local Pi Scope server.

## Features

- **Monotonic Event Sequencing:** Automatically assigns zero-indexed sequence numbers (`seq`) per session.
- **Fire-and-Forget Queueing:** Runs non-blocking background queue with up to 10k items, dropping older items on overflow.
- **Exponential Backoff:** Gracefully handles server dropouts, backing off flushes exponentially (250ms -> 5s).
- **Auto-Environment Resolution:** Auto-loads `.env` and `.env.local` from the active directory at session start.
- **Payload Safety Truncation:** Gracefully truncates heavy payloads (tool outputs, prompts) to keep communication lightweight.

## Installation & Load

Simply pass the `-e` or `--extension` flag to load the extension:

```bash
pi -e ./extension/pi-scope.ts
```

Alternatively, add the path to your local `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/absolute/path/to/extension/pi-scope.ts"
  ]
}
```

## Configuration

You can configure the telemetry stream using CLI flags or environment variables.

### CLI Flags

| Flag | Type | Description |
|---|---|---|
| `--obs-server-url` | `string` | Pi Scope server URL (default: `http://127.0.0.1:43190`). |
| `--obs-token` | `string` | Bearer token for server authentication (never logged). |
| `--o-pool` | `string` | Logical pool / bucket name (default: `"default"`). |
| `--o-tag` | `string` | Comma-separated or repeatable tags. |
| `--o-name` | `string` | Optional human-friendly name for this agent session. |
| `--obs-disable` | `boolean` | Hard kill switch. When true, no listeners are registered. |

### Environment Variables

If flags are omitted, the extension falls back to these variables:

- `OBS_SERVER_URL`
- `OBS_AUTH_TOKEN`
- `OBS_POOL`
- `OBS_TAG`
- `OBS_NAME`
- `OBS_DISABLE`

## Emitted Telemetry Events

The extension maps agent events directly into the canonical `ObsEvent` envelopes:

- **`session_start`** & **`session_shutdown`**: Tracks session boundaries.
- **`agent_start`** & **`agent_end`**: Fired per user prompt cycle.
- **`turn_start`** & **`turn_end`**: Tracks individual assistant model calls and usage/cost.
- **`user_message`**: Captures user prompts.
- **`assistant_message`**: Captures model completions (text, tools called, token usage).
- **`thinking`**: Emitted as a chronological sibling when the model streams a `<thinking>` block.
- **`tool_call`** & **`tool_result`**: Non-blocking tool telemetry with truncation checks.
- **`model_change`**: Captured on manual switches or model cycling.
- **`compaction`**: Emitted when session history is compacted (manual or auto).
- **`branch_nav`**: Emitted on session-tree branch navigation (with optional summary preview).
