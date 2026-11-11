/**
 * The backend for the model pickers on Privacy rules (owner, 2026-11-07,
 * mockups final-4 and final-5): what each picker lists, and saving a pick.
 *
 * Pinned models are written where the runtime already reads them (the
 * sovereignty profiles); "Always the strongest" and the built-in size are
 * kept in model-choices.json beside the policy (core/model-choices.ts). Every
 * save that changes what answers asks the worker to reload, like a new key.
 */
import {
  addableVeniceModels,
  BUILT_IN_SIZES,
  readModelChoices,
  STRONGEST_MODEL,
  validModelId,
  writeModelChoices,
  type BuiltInSize,
  type DashboardModelChoices,
  type ModelChoiceList,
  type ModelChoiceProvider,
} from '../../../core/model-choices.ts';
import { updateSovereigntyConfigFile, type SovereigntyConfig } from '../../../core/sovereignty.ts';
import { BUILT_IN_REASONING_MODELS } from '../../source-index/built-in-reasoning/manifest.ts';
import type { VenicePrivacyCategory } from '../../../core/venice-models.ts';

export const VENICE_PROFILE_ID = 'venice-private';
export const LOCAL_PROFILE_ID = 'local-source-answer';

export interface ModelChoicesBackendOptions {
  /** The writable policy file; absent: nothing can be saved. */
  policyPath?: string;
  config: () => SovereigntyConfig;
  /**
   * Whether the built-in model answers now: it backs the local profile and
   * the owner's model server, which is tried first, is not answering.
   */
  builtInAnswers: () => boolean | Promise<boolean>;
  /** The built-in model this worker runs now, by size; absent: none. */
  builtInSize: () => BuiltInSize | undefined;
  totalMemoryBytes: number;
  /**
   * zkAPI: questions go to the consult settings' model (consult.json, the same
   * setting Outside help edits), never the sovereignty profile. Unset means
   * the release's default, which is what "Always the strongest" follows.
   */
  zkapi?: {
    available: () => boolean;
    strongest: string;
    read: () => string | undefined;
    write: (model: string | undefined) => Promise<{ ok: true } | { ok: false; message: string }>;
  };
  /** Venice: the model "Always the strongest" resolves to now, and the catalog of addable models. */
  venice?: {
    strongest: () => Promise<string | undefined>;
    catalog: () => Promise<Readonly<Record<string, VenicePrivacyCategory>>>;
  };
  requestReload: () => boolean;
}

export interface ModelChoicesBackend {
  status(): Promise<DashboardModelChoices>;
  save(provider: ModelChoiceProvider, value: string): Promise<{ ok: true; status_message: string } | { ok: false; message: string }>;
  addable(provider: 'venice'): Promise<string[]>;
  /** Re-resolve every "Always the strongest" and write a changed model (boot and the readiness check). */
  refreshStrongest(): Promise<boolean>;
}

const SIZE_NOTES: Record<BuiltInSize, string> = {
  small: 'built in · faster, simpler answers',
  standard: 'built in · recommended for most computers',
  large: 'built in · better answers, slower',
};

export function createModelChoicesBackend(options: ModelChoicesBackendOptions): ModelChoicesBackend {
  const profileModel = (id: string): string | undefined => {
    const profile = options.config().modelProfiles[id];
    return profile && 'model' in profile && typeof profile.model === 'string' ? profile.model : undefined;
  };
  const writeProfileModel = (id: string, model: string): boolean => {
    if (!options.policyPath) return false;
    if (profileModel(id) === model) return true;
    const result = updateSovereigntyConfigFile({ path: options.policyPath, expect: options.config(), patch: current => {
      const profile = current.modelProfiles[id];
      if (!profile || !('model' in profile)) return current;
      return { ...current, modelProfiles: { ...current.modelProfiles, [id]: { ...profile, model } } };
    } });
    return result.ok && result.changed;
  };
  const fittingSizes = (): BuiltInSize[] => BUILT_IN_SIZES.filter(size => {
    const spec = BUILT_IN_REASONING_MODELS.find(model => model.sizeClass === size);
    return spec !== undefined && options.totalMemoryBytes >= spec.minimumMemoryBytes;
  });
  const sizeName = (size: BuiltInSize): string => BUILT_IN_REASONING_MODELS.find(model => model.sizeClass === size)?.displayName ?? size;

  const localList = async (): Promise<ModelChoiceList | undefined> => {
    const external = profileModel(LOCAL_PROFILE_ID);
    if (!await options.builtInAnswers()) {
      // A model server the owner runs answers: it is the one option, and Add a model replaces it.
      return external ? { provider: 'local', current: external, options: [{ value: external, label: external, note: 'on a model server you run' }] } : undefined;
    }
    const current = options.builtInSize();
    const sizes = fittingSizes();
    if (sizes.length === 0) return undefined;
    return {
      provider: 'local',
      current: current ? `builtin:${current}` : '',
      options: sizes.map(size => ({ value: `builtin:${size}`, label: sizeName(size), note: SIZE_NOTES[size] })),
    };
  };

  const veniceList = async (): Promise<ModelChoiceList | undefined> => {
    const pinned = profileModel(VENICE_PROFILE_ID);
    if (!pinned) return undefined;
    const mode = options.policyPath ? readModelChoices(options.policyPath).venice : undefined;
    const strongestNow = mode === 'strongest' ? pinned : undefined;
    return {
      provider: 'venice',
      current: mode === 'strongest' ? STRONGEST_MODEL : pinned,
      ...(strongestNow ? { strongestNow } : {}),
      options: [
        { value: STRONGEST_MODEL, label: 'Always the strongest', note: "Olympus moves to Venice's strongest private reasoning model when a new one arrives." },
        { value: pinned, label: pinned, note: mode === 'strongest' ? 'stay on this one' : 'in use' },
      ],
    };
  };

  const zkapiList = (): ModelChoiceList | undefined => {
    const zkapi = options.zkapi;
    if (!zkapi?.available()) return undefined;
    const pinned = zkapi.read();
    const choices = [{ value: STRONGEST_MODEL, label: 'Always the strongest', note: 'Olympus moves to the strongest zkAPI model with each release.' }];
    if (pinned) choices.push({ value: pinned, label: pinned, note: 'in use' });
    if (zkapi.strongest !== pinned) choices.push({ value: zkapi.strongest, label: zkapi.strongest, note: 'the strongest now' });
    return {
      provider: 'zkapi',
      current: pinned ?? STRONGEST_MODEL,
      ...(pinned ? {} : { strongestNow: zkapi.strongest }),
      options: choices,
    };
  };

  const applied = (message: string) => {
    const reloaded = options.requestReload();
    return { ok: true as const, status_message: reloaded ? message : `${message} Restart Olympus to apply it.` };
  };

  return {
    async status() {
      const [venice, local] = await Promise.all([veniceList(), localList()]);
      const zkapi = zkapiList();
      return { ...(local ? { local } : {}), ...(venice ? { venice } : {}), ...(zkapi ? { zkapi } : {}) };
    },

    async save(provider, value) {
      if (provider === 'zkapi') {
        const zkapi = options.zkapi;
        if (!zkapi?.available()) return { ok: false, message: 'Set up zkAPI first.' };
        if (value !== STRONGEST_MODEL && !validModelId(value)) return { ok: false, message: 'Enter a zkAPI model name such as provider/model.' };
        // The consult settings are read at each question, so no reload is needed.
        const written = await zkapi.write(value === STRONGEST_MODEL ? undefined : value);
        if (!written.ok) return written;
        return { ok: true, status_message: value === STRONGEST_MODEL ? `Saved. zkAPI questions go to ${zkapi.strongest}, and Olympus follows the strongest from now on.` : `Saved. zkAPI questions go to ${value}.` };
      }
      if (!options.policyPath) return { ok: false, message: 'Olympus cannot save model choices here: the policy is not a file it can write.' };
      if (provider === 'local') {
        const size = value.startsWith('builtin:') ? value.slice('builtin:'.length) as BuiltInSize : undefined;
        if (!size || !fittingSizes().includes(size)) return { ok: false, message: 'Choose one of the models listed.' };
        if (!await options.builtInAnswers()) return { ok: false, message: 'A model server you run answers now. Use Add a model to change it.' };
        if (options.builtInSize() === size) return { ok: true, status_message: 'That model is already in use.' };
        writeModelChoices(options.policyPath, { builtIn: size });
        return applied(`Saved. Olympus is getting ${sizeName(size)} ready; it answers once it has downloaded and checked it.`);
      }
      if (provider === 'venice') {
        if (!profileModel(VENICE_PROFILE_ID)) return { ok: false, message: 'Connect Venice first.' };
        if (value === STRONGEST_MODEL) {
          const strongest = await options.venice?.strongest();
          writeModelChoices(options.policyPath, { venice: 'strongest' });
          if (strongest && !writeProfileModel(VENICE_PROFILE_ID, strongest)) return { ok: false, message: 'The policy changed while saving. Refresh and try again.' };
          return applied(strongest ? `Saved. Venice answers with ${strongest}, and Olympus follows the strongest from now on.` : 'Saved. Olympus follows the strongest Venice model once it can reach Venice.');
        }
        if (!validModelId(value)) return { ok: false, message: 'Choose one of the models listed.' };
        const allowed = await this.addable('venice');
        if (value !== profileModel(VENICE_PROFILE_ID) && !allowed.includes(value)) return { ok: false, message: 'Venice does not list that model as private. Choose another.' };
        writeModelChoices(options.policyPath, { venice: 'pinned' });
        if (!writeProfileModel(VENICE_PROFILE_ID, value)) return { ok: false, message: 'The policy changed while saving. Refresh and try again.' };
        return applied(`Saved. Venice answers with ${value}.`);
      }
      return { ok: false, message: 'Choose one of the models listed.' };
    },

    async addable(provider) {
      if (provider !== 'venice' || !options.venice) return [];
      return addableVeniceModels(await options.venice.catalog().catch(() => ({})));
    },

    async refreshStrongest() {
      if (!options.policyPath) return false;
      const state = readModelChoices(options.policyPath);
      let changed = false;
      if (state.venice === 'strongest' && options.venice && profileModel(VENICE_PROFILE_ID)) {
        const strongest = await options.venice.strongest().catch(() => undefined);
        // The owner may have pinned a model while the lookup ran: then it stays.
        const still = readModelChoices(options.policyPath).venice === 'strongest';
        if (still && strongest && strongest !== profileModel(VENICE_PROFILE_ID)) changed = writeProfileModel(VENICE_PROFILE_ID, strongest) || changed;
      }
      if (changed) options.requestReload();
      return changed;
    },
  };
}
