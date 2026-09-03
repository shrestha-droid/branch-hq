import * as crypto from 'crypto'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { app } from 'electron'

// NEW: Phase 1 of multi-device Branch HQ coordination -- device
// identity. Every installation generates its own Ed25519 keypair once,
// on first run, and keeps it forever (persisted locally, private key
// NEVER transmitted anywhere). This is the actual root of trust
// everything else in this phase builds on: device discovery (mDNS)
// just announces "a Branch HQ exists here," but PAIRING -- deciding
// which other devices this one will actually accept tasks from later
// -- depends entirely on cryptographic identity, not just "I saw it on
// the network." Ed25519 chosen specifically: fast, small keys/PEMs
// (113 bytes, confirmed -- easily fits in a DNS TXT record for
// discovery), no digest-algorithm parameter needed for sign/verify
// (unlike RSA), built into Node's crypto module natively -- no new
// dependency for the cryptography itself.

export interface DeviceIdentity {
  deviceId: string
  deviceName: string
  publicKeyPem: string
  privateKeyPem: string
}

const IDENTITY_PATH = () => path.join(app.getPath('userData'), 'branch-hq-device-identity.json')

let cachedIdentity: DeviceIdentity | null = null

// A short, stable fingerprint of the public key -- used as the device's
// actual id everywhere (discovery, pairing, trusted-peer records)
// instead of the full PEM, which is unwieldy as an identifier even
// though it's small enough to transmit.
export function fingerprintPublicKey(publicKeyPem: string): string {
  return crypto.createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 16)
}

export async function getDeviceIdentity(): Promise<DeviceIdentity> {
  if (cachedIdentity) return cachedIdentity

  try {
    const raw = await fs.readFile(IDENTITY_PATH(), 'utf-8')
    cachedIdentity = JSON.parse(raw)
    return cachedIdentity!
  } catch {
    // No identity yet -- generate a real, fresh keypair. This only
    // happens once per installation; every future launch loads the
    // same identity from disk instead of regenerating it, since a
    // device's whole point is having a STABLE identity other devices
    // can recognize and trust over time.
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    })
    const identity: DeviceIdentity = {
      deviceId: fingerprintPublicKey(publicKey),
      deviceName: os.hostname() || 'Branch HQ Device',
      publicKeyPem: publicKey,
      privateKeyPem: privateKey
    }
    await fs.mkdir(path.dirname(IDENTITY_PATH()), { recursive: true }).catch(() => {})
    await fs.writeFile(IDENTITY_PATH(), JSON.stringify(identity, null, 2), 'utf-8')
    cachedIdentity = identity
    return identity
  }
}

export async function setDeviceName(name: string): Promise<DeviceIdentity> {
  const identity = await getDeviceIdentity()
  identity.deviceName = name.trim() || identity.deviceName
  await fs.writeFile(IDENTITY_PATH(), JSON.stringify(identity, null, 2), 'utf-8')
  return identity
}

// Signs a payload with this device's own private key. The payload
// should be a canonical, deterministic string (e.g. JSON.stringify of
// a plain object with a fixed key order) -- the signature is only
// meaningful if both sides can reconstruct the exact same bytes.
export function signPayload(privateKeyPem: string, payload: string): string {
  return crypto.sign(null, Buffer.from(payload, 'utf-8'), privateKeyPem).toString('base64')
}

// Verifies a payload against a claimed public key. Never throws --
// any malformed key, signature, or payload is just a real "no", not an
// exception a caller has to remember to catch. Confirmed via a real
// sign/verify/tamper round-trip test before this was wired into
// anything -- see the accompanying test notes.
export function verifySignature(publicKeyPem: string, payload: string, signatureBase64: string): boolean {
  try {
    return crypto.verify(null, Buffer.from(payload, 'utf-8'), publicKeyPem, Buffer.from(signatureBase64, 'base64'))
  } catch {
    return false
  }
}

// NEW: the human-verifiable pairing code. Deterministically derived
// from BOTH devices' real public keys, in a fixed order (requester's
// key first, then responder's) -- so both sides independently compute
// the identical code from the identical underlying key bytes, and any
// tampering with either key in transit changes the code on whichever
// side received the tampered value, which a human comparing the two
// codes will notice. This is the same trust model as Bluetooth numeric
// comparison / Signal safety numbers: security comes from the human
// noticing a mismatch, not from the channel being encrypted.
export function computeVerificationCode(requesterPublicKeyPem: string, responderPublicKeyPem: string): string {
  return crypto.createHash('sha256')
    .update(requesterPublicKeyPem + '|' + responderPublicKeyPem)
    .digest('hex')
    .slice(0, 6)
    .toUpperCase()
}