// WhatsApp as a source an imported chat export joins
// (docs/design/archive-live-one-dataset.md, sections 1 and 7;
// archive-import/source-targets.ts).
//
// - Account: an export never names its account. It joins the source's only
//   account at the owner's confirmation in the import sheet, or creates the
//   account, which pairing then joins; the owner can keep it apart under
//   Archives instead.
// - No exclusive runner: the WhatsApp account guard never binds another
//   account's stores over this one, so the scheduler key keeps an import from
//   running beside a live pull, and nothing more is needed.
// - One connector: the live connector, which reads the export through
//   `forInput` with the same record builder as the spool.

import { WHATSAPP_SOURCE_ID } from '../../core/olympus-layout.ts';
import type { LayoutEnv } from '../../core/olympus-layout.ts';
import type { StorageAccount } from '../../core/source-storage.ts';
import type { ConnectorStoreSyncOptions } from '../connector-store/index.ts';
import type { TieredStoreSet } from '../connector-store/tiered-store-set.ts';
import { withInputs } from '../archive-import/source-input.ts';
import type { ArchiveSourceLane, ArchiveSourceTarget } from '../archive-import/source-targets.ts';
import { WHATSAPP_ARCHIVE_FORMAT_ID } from '../archive-import/whatsapp/connector.ts';
import { createWhatsAppExportInput } from './archive-input.ts';
import { createWhatsAppLiveSourceConnector, createWhatsAppRecordBuilder } from './live-connector.ts';
import {
  WHATSAPP_LIVE_CORPUS_ID,
  WHATSAPP_PERSONAL_ACCOUNT_SCOPE,
  WHATSAPP_PRODUCT_CONNECTOR_ID,
  WHATSAPP_STORE_PLACEMENT,
  defaultWhatsAppSpoolDir,
} from './store-sync.ts';

/** The live pull's own sync options: one code path for every input. */
export const WHATSAPP_LANE_SYNC: ConnectorStoreSyncOptions = Object.freeze({
  placement: WHATSAPP_STORE_PLACEMENT,
  fetchContent: true,
  deferMetadataOnlyContent: true,
});

export interface WhatsAppArchiveTargetOptions {
  env: LayoutEnv;
  /** The account's tier set: the live lane's own when it is open, else opened for the import. */
  set(account: Required<StorageAccount>, env: LayoutEnv): TieredStoreSet;
  /** Reads an imported child's bytes by its locator (archive-import/input-media.ts). */
  readChild?: (locator: string, options: { maxBytes?: number }) => Uint8Array;
  /** Zones the export input tries (test seam). */
  zones?: readonly string[];
}

/** The WhatsApp connector of an account, live and with its export inputs. */
export function whatsAppConnectorWithInputs(options: {
  spoolDir: string;
  readChild?: (locator: string, options: { maxBytes?: number }) => Uint8Array;
}) {
  const live = {
    ...createWhatsAppLiveSourceConnector({ spoolDir: options.spoolDir, account: WHATSAPP_PERSONAL_ACCOUNT_SCOPE }),
    id: WHATSAPP_PRODUCT_CONNECTOR_ID,
  };
  const builder = createWhatsAppRecordBuilder({
    spoolDir: options.spoolDir,
    account: WHATSAPP_PERSONAL_ACCOUNT_SCOPE,
    ...(options.readChild ? { readChild: options.readChild } : {}),
  });
  const connector = withInputs(live, builder);
  // A child an export brought is read by its locator; anything else as the live connector reads it.
  connector.fetchItem = (localItemId, fetchOptions) => builder.fetchItem(localItemId, fetchOptions);
  return connector;
}

export function createWhatsAppArchiveTarget(options: WhatsAppArchiveTargetOptions): ArchiveSourceTarget {
  return {
    sourceId: WHATSAPP_SOURCE_ID,
    label: 'WhatsApp',
    formats: [WHATSAPP_ARCHIVE_FORMAT_ID],
    // The live pull's scheduler key (its corpus): an import never runs beside it.
    concurrencyKey: WHATSAPP_LIVE_CORPUS_ID,
    identify: () => ({ kind: 'none' }),
    input: (archive) => createWhatsAppExportInput({
      archive,
      spoolDir: defaultWhatsAppSpoolDir(options.env),
      ...(options.zones ? { zones: options.zones } : {}),
    }),
    lane(account, env): ArchiveSourceLane {
      return {
        set: options.set(account, env),
        sync: WHATSAPP_LANE_SYNC,
        connector: whatsAppConnectorWithInputs({
          spoolDir: defaultWhatsAppSpoolDir(env),
          ...(options.readChild ? { readChild: options.readChild } : {}),
        }),
      };
    },
  };
}
