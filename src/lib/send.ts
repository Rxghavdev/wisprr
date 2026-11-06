import { isAddress, type Address } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { SEPOLIA_RPC } from "./chain";
import { anonRequest } from "./rpc";

export async function sendSepoliaEth(mnemonic: string, to: string, value: bigint): Promise<string> {
  if (!isAddress(to)) throw new Error("That address looks wrong.");
  if (value <= 0n) throw new Error("Amount has to be more than zero.");
  const account = mnemonicToAccount(mnemonic);
  const nonceHex = (await anonRequest("eth_getTransactionCount", [account.address, "pending"], SEPOLIA_RPC)) as string;
  const gasHex = (await anonRequest("eth_gasPrice", [], SEPOLIA_RPC)) as string;
  const signed = await account.signTransaction({
    chainId: 11155111,
    to: to as Address,
    value,
    gas: 21000n,
    gasPrice: BigInt(gasHex),
    nonce: Number(nonceHex),
  });
  return (await anonRequest("eth_sendRawTransaction", [signed], SEPOLIA_RPC)) as string;
}
