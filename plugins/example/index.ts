/**
 * Example plugin — preinstalled, and disabled until a deployment lists
 * `example` in PLUGINS_ENABLED.
 *
 * It keeps a timeline of notes per payment intent. Read it top to bottom as a
 * tour of what a plugin can do:
 *
 *   - read the core through a capability declared in plugin.json
 *     (`payment_intents:read`) — only the calling tenant's intents;
 *   - keep its own data in `ctx.storage` — the notes never touch the core's
 *     `payment_intent` table;
 *   - answer a query and a command;
 *   - react to an event (`PAYMENT_INTENT_SUCCEEDED`) with no request at all;
 *   - read a tenant setting (`label`) from `ctx.installation.config`.
 */
import {
  defineHandlers,
  PluginError,
  requireString,
  type PluginContext,
  type PluginJson,
} from '@/plugins/sdk';

const NOTES = 'notes'; // the storage collection this plugin writes
const MAX_NOTES = 50; // per intent: the oldest fall off
const MAX_TEXT = 280;

interface Note {
  at: string;
  text: string;
  source: 'tenant' | 'event';
}

async function readNotes(
  ctx: PluginContext,
  intentId: string,
): Promise<Note[]> {
  const stored = await ctx.storage.get(NOTES, intentId);
  return Array.isArray(stored) ? (stored as unknown as Note[]) : [];
}

async function addNote(
  ctx: PluginContext,
  intentId: string,
  text: string,
  source: Note['source'],
): Promise<Note[]> {
  const label = ctx.installation.config.label;
  const note: Note = {
    at: new Date().toISOString(),
    text: typeof label === 'string' && label ? `[${label}] ${text}` : text,
    source,
  };
  const notes = [...(await readNotes(ctx, intentId)), note].slice(-MAX_NOTES);
  await ctx.storage.put(NOTES, intentId, notes as unknown as PluginJson);
  return notes;
}

export default defineHandlers({
  queries: {
    // POST /v1/plugins/example/queries/get-notes  { "input": { "paymentIntentId": "…" } }
    'get-notes': async (ctx, input) => {
      const paymentIntentId = requireString(input, 'paymentIntentId', {
        max: 64,
      });
      const notes = await readNotes(ctx, paymentIntentId);
      return { paymentIntentId, notes } as unknown as PluginJson;
    },
  },

  commands: {
    // POST /v1/plugins/example/commands/add-note  { "input": { "paymentIntentId": "…", "text": "…" } }
    'add-note': async (ctx, input) => {
      const paymentIntentId = requireString(input, 'paymentIntentId', {
        max: 64,
      });
      const text = requireString(input, 'text', { max: MAX_TEXT });

      // Reading through the core is also the ownership check: another
      // tenant's intent reads as null here.
      if (!(await ctx.core.paymentIntents.get(paymentIntentId))) {
        throw new PluginError(`Payment intent ${paymentIntentId} not found`);
      }
      const notes = await addNote(ctx, paymentIntentId, text, 'tenant');
      return { paymentIntentId, notes } as unknown as PluginJson;
    },
  },

  events: {
    PAYMENT_INTENT_SUCCEEDED: async (ctx, { data }) => {
      const tx = data.txHash ? ` in ${data.txHash.slice(0, 12)}…` : '';
      const amount = data.amount ? `${data.amount} ` : '';
      await addNote(ctx, data.id, `Paid ${amount}${data.asset}${tx}`, 'event');
    },
  },
});
