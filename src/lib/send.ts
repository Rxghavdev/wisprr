import { isAddress, type Address } from "viem";
import { accountFromSecret } from "./account";
import { SEPOLIA_RPC } from "./chain";
import { anonRequest } from "./rpc";

export async function sendSepoliaEth(secret: string, to: string, value: bigint): Promise<string> {
  if (!isAddress(to)) throw new Error("That address looks wrong.");
  if (value <= 0n) throw new Error("Amount has to be more than zero.");
  const account = accountFromSecret(secret);
  const call = { from: account.address, to, value: `0x${value.toString(16)}` };
  let gas: bigint;
  try {
    const est = (await anonRequest("eth_estimateGas", [call], SEPOLIA_RPC)) as string;
    gas = (BigInt(est) * 12n) / 10n;
  } catch (err) {
    const message = err instanceof Error ? err.message : "This address would reject the transfer.";
    throw new Error(message);
  }
  if (gas < 21000n) gas = 21000n;
  const nonceHex = (await anonRequest("eth_getTransactionCount", [account.address, "pending"], SEPOLIA_RPC)) as string;
  const gasHex = (await anonRequest("eth_gasPrice", [], SEPOLIA_RPC)) as string;
  const signed = await account.signTransaction({
    chainId: 11155111,
    to: to as Address,
    value,
    gas,
    gasPrice: BigInt(gasHex),
    nonce: Number(nonceHex),
  });
  return (await anonRequest("eth_sendRawTransaction", [signed], SEPOLIA_RPC)) as string;
}
