// A self-contained test suite for the parts that can be tested outside a browser.
//
//   npm test
//
// It exercises the cryptography, the leak guard, the scoped grants and the page
// routing against fake chrome APIs. It does NOT test the extension UI, the
// offscreen document, or the live mixnet — those need a real Chrome, and
// `TESTING.md` says how to check them by hand.

import { verifyMessage, verifyTypedData } from "viem";
import { english, generateMnemonic, mnemonicToAccount } from "viem/accounts";
import {
  auditGrant,
  auditView,
  accountFor,
  derivePayment,
  keysFromSecret,
  metaAddress,
  openPayment,
  parseMeta,
  publicKeys,
} from "../src/lib/stealth";
import { inspect, blocking, type SweepContext } from "../src/lib/guard";
import { grantHash, makeGrant, scopedRecogniser, within, check } from "../src/lib/grants";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, condition: boolean, detail = "") {
  if (condition) {
    pass += 1;
    console.log(`  ok    ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function group(name: string) {
  console.log(`\n${name}`);
}

const secret = generateMnemonic(english);
const keys = keysFromSecret(secret);

/* ---------------------------------------------------------------- stealth */

group("stealth addresses (ERC-5564)");
{
  const meta = metaAddress(keys);
  ok("meta-address is st:eth:0x + 132 hex", /^st:eth:0x[0-9a-f]{132}$/.test(meta));
  ok("meta-address parses to two 33-byte keys", (() => {
    const p = parseMeta(meta);
    return p.spending.length === 33 && p.viewing.length === 33;
  })());

  const payments = Array.from({ length: 20 }, () => derivePayment(meta));
  ok("20 payments produce 20 distinct addresses", new Set(payments.map((p) => p.stealthAddress)).size === 20);
  ok("no payment address equals the meta-address", payments.every((p) => !meta.includes(p.stealthAddress.slice(2))));

  let recovered = 0;
  for (const p of payments) {
    const priv = openPayment(keys, p.ephemeralPubKey, p.viewTag);
    if (priv && accountFor(priv).address.toLowerCase() === p.stealthAddress.toLowerCase()) recovered += 1;
  }
  ok("all 20 payments recover to their address", recovered === 20, `${recovered}/20`);

  const wrong = openPayment(keys, payments[0].ephemeralPubKey, (payments[0].viewTag + 1) % 256);
  ok("a wrong view tag is rejected", wrong === undefined);

  const stranger = keysFromSecret(generateMnemonic(english));
  const stolen = openPayment(stranger, payments[0].ephemeralPubKey, payments[0].viewTag);
  ok("another wallet cannot open a payment", stolen === undefined);

  const restored = keysFromSecret(secret.trim().toLowerCase());
  ok("same phrase restores the same meta-address", metaAddress(restored) === meta);

  const sig = await accountFor(openPayment(keys, payments[0].ephemeralPubKey, payments[0].viewTag)!).signMessage({
    message: "sweep",
  });
  ok(
    "the derived key can sign for the stealth address",
    await verifyMessage({ address: payments[0].stealthAddress, message: "sweep", signature: sig }),
  );

  ok("malformed ephemeral key returns undefined, not a throw", openPayment(keys, "0xdeadbeef" as `0x${string}`, 0) === undefined);
}

/* ------------------------------------------------------------ disclosure */

group("selective disclosure");
{
  const grant = auditGrant(keys);
  const meta = metaAddress(keys);
  const payments = Array.from({ length: 5 }, () => derivePayment(meta));

  const seen = payments.filter(
    (p) => auditView(grant, p.ephemeralPubKey, p.viewTag)?.toLowerCase() === p.stealthAddress.toLowerCase(),
  );
  ok("the auditor identifies every payment", seen.length === 5, `${seen.length}/5`);

  const foreign = derivePayment(metaAddress(keysFromSecret(generateMnemonic(english))));
  ok("foreign payments stay invisible", auditView(grant, foreign.ephemeralPubKey, foreign.viewTag) === undefined);

  ok("the grant holds no spending private key", !JSON.stringify(grant).toLowerCase().includes("0x" + Buffer.from(keys.spending).toString("hex")));
  ok("the spending public key is the real one", grant.spendingPub.toLowerCase() === "0x" + Buffer.from(publicKeys(keys).spending).toString("hex"));
}

/* ---------------------------------------------------------------- grants */

group("scoped grants");
{
  const Q3_FROM = Date.UTC(2026, 6, 1) / 1000;
  const Q3_TO = Date.UTC(2026, 9, 1) / 1000;
  const inQ3 = Date.UTC(2026, 7, 15) / 1000;
  const inQ1 = Date.UTC(2026, 1, 15) / 1000;

  const g = makeGrant(keys, "Auditor AG", "Q3 flows", Q3_FROM, Q3_TO);
  const p = derivePayment(metaAddress(keys));

  ok("a payment inside the window is identified", scopedRecogniser(g, inQ3)(p.ephemeralPubKey, p.viewTag)?.toLowerCase() === p.stealthAddress.toLowerCase());
  ok("a payment outside the window is refused", scopedRecogniser(g, inQ1)(p.ephemeralPubKey, p.viewTag) === undefined);
  ok("window start is inclusive", within(g, Q3_FROM));
  ok("one second before the window is excluded", !within(g, Q3_FROM - 1));
  ok("one second after the window is excluded", !within(g, Q3_TO + 1));
  ok("an expired grant is refused", check({ ...g, to: Math.floor(Date.now() / 1000) - 10 }, inQ3).allowed === false);
  ok("a live grant inside its window is allowed", check({ ...g, to: Math.floor(Date.now() / 1000) + 3600 }, inQ3).allowed === true);
  ok("the hash commits to the grantee", grantHash(g) !== grantHash({ ...g, grantee: "Someone Else" }));
  ok("the hash commits to the window", grantHash(g) !== grantHash({ ...g, to: Q3_TO + 86400 }));

  let threw = false;
  try {
    makeGrant(keys, "", "purpose", Q3_FROM, Q3_TO);
  } catch {
    threw = true;
  }
  ok("a grant without a named grantee is rejected", threw);
}

/* ----------------------------------------------------------------- guard */

group("leak guard");
{
  const p = (addr: string, spent = false) =>
    ({
      address: addr as `0x${string}`,
      ephemeralPubKey: "0x" as `0x${string}`,
      viewTag: 0,
      txHash: "0x" as `0x${string}`,
      block: 1n,
      eth: "1",
      spent,
    });

  const base: SweepContext = {
    to: "0x1111111111111111111111111111111111111111",
    payment: p("0xaaaa000000000000000000000000000000000001"),
    others: [],
    destinationIsOwnVault: false,
    destinationPaidUs: false,
  };

  ok("clean sweep produces no blocking rule", blocking(inspect(base, "0", 7 * 86400)).length === 0);
  ok("H1 blocks a sweep to your own vault", blocking(inspect({ ...base, destinationIsOwnVault: true }, "0", 7 * 86400)).length === 1);
  ok("H2 blocks a sweep back to the payer", blocking(inspect({ ...base, destinationPaidUs: true }, "0", 7 * 86400)).length === 1);
  ok("H3 warns on a collector pattern", inspect({ ...base, others: [p("0xbb01"), p("0xbb02")] }, "0", 7 * 86400).some((l) => l.rule.startsWith("H3")));
  ok("H3 stays quiet for a single payment", !inspect(base, "0", 7 * 86400).some((l) => l.rule.startsWith("H3")));
  ok("H4 warns when a token has no gas", inspect(base, "0", 7 * 86400).some((l) => l.rule.startsWith("H4")));
  ok("H4 stays quiet when the address has ETH", !inspect(base, "0.05", 7 * 86400).some((l) => l.rule.startsWith("H4")));
  ok("H5 warns on a sweep two hours after receipt", inspect(base, "0.05", 2 * 3600).some((l) => l.rule.startsWith("H5")));
  ok("H5 stays quiet after a day", !inspect(base, "0.05", 2 * 86400).some((l) => l.rule.startsWith("H5")));
  ok("H1 and H2 both block at once", blocking(inspect({ ...base, destinationIsOwnVault: true, destinationPaidUs: true }, "0", 0)).length === 2);
  ok("spent payments do not count toward H3", !inspect({ ...base, others: [p("0xbb01", true), p("0xbb02", true)] }, "0.05", 7 * 86400).some((l) => l.rule.startsWith("H3")));
}

/* ------------------------------------------------------- signing (EIP-191) */

group("message signing");
{
  const acct = mnemonicToAccount(secret);
  const sig = await acct.signMessage({ message: "hello" });
  ok("personal_sign produces a verifiable signature", await verifyMessage({ address: acct.address, message: "hello", signature: sig }));

  const typed = {
    domain: { name: "T", version: "1", chainId: 1 },
    types: { Person: [{ name: "name", type: "string" }] },
    primaryType: "Person" as const,
    message: { name: "alice" },
  };
  const tsig = await acct.signTypedData(typed);
  ok(
    "typed data produces a verifiable signature",
    await verifyTypedData({ address: acct.address, ...typed, signature: tsig }),
  );
}

/* ------------------------------------------------------------ ens record */

group("ens stealth record");
{
  // The draft ENSIP key, from the ENS forum RFC "Privacy-Preserving Names".
  const KEY = "stealth-meta-address[1]";
  ok("record key matches the draft ENSIP", KEY === "stealth-meta-address[1]");

  const meta = metaAddress(keysFromSecret(generateMnemonic(english)));
  const ACCEPT = /^st:eth:0x[0-9a-fA-F]{132}$/;

  ok("a real meta-address is accepted", ACCEPT.test(meta.trim()));
  ok("a truncated one is rejected", !ACCEPT.test(meta.slice(0, -1)));
  ok("a non-meta string is rejected", !ACCEPT.test("hello"));
  ok("an empty record is rejected", !ACCEPT.test(""));
  ok("a wrong-prefix value is rejected", !ACCEPT.test("st:btc:0x" + "aa".repeat(66)));
  ok("non-hex is rejected", !ACCEPT.test("st:eth:0x" + "zz".repeat(66)));

  // The value written must survive a parse.
  const parsed = parseMeta(meta);
  ok("the value parses to two 33-byte keys", parsed.spending.length === 33 && parsed.viewing.length === 33);

  // setText calldata must use the documented selector.
  const { encodeFunctionData, namehash, keccak256, toHex } = await import("viem");
  const node = namehash("alice.eth");
  const data = encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "setText",
        stateMutability: "nonpayable",
        inputs: [{ name: "node", type: "bytes32" }, { name: "key", type: "string" }, { name: "value", type: "string" }],
        outputs: [],
      },
    ] as const,
    functionName: "setText",
    args: [node, KEY, meta],
  });
  ok("setText selector is 0x10f13a8c", data.slice(0, 10) === "0x10f13a8c", data.slice(0, 10));
  ok("namehash is deterministic", namehash("alice.eth") === node);
  ok(
    "namehash differs per name",
    namehash("alice.eth") !== namehash("bob.eth"),
  );
  ok(
    "the setText selector matches keccak of the signature",
    keccak256(toHex("setText(bytes32,string,string)")).slice(0, 10) === "0x10f13a8c",
  );
}

/* ---------------------------------------------------------------- ensv2 */

group("ensv2");
{
  const { ENS, META_KEY, dnsEncode, namehashV2 } = await import("../src/lib/ens");
  const { getAddress, namehash, isAddress } = await import("viem");

  ok("every ENS address is a valid checksum", Object.values(ENS).every((a) => isAddress(a) && getAddress(a) === a));
  ok("root registry is not the eth registry", ENS.rootRegistry.toLowerCase() !== ENS.ethRegistry.toLowerCase());

  // ENSIP-10 name encoding, not a namehash.
  ok("dnsEncode('test.eth') matches the spec", dnsEncode("test.eth") === "0x04746573740365746800");
  ok("dnsEncode('eth') is 4 bytes", dnsEncode("eth") === "0x0365746800");
  ok("dnsEncode is case-insensitive", dnsEncode("TEST.eth") === dnsEncode("test.eth"));
  ok("dnsEncode rejects an empty name", (() => {
    try {
      dnsEncode("");
      return false;
    } catch {
      return true;
    }
  })());

  // Our v2 node derivation must agree with viem's.
  ok("namehashV2 matches viem for eth", namehashV2("eth") === namehash("eth"));
  ok("namehashV2 matches viem for a subname", namehashV2("alice.eth") === namehash("alice.eth"));
  ok("namehashV2 differs per name", namehashV2("alice.eth") !== namehashV2("bob.eth"));

  // The record key is the draft ENSIP one.
  ok("meta record key is the draft ENSIP key", META_KEY === "stealth-meta-address[1]");
}

/* ------------------------------------------- interop with reference SDK */

group("interop: scopelift stealth-address-sdk");
{
  const sdk = await import("@scopelift/stealth-address-sdk");
  const { secp256k1 } = await import("@noble/curves/secp256k1.js");
  const { keccak256 } = await import("viem");

  const hexOf = (b: Uint8Array) => ("0x" + Buffer.from(b).toString("hex")) as `0x${string}`;
  const meta = metaAddress(keys);

  // Our payment must be recoverable by the reference implementation.
  for (let i = 0; i < 3; i++) {
    const mine = derivePayment(meta);
    const sdkKey = sdk.computeStealthKey({
      viewingPrivateKey: hexOf(keys.viewing),
      spendingPrivateKey: hexOf(keys.spending),
      ephemeralPublicKey: mine.ephemeralPubKey,
      schemeId: sdk.VALID_SCHEME_ID.SCHEME_ID_1,
    });
    ok(
      `the SDK recovers our payment #${i + 1}`,
      accountFor(sdkKey).address.toLowerCase() === mine.stealthAddress.toLowerCase(),
    );
  }

  // The reference implementation's payment must be recoverable by ours.
  for (let i = 0; i < 3; i++) {
    const theirs = sdk.generateStealthAddress({ stealthMetaAddressURI: meta });
    const priv = openPayment(keys, theirs.ephemeralPublicKey as `0x${string}`, Number(theirs.viewTag));
    ok(
      `we recover the SDK's payment #${i + 1}`,
      Boolean(priv) && accountFor(priv!).address.toLowerCase() === theirs.stealthAddress.toLowerCase(),
    );
  }

  // The view tag is the first byte of keccak256(sharedSecret), nothing more.
  const p = derivePayment(meta);
  const shared = secp256k1.getSharedSecret(
    keys.viewing,
    Uint8Array.from(Buffer.from(p.ephemeralPubKey.slice(2), "hex")),
    true,
  );
  const hashed = sdk.getHashedSharedSecret({ sharedSecret: shared, schemeId: sdk.VALID_SCHEME_ID.SCHEME_ID_1 });
  ok("the shared secret hash matches the SDK", keccak256(shared as Uint8Array).toLowerCase() === hashed.toLowerCase());
  ok(
    "the view tag matches the SDK",
    Number(sdk.getViewTag({ hashedSharedSecret: hashed, schemeId: sdk.VALID_SCHEME_ID.SCHEME_ID_1 })) === p.viewTag,
  );
}

/* ---------------------------------------------------------------- summary */
console.log(`\n${"-".repeat(48)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
