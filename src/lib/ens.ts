import { createPublicClient, custom, type Address } from "viem";
import { mainnet } from "viem/chains";
import { anonRequest } from "./rpc";

// Reverse resolution: address to name. viem picks the resolver.
// https://docs.ens.domains/learn/resolution
const client = createPublicClient({
  chain: mainnet,
  transport: custom({
    async request({ method, params }) {
      return anonRequest(method, params ? [...params] : []);
    },
  }),
});

export async function ensName(address: Address): Promise<string | null> {
  return client.getEnsName({ address });
}
