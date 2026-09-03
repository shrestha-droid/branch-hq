import * as fs from 'fs/promises'
import * as path from 'path'
import { app } from 'electron'
import { computeVerificationCode } from './deviceIdentity'

// NEW: Phase 1, part 2 -- the actual pairing protocol and the persisted
// record of which devices this installation trusts. See
// deviceIdentity.ts for the cryptographic foundation this builds on.
//
// THE PROTOCOL, in full, since this is the security-critical part:
//
// 1. Device A discovers Device B via mDNS (deviceDiscovery.ts), which
//    already carries B's public key in the advertisement. A's user
//    clicks "Pair" -- A immediately computes and shows its own copy of
//    the verification code (it already has both keys at this point).
// 2. A -- POST /pairing/request to B -- signed with A's own key.
//    B verifies the signature (proves A holds the private key for the
//    public key it's claiming -- not yet proof of WHICH device, that's
//    what the human code comparison is for), computes the SAME
//    verification code, and shows a pairing prompt to B's user.
// 3. If B's user clicks Accept -- B -- POST /pairing/confirm to A --
//    signed with B's own key. A verifies, shows A's user the same
//    code it already computed, asks them to confirm it MATCHES what's
//    on B's screen.
// 4. If A's user confirms -- A adds B as trusted locally, then --
//    POST /pairing/finalize to B -- B adds A as trusted too. Only at
//    this point does either side actually trust the other; either
//    human declining, or the code not matching, must be a real STOP,
//    not something recoverable automatically.
//
// A KNOWN, INHERENT LIMIT worth stating plainly: this protects against
// tampering DURING the pairing exchange (a MITM substituting a
// different key will produce mismatched codes, which the humans should
// notice). It does NOT protect against an attacker impersonating B in
// mDNS discovery itself BEFORE any of this starts -- if A connects to
// an imposter believing it's B, the imposter's own code (computed from
// the imposter's real key) would show on A's screen, but B (the real
// one) would never see any request at all. The mitigation is the same
// as it is for any first-contact pairing scheme without a pre-shared
// secret (Bluetooth, WiFi Direct): if the other device's human doesn't
// see a matching request, both sides should stop and not proceed.

export interface TrustedPeer {
  deviceId: string
  deviceName: string
  publicKeyPem: string
  pairedAt: number
}

export interface PendingIncomingRequest {
  requestId: string
  fromDeviceId: string
  fromDeviceName: string
  fromPublicKeyPem: string
  verificationCode: string
  receivedAt: number
}

const TRUSTED_PEERS_PATH = () => path.join(app.getPath('userData'), 'branch-hq-trusted-peers.json')
const PENDING_REQUEST_TTL_MS = 90_000

let peersCache: Record<string, TrustedPeer> | null = null

async function loadPeers(): Promise<Record<string, TrustedPeer>> {
  if (peersCache) return peersCache
  try {
    const raw = await fs.readFile(TRUSTED_PEERS_PATH(), 'utf-8')
    peersCache = JSON.parse(raw)
  } catch {
    peersCache = {}
  }
  return peersCache!
}

async function savePeers(): Promise<void> {
  if (!peersCache) return
  await fs.mkdir(path.dirname(TRUSTED_PEERS_PATH()), { recursive: true }).catch(() => {})
  await fs.writeFile(TRUSTED_PEERS_PATH(), JSON.stringify(peersCache, null, 2), 'utf-8')
}

export async function getTrustedPeers(): Promise<TrustedPeer[]> {
  const peers = await loadPeers()
  return Object.values(peers)
}

export async function isPeerTrusted(deviceId: string): Promise<boolean> {
  const peers = await loadPeers()
  return !!peers[deviceId]
}

export async function getPeerPublicKey(deviceId: string): Promise<string | null> {
  const peers = await loadPeers()
  return peers[deviceId]?.publicKeyPem || null
}

export async function addTrustedPeer(peer: TrustedPeer): Promise<void> {
  const peers = await loadPeers()
  peers[peer.deviceId] = peer
  await savePeers()
}

export async function removeTrustedPeer(deviceId: string): Promise<void> {
  const peers = await loadPeers()
  delete peers[deviceId]
  await savePeers()
}

// NEW: in-memory only, deliberately -- a pairing request that isn't
// actively being decided on right now has no reason to survive an app
// restart, and letting it persist would just be a stale prompt
// resurfacing days later. Keyed by a random request id, not deviceId,
// so a device that sends a second request before the first is decided
// doesn't silently clobber the pending one.
const pendingIncoming = new Map<string, PendingIncomingRequest>()

export function createPendingIncomingRequest(params: {
  fromDeviceId: string
  fromDeviceName: string
  fromPublicKeyPem: string
  myPublicKeyPem: string
}): PendingIncomingRequest {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const request: PendingIncomingRequest = {
    requestId,
    fromDeviceId: params.fromDeviceId,
    fromDeviceName: params.fromDeviceName,
    fromPublicKeyPem: params.fromPublicKeyPem,
    verificationCode: computeVerificationCode(params.fromPublicKeyPem, params.myPublicKeyPem),
    receivedAt: Date.now()
  }
  pendingIncoming.set(requestId, request)
  return request
}

export function getPendingIncomingRequest(requestId: string): PendingIncomingRequest | null {
  const request = pendingIncoming.get(requestId)
  if (!request) return null
  if (Date.now() - request.receivedAt > PENDING_REQUEST_TTL_MS) {
    pendingIncoming.delete(requestId)
    return null
  }
  return request
}

export function consumePendingIncomingRequest(requestId: string): void {
  pendingIncoming.delete(requestId)
}

export function listPendingIncomingRequests(): PendingIncomingRequest[] {
  const now = Date.now()
  const live: PendingIncomingRequest[] = []
  for (const [id, request] of pendingIncoming.entries()) {
    if (now - request.receivedAt > PENDING_REQUEST_TTL_MS) {
      pendingIncoming.delete(id)
    } else {
      live.push(request)
    }
  }
  return live
}

// NEW: the requester's (A's) half of the same handshake -- tracks a
// pairing attempt A has initiated, keyed by the TARGET device's id
// (not a random request id, since A only ever has one active outgoing
// attempt per target at a time -- a second attempt at the same target
// should just replace the first, not create a confusing duplicate).
export interface PendingOutgoingRequest {
  targetDeviceId: string
  targetDeviceName: string
  targetPublicKeyPem: string
  verificationCode: string
  status: 'awaiting_peer' | 'awaiting_local_confirmation'
  sentAt: number
}

const pendingOutgoing = new Map<string, PendingOutgoingRequest>()

export function createPendingOutgoingRequest(params: {
  targetDeviceId: string
  targetDeviceName: string
  targetPublicKeyPem: string
  myPublicKeyPem: string
}): PendingOutgoingRequest {
  const request: PendingOutgoingRequest = {
    targetDeviceId: params.targetDeviceId,
    targetDeviceName: params.targetDeviceName,
    targetPublicKeyPem: params.targetPublicKeyPem,
    verificationCode: computeVerificationCode(params.myPublicKeyPem, params.targetPublicKeyPem),
    status: 'awaiting_peer',
    sentAt: Date.now()
  }
  pendingOutgoing.set(params.targetDeviceId, request)
  return request
}

export function getPendingOutgoingRequest(targetDeviceId: string): PendingOutgoingRequest | null {
  const request = pendingOutgoing.get(targetDeviceId)
  if (!request) return null
  if (Date.now() - request.sentAt > PENDING_REQUEST_TTL_MS) {
    pendingOutgoing.delete(targetDeviceId)
    return null
  }
  return request
}

export function markOutgoingAwaitingLocalConfirmation(targetDeviceId: string): void {
  const request = pendingOutgoing.get(targetDeviceId)
  if (request) request.status = 'awaiting_local_confirmation'
}

export function consumePendingOutgoingRequest(targetDeviceId: string): void {
  pendingOutgoing.delete(targetDeviceId)
}