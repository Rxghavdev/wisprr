import { keccak256, toHex, type Hex } from "viem";
import { auditGrant, auditView, type Keys } from "./stealth";

// Scoped disclosure grants.
//
// A raw stealth viewing key is a bad fit for compliance. It covers the whole
// account, works backwards through history, cannot be revoked, and the holder
// decides when to hand it over. An auditor wants the other thing: a named
// grantee, a stated purpose, a date range, an expiry, and a record that it
// happened.
//
// Same cryptography, wrapped in that envelope. The viewing key decides which
// payments are yours. The grant decides which of those an auditor may see.
// Anything outside the window they cannot recognise at all.

export type Grant = {
  // Who holds it. Bound to a name, not a bearer key.
  grantee: string;
  // Why. Shown to the auditor and recorded in the log.
  purpose: string;
  // The disclosure window, in unix seconds. Outside it, nothing.
  from: number;
  to: number;
  // The viewing scalar plus the spending public key. Identifies payments, cannot
  // move them.
  viewing: Hex;
  spendingPub: Hex;
  // Issued at, for the log.
  issuedAt: number;
};

export type GrantRecord = Grant & { hash: Hex; revokedAt?: number };

const LOG = "wisprr-grants";

// The grant hash is what gets anchored (or shown to a counterparty) as evidence
// that a disclosure happened, to whom, and under what mandate. It commits to
// every field, so the mandate cannot be widened after the fact.
export function grantHash(g: Grant): Hex {
  return keccak256(
    toHex(
      [
        g.grantee.toLowerCase(),
        g.purpose.toLowerCase(),
        g.from.toString(),
        g.to.toString(),
        g.viewing.toLowerCase(),
        g.spendingPub.toLowerCase(),
        g.issuedAt.toString(),
      ].join("|"),
    ),
  );
}

export function makeGrant(
  keys: Keys,
  grantee: string,
  purpose: string,
  from: number,
  to: number,
): Grant {
  if (!grantee.trim()) throw new Error("A grant needs a named grantee.");
  if (!purpose.trim()) throw new Error("A grant needs a stated purpose.");
  if (!(to > from)) throw new Error("The window ends before it begins.");
  const { viewing, spendingPub } = auditGrant(keys);
  return { grantee: grantee.trim(), purpose: purpose.trim(), from, to, issuedAt: Math.floor(Date.now() / 1000), viewing, spendingPub };
}

// Is this payment inside the mandate? Both ends inclusive, in unix seconds.
export function within(g: Grant, when: number): boolean {
  return when >= g.from && when <= g.to;
}

export async function recordGrant(g: Grant): Promise<GrantRecord> {
  const bag = await chrome.storage.local.get(LOG);
  const rows = (Array.isArray(bag[LOG]) ? bag[LOG] : []) as GrantRecord[];
  const record: GrantRecord = { ...g, hash: grantHash(g) };
  await chrome.storage.local.set({ [LOG]: [...rows, record] });
  return record;
}

export async function grants(): Promise<GrantRecord[]> {
  const bag = await chrome.storage.local.get(LOG);
  const rows = (Array.isArray(bag[LOG]) ? bag[LOG] : []) as GrantRecord[];
  return rows.slice().reverse();
}

export async function revokeGrant(hash: string): Promise<void> {
  const bag = await chrome.storage.local.get(LOG);
  const rows = (Array.isArray(bag[LOG]) ? bag[LOG] : []) as GrantRecord[];
  await chrome.storage.local.set({
    [LOG]: rows.map((r) => (r.hash === hash ? { ...r, revokedAt: Math.floor(Date.now() / 1000) } : r)),
  });
}

// What an auditor is permitted to recognise, given a grant. Returns nothing outside
// the window, so a Q3 grant cannot see Q1. That refusal is the point,
// not a limitation to work around.
export function scopedRecogniser(g: Grant, when: number) {
  if (!within(g, when)) return () => undefined;
  return (eph: Hex, tag: number) => auditView({ viewing: g.viewing, spendingPub: g.spendingPub }, eph, tag);
}

export type Rejection = { allowed: false; reason: string } | { allowed: true };

export function check(g: Grant, when: number, now = Math.floor(Date.now() / 1000)): Rejection {
  if (now > g.to + 0) {
    // Expired grants stop working. This is what a raw viewing key cannot do.
    return { allowed: false, reason: "The grant expired." };
  }
  if (!within(g, when)) {
    return { allowed: false, reason: "That payment is outside the granted period." };
  }
  return { allowed: true };
}
