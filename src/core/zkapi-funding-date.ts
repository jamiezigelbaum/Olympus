/**
 * The owner-confirmed zkAPI funding date (#846): one setter and one live read.
 *
 * `setZkapiFundingDate` changes only `zkapi.fundingDate` of the one `zkapi`
 * profile in the owner's sovereignty policy file, through
 * `updateSovereigntyConfigFile` (the policy file lease, re-read, validate,
 * atomic commit), the same transaction the dashboard's Outside help card
 * uses. `olympus zkapi funding-date` is its caller.
 *
 * `zkapiFundingDateRefresher` lets a running process follow that date
 * without a restart. Everything else in the policy is still read at boot;
 * only the funding date, which feeds the expiry estimate and nothing that
 * widens what may be sent, is taken from the file as it is now. The file is
 * re-read only when it changes (inode, size, mtime). An unreadable file or an
 * invalid date keeps the last good date.
 */
import { readFileSync, statSync } from 'node:fs';
import { FileLeaseBusyError } from './file-lease.ts';
import { updateSovereigntyConfigFile, type SovereigntyConfig } from './sovereignty.ts';
import { parseIsoDate, type ZkapiConsultSettings } from './zkapi-consult-settings.ts';

export type ZkapiFundingDateResult =
  | { ok: true; changed: boolean; fundingDate: string; previous?: string; profileId: string }
  | {
    ok: false;
    code: 'funding_date_invalid' | 'route_not_configured' | 'policy_busy' | 'policy_unreadable' | 'policy_uncertain';
    message: string;
  };

class RouteMissing extends Error {}

export function setZkapiFundingDate(input: { path: string; date: string }): ZkapiFundingDateResult {
  const date = input.date.trim();
  if (parseIsoDate(date) === undefined) {
    return { ok: false, code: 'funding_date_invalid', message: 'Give the funding date as YYYY-MM-DD, the day the deposit was confirmed.' };
  }
  let profileId = '';
  let previous: string | undefined;
  try {
    const update = updateSovereigntyConfigFile({
      path: input.path,
      patch: (current) => {
        const routes = Object.entries(current.modelProfiles).filter(([, profile]) => profile.provider === 'zkapi');
        if (routes.length !== 1 || !routes[0]![1].zkapi) throw new RouteMissing();
        const [id, profile] = routes[0]!;
        profileId = id;
        previous = profile.zkapi!.fundingDate;
        if (previous === date) return current;
        const next = structuredClone(current) as SovereigntyConfig;
        (next.modelProfiles[id] as { zkapi: ZkapiConsultSettings }).zkapi = { ...profile.zkapi!, fundingDate: date };
        return next;
      },
    });
    if (!update.ok) {
      if (update.reason === 'uncertain') return { ok: false, code: 'policy_uncertain', message: 'Olympus could not confirm whether the privacy policy file changed. Run the command again to check.' };
      return { ok: false, code: 'policy_unreadable', message: 'The privacy policy file could not be read. Nothing was written.' };
    }
    return { ok: true, changed: update.changed, fundingDate: date, ...(previous ? { previous } : {}), profileId };
  } catch (error) {
    if (error instanceof RouteMissing) return { ok: false, code: 'route_not_configured', message: 'The privacy policy has no zkAPI route. Add it from Anonymous answers in the dashboard first.' };
    if (error instanceof FileLeaseBusyError) return { ok: false, code: 'policy_busy', message: 'Another change to the privacy policy file is in progress. Nothing was written; try again.' };
    throw error;
  }
}

type ZkapiProfiles = Readonly<Record<string, { readonly provider: string; readonly zkapi?: ZkapiConsultSettings }>>;

/**
 * Returns a function that overlays the policy file's current funding date on
 * the boot profiles. Without a policy file it returns the profiles as given.
 * The boot profiles are never mutated; profiles other than the zkapi route
 * pass through as the same objects.
 */
export function zkapiFundingDateRefresher(path: string | undefined): <P extends ZkapiProfiles>(profiles: P) => P {
  let seen: string | undefined;
  let known: { id: string; fundingDate: string | undefined } | undefined;
  const current = (): typeof known => {
    if (!path) return undefined;
    let key: string;
    try {
      const stat = statSync(path);
      key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return known;
    }
    if (key === seen) return known;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { modelProfiles?: Record<string, { provider?: unknown; zkapi?: { fundingDate?: unknown } }> };
      const routes = Object.entries(raw?.modelProfiles ?? {}).filter(([, profile]) => profile?.provider === 'zkapi');
      if (routes.length !== 1) return known;
      const [id, profile] = routes[0]!;
      const date = profile.zkapi?.fundingDate;
      if (date !== undefined && (typeof date !== 'string' || parseIsoDate(date) === undefined)) return known;
      known = { id, fundingDate: date };
      seen = key;
    } catch {
      // Mid-write or hand-edited into invalid JSON: keep the last good date and look again next time.
    }
    return known;
  };
  return <P extends ZkapiProfiles>(profiles: P): P => {
    const live = current();
    if (!live) return profiles;
    const profile = profiles[live.id];
    if (!profile || profile.provider !== 'zkapi' || !profile.zkapi || profile.zkapi.fundingDate === live.fundingDate) return profiles;
    const { fundingDate: _old, ...rest } = profile.zkapi;
    const zkapi = live.fundingDate === undefined ? rest : { ...rest, fundingDate: live.fundingDate };
    return { ...profiles, [live.id]: { ...profile, zkapi } };
  };
}
