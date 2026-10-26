/**
 * A child item's own id (docs/design/child-items.md, "Contract"): its parent's
 * `providerItemId`, the separator, and the child's key within its parent (an
 * attachment's ordinal, a MIME part path, Telegram's `media`). Every connector
 * builds a child's id here, so the shared readers can find the parent from the
 * child alone (`parentIdentityOf`): a Secret attachment stays hidden by its
 * parent's standing even once the parent's row is gone.
 */

/** The separator between a parent's `providerItemId` and its child's key. */
export const CHILD_ITEM_ID_SEPARATOR = '#child:';

/** `<parent providerItemId>#child:<key>`. The key is the connector's own, stable for the same child. */
export function childProviderItemId(parentProviderItemId: string, key: string): string {
  if (!parentProviderItemId) throw new TypeError('A child needs its parent\'s id.');
  if (!key || key.includes(CHILD_ITEM_ID_SEPARATOR)) throw new TypeError('A child\'s key must be plain text.');
  return `${parentProviderItemId}${CHILD_ITEM_ID_SEPARATOR}${key}`;
}
