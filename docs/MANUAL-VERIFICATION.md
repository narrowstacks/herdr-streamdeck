# Manual verification checklist

Everything that could be automated has been, and verified against your live herdr.
What remains needs a human: real agent CLIs sitting at real approval prompts, and
physical Stream Deck key presses.

## Install

```bash
npm run build
ln -sfn "$PWD/com.aaronfa.herdr-agents.sdPlugin" \
  "$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.aaronfa.herdr-agents.sdPlugin"
```

Then restart the Stream Deck app. "Herdr Agents" should appear in the actions list
with three actions: Agent Slot, Approve, Deny.

Place three Agent Slot keys and set their Slot values to 1, 2, 3 in the Property
Inspector. Place one Approve and one Deny key.

---

## Part 1 — the open protocol question (do this first)

**This is the one unresolved unknown in the project.** `DEFAULT_KEYMAP` currently
guesses that every agent accepts with `Enter` and rejects with `Esc`. The key
*names* are verified against herdr; which key each *CLI* actually wants is not.

For each of `claude` and `codex`:

1. Start the CLI in a herdr pane.
2. Drive it to an approval prompt — e.g. ask Claude Code to run a shell command
   that needs approval.
3. Confirm herdr sees it as blocked:
   ```bash
   herdr agent list | python3 -m json.tool | grep -A1 agent_status
   ```
4. At the prompt, press the candidate accept key manually and note what actually
   accepts. Repeat for reject.
5. Record the result in `com.aaronfa.herdr-agents.sdPlugin/keymap.json`.

Valid key names (verified against herdr 0.6.9): crossterm `KeyCode` names, case
insensitive. `Enter`, `Esc`, `Tab`, `Up`/`Down`/`Left`/`Right`, `Home`, `End`,
`PageUp`, `PageDown`, `Delete`, `Insert`, `Backspace`, `F1`–`F12`, and single
characters like `y` or `1`. Modifiers use `+`, e.g. `ctrl+c`.

**`Escape` is NOT valid — it is `Esc`.** That already bit us once.

If an agent's sequence can't be confirmed, delete its entry from `keymap.json` so
it falls through to `default`, rather than leaving a wrong guess that looks
authoritative.

---

## Part 2 — behaviour checks

| # | Check | Expected |
|---|---|---|
| 1 | Agents running in herdr | Each slot key shows agent name + project basename |
| 2 | An idle agent | Green |
| 3 | A working agent | Amber |
| 4 | Drive an agent to an approval prompt | Its key turns red and pulses within ~1s |
| 5 | Press that red key | herdr focuses that pane |
| 6 | Press Approve while it is blocked | Prompt is accepted; key returns to amber/green |
| 7 | Press Deny at a prompt | Prompt is rejected |
| 8 | Stop herdr (`herdr server stop`) | Within ~5s every slot shows "no herdr" — **not** a stale colour |
| 9 | Restart herdr | Keys recover without restarting Stream Deck |
| 10 | Exit an agent | Its slot goes dark but keeps the project label |
| 11 | Restart an agent in the same directory | It returns to the **same** slot |
| 12 | Quit and reopen Stream Deck | Slot assignments unchanged |
| 13 | Close a herdr pane, then open a new one | Keys keep working — this was a Critical bug; the fix is verified but worth confirming on real hardware |

### Check 6a — the one that matters most

**Press Approve while NO agent is blocked.**

Expected: the key flashes an alert and **no keystroke reaches any pane**.

Verify by checking that the previously-focused agent's transcript is unchanged.
Do not verify this by reasoning about the code — actually press it and look.

This is the safety interlock. If it fails, Approve is injecting stray keystrokes
into working agent sessions, which silently corrupts whatever they were doing.

### Check 6b — targeting with two blocked agents

Get **two** agents blocked simultaneously, focus one, press Approve.

Expected: the focused one is approved, not the other. Focus tracking is now driven
by herdr's `pane.focused` event; before that fix it could be up to 5s stale and
approve the wrong agent.

---

## If something fails

Plugin logs go to the Stream Deck plugin log directory. To watch the herdr side:

```bash
herdr agent list                    # what herdr thinks the state is
tail -f ~/.config/herdr/herdr.log
```

A useful isolation question: does `herdr agent list` show the right state? If yes,
the bug is in the plugin. If no, the plugin is faithfully reporting what herdr
told it.
