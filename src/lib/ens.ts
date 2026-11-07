import { createPublicClient, custom, encodeFunctionData, decodeAbiParameters, keccak256, toHex, parseAbi, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { anonRequest } from "./rpc";
import { SEPOLIA_RPC } from "./chain";

// ENSv2, not v1.
//
// ENSv2 replaces the single v1 registry with a hierarchy: every registry is its own
// contract holding its own names, and permissions are enforced with Enhanced Access
// Control. The parts that matter here:
//
//   RootRegistry          the root. getSubregistry("eth") returns the ETH registry.
//   ETHRegistry           holds .eth labels. getResolver(label), setResolver(anyId, addr)
//   UniversalResolverV2   findResolver(name), then resolve(name, data) for records.
//   PermissionedResolver  per-name resolver where records sit behind an ACL.
//   MockUSDC              the token the Sepolia registrar charges.
//
// Every address below was read off the live deployment and checked on chain, not
// copied from a doc: RootRegistry.getSubregistry("eth") resolves to the ETHRegistry
// listed here, and its getParent() returns (RootRegistry, "eth").

export const ENS = {
  rootRegistry: "0xB458D6a3a77919449d03e7A6903C26827c1eC43f",
  ethRegistry: "0xD4eBcbBdF463C9c45784603Db0dDD499BC44A8B4",
  universalResolver: "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe",
  resolverV2: "0x1cF3989ED3E5EC3cB1d731fC3777323813b61aCf",
  permissionedResolverImpl: "0x115eb53F0c60696633855F90b138178Fb40b2b2C",
  verifiableFactory: "0x118Bc31A50d559F7015a8Da26d54B3b030CdB70F",
  usdc: "0x240b0316Df57887DBBE58b586508b19e633a14aa",
} as const;

// The draft ENSIP key for a scheme-1 meta-address. Text records still carry the
// value under ENSv2, they are just read through resolve() instead of a direct
// text() call.
export const META_KEY = "stealth-meta-address[1]";

const publicClient = createPublicClient({
  chain: sepolia,
  transport: custom({
    async request({ method, params }) {
      // SEPOLIA_RPC, not the default. anonRequest defaults to the mainnet endpoint,
      // and ENSv2 for this wallet lives on Sepolia. Sending these calls to mainnet
      // made every lookup return nothing and eventually time out.
      return anonRequest(method, params ? [...params] : [], SEPOLIA_RPC, "ens");
    },
  }),
});

const REGISTRY_ABI = parseAbi([
  "function getSubregistry(string label) view returns (address)",
  "function getResolver(string label) view returns (address)",
  "function getParent() view returns (address parent, string label)",
  "function setResolver(uint256 anyId, address resolver)",
  "function getStatus(uint256 anyId) view returns (uint8)",
  "function getExpiry(uint256 anyId) view returns (uint64)",
  "function getOwner(uint256 anyId) view returns (address)",
]);

const UNIVERSAL_ABI = parseAbi([
  "function findResolver(bytes name) view returns (address resolver, bytes32 node, uint256 offset)",
  "function resolve(bytes name, bytes data) view returns (bytes result, address resolver)",
]);

const TEXT_ABI = parseAbi(["function text(bytes32 node, string key) view returns (string)"]);

// ENSIP-10 name encoding: each label length-prefixed, terminated by a zero byte.
// This is what findResolver and resolve expect, not a namehash.
export function dnsEncode(name: string): Hex {
  const clean = name.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!clean) throw new Error("Enter a name.");
  let out = "0x";
  for (const label of clean.split(".")) {
    if (!label) throw new Error("That name has an empty label.");
    if (label.length > 255) throw new Error("A label is too long.");
    out += label.length.toString(16).padStart(2, "0");
    for (const ch of label) out += ch.charCodeAt(0).toString(16).padStart(2, "0");
  }
  return (out + "00") as Hex;
}

// The registry that owns a label, read from the root. Proves the hierarchy is live
// rather than assuming one registry for everything.
export async function ethRegistry(): Promise<string> {
  return publicClient.readContract({
    address: ENS.rootRegistry,
    abi: REGISTRY_ABI,
    functionName: "getSubregistry",
    args: ["eth"],
  });
}

export type NameState = {
  name: string;
  resolver: string;
  node: Hex;
  status: "available" | "reserved" | "registered" | "unknown";
  expiry: string | null;
  meta: string | null;
  // Why the record could not be read, when it could not. Null means it was read
  // and is genuinely empty.
  readError: string | null;
};

function statusName(v: number): NameState["status"] {
  return v === 0 ? "available" : v === 1 ? "reserved" : v === 2 ? "registered" : "unknown";
}

// Bounds a whole operation, so a chain of individually-timeout-ed calls cannot add
// up to more than a user will wait.
function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} took too long`)), ms)),
  ]);
}

// Reads a name through the v2 universal resolver: find its resolver, then read the
// text record inside resolve(). Two calls, both against the same deployment.
//
// `quick` skips the registry status and expiry reads, which are decoration for the
// send path. Every call crosses the mixnet and costs seconds, so paying for four
// round trips when one question was asked is how a lookup appeared to hang.
export async function lookup(name: string, quick = false): Promise<NameState> {
  const clean = name.trim().toLowerCase();
  const encoded = dnsEncode(clean);
  const label = clean.split(".")[0];

  // A hard ceiling on the whole lookup. Each underlying call has its own timeout,
  // but a boot plus two calls plus a fallback could still add up past this.
  return withDeadline(doLookup(clean, encoded, label, quick), 25_000, `${clean} lookup`);
}

async function doLookup(clean: string, encoded: Hex, label: string, quick: boolean): Promise<NameState> {
  const [resolver, node] = await publicClient.readContract({
    address: ENS.universalResolver,
    abi: UNIVERSAL_ABI,
    functionName: "findResolver",
    args: [encoded],
  });

  let meta: string | null = null;
  let readError: string | null = null;
  try {
    const inner = encodeFunctionData({ abi: TEXT_ABI, functionName: "text", args: [node, META_KEY] });
    const [result] = await publicClient.readContract({
      address: ENS.universalResolver,
      abi: UNIVERSAL_ABI,
      functionName: "resolve",
      args: [encoded, inner],
    });
    const [value] = decodeAbiParameters([{ type: "string" }], result);
    // Only accept something that is actually a scheme-1 meta-address, so a stray
    // record cannot send funds somewhere unintended.
    if (typeof value === "string" && /^st:eth:0x[0-9a-fA-F]{132}$/.test(value.trim())) {
      meta = value.trim();
    } else if (typeof value === "string" && value !== "") {
      readError = `the record holds ${value.length} characters that are not a meta-address`;
    }
  } catch (err) {
    // Keep the reason. Swallowing it is what made this look like "no record" when
    // the read had actually failed.
    readError = err instanceof Error ? err.message.split("\n")[0] : "the read failed";
  }

  if (quick) {
    return { name: clean, resolver, node, status: "unknown", expiry: null, meta, readError };
  }

  // Status and expiry live on the registry, keyed by labelhash.
  const anyId = BigInt(keccak256(toHex(label)));
  const [status, expiry] = await Promise.all([
    publicClient
      .readContract({ address: ENS.ethRegistry, abi: REGISTRY_ABI, functionName: "getStatus", args: [anyId] })
      .catch(() => -1),
    publicClient
      .readContract({ address: ENS.ethRegistry, abi: REGISTRY_ABI, functionName: "getExpiry", args: [anyId] })
      .catch(() => 0n),
  ]);

  return {
    name: clean,
    resolver,
    node,
    status: status < 0 ? "unknown" : statusName(Number(status)),
    expiry: expiry ? new Date(Number(expiry) * 1000).toISOString().slice(0, 10) : null,
    meta,
    readError,
  };
}

// Points a name at a resolver. Under v2 the resolver is set per-name on the
// registry with setResolver(anyId, resolver), where anyId is the labelhash.
//
// Passing nothing means "leave it alone and just report what it already points
// at", which is the common case: the ENS app deploys a per-account resolver proxy
// when a name is registered, so there is usually nothing to change.
export async function nameResolver(label: string): Promise<string> {
  return publicClient.readContract({
    address: ENS.ethRegistry,
    abi: REGISTRY_ABI,
    functionName: "getResolver",
    args: [label],
  });
}

export function buildSetResolver(name: string, resolver: string) {
  const clean = name.trim().toLowerCase();
  const label = clean.split(".")[0];
  if (!label) throw new Error("Enter a name.");
  if (!/^0x[0-9a-fA-F]{40}$/.test(resolver)) throw new Error("That resolver address looks wrong.");
  return {
    to: ENS.ethRegistry,
    data: encodeFunctionData({
      abi: REGISTRY_ABI,
      functionName: "setResolver",
      args: [BigInt(keccak256(toHex(label))), resolver as `0x${string}`],
    }),
  };
}

// Writes the meta-address record. Records live on whichever resolver the name
// points at, so this reads that resolver from the registry first rather than
// assuming a shared one. Under v2 every account gets its own resolver proxy, so
// the address differs per name.
export async function buildSetMeta(name: string, meta: string) {
  if (!/^st:eth:0x[0-9a-fA-F]{132}$/.test(meta)) throw new Error("That is not a meta-address.");
  const clean = name.trim().toLowerCase();
  const label = clean.split(".")[0];
  const resolver = await nameResolver(label);
  if (!resolver || resolver === "0x0000000000000000000000000000000000000000") {
    throw new Error(`${clean} has no resolver yet, so it cannot hold a record.`);
  }
  const node = namehashV2(clean);
  return {
    to: resolver as `0x${string}`,
    data: encodeFunctionData({
      // The v2 Permissioned Resolver takes the DNS-encoded name, not a nodehash,
      // in its setters. The legacy node-based setter is not what v2 exposes.
      abi: parseAbi(["function setText(bytes name, string key, string value)"]),
      functionName: "setText",
      args: [dnsEncode(clean), META_KEY, meta],
    }),
  };
}

// v2 keeps namehash as the node identifier for records, same construction as v1.
function namehashV2(name: string): Hex {
  const labels = name.trim().toLowerCase().replace(/^\.+|\.+$/g, "").split(".");
  let node: Hex = `0x${"00".repeat(32)}`;
  for (const label of [...labels].reverse()) {
    const labelHash = keccak256(toHex(label));
    node = keccak256(`0x${node.slice(2)}${labelHash.slice(2)}` as Hex);
  }
  return node;
}

// Reverse resolution is still a v1-shaped feature; keep the old helper so the
// header can show a name when one is set, without pretending it is v2.
export async function ensName(address: string): Promise<string | null> {
  try {
    const name = await publicClient.getEnsName({ address: address as Hex });
    return name ?? null;
  } catch {
    return null;
  }
}

export { namehashV2 };
