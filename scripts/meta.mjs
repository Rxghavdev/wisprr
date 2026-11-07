// Prints the stealth meta-address for a recovery phrase.
//
//   node scripts/meta.mjs
//
// The meta-address is derived from the phrase, never stored. This does the same
// derivation the extension does, so the value it prints is the one the wallet will
// use, and the one to publish to ENS.
//
// Paste the phrase at the prompt. It is not written to disk and not echoed.

import { createInterface } from "node:readline/promises";
import { mnemonicToAccount } from "viem/accounts";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak256, toHex } from "viem";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const raw = (await rl.question("Recovery phrase (12 or 24 words): ")).trim();
rl.close();

const phrase = raw.toLowerCase().replace(/\s+/g, " ");
const words = phrase.split(" ").length;
if (words !== 12 && words !== 24) {
  console.error(`That is ${words} words. Expected 12 or 24.`);
  process.exit(1);
}

// Same check the wallet does, so a typo is caught before anything is derived.
let vault;
try {
  vault = mnemonicToAccount(phrase).address;
} catch {
  console.error("That phrase is not valid. Check the words and the order.");
  process.exit(1);
}

const ORDER = secp256k1.Point.Fn.ORDER;
const bytes = (h) => Uint8Array.from(Buffer.from(h.startsWith("0x") ? h.slice(2) : h, "hex"));
const hex = (b) =>
  "0x" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const to32 = (n) => bytes(n.toString(16).padStart(64, "0"));
const reduce = (n) => {
  const r = n % ORDER;
  return r === 0n ? 1n : r;
};

// Identical to keysFromSecret in src/lib/stealth.ts.
const spending = to32(reduce(BigInt(keccak256(toHex(`wisprr/stealth/spend/${phrase}`)))));
const viewing = to32(reduce(BigInt(keccak256(toHex(`wisprr/stealth/view/${phrase}`)))));

const spendPub = hex(secp256k1.getPublicKey(spending, true));
const viewPub = hex(secp256k1.getPublicKey(viewing, true));
const meta = `st:eth:${spendPub}${viewPub.slice(2)}`;

console.log("");
console.log("vault address :", vault);
console.log("spending pub  :", spendPub);
console.log("viewing pub   :", viewPub);
console.log("");
console.log("META-ADDRESS  :", meta);
console.log("");
console.log("length        :", meta.length, meta.length === 141 ? "(correct)" : "(WRONG, expected 141)");
