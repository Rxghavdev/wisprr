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
// A first scan needs a starting point. About half a day of Sepolia: enough to
// catch a payment you just made, few enough requests to finish quickly. The deep
// scan reaches further back on purpose.
const FIRST_LOOKBACK = 30_000n;
const DEEP_LOOKBACK = 400_000n;

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

// Public nodes disagree about what range they will serve, and some prune history
// outright. Neither is fatal: a rejected range is split and retried, and a range
// the node simply does not have is skipped rather than aborting the whole scan.
//
// The old version had a real bug. On failure it halved the width but kept the same
// start, so with a small enough width it either spun forever or threw, and
// "pruned history" was not recognised as retryable at all.
const MAX_RANGE = 40_000n;
const MIN_RANGE = 500n;

function rangeTooWide(message: string): boolean {
  return /range|limit|too many|exceed|10000|50000|block range/i.test(message);
}

function pruned(message: string): boolean {
  return /pruned|archive|unavailable|not available|missing trie/i.test(message);
}

async function logsAdaptive(
  net: NetName,
  from: bigint,
  to: bigint,
  deadline: number,
): Promise<{ logs: Log[]; skipped: number }> {
  const out: Log[] = [];
  let skipped = 0;
  let start = from;

  while (start <= to) {
    // The deadline is checked here as well as in the caller. A single slice can
    // halve many times, and a stalled mixnet request must not outlive the budget.
    if (Date.now() > deadline) break;

    const end = start + MAX_RANGE > to ? to : start + MAX_RANGE;
    let lo = start;
    let hi = end;
    let width = hi - lo + 1n;

    // Narrow the window until the node accepts it. "Pruned" is not a reason to
    // give up: this node serves a narrower range happily, so shrink first and only
    // skip the slice once it is too small to be useful.
    for (;;) {
      if (Date.now() > deadline) break;
      try {
        out.push(...(await logs(net, lo, hi)));
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : "";
        const canShrink = rangeTooWide(message) || pruned(message);
        if (!canShrink) throw err;
        if (width <= MIN_RANGE) {
          skipped += 1;
          break;
        }
        width = width / 2n;
        hi = lo + width - 1n;
        if (hi < lo) {
          skipped += 1;
          break;
        }
      }
    }

    // Always advance, whatever happened above. This is what the old loop missed.
    start = end + 1n;
  }

  return { logs: out, skipped };
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
  return scanWith(
    (eph, tag) => {
      const priv = openPayment(keys, eph, tag);
      if (!priv) return;
      return accountFor(priv).address;
    },
    net,
    full,
  );
}

// The scanner, parameterised by how an address is recognised. The owner opens the
// announcement with their spending scalar; an auditor recognises it with the
// disclosed viewing key. Same walk, same proofs, different capability.
export type Recognise = (ephemeralPubKey: Hex, viewTag: number) => Hex | undefined;

// A scoped scan. The recogniser is handed the announcement's block time, and the
// grant decides whether to answer at all. Payments outside the mandate are not
// filtered out afterwards. They are never recognised, so they cannot leak.
export type TimedRecognise = (ephemeralPubKey: Hex, viewTag: number, when: number) => Hex | undefined;

export async function scanScoped(
  recognise: TimedRecognise,
  net: NetName,
  window?: { from: number; to: number },
): Promise<Found[]> {
  const found = await walk((row, when) => tryTimed(recognise, row, when), net, {
    reset: Boolean(window),
    needTime: true,
  });
  return withBalances(found, net);
}

// One walk over the announcement log, shared by the owner scan and the auditor
// scan. Bounded by a wall-clock deadline so a slow or uncooperative node cannot
// leave the UI spinning forever, which is exactly what happened before.
const SCAN_BUDGET_MS = 45_000;

type Hit = (row: Log, when: number) => Found | undefined;

async function walk(
  hit: Hit,
  net: NetName,
  opts: { reset?: boolean; needTime?: boolean; deep?: boolean } = {},
): Promise<Found[]> {
  const started = Date.now();
  const deadline = started + SCAN_BUDGET_MS;
  const head = await latestBlock(net);
  const mark = opts.reset ? undefined : await checkpoint(net);
  // A reset scan starts from scratch, and a deep one starts further back.
  const lookback = opts.deep ? DEEP_LOOKBACK : FIRST_LOOKBACK;
  let from = mark ?? head - lookback;
  if (from < 1n) from = 1n;

  const found = new Map<string, Found>();
  let reached = from;

  for (let start = from; start <= head; start += CHUNK) {
    if (Date.now() > deadline) break;
    const last = start + CHUNK - 1n;
    const to = last > head ? head : last;
    const { logs: rows } = await logsAdaptive(net, start, to, deadline);
    reached = to + 1n;

    // Timestamps are only needed when a window has to be enforced.
    const stamp = opts.needTime ? await batchTimestamps(net, rows.map((r) => r.blockNumber)) : new Map<string, number>();
    for (const row of rows) {
      const got = hit(row, stamp.get(row.blockNumber) ?? 0);
      if (got && !found.has(got.address.toLowerCase())) found.set(got.address.toLowerCase(), got);
    }
  }

  // Checkpoint only what was actually looked at, so a scan cut short resumes
  // where it stopped instead of skipping the blocks it never reached.
  if (reached > from) await saveCheckpoint(net, reached);

  return [...found.values()];
}

// Balances are read per address through the mixnet, so no single node learns that
// these addresses are one wallet.
async function withBalances(rows: Found[], net: NetName): Promise<Found[]> {
  await Promise.all(
    rows.map(async (row) => {
      try {
        const bal = (await anonRequest("eth_getBalance", [row.address, "latest"], netInfo(net).rpc, "scan")) as string;
        row.eth = formatEther(BigInt(bal));
        row.spent = BigInt(bal) === 0n;
      } catch {
        row.eth = "";
      }
    }),
  );
  return rows.sort((a, b) => (a.block < b.block ? 1 : -1));
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

export async function scanWith(recognise: Recognise, net: NetName, full = false): Promise<Found[]> {
  const found = await walk((row) => tryRecognise(recognise, row), net, { reset: full, deep: full });
  return withBalances(found, net);
}

export async function pendingCount(keys: Keys, net: NetName): Promise<number> {
  const rows = await scan(keys, net);
  return rows.filter((r) => !r.spent).length;
}

// Announcement ABI kept for the payer side, which writes to the announcer.
export const ANNOUNCE = parseAbiItem(
  "function announce(uint256 schemeId, address stealthAddress, bytes ephemeralPubKey, bytes metadata)",
);

