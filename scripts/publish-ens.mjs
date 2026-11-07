// Publishes a stealth meta-address to an ENSv2 name.
//
//   node scripts/publish-ens.mjs
//
// It asks for two things: the private key of the wallet that owns the name, and the
// meta-address from the extension. Nothing is written to disk and the key is never
// echoed.
//
// Why a script: the ENSv2 setter takes the DNS-encoded name as bytes, not a string,
// and getting that wrong on a block explorer is a revert. This builds it correctly
// and simulates first, so you find out before spending gas.
//
// The private key belongs to the ENS name owner (MetaMask). The meta-address belongs
// to the extension's phrase. They can be different wallets: the name is only a
// pointer, and the extension holds the keys that can spend the payments.

import { createPublicClient, createWalletClient, http, parseAbi, keccak256, toHex } from "viem";
import { sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { createInterface } from "node:readline/promises";

const ETH_REGISTRY = "0xD4eBcbBdF463C9c45784603Db0dDD499BC44A8B4";
const META_KEY = "stealth-meta-address[1]";
const META_RE = /^st:eth:0x[0-9a-fA-F]{132}$/;

const rl = createInterface({ input: process.stdin, output: process.stdout });

const label = (await rl.question("Label without .eth (e.g. wisprr): ")).trim().toLowerCase();
if (!/^[a-z0-9-]+$/.test(label)) {
  console.error("That label looks wrong.");
  process.exit(1);
}

const meta = (await rl.question("Meta-address (st:eth:0x…): ")).trim();
if (!META_RE.test(meta)) {
  console.error(`Not a meta-address. Expected st:eth:0x followed by 132 hex characters, got ${meta.length} total.`);
  process.exit(1);
}

const pk = (await rl.question("Private key of the ENS owner (0x…, hidden): ")).trim();
rl.close();
if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
  console.error("That does not look like a private key.");
  process.exit(1);
}

const account = privateKeyToAccount(pk);
const client = createPublicClient({ chain: sepolia, transport: http("https://ethereum-sepolia-rpc.publicnode.com") });

const REG = parseAbi([
  "function getOwner(uint256 anyId) view returns (address)",
  "function getResolver(string label) view returns (address)",
]);
const RES = parseAbi(["function setText(bytes name, string key, string value)"]);

const id = BigInt(keccak256(toHex(label)));

console.log(`\nlabel     : ${label}.eth`);
console.log(`signer    : ${account.address}`);

const owner = await client.readContract({ address: ETH_REGISTRY, abi: REG, functionName: "getOwner", args: [id] });
console.log(`owner     : ${owner}`);
if (owner.toLowerCase() !== account.address.toLowerCase()) {
  console.error(`\nThat key does not own ${label}.eth. The owner is ${owner}. Aborting.`);
  process.exit(1);
}

const resolver = await client.readContract({ address: ETH_REGISTRY, abi: REG, functionName: "getResolver", args: [label] });
if (!resolver || resolver === "0x0000000000000000000000000000000000000000") {
  console.error(`\n${label}.eth has no resolver, so it cannot hold a record.`);
  process.exit(1);
}
console.log(`resolver  : ${resolver}`);

// DNS-encode per ENSIP-10: length-prefixed labels, zero-terminated.
const full = `${label}.eth`;
let dns = "0x";
for (const part of full.split(".")) {
  dns += part.length.toString(16).padStart(2, "0");
  for (const ch of part) dns += ch.charCodeAt(0).toString(16).padStart(2, "0");
}
dns += "00";
console.log(`dns name  : ${dns}`);

const args = [dns, META_KEY, meta];

console.log("\nsimulating…");
try {
  await client.simulateContract({ address: resolver, abi: RES, functionName: "setText", args, account });
  console.log("simulation passed.");
} catch (err) {
  console.error("simulation failed:", err.shortMessage || err.message);
  process.exit(1);
}

const wallet = createWalletClient({ account, chain: sepolia, transport: http("https://ethereum-sepolia-rpc.publicnode.com") });
console.log("sending…");
const hash = await wallet.writeContract({ address: resolver, abi: RES, functionName: "setText", args });
console.log(`\ntx: ${hash}`);
console.log(`https://eth-sepolia.blockscout.com/tx/${hash}`);

const receipt = await client.waitForTransactionReceipt({ hash });
console.log(receipt.status === "success" ? "\nConfirmed. Check the name in the extension." : "\nReverted on chain.");
process.exit(receipt.status === "success" ? 0 : 1);
