import { formatEther } from "viem";
import type { NetName } from "./chain";
import { anonGet, anonPost } from "./rpc";

// Uniswap data API, the same service their app uses to value a portfolio.
const UNI = "https://entry-gateway.backend-prod.api.uniswap.org/data.v1.DataApiService";

function money(n: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);
}

function shortEth(wei: string) {
  const [whole, frac = ""] = formatEther(BigInt(wei)).split(".");
  return frac ? `${whole}.${frac.slice(0, 4)}` : whole;
}

export type Exposure = {
  net: string;
  worth: string;
  eth: string;
  txs: string;
  transfers: string;
  known: string;
};

type Counters = { transactions_count?: string; token_transfers_count?: string };
type Info = { is_contract?: boolean; has_tokens?: boolean };
type Priced = { balance?: { total?: { valueUsd?: number } } };

// The receipt a site gets when it holds this address. Every read below goes through
// the mixnet, under the identity's own isolation key, so the vault and its faces do
// not share a mixnet identity.
export async function exposure(address: string, net: NetName, key?: string): Promise<Exposure> {
  const host = net === "sepolia" ? "https://eth-sepolia.blockscout.com" : "https://eth.blockscout.com";
  const [info, counters, priced] = await Promise.all([
    anonGet(`${host}/api/v2/addresses/${address}`, key) as Promise<Info & { coin_balance?: string }>,
    anonGet(`${host}/api/v2/addresses/${address}/counters`, key) as Promise<Counters>,
    net === "mainnet"
      ? (anonPost(`${UNI}/GetWalletBalances`, {
          walletAccount: { platformAddresses: [{ address }] },
          chainIds: [1],
          includeCategories: [],
        }, key).catch(() => undefined) as Promise<Priced | undefined>)
      : Promise.resolve(undefined),
  ]);
  const wei = info.coin_balance ?? "0";
  const txs = Number(counters.transactions_count ?? "0");
  const transfers = Number(counters.token_transfers_count ?? "0");
  const usd = priced?.balance?.total?.valueUsd;
  return {
    net: net === "sepolia" ? "Sepolia" : "Ethereum",
    worth: typeof usd === "number" ? money(usd) : "not priced here",
    eth: shortEth(wei),
    txs: txs.toLocaleString("en-US"),
    transfers: transfers.toLocaleString("en-US"),
    known: info.is_contract ? "a contract, not a person's wallet" : txs ? "a wallet with history" : "a wallet with no history",
  };
}
