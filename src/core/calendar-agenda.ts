/**
 * Bounded read-only Google Calendar agenda.
 *
 * Read posture only (SOURCE_FAMILIES: calendars are time-truth surfaces —
 * "read posture is useful; write posture remains approval-gated"). The command
 * issues a broker session for the delegated calendar handle, fetches upcoming
 * events from the Calendar API, and prints a bounded agenda. No token material
 * ever leaves the process; adapters do not own credentials.
 */
import {
  requireBearerTokenCredentialSession,
  type CredentialBroker,
  type CredentialBrokerFetch,
} from '../workers/credential-broker/index.ts';

export const GOOGLE_CALENDAR_AGENDA_HANDLE = 'google_calendar.personal.delegated';
export const GOOGLE_CALENDAR_AGENDA_CAPABILITY = 'google_calendar.events.read';
const GOOGLE_CALENDAR_API_BASE_URL = 'https://www.googleapis.com/calendar/v3';
const DEFAULT_DAYS = 7;
const MAX_DAYS = 62;
const DEFAULT_MAX_EVENTS = 50;
const MAX_MAX_EVENTS = 250;

const DELEGATION_HINT = 'If this is unauthorized_client or access_denied, the '
  + 'calendar.readonly scope is not delegated to the service-account client: '
  + 'add https://www.googleapis.com/auth/calendar.readonly to the client in '
  + 'Google Admin console -> Security -> API controls -> Domain-wide delegation.';

export class CalendarAgendaError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CalendarAgendaError';
    this.code = code;
  }
}

export interface CalendarAgendaOptions {
  days: number;
  maxEvents: number;
  calendarId: string;
  json: boolean;
}

export interface CalendarAgendaEvent {
  start: string;
  end: string;
  allDay: boolean;
  summary: string;
  location?: string;
}

export interface CalendarAgendaResult {
  calendarId: string;
  windowStart: string;
  windowEnd: string;
  events: CalendarAgendaEvent[];
  truncated: boolean;
}

export function parseCalendarAgendaArgs(args: string[]): CalendarAgendaOptions {
  const options: CalendarAgendaOptions = {
    days: DEFAULT_DAYS,
    maxEvents: DEFAULT_MAX_EVENTS,
    calendarId: 'primary',
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (argument === '--days' || argument === '--max-events' || argument === '--calendar') {
      const value = args[index + 1];
      if (value === undefined) {
        throw new CalendarAgendaError('missing_value', `${argument} requires a value`);
      }
      index += 1;
      if (argument === '--calendar') {
        options.calendarId = value;
        continue;
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new CalendarAgendaError('invalid_value', `${argument} requires a positive integer, got ${JSON.stringify(value)}`);
      }
      if (argument === '--days') options.days = Math.min(parsed, MAX_DAYS);
      else options.maxEvents = Math.min(parsed, MAX_MAX_EVENTS);
      continue;
    }
    throw new CalendarAgendaError('unknown_argument', `unknown argument ${JSON.stringify(argument)}`);
  }
  return options;
}

interface RawCalendarEvent {
  status?: string;
  summary?: string;
  location?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
}

export async function runCalendarAgenda(options: {
  broker: CredentialBroker;
  agenda: CalendarAgendaOptions;
  fetchImpl?: CredentialBrokerFetch;
  now?: () => Date;
}): Promise<CalendarAgendaResult> {
  const now = options.now ? options.now() : new Date();
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const windowStart = now.toISOString();
  const windowEnd = new Date(now.getTime() + options.agenda.days * 24 * 60 * 60 * 1000).toISOString();

  let session;
  try {
    session = requireBearerTokenCredentialSession(await options.broker.issueSession({
      handle: GOOGLE_CALENDAR_AGENDA_HANDLE,
      provider: 'google_calendar',
      capability: GOOGLE_CALENDAR_AGENDA_CAPABILITY,
      trustDomain: 'secure_local',
    }), GOOGLE_CALENDAR_AGENDA_HANDLE);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CalendarAgendaError(
      'credential_session_failed',
      `could not obtain a calendar session for ${GOOGLE_CALENDAR_AGENDA_HANDLE}: ${detail}. ${DELEGATION_HINT}`,
    );
  }

  const url = new URL(`${GOOGLE_CALENDAR_API_BASE_URL}/calendars/${encodeURIComponent(options.agenda.calendarId)}/events`);
  url.searchParams.set('timeMin', windowStart);
  url.searchParams.set('timeMax', windowEnd);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', String(options.agenda.maxEvents));

  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const bounded = body.slice(0, 300);
    const hint = response.status === 403 || response.status === 401 ? ` ${DELEGATION_HINT}` : '';
    throw new CalendarAgendaError(
      'calendar_api_error',
      `calendar API returned ${response.status} for ${options.agenda.calendarId}: ${bounded}${hint}`,
    );
  }

  const payload = await response.json() as { items?: RawCalendarEvent[]; nextPageToken?: string };
  const items = Array.isArray(payload.items) ? payload.items : [];
  const events: CalendarAgendaEvent[] = [];
  for (const item of items) {
    if (item.status === 'cancelled') continue;
    const start = item.start?.dateTime ?? item.start?.date;
    const end = item.end?.dateTime ?? item.end?.date;
    if (!start || !end) continue;
    events.push({
      start,
      end,
      allDay: !item.start?.dateTime,
      summary: item.summary?.trim() || '(no title)',
      ...(item.location?.trim() ? { location: item.location.trim() } : {}),
    });
  }
  return {
    calendarId: options.agenda.calendarId,
    windowStart,
    windowEnd,
    events,
    truncated: Boolean(payload.nextPageToken),
  };
}

const DAY_FORMAT = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
});
const TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', minute: '2-digit', hour12: false,
});

function dayKey(event: CalendarAgendaEvent): string {
  if (event.allDay) return event.start;
  return DAY_FORMAT.format(new Date(event.start));
}

export function formatCalendarAgenda(result: CalendarAgendaResult): string {
  if (result.events.length === 0) {
    return `No events on ${result.calendarId} between ${result.windowStart} and ${result.windowEnd}.`;
  }
  const lines: string[] = [];
  let currentDay = '';
  for (const event of result.events) {
    const day = dayKey(event);
    if (day !== currentDay) {
      currentDay = day;
      lines.push(`${day}`);
    }
    const where = event.location ? ` @ ${event.location}` : '';
    if (event.allDay) {
      lines.push(`  all-day  ${event.summary}${where}`);
    } else {
      lines.push(`  ${TIME_FORMAT.format(new Date(event.start))}-${TIME_FORMAT.format(new Date(event.end))}  ${event.summary}${where}`);
    }
  }
  if (result.truncated) {
    lines.push(`(more events exist past the first ${result.events.length}; raise --max-events)`);
  }
  return lines.join('\n');
}
