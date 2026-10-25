/**
 * What the archive layer adds around an archive that is one input of a source
 * (docs/design/archive-live-one-dataset.md, sections 1 to 3). The source's own
 * connector reads the input and builds the items (core/source-inputs.ts); this
 * module keeps only what is the archive's: its resume point is bound to its
 * files, and every item built from one of its records is held Private until
 * the private model has judged it.
 */
import { ArchiveImportStoppedError } from '../../core/archive-formats.ts';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorInput,
  SourceConnectorListOptions,
  SourceConnectorListPage,
  SourceRecordPage,
} from '../../core/contracts.ts';
import { inputConnector } from '../../core/source-inputs.ts';
import type { IntakeObservingInput, SourceIntakeOutcome, SourceRecordBuilder } from '../../core/source-inputs.ts';

/**
 * Binds an archive input's resume point to the files it was made for: the
 * cursor the input hands out names the manifest, and a cursor of other files
 * stops the import (`resume_point_invalid`) instead of reading different
 * bytes from where the old ones ended. Every archive input has this, whatever
 * its format.
 */
export function bindInputToFiles<R>(input: SourceConnectorInput<R>, manifestSha256: string): SourceConnectorInput<R> {
  const prefix = `${manifestSha256}|`;
  return {
    inputId: input.inputId,
    kind: input.kind,
    records(options): AsyncIterable<SourceRecordPage<R>> {
      let inner: string | undefined;
      if (options?.cursor !== undefined) {
        if (!options.cursor.startsWith(prefix)) {
          throw new ArchiveImportStoppedError('resume_point_invalid', 'This import\'s resume point does not belong to its files.');
        }
        inner = options.cursor.slice(prefix.length);
      }
      const pages = input.records({
        ...(inner !== undefined ? { cursor: inner } : {}),
        ...(options?.limit !== undefined ? { limit: options.limit } : {}),
      });
      return (async function* (): AsyncGenerator<SourceRecordPage<R>> {
        for await (const page of pages) {
          yield (page.nextCursor !== undefined ? { ...page, nextCursor: `${prefix}${page.nextCursor}` } : page) as SourceRecordPage<R>;
        }
      })();
    },
  };
}

/**
 * A source's connector that also reads inputs: `forInput` hands an input to the
 * source's own record builder, so a live pull and an imported archive build
 * their items the same way (core/source-inputs.ts). A source whose connector
 * lists the live reader some other way adds the one method to it and nothing
 * else.
 */
export function withInputs<R>(connector: SourceConnector, builder: SourceRecordBuilder<R>): SourceConnector {
  const withMethod = Object.create(connector) as SourceConnector;
  withMethod.forInput = (input: SourceConnectorInput): SourceConnector => inputConnector(builder, input as IntakeObservingInput<R>);
  return withMethod;
}

/** The input told what each page of its records came to (core/source-inputs.ts). */
export function observingIntake<R>(
  input: SourceConnectorInput<R>,
  observe: (outcomes: readonly SourceIntakeOutcome[]) => void,
): IntakeObservingInput<R> {
  return { inputId: input.inputId, kind: input.kind, records: (options) => input.records(options), observeIntake: observe };
}

/**
 * The connector of an archive input with every item it lists held until the
 * private model has judged it (`RawItem.holdContentUntilJudged`). Placement
 * honours the hold through first classification and child extraction, and the
 * persisted hold keeps applying to the item's later versions, a live one
 * included, until it was judged. Done here, after the source's connector, so
 * no source or format sets it and none can forget to.
 */
export function holdingItems(connector: SourceConnector): SourceConnector {
  const held = Object.create(connector) as SourceConnector;
  held.listItems = (options?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage> => {
    const pages = connector.listItems(options);
    return (async function* (): AsyncGenerator<SourceConnectorListPage> {
      for await (const page of pages) {
        yield { ...page, items: page.items.map((item): RawItem => ({ ...item, holdContentUntilJudged: true })) } as SourceConnectorListPage;
      }
    })();
  };
  return held;
}
