# Submitted engine's relay connection (frozen)

The relay client and the shared modules it loads, exactly as in commit
`2b0291fc905e4de7297965399b31dca41b648580`, the build submitted to OpenAI's
plugin directory and running on the reviewer demo engine
(`connect-relay/server/directory/approved.ts`). Do not edit these files:
`test/reviewer-path.test.ts` connects them to the current relay so a relay
change that would break the demo engine fails CI. Replace them only when the
demo engine is updated to a new submitted build.
