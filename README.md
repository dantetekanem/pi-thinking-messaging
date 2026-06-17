# pi-thinking-messaging

A small Pi extension that keeps Pi's original animated working loader, but adds elapsed time and a current-run token count to the active working message:

```text
Working… (7m 7s · ↓ 30.0k tokens)
```

The token arrow shows direction: `↑` for request/input tokens being sent upstream, and `↓` for assistant output tokens coming back from the model.

When Pi is streaming hidden thinking content, the same active loader line switches to:

```text
Thinking… (7m 7s · ↓ 30.0k tokens)
```

## Behavior

- Keeps Pi's original animated working indicator.
- Suppresses the separate collapsed hidden-thinking label and its empty placeholder line so `Thinking...` only appears in the controlled loader.
- On each `agent_start`, starts a per-run timer and token counter.
- Switches the controlled working message between `Thinking…` and `Working…` based on the current assistant stream phase.
- Updates the working message every second with elapsed time from `agent_start`.
- Shows `↑` while request/input tokens are being sent upstream, then `↓` while assistant output tokens are streaming back.
- For `↑`, estimates only the current user talk/prompt text, not the full serialized provider payload, system prompt, tool schemas, or cached context overhead.
- For `↓`, estimates the current assistant message while streaming, then replaces the output estimate with provider-reported output usage when each assistant message ends.
- Appends staged idle notices when no request or response token activity is seen:
  - after more than 60 seconds: yellow `- agent is taking a while...`
  - after more than 180 seconds: yellow `- agent is probably idle...`
  - after more than 300 seconds: red `- agent is idle`
- Does not intercept terminal input, send messages, steer/follow up, or await work in event handlers, so Esc/abort stays owned by Pi.
- Clears intervals and restores Pi's working-loader defaults on `agent_end`.

No commands or settings are registered. To change the labels or update interval, edit the constants at the top of `src/index.ts`.

## Install

Install once for your computer:

```bash
pi install git:github.com/dantetekanem/pi-thinking-messaging
```

Or with the HTTPS URL:

```bash
pi install https://github.com/dantetekanem/pi-thinking-messaging
```

Then reload your active Pi session:

```text
/reload
```

## Local development

Load the local checkout for one run:

```bash
pi -e /Users/leonardopereira/Poetry/pi-thinking-messaging
```

Run the focused unit tests:

```bash
pnpm test
```

## Token count limitation

During streaming, provider-reported exact usage may not be finalized until the response completes. This extension intentionally treats `↑` as current user talk/prompt size rather than exact provider input usage, because provider `usage.input` includes system prompt, tool schemas, cached context, and other overhead. Assistant `↓` output is estimated while streaming and replaced with provider `usage.output` when Pi receives it at `message_end`.
