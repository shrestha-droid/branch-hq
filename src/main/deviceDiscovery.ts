import Bonjour from 'bonjour-service'
import type { Service } from 'bonjour-service'

// NEW: Phase 1, part 3 -- LAN discovery via mDNS (the same underlying
// technology as AirPlay/Chromecast/network printers). Deliberately
// LAN-only, no cloud relay or public discovery server of any kind --
// anything else would mean Branch HQ instances routing through a third
// party just to find each other, directly undermining the "nothing
// leaves your machine" pitch that's the actual product differentiator.
// bonjour-service chosen specifically because it's pure JavaScript/
// TypeScript -- no native compilation, no platform SDK to install
// (unlike the older 'mdns' package, which needs a C++ compiler and,
// on Windows, Apple's separate Bonjour SDK) -- the same reasoning that
// already led this project to bcryptjs over bcrypt for WebContainer
// compatibility.
//
// Discovery alone grants NO trust -- a discovered device is just
// something visible on the network, nothing more. Actual trust only
// exists after the pairing handshake in devicePairing.ts completes.
// The device's real public key IS included in the discovery
// advertisement (in the TXT record) specifically so the pairing flow
// can compute its human-verification code immediately, before any
// pairing request is even sent -- not because discovery itself is
// trusted.

const SERVICE_TYPE = 'branchhq'

export interface DiscoveredDevice {
  deviceId: string
  deviceName: string
  publicKeyPem: string
  host: string
  port: number
  lastSeen: number
}

let bonjourInstance: InstanceType<typeof Bonjour> | null = null
const discovered = new Map<string, DiscoveredDevice>()

function serviceToDiscoveredDevice(service: Service): DiscoveredDevice | null {
  const txt = (service.txt || {}) as Record<string, string>
  const deviceId = txt.deviceId
  const publicKeyPem = txt.publicKeyPem
  if (!deviceId || !publicKeyPem) return null // Not a genuine Branch HQ advertisement -- malformed or foreign.

  const address = (service.addresses || []).find(a => a.includes('.')) || service.addresses?.[0] || service.host
  return {
    deviceId,
    deviceName: txt.deviceName || service.name || 'Unknown Device',
    publicKeyPem,
    host: address,
    port: service.port,
    lastSeen: Date.now()
  }
}

// Starts advertising this installation on the LAN and browsing for
// others. Safe to call once at app startup; safe to no-op if called
// again (e.g. after a settings change) without leaking a duplicate
// advertisement -- stopDiscovery() first if genuinely restarting it.
export function startDiscovery(params: { deviceId: string; deviceName: string; publicKeyPem: string; pairingPort: number }): void {
  if (bonjourInstance) return

  // errorCallback prevents a real, confirmed failure mode -- an
  // unhandled mdns/bonjour error would otherwise crash the whole
  // Electron app, for something as non-critical as "device discovery
  // hit a network hiccup." Logged, not fatal.
  bonjourInstance = new Bonjour(undefined, (err: Error) => {
    console.error('[Device Discovery] Bonjour error (non-fatal):', err.message)
  })

  bonjourInstance.publish({
    name: `${params.deviceName} (${params.deviceId.slice(0, 8)})`,
    type: SERVICE_TYPE,
    port: params.pairingPort,
    txt: {
      deviceId: params.deviceId,
      deviceName: params.deviceName,
      publicKeyPem: params.publicKeyPem
    }
  })

  const browser = bonjourInstance.find({ type: SERVICE_TYPE }, (service: Service) => {
    const device = serviceToDiscoveredDevice(service)
    // Never list this device's own advertisement as a "discovered
    // peer" -- mDNS browsing on the same host can see its own
    // published service.
    if (device && device.deviceId !== params.deviceId) {
      discovered.set(device.deviceId, device)
    }
  })

  browser.on('down', (service: Service) => {
    const txt = (service.txt || {}) as Record<string, string>
    if (txt.deviceId) discovered.delete(txt.deviceId)
  })
}

export function stopDiscovery(): void {
  if (!bonjourInstance) return
  try { bonjourInstance.unpublishAll(() => {}) } catch { /* best-effort */ }
  try { bonjourInstance.destroy() } catch { /* best-effort */ }
  bonjourInstance = null
  discovered.clear()
}

// NEW: a discovered device stops being listed if it hasn't been seen
// in a while -- mDNS 'down' events aren't always reliable (a device
// that loses network connectivity abruptly, rather than shutting down
// cleanly, may never send one), so this is a real, active staleness
// check rather than trusting 'down' alone.
const STALE_MS = 60_000

export function listDiscoveredDevices(): DiscoveredDevice[] {
  const now = Date.now()
  const live: DiscoveredDevice[] = []
  for (const [id, device] of discovered.entries()) {
    if (now - device.lastSeen > STALE_MS) {
      discovered.delete(id)
    } else {
      live.push(device)
    }
  }
  return live
}