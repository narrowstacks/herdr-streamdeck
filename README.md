# Herdr Agents (Stream Deck plugin)

Surfaces herdr agent state on your Stream Deck and alerts when an agent needs
attention. macOS only.

## What it does

Agent CLIs (Claude Code, Codex, and others) block waiting on you — for command
approval, for an answer to a question — with no ambient signal that it has
happened, so an agent can sit blocked for minutes while you work elsewhere. This
plugin puts that state on a Stream Deck: which agents exist, which one needs you
right now, and a way to act on it without hunting for the right terminal pane.

The only signal source is herdr, which already tracks per-pane agent state
across the agent CLIs it integrates with, exposes it over a local Unix socket,
and can focus panes and send keys to them.

## Requirements

- macOS 10.15 or newer
- Stream Deck app 6.5 or newer
- herdr running, with its socket at `~/.config/herdr/herdr.sock`

## The keys

The plugin provides three actions:

| Action | What it does |
|---|---|
| Agent Slot | Shows one agent's status (colour + shape badge). Press to focus its pane; optionally raises a configured terminal app afterwards. |
| Approve | Sends the approve sequence to the focused agent. Only acts when that agent is blocked. |
| Deny | Sends the deny sequence to the focused agent. Only acts when that agent is blocked. |

Each agent gets its own Agent Slot key. Approve and Deny target whichever agent
herdr reports as focused — press a slot to focus and read it, then Approve or
Deny acts on what you are looking at. The Approve and Deny keys dim when nothing
is actionable and brighten when the focused agent is blocked, so what the key
looks like matches what pressing it will do.

## Status meaning

Each Agent Slot key encodes status by both colour and a corner shape badge, so
status is readable without relying on colour alone:

| Status | Colour | Badge |
|---|---|---|
| blocked | red (pulses) | `!` |
| working | amber | spinner ring |
| idle | green | dot |
| disconnected | distinct "no herdr" state | full-size X |

The disconnected state appears whenever herdr is down, so stale data is never
shown as if it were live.

## Configuring

Property Inspectors are provided for each action:

- Agent Slot — pick which slot the key shows, and optionally a terminal app to
  raise when you focus a pane.
- Approve / Deny — override the key sequence the key sends (the "Approve keys"
  and "Deny keys" fields) when the shipped default is wrong for a given agent
  CLI. Leave a field blank to keep the shipped keymap.

## Approve / Deny caveat

The per-agent approve and deny sequences ship as an **unverified** Enter/Esc
guess — nobody has yet confirmed them against a real agent CLI sitting at an
approval prompt. Confirm the sequence for your agent CLI before relying on
Approve or Deny, and if it is wrong, override it in the Approve/Deny Property
Inspector rather than hand-editing the keymap.

## Development

- `npm run build` — type-check and bundle the plugin
- `npm test` — run the test suite
- `npm run watch` — rebuild on change
- `npm run typecheck` — type-check only
