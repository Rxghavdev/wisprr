import { anonPost } from "./rpc";

// Uniswap data API, the same service the app uses for token price and Explore stats.
// https://github.com/Uniswap/interface/blob/main/packages/api/src/clients/base/entryGatewayUrls.ts
const API = "https://entry-gateway.backend-prod.api.uniswap.org/data.v2.DataApiService";

function usd(n: number, compact: boolean) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 2 : 2,
  }).format(n);
}

function pct(n: number) {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

export async function uniswapCards() {
  const [token, stats] = await Promise.all([
    anonPost(`${API}/GetToken`, {
      chainId: 1,
      address: "0x0000000000000000000000000000000000000000",
      external: true,
    }),
    anonPost(`${API}/GetProtocolStats`, {
      chainIds: [1],
      protocolVersions: ["PROTOCOL_VERSION_V2", "PROTOCOL_VERSION_V3", "PROTOCOL_VERSION_V4"],
    }),
  ]);
  const price = (token as { token?: { price?: { spotUsd?: number; percentChange1d?: number } } }).token?.price;
  const top = (stats as { stats?: { tvl?: number; volume1d?: number } }).stats;
  if (typeof price?.spotUsd !== "number" || typeof top?.tvl !== "number" || typeof top.volume1d !== "number") {
    throw new Error("Uniswap sent an empty price.");
  }
  return {
    eth: usd(price.spotUsd, false),
    day: pct(price.percentChange1d ?? 0),
    volume: usd(top.volume1d, true),
    tvl: usd(top.tvl, true),
  };
}
