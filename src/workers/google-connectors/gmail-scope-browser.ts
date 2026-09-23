// What the mail scope picker shows before anything runs: the mailbox's labels
// and categories, sender suggestions from a small metadata-only sample, and an
// estimate of the first read. Owner-initiated tooling, never a traversal: it
// reads no message body (metadata format, From header only) and stores
// nothing.
//
// Request cost is bounded and stated. One picker load spends at most
// GMAIL_SCOPE_BROWSE_MAX_REQUESTS Gmail API requests:
//   1   labels.list
//   5   labels.get, one per inbox category (for its message count)
//   1   messages.list on the full-content query (its resultSizeEstimate, and
//       the sample's message ids)
//   1   messages.list on the metadata-only query (its resultSizeEstimate;
//       skipped when the window is Everything)
//   100 messages.get, format=metadata, From header only (the sender sample)
// Every request goes through the lane's budgeted client under operator
// provenance: counted against the Gmail day budget, never refused by it.

import {
  compileGmailMailScope,
  estimateMailScope,
  GMAIL_SCOPE_BROWSE_MAX_REQUESTS,
  GMAIL_SCOPE_CATEGORIES,
  GMAIL_SCOPE_SENDER_SAMPLE,
  GMAIL_SCOPE_CATEGORY_LABEL_IDS,
  GMAIL_SCOPE_CATEGORY_LABELS,
  mailScopeContentAfter,
  type GmailScopeCategory,
  type MailScopeEstimate,
  type MailScopeSelection,
} from '../../core/mail-source-scope.ts';
import type { CredentialBroker, CredentialBrokerFetch } from '../credential-broker/index.ts';
import {
  GoogleGmailSourceConnector,
  type GmailApiClient,
  type GmailLabel,
} from './gmail.ts';
import type { GoogleDailyRequestBudget } from './request-budget.ts';

export { GMAIL_SCOPE_BROWSE_MAX_REQUESTS, GMAIL_SCOPE_SENDER_SAMPLE };
const MAX_LISTED_LABELS = 500;
const MAX_SENDER_SUGGESTIONS = 12;
/** Skippable system labels. Inbox, spam, trash and drafts are not offered. */
const SKIPPABLE_SYSTEM_LABELS = new Set(['SENT', 'CHAT']);

export interface GmailMailScopeLabelView {
  id: string;
  name: string;
  system: boolean;
}

export interface GmailMailScopeCategoryView {
  category: GmailScopeCategory;
  label: string;
  /** Whole-mailbox count from labels.get, not limited to the window. */
  messages_total?: number;
}

export interface GmailMailScopeSenderSuggestion {
  sender: string;
  /** Messages from this sender in the sample. */
  sample_messages: number;
}

export interface GmailMailScopeSummary {
  labels: GmailMailScopeLabelView[];
  categories: GmailMailScopeCategoryView[];
  sender_suggestions: GmailMailScopeSenderSuggestion[];
  sample_size: number;
  estimate: MailScopeEstimate;
  /** Requests this summary actually spent. Never above GMAIL_SCOPE_BROWSE_MAX_REQUESTS. */
  provider_requests: number;
}

export interface GmailMailScopeBrowser {
  summarize(input: {
    scope: Omit<MailScopeSelection, 'contentAfter'>;
    now?: Date;
    /** The operator's hidden query override, ANDed exactly as the lane does. */
    operatorQuery?: string;
    messagesPerPass: number;
    passIntervalMinutes: number;
    dailyRequestBudget: number;
  }): Promise<GmailMailScopeSummary>;
}

export function createGmailMailScopeBrowser(options: {
  credentialHandle: string;
  account?: string;
  credentialBroker?: CredentialBroker;
  fetch?: CredentialBrokerFetch;
  apiClient?: GmailApiClient;
  requestBudget?: GoogleDailyRequestBudget;
  env?: Record<string, string | undefined>;
}): GmailMailScopeBrowser {
  const connector = new GoogleGmailSourceConnector({
    credentialHandle: options.credentialHandle,
    ...(options.account ? { account: options.account } : {}),
    ...(options.credentialBroker ? { credentialBroker: options.credentialBroker } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.apiClient ? { apiClient: options.apiClient } : {}),
    ...(options.requestBudget ? { requestBudget: options.requestBudget } : {}),
    ...(options.env ? { env: options.env } : {}),
    provenance: 'operator',
  });
  return {
    async summarize(input) {
      const client = await connector.apiClientForTooling();
      let requests = 0;
      const count = <T>(promise: Promise<T>): Promise<T> => {
        requests += 1;
        return promise;
      };
      const labels: GmailLabel[] = client.listLabels ? await count(client.listLabels()) : [];
      const categories: GmailMailScopeCategoryView[] = [];
      for (const category of GMAIL_SCOPE_CATEGORIES) {
        const label = client.getLabel
          ? await count(client.getLabel(GMAIL_SCOPE_CATEGORY_LABEL_IDS[category])).catch(() => undefined)
          : undefined;
        categories.push({
          category,
          label: GMAIL_SCOPE_CATEGORY_LABELS[category],
          ...(label?.messagesTotal !== undefined ? { messages_total: label.messagesTotal } : {}),
        });
      }
      const contentAfter = mailScopeContentAfter(input.scope.window, input.now ?? new Date());
      const compiled = compileGmailMailScope(
        { ...input.scope, ...(contentAfter ? { contentAfter } : {}) },
        { operatorQuery: input.operatorQuery },
      );
      const contentPage = await count(client.listMessages({
        maxResults: GMAIL_SCOPE_SENDER_SAMPLE,
        ...(compiled.contentQuery ? { query: compiled.contentQuery } : {}),
      }));
      const metadataPage = compiled.metadataQuery
        ? await count(client.listMessages({ maxResults: 1, query: compiled.metadataQuery }))
        : undefined;
      const tally = new Map<string, number>();
      const sample = contentPage.messages.slice(0, GMAIL_SCOPE_SENDER_SAMPLE);
      for (const message of sample) {
        const fetched = await count(client.getMessage(message.id, { format: 'metadata', metadataHeaders: ['From'] }));
        const from = fetched.payload?.headers?.find((header) => header.name?.toLowerCase() === 'from')?.value;
        const sender = senderAddress(from);
        if (sender) tally.set(sender, (tally.get(sender) ?? 0) + 1);
      }
      return {
        labels: labels
          .filter((label) => label.id && label.name
            && (label.type === 'user' || SKIPPABLE_SYSTEM_LABELS.has(label.id)))
          .slice(0, MAX_LISTED_LABELS)
          .map((label) => ({ id: label.id, name: label.name, system: label.type !== 'user' }))
          .sort((left, right) => Number(left.system) - Number(right.system) || left.name.localeCompare(right.name)),
        categories,
        sender_suggestions: [...tally]
          .filter(([, messages]) => messages >= 2)
          .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
          .slice(0, MAX_SENDER_SUGGESTIONS)
          .map(([sender, messages]) => ({ sender, sample_messages: messages })),
        sample_size: sample.length,
        estimate: estimateMailScope({
          contentMessages: contentPage.resultSizeEstimate ?? contentPage.messages.length,
          metadataMessages: metadataPage?.resultSizeEstimate ?? metadataPage?.messages.length ?? 0,
          messagesPerPass: input.messagesPerPass,
          passIntervalMinutes: input.passIntervalMinutes,
          dailyRequestBudget: input.dailyRequestBudget,
        }),
        provider_requests: requests,
      };
    },
  };
}

/** `Name <a@b.com>` or `a@b.com`, lower-cased; undefined when there is no address. */
export function senderAddress(from: string | undefined): string | undefined {
  if (!from) return undefined;
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(from);
  const bare = angle?.[1] ?? /([^\s<>"()]+@[^\s<>"()]+\.[a-z]{2,})/i.exec(from)?.[1];
  return bare?.toLowerCase();
}
