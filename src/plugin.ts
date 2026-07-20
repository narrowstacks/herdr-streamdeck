import streamDeck from "@elgato/streamdeck";
import { AgentSlotAction } from "./actions/agent-slot.js";
import { ApproveAction } from "./actions/approve.js";
import { DenyAction } from "./actions/deny.js";
import { loadKeymap, loadSlots, startHerdr } from "./plugin-state.js";

loadKeymap();

streamDeck.actions.registerAction(new AgentSlotAction());
streamDeck.actions.registerAction(new ApproveAction());
streamDeck.actions.registerAction(new DenyAction());

await streamDeck.connect();
// Must precede startHerdr: the first render claims slots, and it must claim
// against restored assignments rather than an empty allocator.
await loadSlots();
await startHerdr();
