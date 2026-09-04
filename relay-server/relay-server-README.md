# Branch HQ Pairing Relay

A small, standalone WebSocket server that lets two Branch HQ installations pair with each other over the internet, not just the same local network. This is entirely separate from the main Branch HQ app -- it needs to be deployed somewhere publicly reachable for worldwide pairing to work at all.

## What this server does and does not do

- It matches two devices that present the same short, single-use pairing code, then forwards whatever messages they send each other -- nothing more.
- It never sees either device's private key, project code, generated files, or any client-specific information. The actual identity verification (Ed25519 signing) happens entirely on the two devices; this server only ever relays already-signed messages it cannot itself produce or forge.
- This is what keeps worldwide pairing honestly consistent with the rest of Branch HQ's local-first design -- the one thing that leaves a device during worldwide pairing is pairing handshake metadata, never actual work.

## Deploying it

This is a plain Node process. It runs anywhere that can run Node and expose a port -- a small VPS, Render, Railway, Fly.io, or your own machine if you're comfortable exposing it.

```bash
npm install
PORT=8080 npm start
```

**Put a real TLS-terminating reverse proxy in front of it for production** (nginx, Caddy, or your hosting provider's built-in HTTPS/WSS support). This server speaks plain `ws://` on its own -- without a real reverse proxy providing `wss://`, the pairing handshake travels unencrypted over the network, even though it's still cryptographically signed and verified end-to-end. Both are worth having: encryption in transit, and the signature verification that already happens regardless of transport.

## Configuring Branch HQ to use it

Once deployed, set the relay's public `wss://` URL in Branch HQ's own Settings (Worldwide Pairing). Anyone you want to worldwide-pair with needs their Branch HQ pointed at the *same* relay URL -- the invite string itself carries the relay URL along with the pairing code, so whoever redeems your invite doesn't need to configure this separately beforehand.

## Who should run this

Nobody has to. Worldwide pairing is entirely opt-in on the Branch HQ side -- if you never configure a relay URL, nothing about this feature is ever used, and LAN pairing (which needs no external server at all) works exactly as it always has. Running this relay is a deliberate choice, not something Branch HQ requires.