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
`params`; responses echo `id` and carry `result` or `error`. Events arrive only on a
connection that has issued `events.subscribe` — see "Connection model" below, which
corrects an assumption this spec originally got wrong.

Methods this plugin uses:

| Method | Purpose |
|---|---|
| `agent.list` | Enumerate agents: `pane_id`, `agent`, `agent_status`, `cwd`, `focused`, `workspace_id` |
| `agent.focus` | Bring a pane into view |
| `pane.send_keys` | Send key events to a pane (approve/deny) |
| `events.subscribe` | Turn this connection into a one-way event stream |

`agent.list` result shape, observed live:

```json
{"id":"cli:agent:list","result":{"agents":[{
  "agent":"claude","agent_status":"working",
  "cwd":"/Users/aaron/workspace/claude-control-streamdeck",
  "focused":true,"pane_id":"w65704613465d81-1",
  "terminal_id":"term_65704613465d224","workspace_id":"w65704613465d81"
}],"type":"agent_list"}}
```

### Connection model — VERIFIED, and it is not what this spec originally assumed

**herdr's API socket serves exactly ONE request per connection, then closes it.**
Verified 2026-07-20 against the running server by direct probing:

```
ping, ping        ->  resp | CLOSED | (closed before 2nd)
ping, agent.list  ->  resp | CLOSED | (closed before 2nd)
agent.list, ping  ->  resp | CLOSED | (closed before 2nd)
subscribe-only    ->  still open after 5s
```

`events.subscribe` is the sole exception: that connection stays open indefinitely
as a one-way event stream. Sending any request on a subscribed connection causes
herdr to close it.

This spec originally specified a single persistent multiplexed connection with
request/response correlation by `id` and a reconnect supervisor. **That design is
impossible against this server** and was corrected after the transport was built.

The required shape is two distinct paths:

| Path | Lifetime | Used for |
|---|---|---|
| Request | One connection per request: connect, send, read one response, peer closes | `agent.list`, `agent.focus`, `pane.send_keys` |
| Event | One long-lived connection, subscribe then listen | `pane.agent_status_changed` and lifecycle events |

Because only one request is ever in flight per connection, request/response
correlation by `id` is unnecessary on the request path (harmless to keep for
sanity-checking the reply).

The event connection still needs reconnect with backoff, and must **re-subscribe**
after every reconnect — subscriptions do not survive a new connection.

### Subscription constraint

`events.subscribe` takes `params.subscriptions`, an array of internally-tagged
objects. `pane.agent_status_changed` requires a `pane_id`; `pane.created`,
`pane.closed`, and `pane.agent_detected` do not. Verified:

```json
{"id":"s1","method":"events.subscribe","params":{"subscriptions":[
  {"type":"pane.agent_status_changed","pane_id":"w65704613465d81-1"},
  {"type":"pane.created"}]}}
-> {"id":"s1","result":{"type":"subscription_started"}}
```

You cannot subscribe to an agent that does not exist yet, so push alone cannot be
the whole sync strategy — hence the poll backstop.

### Event payload shape — VERIFIED, also not as originally assumed

This spec originally assumed `{type, pane_id, agent_status}` at the top level.
Real payloads, captured verbatim from the wire:

```json
{"data":{"agent":"claude","agent_status":"blocked","pane_id":"w65704613465d81-2","workspace_id":"w65704613465d81"},"event":"pane.agent_status_changed"}
{"data":{"pane_id":"w65704613465d81-2","type":"pane_closed","workspace_id":"w65704613465d81"},"event":"pane_closed"}
{"data":{"agent":"claude","pane_id":"w65704613465d81-1","type":"pane_agent_detected","workspace_id":"w65704613465d81"},"event":"pane_agent_detected"}
```

- The discriminator is **`event`**, not `type`. Fields live under **`data`**.
- Naming is inconsistent: `pane.agent_status_changed` arrives DOTTED, but the
  lifecycle events arrive UNDERSCORED (`pane_created`, `pane_closed`,
  `pane_agent_detected`). A handler must accept both spellings.
- `pane_created` nests its pane fields one level deeper, under `data.pane`.

Full captured fixtures: `.superpowers/sdd/real-herdr-events.md`.

### send_keys key vocabulary — VERIFIED

```
ACCEPTED: Enter, enter, Esc, esc, Tab, tab, Down, down, ctrl+c, y, 1
REJECTED: Escape, escape, ctrl-c
```

**`Escape` is rejected; the accepted name is `Esc`.** Names are case-insensitive,
modifiers use `+` not `-`, and single characters are valid keys. The vocabulary is
crossterm `KeyCode` names.

## Architecture

Four components, each with one purpose and independently testable.

| Component | Purpose | Depends on |
|---|---|---|
| `HerdrClient` | Owns both socket paths: a short-lived connection per request, and one long-lived subscribed event stream with reconnect + re-subscribe. Newline-JSON framing. | socket path |
| `AgentRegistry` | Source of truth for what agents exist and their state. Emits `agentChanged`. | `HerdrClient` |
| `SlotAllocator` | Sticky cwd→slot assignment, persisted. Pure logic, no I/O. | nothing |
| Actions | Stream Deck surface: render state, translate presses into herdr calls. | `AgentRegistry`, `SlotAllocator` |

**Stack:** TypeScript on Elgato's Node SDK (`@elgato/streamdeck`, SDK v2). Node has
native Unix-socket support, so the plugin speaks the protocol directly rather than
shelling out to the `herdr` binary per tick. Note that "persistent connection" applies
only to the event stream — requests each get their own short-lived connection, because
herdr closes one after every response.

### State synchronization — hybrid, deliberately

1. On start: `agent.list` (its own connection) seeds the registry; subscribe
   `pane.agent_status_changed` per discovered pane on the event-stream connection.
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

1. ~~Verify `pane.send_keys` key-name vocabulary.~~ **RESOLVED** — see above.
   `Escape` is invalid; use `Esc`.
2. Verify approve/deny sequences per agent CLI at a live approval prompt.
   **STILL OPEN** — requires a real agent sitting at a real prompt.
3. ~~Confirm the payload shape of `pane.agent_status_changed`.~~ **RESOLVED** — see
   above. The originally assumed shape was wrong in every field.
4. ~~Connection model.~~ **RESOLVED, and it invalidated the original transport
   design** — one request per connection. See "Connection model" above.
