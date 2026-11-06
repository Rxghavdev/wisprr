import type { Hex } from "viem";
import type { Found } from "./payments";

// A leak guard.
//
// The deanonymisation papers publish their heuristics. No wallet enforces them.
// These are the same rules as pre-signature checks, so the wallet cannot be used
// in a way that publishes a link between a stealth address and its owner.
//
// Blocking rules are the two that destroy privacy outright. The rest warn,
// because a user who understands the tradeoff may still want to go ahead.

export type Severity = "block" | "warn";

export type Leak = {
  // The published heuristic this corresponds to.
  rule: string;
  severity: Severity;
  // Plain language, shown to the user.
  why: string;
  // What to do instead.
  instead: string;
};

export type SweepContext = {
  // Where the money is going.
  to: Hex;
  // The payment being moved.
  payment: Found;
  // Everything else this wallet has received, to detect collector patterns.
  others: Found[];
  // Is the destination one of this wallet's own known/linked addresses?
  destinationIsOwnVault: boolean;
  // Has the destination ever appeared as a payer for one of these payments?
  destinationPaidUs: boolean;
};

// H1, recipient reuse. Sweeping to a registrant address anchors the stealth
// address to a public identity, permanently.
export function ruleH1(ctx: SweepContext): Leak | undefined {
  if (!ctx.destinationIsOwnVault) return;
  return {
    rule: "H1 destination reuse",
    severity: "block",
    why: "Sweeping to your main wallet writes 'this stealth address is mine' onto the chain, publicly and permanently. Every private payment you received becomes linked to that address.",
    instead: "Sweep to a fresh address instead. An exchange deposit address, or a new wallet you have not used before.",
  };
}

// H2, the self-payment loop. Paying yourself via a stealth address and sweeping
// back to the wallet that sent it is a full ceremony that proves common ownership.
export function ruleH2(ctx: SweepContext): Leak | undefined {
  if (!ctx.destinationPaidUs) return;
  return {
    rule: "H2 round trip",
    severity: "block",
    why: "That address paid you. Sweeping back to it makes the payment circular, so the chain shows one wallet sending to itself via a detour.",
    instead: "Use a destination that has never interacted with this payment.",
  };
}

// H3, the collector pattern. Several stealth addresses drained in one block are
// a near-proof of common ownership: a real recipient has no reason to gather
// unrelated payments simultaneously.
export function ruleH3(ctx: SweepContext): Leak | undefined {
  const unspent = ctx.others.filter((p) => !p.spent && p.address !== ctx.payment.address);
  if (unspent.length < 2) return;
  return {
    rule: "H3 collector pattern",
    severity: "warn",
    why: `There are ${unspent.length} other unspent payments. Sweeping them close together makes it obvious one person owns them all.`,
    instead: "Sweep one now and wait before the next. Spacing them out breaks the pattern.",
  };
}

// H4, gas funding. The ERC itself says the funding wallet must have no physical
// connection to the stealth owner. A fresh address that receives exactly enough
// ETH for gas is a fingerprint.
export function ruleH4(ethBalance: string): Leak | undefined {
  const value = Number(ethBalance);
  if (!Number.isFinite(value) || value > 0) return;
  return {
    rule: "H4 gas funding",
    severity: "warn",
    why: "A token cannot move itself. The stealth address has no ETH for gas, and sending it some publicly connects that address to the funder.",
    instead: "Use the token sweep. It signs offline, so the address never needs ETH.",
  };
}

// H5, timing. A sweep minutes after receipt is the single strongest link in the
// published literature.
export function ruleH5(ctx: SweepContext, secondsSincePayment: number): Leak | undefined {
  if (secondsSincePayment > 86_400) return;
  const hours = Math.max(1, Math.round(secondsSincePayment / 3600));
  return {
    rule: "H5 timing",
    severity: "warn",
    why: `This payment arrived about ${hours}h ago. A sweep that soon after receipt is one of the strongest links an analyst has, because few other payments could be the source.`,
    instead: "Waiting a day removes most of the correlation.",
  };
}

export function inspect(ctx: SweepContext, ethBalance = "0", secondsSincePayment = 0): Leak[] {
  return [ruleH1(ctx), ruleH2(ctx), ruleH3(ctx), ruleH4(ethBalance), ruleH5(ctx, secondsSincePayment)].filter(
    (l): l is Leak => Boolean(l),
  );
}

export function blocking(leaks: Leak[]): Leak[] {
  return leaks.filter((l) => l.severity === "block");
}
