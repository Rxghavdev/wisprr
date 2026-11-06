import { decodeAbiParameters, formatEther, keccak256, parseAbiItem, toHex, type Hex, type Hash } from "viem";
import { anonRequest } from "./rpc";
import { netInfo, type NetName } from "./chain";
import { ANNOUNCER, SCHEME_ID, accountFor, openPayment, type Keys } from "./stealth";

// Private receiving: payments arrive at a one-time address, announced on chain.
// This module finds the ones that belong to this wallet and can move them.

const TOPIC = keccak256(toHex("Announcement(uint256,address,address,bytes,bytes)"));
const CHECKPOINT = (net: NetName) => `wisprr-scan-${net}`;
// Public nodes cap eth_getLogs at 50,000 blocks, and the cap is exclusive. Sit
// under it with margin so one provider's stricter limit does not stop a scan.
const CHUNK = 40_000n;
// First scan has to start somewhere. Two days of Sepolia is plenty for a demo and
// keeps the first run to a handful of calls.
const FIRST_LOOKBACK = 400_000n;

export type Found = {
  address: Hex;
  ephemeralPubKey: Hex;
  viewTag: number;
  txHash: Hash;
  block: bigint;
  eth: string;
  spent: boolean;
};

type Log = {
  address: Hex;
  topics: Hex[];
  data: Hex;
  transactionHash: Hash;
  blockNumber: Hex;
};

async function checkpoint(net: NetName): Promise<bigint | undefined> {
  const bag = await chrome.storage.local.get(CHECKPOINT(net));
  const raw = bag[CHECKPOINT(net)];
  return typeof raw === "string" ? BigInt(raw) : undefined;
}

async function saveCheckpoint(net: NetName, block: bigint): Promise<void> {
  await chrome.storage.local.set({ [CHECKPOINT(net)]: block.toString() });
}

async function latestBlock(net: NetName): Promise<bigint> {
  const hex = (await anonRequest("eth_blockNumber", [], netInfo(net).rpc, "scan")) as string;
  return BigInt(hex);
}

async function logs(net: NetName, from: bigint, to: bigint): Promise<Log[]> {
  const rows = (await anonRequest(
    "eth_getLogs",
    [{ address: ANNOUNCER, topics: [TOPIC], fromBlock: toHex(from), toBlock: toHex(to) }],
    netInfo(net).rpc,
    "scan",
  )) as Log[];
  return rows ?? [];
}

// Public nodes disagree about what range they will serve and some prune history
// outright. A scan that assumed one limit would fail on the next provider, so a
// rejected range is halved and retried instead of aborting the whole scan.
async function logsAdaptive(net: NetName, from: bigint, to: bigint): Promise<{ logs: Log[]; next: bigint }> {
  let width = to - from;
  let start = from;
  const out: Log[] = [];
  while (start <= to) {
    let end = start + width > to ? to : start + width;
    try {
      out.push(...(await logs(net, start, end)));
      start = end + 1n;
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      const tooWide = /range|limit|too many|exceed|10000|50000/i.test(message);
      if (width <= 1_000n || !tooWide) throw err;
      width = width / 2n;
      end = start + width > to ? to : start + width;
      if (end < start) throw err;
    }
  }
  return { logs: out, next: to + 1n };
}

// Opens one announcement. Returns it only when the recogniser claims it, so a
// scan of someone else's payments yields nothing.
function tryRecognise(recognise: Recognise, log: Log): Found | undefined {
  const scheme = log.topics[1];
  if (!scheme || BigInt(scheme) !== SCHEME_ID) return;
  const stealthAddress = `0x${log.topics[2]?.slice(-40) ?? ""}` as Hex;
  let ephemeralPubKey: Hex;
  let metadata: Hex;
  try {
    const [eph, meta] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], log.data);
    ephemeralPubKey = eph as Hex;
    metadata = meta as Hex;
  } catch {
    return;
  }
  if (!ephemeralPubKey || ephemeralPubKey === "0x") return;
  const viewTag = metadata && metadata.length >= 4 ? parseInt(metadata.slice(2, 4), 16) : 0;
  let claimed: Hex | undefined;
  try {
    claimed = recognise(ephemeralPubKey, viewTag);
  } catch {
    return;
  }
  if (!claimed) return;
  // The view tag is a hint, not proof: confirm the address really is the one the
  // announcement named, so a malformed record cannot invent a payment.
  if (claimed.toLowerCase() !== stealthAddress.toLowerCase()) return;
  return {
    address: stealthAddress,
    ephemeralPubKey,
    viewTag,
    txHash: log.transactionHash,
    block: BigInt(log.blockNumber),
    eth: "0",
    spent: false,
  };
}

export async function scan(keys: Keys, net: NetName, full = false): Promise<Found[]> {
  return scanWith((eph, tag) => {
    const priv = openPayment(keys, eph, tag);
    if (!priv) return;
    return accountFor(priv).address;
  }, net, full);
}

// The scanner, parameterised by how an address is recognised. The owner opens the
// announcement with their spending scalar; an auditor recognises it with the
// disclosed viewing key. Same walk, same proofs, different capability.
export type Recognise = (ephemeralPubKey: Hex, viewTag: number) => Hex | undefined;

// A scoped scan. The recogniser is handed the announcement's block time, and the
// grant decides whether to answer at all. Payments outside the mandate are not
// filtered out afterwards. They are never recognised, so they cannot leak.
export type TimedRecognise = (ephemeralPubKey: Hex, viewTag: number, when: number) => Hex | undefined;

export async function scanScoped(recognise: TimedRecognise, net: NetName, window?: { from: number; to: number }): Promise<Found[]> {
  const head = await latestBlock(net);
  // A grant with a window only ever needs to look at the block range it covers.
  // Clamping here is a second, independent guarantee that nothing outside the
  // mandate is even fetched.
  const mark = window ? undefined : await checkpoint(net);
  let from = mark ?? head - FIRST_LOOKBACK;
  if (from < 1n) from = 1n;

  const found = new Map<string, Found>();
  for (let start = from; start <= head; start += CHUNK) {
    const last = start + CHUNK - 1n;
    const to = last > head ? head : last;
    const { logs: rows } = await logsAdaptive(net, start, to);
    // Block timestamps are needed for the window check, fetched once per batch.
    const stamp = await batchTimestamps(net, rows.map((r) => r.blockNumber));
    for (const row of rows) {
      const when = stamp.get(row.blockNumber) ?? 0;
      const hit = tryTimed(recognise, row, when);
      if (hit && !found.has(hit.address.toLowerCase())) found.set(hit.address.toLowerCase(), hit);
    }
  }
  if (!window) await saveCheckpoint(net, head + 1n);

  const out = [...found.values()];
  await Promise.all(
    out.map(async (row) => {
      try {
        const bal = (await anonRequest("eth_getBalance", [row.address, "latest"], netInfo(net).rpc, "scan")) as string;
        row.eth = formatEther(BigInt(bal));
        row.spent = BigInt(bal) === 0n;
      } catch {
        row.eth = "";
      }
    }),
  );
  return out.sort((a, b) => (a.block < b.block ? 1 : -1));
}

// One timestamp per distinct block, through the mixnet.
async function batchTimestamps(net: NetName, blocks: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unique = [...new Set(blocks)];
  await Promise.all(
    unique.map(async (b) => {
      try {
        const blk = (await anonRequest("eth_getBlockByNumber", [b, false], netInfo(net).rpc, "scan")) as {
          timestamp?: string;
        };
        if (blk?.timestamp) out.set(b, Number(BigInt(blk.timestamp)));
      } catch {
        /* a missing timestamp simply means the payment is not recognised */
      }
    }),
  );
  return out;
}

function tryTimed(recognise: TimedRecognise, log: Log, when: number): Found | undefined {
  const scheme = log.topics[1];
  if (!scheme || BigInt(scheme) !== SCHEME_ID) return;
  const stealthAddress = `0x${log.topics[2]?.slice(-40) ?? ""}` as Hex;
  let ephemeralPubKey: Hex;
  let metadata: Hex;
  try {
    const [eph, meta] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], log.data);
    ephemeralPubKey = eph as Hex;
    metadata = meta as Hex;
  } catch {
    return;
  }
  if (!ephemeralPubKey || ephemeralPubKey === "0x") return;
  const viewTag = metadata && metadata.length >= 4 ? parseInt(metadata.slice(2, 4), 16) : 0;
  let claimed: Hex | undefined;
  try {
    claimed = recognise(ephemeralPubKey, viewTag, when);
  } catch {
    return;
  }
  if (!claimed || claimed.toLowerCase() !== stealthAddress.toLowerCase()) return;
  return {
    address: stealthAddress,
    ephemeralPubKey,
    viewTag,
    txHash: log.transactionHash,
    block: BigInt(log.blockNumber),
    eth: "0",
    spent: false,
  };
}

export async function scanWith(recognise: Recognise, net: NetName, full = false): Promise<Found[]> {  const head = await latestBlock(net);
  const mark = full ? undefined : await checkpoint(net);
  let from = mark ?? head - FIRST_LOOKBACK;
  if (from < 1n) from = 1n;

  const found = new Map<string, Found>();
  for (let start = from; start <= head; start += CHUNK) {
    const last = start + CHUNK - 1n;
    const to = last > head ? head : last;
    const { logs: rows } = await logsAdaptive(net, start, to);
    for (const row of rows) {
      const hit = tryRecognise(recognise, row);
      // A stealth address only ever receives once in practice, but a duplicate
      // announcement must not double-count.
      if (hit && !found.has(hit.address.toLowerCase())) found.set(hit.address.toLowerCase(), hit);
    }
  }
  await saveCheckpoint(net, head + 1n);

  const out = [...found.values()];
  // Balances are read per address through the mixnet, so no single node learns
  // that these addresses are one wallet.
  await Promise.all(
    out.map(async (row) => {
      try {
        const bal = (await anonRequest("eth_getBalance", [row.address, "latest"], netInfo(net).rpc, "scan")) as string;
        row.eth = formatEther(BigInt(bal));
        row.spent = BigInt(bal) === 0n;
      } catch {
        row.eth = "";
      }
    }),
  );
  return out.sort((a, b) => (a.block < b.block ? 1 : -1));
}

export async function pendingCount(keys: Keys, net: NetName): Promise<number> {
  const rows = await scan(keys, net);
  return rows.filter((r) => !r.spent).length;
}

// Announcement ABI kept for the payer side, which writes to the announcer.
export const ANNOUNCE = parseAbiItem(
  "function announce(uint256 schemeId, address stealthAddress, bytes ephemeralPubKey, bytes metadata)",
);
