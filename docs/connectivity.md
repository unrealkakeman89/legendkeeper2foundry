# Connectivity

The companion service URL is a Foundry setting from the first module build. The sync protocol is the same for every profile. Only the address, TLS, and origin allowlist change.

## Same computer

Foundry and the authorized GM browser run on the host that runs the service.

- Bind `LEGENDKEEPER_HOST=127.0.0.1` (the default).
- Leave the module service URL at `http://127.0.0.1:8787`.
- This profile does not work for a browser on another computer. In that browser, `127.0.0.1` is the browser's own machine, not the Foundry server.

## Foundry on another computer

Run the service where the API key should live. Put it behind authenticated HTTPS or a reverse proxy. Set:

- `LEGENDKEEPER_HOST` to the proxy's bind address.
- `LEGENDKEEPER_ALLOWED_ORIGINS` to the origin of the Foundry site the GM browser uses.
- The module service URL to that HTTPS endpoint.

## Browser over the internet

Use the same authenticated HTTPS endpoint. Loopback is not a substitute. Browsers also apply CORS, secure-context rules, and local-network access limits. The service allowlists origins, and every operation still requires the revocable access token. CORS is not authentication.

## Credentials

- The LegendKeeper API key is an Admin key in the service environment. API keys have at most Admin privileges. A Member key hides hidden documents, which the sync would then treat as deletions.
- Pair Foundry once with the pairing code. The module stores the returned token in a client-scoped setting, not in a journal, world setting, or socket.
- Players receive journals from the Foundry server. They do not call the companion service, and the GM client does not relay their view.
