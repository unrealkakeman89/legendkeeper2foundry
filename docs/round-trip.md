# Round-trip proof

The first release gate is automated in `packages/service/test/round-trip.test.js`.

1. Create a LegendKeeper page with several formatted blocks, an image, and one unsupported block.
2. Import it into a Foundry V14 journal that starts GM-only.
3. Check stored block ids, formatting, and order against the original snapshot.
4. Edit exactly one paragraph in Foundry.
5. Sync that change with a surgical `blocks.update` that uses the original block id.
6. Fetch the page again from LegendKeeper.
7. Compare every unchanged block, including the unsupported block, ignoring document version and modification timestamp.
8. Restart the companion service and confirm the resource mapping and last accepted baseline are still stored.

Maps, boards, and timelines stay placeholders. `documents.assignBlockIds` is not part of import. A page whose blocks lack ids must be migrated with an explicit confirmation before the first edit, and the baseline is fetched again before that edit is accepted.
