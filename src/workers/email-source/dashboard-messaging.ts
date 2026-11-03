/** Local dashboard pairing state. Credentials only cross the helper's pipes. */
export type MessagingSource = 'telegram' | 'whatsapp';
export type PairingField = 'api_id' | 'api_hash' | 'phone' | 'code' | 'password';
export interface PairingChat { chatScope: string; title: string; kind: string }
type ChatSelection = { wholeAccount: boolean; chatScopes: string[] };
export interface PairingHooks {
  signal: AbortSignal;
  prompt(field: PairingField, reply: (value: string) => void): void;
  qr(value: string): void;
  /** The phone accepted the link: the QR is spent, and Olympus is reading the chat list. */
  linked(): void;
  commit(): void;
  choose(chats: readonly PairingChat[]): Promise<ChatSelection>;
}
type PairResult = { chats: readonly PairingChat[] };
type PairState = {
  state: 'starting' | 'waiting' | 'committing' | 'scope_selection_required' | 'paired' | 'failed' | 'cancelled';
  controller: AbortController;
  field?: PairingField;
  reply?: (value: string) => void;
  qr?: string;
  linked?: boolean;
  /** Why the last pairing failed: a fixed code, never a provider message, path or account detail. */
  reason?: string;
  /** After a failed or cancelled pairing that linked a new device: whether Olympus removed it from the phone. */
  unlinked?: 'removed' | 'offline' | 'failed';
  chats?: readonly PairingChat[];
  registrationMayBeSaved?: boolean;
  selection?: (selection: ChatSelection) => void;
  task?: Promise<void>;
};

export function createDashboardMessagingPairing<T extends PairResult>(options: {
  pair(source: MessagingSource, hooks: PairingHooks): Promise<T>;
  publish(source: MessagingSource, result: T, signal: AbortSignal): Promise<void>;
}) {
  const states = new Map<MessagingSource, PairState>();
  const status = (source: MessagingSource) => {
    const item = states.get(source);
    return item ? {
      ok: true as const, state: item.state,
      ...(item.field ? { field: item.field } : {}),
      ...(item.qr ? { qr: item.qr } : {}),
      ...(item.linked && item.state !== 'failed' && item.state !== 'cancelled' ? { linked: true } : {}),
      ...(item.state === 'failed' && item.reason ? { reason: item.reason } : {}),
      ...((item.state === 'failed' || item.state === 'cancelled') && item.unlinked ? { unlinked: item.unlinked } : {}),
      ...(item.chats ? { chats: item.chats } : {}),
      ...(item.state === 'scope_selection_required' ? { wholeAccount: false, chatScopes: [] } : {}),
      ...(item.registrationMayBeSaved ? { registrationMayBeSaved: true } : {}),
    } : { ok: true as const, state: 'idle' as const };
  };
  return {
    status,
    busy(source: MessagingSource) { return states.get(source)?.task !== undefined; },
    start(source: MessagingSource) {
      const prior = states.get(source);
      if (prior?.task) throw new Error('Pairing is already running.');
      const item: PairState = { state: 'starting', controller: new AbortController() };
      states.set(source, item);
      item.task = Promise.resolve().then(async () => {
        try {
          const result = await options.pair(source, {
            signal: item.controller.signal,
            prompt(field, reply) {
              if (item.controller.signal.aborted || item.reply) throw new Error('Pairing prompt is unavailable.');
              item.field = field;
              item.reply = reply;
              item.state = 'waiting';
            },
            qr(value) { if (!item.controller.signal.aborted) { item.qr = value; item.state = 'waiting'; } },
            linked() { if (!item.controller.signal.aborted) { delete item.qr; item.linked = true; item.state = 'starting'; } },
            choose(chats) {
              if (item.controller.signal.aborted) return Promise.reject(new Error('Pairing was cancelled.'));
              delete item.reply; delete item.field; delete item.qr;
              item.chats = chats;
              item.state = 'scope_selection_required';
              return new Promise<ChatSelection>((resolve, reject) => {
                const abort = () => { delete item.selection; reject(new Error('Pairing was cancelled.')); };
                item.controller.signal.addEventListener('abort', abort, { once: true });
                item.selection = selection => {
                  item.controller.signal.removeEventListener('abort', abort);
                  delete item.selection;
                  item.state = 'starting';
                  resolve(selection);
                };
              });
            },
            commit() {
              if (item.controller.signal.aborted) throw new Error('Pairing was cancelled.');
              delete item.reply; delete item.field; delete item.qr;
              item.state = 'committing';
            },
          });
          if (item.controller.signal.aborted) return;
          item.state = 'committing';
          await options.publish(source, result, item.controller.signal);
          if (item.controller.signal.aborted) return;
          item.chats = result.chats;
          item.state = 'paired';
        } catch (error) {
          const unlinked = error && typeof error === 'object' ? (error as { unlinked?: unknown }).unlinked : undefined;
          if (unlinked === 'removed' || unlinked === 'offline' || unlinked === 'failed') item.unlinked = unlinked;
          if (!item.controller.signal.aborted) {
            if (item.state === 'committing') item.registrationMayBeSaved = true;
            item.reason = pairingFailureReason(error);
            item.state = 'failed';
            // The code only: a helper's message can carry a path or an account detail.
            console.warn(`[messaging] ${source} pairing failed: ${item.reason}`);
          }
        } finally {
          delete item.reply;
          delete item.field;
          delete item.qr;
          delete item.task;
        }
      });
      return status(source);
    },
    select(source: MessagingSource, selection: ChatSelection) {
      const item = states.get(source);
      if (!item || item.state !== 'scope_selection_required' || !item.selection) throw new Error('No pending chat choice.');
      if (selection.wholeAccount ? selection.chatScopes.length > 0 : selection.chatScopes.length === 0) throw new Error('Choose all chats or at least one chat.');
      if (selection.chatScopes.some(scope => !item.chats?.some(chat => chat.chatScope === scope))) throw new Error('Chat list changed.');
      item.selection(selection);
      return status(source);
    },
    respond(source: MessagingSource, field: string, value: string) {
      const item = states.get(source);
      if (!item || item.state !== 'waiting' || item.field !== field || !item.reply || !value || value.length > 4096 || /[\r\n\0]/.test(value)) {
        throw new Error('No matching pairing prompt.');
      }
      const reply = item.reply;
      delete item.reply;
      delete item.field;
      item.state = 'starting';
      reply(value);
      return status(source);
    },
    cancel(source: MessagingSource) {
      const item = states.get(source);
      if (item && (item.state === 'starting' || item.state === 'waiting' || item.state === 'scope_selection_required')) {
        item.controller.abort();
        delete item.reply;
        delete item.field;
        delete item.qr;
        item.state = 'cancelled';
      }
      return status(source);
    },
    async cancelAndWait(source: MessagingSource) {
      this.cancel(source);
      await states.get(source)?.task;
    },
    close() { for (const source of states.keys()) this.cancel(source); },
  };
}

/** A failure's fixed code (`Error.code`, set by the pairing and listing helpers), or `unexpected`. */
export function pairingFailureReason(error: unknown): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : 'unexpected';
}

/** An Error carrying a fixed failure code the dashboard may show and log. */
export function codedError(message: string, code: string | undefined): Error {
  const error = new Error(message) as Error & { code?: string };
  if (code && /^[a-z0-9_]{1,64}$/.test(code)) error.code = code;
  return error;
}
