# pi-thinking-messaging

A small Pi extension that keeps Pi's original animated working loader, but adds elapsed time and a current-run output token count to the active working message:

```text
Working… (7m 7s · ↓ 30.0k tokens)
```

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
- Estimates tokens from the current assistant message while streaming.
- Replaces the estimate with provider-reported output usage when each assistant message ends.
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

## Token count limitation

During streaming, provider-reported exact output usage may not be finalized until the response completes. This extension estimates the current assistant message from streamed content, then replaces that estimate with exact provider `usage.output` when Pi receives it at `message_end`.
