# Stream Deck Agent Alerts — Design

**Date:** 2026-07-19
**Status:** Approved, pending implementation plan

## Problem

Agent CLIs (Claude Code, Codex, and others) block waiting on the user — for command
approval, for an answer to a question — and there is no ambient signal that this has
happened. An agent can sit blocked for many minutes while the user works elsewhere.

This plugin surfaces that state on a Stream Deck: which agents exist, which one needs
attention right now, and a way to act on it without hunting for the right terminal pane.

## Scope

Signal source is **herdr only**. herdr already tracks per-pane agent state
(`idle` / `working` / `blocked` / `unknown`) across every agent CLI it integrates with,
exposes it over a local Unix socket, and can focus panes and send keys to them. That is
the entire data and control surface this plugin needs.

Deliberately **not** in scope:

- moshi-hook as a signal source (richer per-event detail, but a second protocol to
  reverse-engineer and a cloud dependency)
- Installing our own hooks into agent CLIs (duplicates herdr's work, risks conflicting
  with moshi-hook's already-installed hooks)
- Sound alerts, macOS notification banners, escalating urgency
- Any non-herdr agent

The `HerdrClient` / `AgentRegistry` split leaves room to add moshi-hook as a second
source later. Nothing is built for that now.

## Environment

Verified on this machine on 2026-07-19:

- herdr 0.6.9, protocol 13, server running
- Socket: `~/.config/herdr/herdr.sock`
- Stream Deck plugins live in
  `~/Library/Application Support/com.elgato.StreamDeck/Plugins`

## herdr socket protocol

Newline-delimited JSON over a Unix domain socket. Requests carry `id`, `method`, and
`params`; responses echo `id` and carry `result` or `error`. Unsolicited events arrive
on the same connection.

Methods this plugin uses:

| Method | Purpose |
|---|---|
| `agent.list` | Enumerate agents: `pane_id`, `agent`, `agent_status`, `cwd`, `focused`, `workspace_id` |
| `agent.focus` | Bring a pane into view |
| `pane.send_keys` | Send key events to a pane (approve/deny) |
| `events.subscribe` | Subscribe to a set of events; streams on the same connection |

`agent.list` result shape, observed live:

```json
{"id":"cli:agent:list","result":{"agents":[{
  "agent":"claude","agent_status":"working",
  "cwd":"/Users/aaron/workspace/claude-control-streamdeck",
  "focused":true,"pane_id":"w65704613465d81-1",
  "terminal_id":"term_65704613465d224","workspace_id":"w65704613465d81"
}],"type":"agent_list"}}
```

### Subscription constraint

`events.subscribe` takes `params.subscriptions`, an array of internally-tagged objects.
Available variants include `pane.created`, `pane.closed`, `pane.focused`, `pane.exited`,
`pane.agent_detected`, `pane.agent_status_changed`, plus workspace and tab lifecycle
events.

**`pane.agent_status_changed` requires a `pane_id`.** Subscriptions are per-pane, not
global. Verified:

```json
{"id":"s1","method":"events.subscribe","params":{"subscriptions":[
  {"type":"pane.agent_status_changed","pane_id":"w65704613465d81-1"},
  {"type":"pane.created"}]}}
→ {"id":"s1","result":{"type":"subscription_started"}}
```

This is the single most consequential protocol fact for the design: you cannot subscribe
to an agent that does not exist yet, so push alone cannot be the whole sync strategy.

## Architecture

Four components, each with one purpose and independently testable.

| Component | Purpose | Depends on |
|---|---|---|
| `HerdrClient` | Owns the socket. Framing, request/response correlation by `id`, event demux, reconnect with backoff. | socket path |
| `AgentRegistry` | Source of truth for what agents exist and their state. Emits `agentChanged`. | `HerdrClient` |
| `SlotAllocator` | Sticky cwd→slot assignment, persisted. Pure logic, no I/O. | nothing |
| Actions | Stream Deck surface: render state, translate presses into herdr calls. | `AgentRegistry`, `SlotAllocator` |

**Stack:** TypeScript on Elgato's Node SDK (`@elgato/streamdeck`, SDK v2). Node has
native Unix-socket support, so the plugin holds one persistent connection rather than
shelling out to the `herdr` binary per tick.

### State synchronization — hybrid, deliberately

1. On connect: `agent.list` seeds the registry; subscribe `pane.agent_status_changed`
   per discovered pane.
2. Subscribe globally to `pane.created` / `pane.closed` / `pane.agent_detected`. On any
   of these, re-run `agent.list` and reconcile the subscription set.
3. A 5s `agent.list` reconcile tick as a backstop, to self-heal if an event is dropped
   or a subscription silently dies.

Push provides sub-second alerting; the tick guarantees the plugin cannot sit permanently
stale. Reconcile is idempotent, so push and tick converge rather than fight.

## Slot model

Slots are **sticky by cwd**. A slot claims an agent and records its cwd. If that agent
exits, the slot goes dark but stays reserved, and reclaims the same cwd when an agent
reappears there. New unrecognized agents fill the lowest free slot. Muscle memory
survives agent restarts and herdr server restarts.

Rejected: binding to `pane_id` (ids change across herdr restarts, reshuffling every
slot) and plain list order (any agent exit shifts all later slots left).

Assignments persist to plugin settings so they survive Stream Deck restarts.

## Actions

### `AgentSlot`

Settings: `slotIndex`, `pinnedCwd` (auto-filled on first claim), optional keymap override.

Renders agent label, basename of cwd, and a state color:

| State | Rendering |
|---|---|
| `blocked` | red, pulsing — needs attention |
| `working` | amber, steady |
| `idle` | green, steady |
| reserved (agent gone) | dark, dimmed cwd label |
| unclaimed | blank |
| disconnected | distinct disconnected state — see Failure handling |

Press → `agent.focus` on the bound pane. Reserved and blank slots no-op.

Pulsing is driven by one shared timer for all slots, not a timer per key.

### `Approve` / `Deny`

Both target the pane the registry reports as `focused`. This pairs with the slot keys:
press a slot to focus and read, then press Approve — you always act on what you are
looking at.

Both **gate on the focused agent's state being `blocked`**. If it is not, the key flashes
red and sends nothing. Without this gate a mistimed Approve injects a stray `Enter` into
a working agent, which is real damage done silently.

On a valid press: look up the keymap by the agent label herdr reports, then
`pane.send_keys`.

## Keymap

Ships as data, not code, so a new agent CLI is a config line rather than a release:

```json
{
  "claude":  { "approve": ["Enter"], "deny": ["Escape"] },
  "codex":   { "approve": ["Enter"], "deny": ["Escape"] },
  "default": { "approve": ["Enter"], "deny": ["Escape"] }
}
```

**These values are unverified placeholders.** Two things must be pinned down during
implementation:

1. The key-name vocabulary `pane.send_keys` accepts. This could not be probed from
   outside — herdr validates `pane_id` before key names, so an invalid-key error is never
   reached with a synthetic pane. Determine it against a real scratch pane.
2. The correct approve/deny sequence for each agent CLI, verified against that CLI
   actually sitting at an approval prompt.

Any agent whose sequence cannot be verified falls through to `default`, and that is
documented in the shipped config as a guess rather than a claim.

Per-slot keymap overrides are available in the Property Inspector.

## Failure handling

When herdr is not running or the socket disappears, every slot renders a distinct
**disconnected** state — never a stale-but-plausible green or amber.

This is the failure mode that matters most. A plugin that quietly shows last-known state
is worse than no plugin, because the user trusts it and misses a blocked agent. Staleness
must be visible.

The client reconnects on backoff and repaints all slots on recovery.

Other cases:

- `pane_not_found` on focus/send → the agent died between render and press. Reconcile
  immediately and repaint; flash the key to show the press did not land.
- Malformed or unparseable frame → log, discard the frame, keep the connection.
- Unknown agent label → fall through to `default` keymap.

## Testing

- **`HerdrClient`** — against a scriptable fake Unix socket server. Covers request/response
  correlation, event demux, mid-stream disconnect, reconnect backoff, malformed frames.
- **`SlotAllocator`** — pure unit tests: claim, release, reserve, reclaim-same-cwd,
  overflow past slot count, persistence round-trip.
- **`AgentRegistry`** — synthetic event sequences asserting push and reconcile tick
  converge on identical state, including a dropped-event scenario.
- **Actions** — thin tests over a mocked registry, with the `blocked` gate on Approve/Deny
  covered explicitly.
- **End-to-end** — manual against live herdr. Requires real agent CLIs actually blocking,
  which cannot be faked meaningfully. This is a known gap, not an oversight.

## Open items for implementation

1. Verify `pane.send_keys` key-name vocabulary against a real pane.
2. Verify approve/deny sequences per agent CLI at a live approval prompt.
3. Confirm the payload shape of `pane.agent_status_changed` events — the subscription
   handshake was verified, but no status transition was observed during design, so the
   event body is not yet known.
