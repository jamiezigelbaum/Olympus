import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  createEnvCredentialBroker,
  type CredentialOAuth2HandleState,
  type CredentialOAuth2StateStore,
} from '../src/workers/credential-broker/index.ts';
import {
  CalendarAgendaError,
  formatCalendarAgenda,
  parseCalendarAgendaArgs,
  runCalendarAgenda,
} from '../src/core/calendar-agenda.ts';

// Throwaway key generated per run; no real service-account material in fixtures.
const THROWAWAY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'olympus-fixture-project',
  private_key_id: 'fixture-key-id',
  private_key: THROWAWAY.privateKey,
  client_email: 'olympus-secure@olympus-fixture-project.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token',
});

class MemoryOAuth2StateStore implements CredentialOAuth2StateStore {
  private readonly states = new Map<string, CredentialOAuth2HandleState>();

  async load(handle: string): Promise<CredentialOAuth2HandleState | undefined> {
    return this.states.get(handle);
  }

  async save(handle: string, state: CredentialOAuth2HandleState): Promise<void> {
    this.states.set(handle, { ...this.states.get(handle), ...state });
  }
}

function fixtureBroker(namespace: string, tokenRequests: Array<{ url: string; body: string }>) {
  return createEnvCredentialBroker({
    env: { OLYMPUS_CREDENTIAL_GOOGLE_OLYMPUS_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT_JSON, OLYMPUS_CREDENTIAL_GOOGLE_PERSONAL_SUBJECT: 'owner-personal@example.test', OLYMPUS_CREDENTIAL_GOOGLE_BUSINESS_SUBJECT: 'owner-business@example.test' },
    oauth2StateStore: new MemoryOAuth2StateStore(),
    oauth2CacheNamespace: namespace,
    now: () => new Date('2026-08-17T21:00:00.000Z'),
    fetch: async (input, init) => {
      tokenRequests.push({ url: String(input), body: String(init?.body) });
      return new Response(JSON.stringify({
        access_token: 'calendar-access-token-fixture',
        expires_in: 3600,
        token_type: 'Bearer',
      }), { status: 200 });
    },
  });
}

function decodeClaims(body: string): Record<string, any> {
  const assertion = new URLSearchParams(body).get('assertion');
  if (!assertion) throw new Error('Token request carried no assertion.');
  return JSON.parse(Buffer.from(assertion.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, any>;
}

const EVENTS_PAYLOAD = {
  items: [
    {
      status: 'confirmed',
      summary: 'Coffee with Harper',
      location: 'Filtrô',
      start: { dateTime: '2026-08-20T10:00:00+01:00' },
      end: { dateTime: '2026-08-20T10:45:00+01:00' },
    },
    {
      status: 'cancelled',
      summary: 'Cancelled thing',
      start: { dateTime: '2026-08-20T12:00:00+01:00' },
      end: { dateTime: '2026-08-20T13:00:00+01:00' },
    },
    {
      status: 'confirmed',
      summary: 'Bar mitzvah prep',
      start: { date: '2026-08-21' },
      end: { date: '2026-08-22' },
    },
  ],
};

describe('calendar agenda', () => {
  test('mints a delegated calendar session and returns bounded events', async () => {
    const tokenRequests: Array<{ url: string; body: string }> = [];
    const broker = fixtureBroker('calendar-agenda-happy', tokenRequests);
    const apiRequests: Array<{ url: string; authorization: string | undefined }> = [];

    const result = await runCalendarAgenda({
      broker,
      agenda: parseCalendarAgendaArgs(['--days', '7']),
      now: () => new Date('2026-08-17T21:00:00.000Z'),
      fetchImpl: async (input, init) => {
        const headers = new Headers(init?.headers);
        apiRequests.push({ url: String(input), authorization: headers.get('authorization') ?? undefined });
        return new Response(JSON.stringify(EVENTS_PAYLOAD), { status: 200 });
      },
    });

    expect(tokenRequests.length).toBe(1);
    const claims = decodeClaims(tokenRequests[0]!.body);
    expect(claims.scope).toBe('https://www.googleapis.com/auth/calendar.readonly');
    expect(claims.sub).toBe('owner-personal@example.test');

    expect(apiRequests.length).toBe(1);
    const url = new URL(apiRequests[0]!.url);
    expect(url.pathname).toBe('/calendar/v3/calendars/primary/events');
    expect(url.searchParams.get('singleEvents')).toBe('true');
    expect(url.searchParams.get('orderBy')).toBe('startTime');
    expect(url.searchParams.get('timeMin')).toBe('2026-08-17T21:00:00.000Z');
    expect(url.searchParams.get('timeMax')).toBe('2026-08-24T21:00:00.000Z');
    expect(apiRequests[0]!.authorization).toBe('Bearer calendar-access-token-fixture');

    expect(result.events.length).toBe(2);
    expect(result.events[0]).toEqual({
      start: '2026-08-20T10:00:00+01:00',
      end: '2026-08-20T10:45:00+01:00',
      allDay: false,
      summary: 'Coffee with Harper',
      location: 'Filtrô',
    });
    expect(result.events[1]!.allDay).toBe(true);
    expect(result.truncated).toBe(false);

    const rendered = formatCalendarAgenda(result);
    expect(rendered).toContain('Coffee with Harper');
    expect(rendered).toContain('@ Filtrô');
    expect(rendered).toContain('all-day  Bar mitzvah prep');
    expect(rendered).not.toContain('Cancelled thing');
  });

  test('surfaces the domain-wide delegation hint on a 403 API response', async () => {
    const broker = fixtureBroker('calendar-agenda-403', []);
    await expect(runCalendarAgenda({
      broker,
      agenda: parseCalendarAgendaArgs([]),
      fetchImpl: async () => new Response('{"error":{"status":"PERMISSION_DENIED"}}', { status: 403 }),
    })).rejects.toThrow(/Domain-wide delegation/);
  });

  test('wraps credential failures with the delegation hint', async () => {
    const broker = createEnvCredentialBroker({
      env: {},
      oauth2StateStore: new MemoryOAuth2StateStore(),
      oauth2CacheNamespace: 'calendar-agenda-missing',
    });
    const failure = runCalendarAgenda({
      broker,
      agenda: parseCalendarAgendaArgs([]),
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    await expect(failure).rejects.toBeInstanceOf(CalendarAgendaError);
    await expect(failure).rejects.toThrow(/google_calendar\.personal\.delegated/);
  });

  test('parses and bounds arguments', () => {
    expect(parseCalendarAgendaArgs([])).toEqual({ days: 7, maxEvents: 50, calendarId: 'primary', json: false });
    expect(parseCalendarAgendaArgs(['--days', '500']).days).toBe(62);
    expect(parseCalendarAgendaArgs(['--max-events', '9999']).maxEvents).toBe(250);
    expect(parseCalendarAgendaArgs(['--calendar', 'work@group.calendar.google.com', '--json']))
      .toEqual({ days: 7, maxEvents: 50, calendarId: 'work@group.calendar.google.com', json: true });
    expect(() => parseCalendarAgendaArgs(['--bogus'])).toThrow(CalendarAgendaError);
    expect(() => parseCalendarAgendaArgs(['--days'])).toThrow(/requires a value/);
    expect(() => parseCalendarAgendaArgs(['--days', 'x'])).toThrow(/positive integer/);
  });
});
