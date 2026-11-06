import { formatEther } from "viem";
import type { NetName } from "./chain";
import { anonGet } from "./rpc";

export type TxRow = {
  hash: string;
  way: "in" | "out";
  eth: string;
  status: "ok" | "failed" | "pending";
  note: string;
  when: string;
};

type Party = { hash?: string };
type Item = {
  hash?: string;
  value?: string;
  status?: string | null;
  result?: string | null;
  timestamp?: string;
  from?: Party;
  to?: Party;
};

function host(net: NetName) {
  return net === "sepolia" ? "https://eth-sepolia.blockscout.com" : "https://eth.blockscout.com";
}

// Blockscout omits `status` entirely for a transaction that is not yet mined, so a
// missing value means pending, never failed. The old code mapped anything that was
// not "ok" or "pending" to "failed", which showed a brand-new success as a failure.
function statusOf(item: Item): TxRow["status"] {
  const s = (item.status ?? "").toLowerCase();
  const r = (item.result ?? "").toLowerCase();
  if (s === "ok" || r === "success") return "ok";
  if (s === "error" || s === "failed" || r === "reverted" || r === "error") return "failed";
  // No status, or something we do not recognise: it is still in flight.
  return "pending";
}

function when(iso?: string) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function eth(wei?: string) {
  try {
    const [whole, frac = ""] = formatEther(BigInt(wei || "0")).split(".");
    return frac ? `${whole}.${frac.slice(0, 6)}` : whole;
  } catch {
    return "0";
  }
}

export async function recentTxs(address: string, net: NetName, key?: string): Promise<TxRow[]> {
  const body = (await anonGet(`${host(net)}/api/v2/addresses/${address}/transactions`, key)) as { items?: Item[] };
  const mine = address.toLowerCase();
  return (body.items ?? []).slice(0, 8).map((item) => {
    const from = item.from?.hash?.toLowerCase() ?? "";
    const status = statusOf(item);
    const way: TxRow["way"] = from === mine ? "out" : "in";
    return {
      hash: item.hash ?? "",
      way,
      eth: eth(item.value),
      status,
      note: status === "failed" ? item.result || "reverted" : status === "pending" ? "still confirming" : "",
      when: when(item.timestamp),
    };
  }).filter((row) => row.hash);
}
