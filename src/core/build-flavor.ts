/**
 * Source checkouts keep the complete repository runtime. The release builder
 * replaces this module with a compile-time `true` constant so private-only
 * branches and imports are removed from the public package bytes.
 */
export const PUBLIC_RUNTIME_BUILD = false;
