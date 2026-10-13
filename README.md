# legendkeeper2foundry

Foundry VTT v14 module and companion service that keep a LegendKeeper project and Foundry journals aligned. LegendKeeper's typed blocks stay the canonical document. The Foundry module never stores the LegendKeeper API key.

The first gate is a round trip: import a page, edit one paragraph in Foundry, and see only that edit back in LegendKeeper. Unsupported blocks are preserved. Maps, boards, and timelines are placeholders.

## Requirements

- Node.js 22.14.0
- Foundry Virtual Tabletop 14
- A LegendKeeper Admin API key from a paid project

## Layout

- `packages/foundry` is the Foundry module. Copy or link it to `Data/modules/legendkeeper`.
- `packages/service` is the companion service.
- `packages/inventory` is the read-only compatibility probe.
- `docs/compatibility.md` is the block matrix.
- `docs/connectivity.md` explains loopback versus a later HTTPS endpoint.
- `docs/round-trip.md` is the acceptance test.

## Service

The default bind is loopback. A GM browser on another computer cannot use `127.0.0.1`. See `docs/connectivity.md`.

```sh
export LEGENDKEEPER_API_KEY="admin key"
export LEGENDKEEPER_PAIRING_CODE="$(openssl rand -hex 24)"
node packages/service/src/main.js
```

In Foundry, set the companion service URL, then pair with the code. Pairing mints a revocable token kept in a client setting. Players read journals from Foundry. They do not submit LegendKeeper changes.

Imported journals are GM-only until you explicitly share them. Hidden documents stay out of Foundry documents. Secret blocks stay in the service database.

## Inventory

```sh
node packages/inventory/src/cli.js
```

With `LEGENDKEEPER_API_KEY` set, the same command also writes aggregate live counts. It does not assign block ids or write pages.

## Tests

```sh
npm test
```
