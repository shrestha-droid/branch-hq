// NEW: the relay server for worldwide (non-LAN) Branch HQ device
// pairing. This is a SEPARATE, standalone application -- it does NOT
// run inside the Electron app, and does not ship as part of it. It's
// meant to be deployed on any publicly reachable host (a small VPS,
// Render, Railway, Fly.io -- anywhere that can run a Node process and
// expose a port) by whoever chooses to offer worldwide pairing, since
// a device on a home network generally can't accept inbound
// connections from strangers on the internet the way it can from
// another device on the same LAN.
//
// WHAT THIS SERVER CAN AND CANNOT SEE -- read this before deploying it
// anywhere, since it's the actual security/privacy boundary of the
// whole worldwide-pairing feature:
//   - It sees: a short, single-use pairing code, and whatever JSON
//     blobs the two matched devices choose to send each other through
//     it (in practice, the same signed deviceId/publicKey/signature
//     payloads already used for LAN pairing).
//   - It does NOT see, and structurally cannot see: either device's
//     private key, any project code, any generated files, any Client
//     Facts, any Project Knowledge, or anything about what either
//     device does after pairing completes. Pairing is the ONLY thing
//     that ever touches this server. The actual cryptographic identity
//     verification (Ed25519 signing/verification) happens entirely on
//     the two devices themselves, exactly as it does for LAN pairing --
//     this server is a dumb message-forwarding pipe between two
//     sockets that share a code, nothing more. It could theoretically
//     be run by someone other than the two people pairing (a shared,
//     third-party relay) without that person gaining any usable
//     insight into either device's actual work.
//   - This is what keeps worldwide pairing honestly compatible with
//     Branch HQ's own "nothing leaves your machine" positioning for
//     actual project work: pairing metadata is the one narrow
//     exception, opted into explicitly, and even that exception never
//     includes real project content.
//
// DEPLOYMENT: `npm install` in this folder, then `node index.js`
// (or `PORT=8080 node index.js` to pick a specific port). Point it
// behind a real TLS-terminating reverse proxy (nginx, Caddy, or your
// host's own built-in HTTPS) for a genuine wss:// URL in production --
// running bare ws:// over the open internet means the pairing
// handshake, while still cryptographically signed and verified,
// travels unencrypted in transit. This file deliberately does not
// implement TLS itself -- that's the deploying host's job, and doing
// it well (real certs, renewal) is much better handled by an existing,
// battle-tested reverse proxy than reimplemented here.

const WebSocket = require('ws')

const PORT = process.env.PORT || 8080
// Matches the LAN invite's own TTL (devicePairing.ts) -- an unclaimed
// code past this age is removed, so a stale, never-used code can't
// linger and eventually be guessed or reused.
const CODE_TTL_MS = 10 * 60 * 1000
// A real, if crude, cap on relayed message size. Nothing in the actual
// pairing handshake should ever need more than a few KB (a device id,
// a public key PEM, a signature, a device name) -- refusing anything
// larger is cheap protection against this being used as an ad hoc data
// tunnel for something it was never meant to carry.
const MAX_MESSAGE_BYTES = 64 * 1024

const wss = new WebSocket.Server({ port: PORT })

// code -> { socket, createdAt } -- the first device to show up for a
// given code waits here until a second one joins with the same code.
const waiting = new Map()

function safeSend(socket, data) {
  if (socket.readyState === WebSocket.OPEN) {
    try { socket.send(JSON.stringify(data)) } catch { /* peer likely just disconnected -- nothing more to do */ }
  }
}

// Periodic sweep for codes nobody ever claimed -- without this, a
// device that generates an invite and then closes the app without
// anyone redeeming it would leave that code (and the open socket
// waiting on it) sitting in memory indefinitely.
setInterval(() => {
  const now = Date.now()
  for (const [code, entry] of waiting.entries()) {
    if (now - entry.createdAt > CODE_TTL_MS) {
      try { entry.socket.close() } catch { /* already gone */ }
      waiting.delete(code)
    }
  }
}, 60 * 1000)

wss.on('connection', (socket) => {
  let joinedCode = null

  socket.on('message', (raw) => {
    if (raw.length > MAX_MESSAGE_BYTES) {
      safeSend(socket, { type: 'error', message: 'Message too large.' })
      return
    }

    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      safeSend(socket, { type: 'error', message: 'Malformed message.' })
      return
    }

    if (msg.type === 'register' || msg.type === 'join') {
      const code = String(msg.code || '').slice(0, 64)
      if (!code) {
        safeSend(socket, { type: 'error', message: 'Missing code.' })
        return
      }

      const existing = waiting.get(code)
      if (existing) {
        // A second device showed up for this code -- match them and
        // remove the code from the waiting pool immediately, so a
        // THIRD device presenting the same code later gets nothing to
        // join (each code is good for exactly one pairing).
        waiting.delete(code)
        existing.socket.peer = socket
        socket.peer = existing.socket
        safeSend(existing.socket, { type: 'matched' })
        safeSend(socket, { type: 'matched' })
      } else {
        waiting.set(code, { socket, createdAt: Date.now() })
        joinedCode = code
      }
      return
    }

    if (msg.type === 'relay') {
      // Blind forwarding only -- this server never inspects, logs, or
      // acts on the actual payload contents, by design (see the note
      // at the top of this file).
      if (socket.peer) safeSend(socket.peer, { type: 'relay', payload: msg.payload })
      return
    }
  })

  socket.on('close', () => {
    if (joinedCode) waiting.delete(joinedCode)
    if (socket.peer) {
      safeSend(socket.peer, { type: 'peer-disconnected' })
      socket.peer.peer = null
    }
  })
})

console.log(`Branch HQ pairing relay listening on port ${PORT}`)