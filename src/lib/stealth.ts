import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ERC-5564 stealth addresses. A payer derives a one-time address from the
// recipient's published meta-address using an ephemeral key only they control,
// and announces it. The chain sees a fresh address with no link to the receiver.
// The receiver recovers the funds by scanning announcements with a viewing key.
//
// Nothing here is stored: both keys come out of the wallet secret, so restoring
// twelve words restores every payment ever sent to you.

const Point = secp256k1.Point;
const ORDER = Point.Fn.ORDER;

// Canonical ERC-5564 announcer, same address on every chain.
export const ANNOUNCER = "0x55649E01B5Df198D18D95b5cc5051630cfD45564" as const;
export const SCHEME_ID = 1n; // secp256k1

export const ANNOUNCEMENT_ABI = [
  {
    type: "event",
    name: "Announcement",
    inputs: [
      { name: "schemeId", type: "uint256", indexed: true },
      { name: "stealthAddress", type: "address", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "ephemeralPubKey", type: "bytes", indexed: false },
      { name: "metadata", type: "bytes", indexed: false },
    ],
  },
  {
    type: "function",
    name: "announce",
    stateMutability: "nonpayable",
    inputs: [
      { name: "schemeId", type: "uint256" },
      { name: "stealthAddress", type: "address" },
      { name: "ephemeralPubKey", type: "bytes" },
      { name: "metadata", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

/* hex helpers. Buffer is not available in a browser. */

function bytesOf(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error("Odd-length hex.");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function hexOf(bytes: Uint8Array): Hex {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s as Hex;
}

function to32(n: bigint): Uint8Array {
  return bytesOf(n.toString(16).padStart(64, "0"));
}

function toBig(data: Uint8Array | Hex): bigint {
  return BigInt(typeof data === "string" ? data : hexOf(data));
}

function reduce(n: bigint): bigint {
  const r = n % ORDER;
  return r === 0n ? 1n : r;
}

// keccak as bytes, so every value below stays a byte array until it is serialised.
const kb = (data: Uint8Array | Hex): Uint8Array =>
  bytesOf(keccak256(typeof data === "string" ? data : hexOf(data)));

// Address is the last 20 bytes of the keccak of the uncompressed point.
function addressOf(point: InstanceType<typeof Point>): Hex {
  return `0x${keccak256(hexOf(point.toBytes(false).slice(1))).slice(-40)}` as Hex;
}

export type Keys = { spending: Uint8Array; viewing: Uint8Array };

// Domain-separated, so one secret yields two independent scalars and neither can
// be walked back to the phrase that produced it.
export function keysFromSecret(secret: string): Keys {
  const base = secret.trim().toLowerCase();
  return {
    spending: to32(reduce(toBig(kb(toHex(`wisprr/stealth/spend/${base}`))))),
    viewing: to32(reduce(toBig(kb(toHex(`wisprr/stealth/view/${base}`))))),
  };
}

export function publicKeys(keys: Keys) {
  return {
    spending: secp256k1.getPublicKey(keys.spending, true),
    viewing: secp256k1.getPublicKey(keys.viewing, true),
  };
}

// What you hand out to be paid. Public keys only, safe to post anywhere.
export function metaAddress(keys: Keys): string {
  const pub = publicKeys(keys);
  return `st:eth:0x${hexOf(pub.spending).slice(2)}${hexOf(pub.viewing).slice(2)}`;
}

export function parseMeta(meta: string): { spending: Uint8Array; viewing: Uint8Array } {
  const bare = meta.trim().replace(/^st:eth:/i, "").replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{132}$/.test(bare)) throw new Error("That is not a stealth meta-address.");
  return { spending: bytesOf(bare.slice(0, 66)), viewing: bytesOf(bare.slice(66)) };
}

// shared -> s -> view tag, then h = keccak(0xff || s || spendingPub) mod n,
// which is the hash the ERC-5564 reference implementation uses.
function sharedOf(myPriv: Uint8Array, theirPub: Uint8Array): Uint8Array {
  return kb(secp256k1.getSharedSecret(myPriv, theirPub, true));
}

// h = keccak256(sharedSecret), reduced mod n. This is what the reference
// implementation does (ScopeLift's stealth-address-sdk, generateStealthAddress.js).
//
// An earlier version of this file hashed 0xff || sharedSecret || spendingPub
// instead. That produces a valid stealth address, but not one any other
// implementation can recover, so it silently broke interoperability. Verified
// against the SDK: the plain keccak matches, the prefixed form does not.
function mask(s: Uint8Array): bigint {
  return reduce(toBig(s));
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export type Payment = { stealthAddress: Hex; ephemeralPubKey: Hex; viewTag: number };

// Sender side. A fresh ephemeral key per payment means two payments to the same
// meta-address land at two addresses nobody can connect.
export function derivePayment(meta: string): Payment {
  const pub = parseMeta(meta);
  const r = secp256k1.utils.randomSecretKey();
  const ephemeralPubKey = secp256k1.getPublicKey(r, true);
  const s = sharedOf(r, pub.viewing);
  const h = mask(s);
  const stealth = Point.fromHex(hexOf(pub.spending).slice(2)).add(Point.BASE.multiply(h));
  return { stealthAddress: addressOf(stealth), ephemeralPubKey: hexOf(ephemeralPubKey), viewTag: s[0] };
}

// Recipient side. The view tag is one byte, so a scan rejects almost every
// announcement before the expensive point multiplication.
//
// Never throws. A scan walks every announcement on the announcer, and some are
// for other schemes or have malformed ephemeral keys; a single bad record must
// not abort the scan.
export function openPayment(keys: Keys, ephemeralPubKey: Hex, viewTag: number): Hex | undefined {
  try {
    if (typeof ephemeralPubKey !== "string" || !/^0x[0-9a-fA-F]{66}$/.test(ephemeralPubKey)) return;
    const pub = publicKeys(keys);
    const s = sharedOf(keys.viewing, bytesOf(ephemeralPubKey));
    if (s[0] !== viewTag) return;
    const stealthPriv = to32((toBig(keys.spending) + mask(s)) % ORDER);
    return hexOf(stealthPriv);
  } catch {
    return;
  }
}

export function accountFor(privateKey: Hex) {
  return privateKeyToAccount(privateKey);
}

// ERC-6538 registry. Registering your meta-address lets anyone pay you from a
// plain address, without you sending them anything first.
export const REGISTRY = "0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538" as const;

export const REGISTRY_ABI = [
  {
    type: "function",
    name: "registerKeys",
    stateMutability: "nonpayable",
    inputs: [
      { name: "schemeId", type: "uint256" },
      { name: "stealthMetaAddress", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "stealthMetaAddressOf",
    stateMutability: "view",
    inputs: [
      { name: "registrant", type: "address" },
      { name: "schemeId", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bytes" }],
  },
  {
    type: "function",
    name: "incrementNonce",
    stateMutability: "nonpayable",
    inputs: [{ name: "schemeId", type: "uint256" }],
    outputs: [],
  },
] as const;

// Selective disclosure. An auditor handed the viewing scalar can identify every
// payment that is yours, and cannot move a single one. The spending scalar stays
// here. This is the property that makes the same system usable by a fund that
// still has to answer to an auditor.
//
// The auditor needs the spending PUBLIC key as well, which is not a secret: it
// sits in the meta-address you publish. A disclosed viewing scalar is still
// sensitive: whoever holds it learns your income, but never your funds.
export type AuditGrant = { spendingPub: Hex; viewing: Hex };

export function auditGrant(keys: Keys): AuditGrant {
  return { spendingPub: hexOf(publicKeys(keys).spending), viewing: hexOf(keys.viewing) };
}

export function auditView(grant: AuditGrant, ephemeralPubKey: Hex, viewTag: number): Hex | undefined {
  try {
    if (!/^0x[0-9a-fA-F]{66}$/.test(ephemeralPubKey)) return;
    const s = sharedOf(bytesOf(grant.viewing), bytesOf(ephemeralPubKey));
    if (s[0] !== viewTag) return;
    const h = mask(s);
    const stealthPub = Point.fromHex(grant.spendingPub.slice(2)).add(Point.BASE.multiply(h));
    return addressOf(stealthPub);
  } catch {
    return;
  }
}

// The key an announcement's stealth address spends with. Derived on demand and
// never persisted, because it is recomputable from the phrase.
export function spendKey(keys: Keys, ephemeralPubKey: Hex, viewTag: number): Hex | undefined {
  return openPayment(keys, ephemeralPubKey, viewTag);
}
