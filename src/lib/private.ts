import { encodeFunctionData, isAddress, type Address, type Hex } from "viem";
import { accountFromSecret } from "./account";
import { netInfo, type NetName } from "./chain";
import { anonRequest } from "./rpc";
import { ANNOUNCER, ANNOUNCEMENT_ABI, accountFor, derivePayment, openPayment, type Keys } from "./stealth";
import type { Found } from "./payments";

// Sending to someone privately is two things that cannot be split: the value
// lands at a one-time address, and the announcement goes out. Without the
// announcement the recipient has no way to find it.

type Call = { to: Address; value?: bigint; data?: Hex };

// A single signed call, used by flows that are one transaction (registration).
export async function sendCall(secret: string, call: Call, net: NetName, key = "vault"): Promise<string> {
  return sendCalls(secret, [call], key, net);
}

async function sendCalls(secret: string, calls: Call[], key: string, net: NetName): Promise<string> {
  const account = accountFromSecret(secret);
  const rpc = netInfo(net).rpc;
  const chainId = net === "sepolia" ? 11155111 : 1;
  const first = calls[0];
  const estimate = {
    from: account.address,
    to: first.to,
    value: `0x${(first.value ?? 0n).toString(16)}`,
    data: first.data,
  };

  let gas: bigint;
  try {
    const est = (await anonRequest("eth_estimateGas", [estimate], rpc, key)) as string;
    gas = (BigInt(est) * 12n) / 10n;
  } catch (err) {
    const message = err instanceof Error ? err.message : "That payment would fail.";
    throw new Error(message);
  }
  const nonceHex = (await anonRequest("eth_getTransactionCount", [account.address, "pending"], rpc, key)) as string;
  const gasPriceHex = (await anonRequest("eth_gasPrice", [], rpc, key)) as string;
  const gasPrice = BigInt(gasPriceHex);

  // One transaction per call. Carrying value and an announcement in a single
  // transaction needs a multicall helper contract, which this build does not have.
  let hash = "";
  for (const [i, call] of calls.entries()) {
    const signed = await account.signTransaction({
      chainId,
      to: call.to,
      value: call.value ?? 0n,
      data: call.data,
      gas,
      gasPrice,
      nonce: Number(nonceHex) + i,
    });
    hash = (await anonRequest("eth_sendRawTransaction", [signed], rpc, key)) as string;
  }
  return hash;
}

export type PrivateSend = {
  stealthAddress: Hex;
  ephemeralPubKey: Hex;
  viewTag: number;
  hash: string;
  announceHash: string;
};

export async function sendPrivate(
  secret: string,
  meta: string,
  value: bigint,
  key = "vault",
  net: NetName = "sepolia",
): Promise<PrivateSend> {
  if (value <= 0n) throw new Error("Amount has to be more than zero.");
  const payment = derivePayment(meta);
  if (!isAddress(payment.stealthAddress)) throw new Error("That meta-address is not usable.");

  const announceData = encodeFunctionData({
    abi: ANNOUNCEMENT_ABI,
    functionName: "announce",
    args: [
      1n,
      payment.stealthAddress,
      payment.ephemeralPubKey,
      // ERC-5564 metadata is opaque. The first byte is our view tag, so a recipient
      // rejects almost every announcement without a point multiplication.
      `0x${payment.viewTag.toString(16).padStart(2, "0")}` as Hex,
    ],
  });

  const hash = await sendCalls(
    secret,
    [
      { to: payment.stealthAddress, value },
      { to: ANNOUNCER as Address, data: announceData },
    ],
    key,
    net,
  );
  return { stealthAddress: payment.stealthAddress, ephemeralPubKey: payment.ephemeralPubKey, viewTag: payment.viewTag, hash, announceHash: hash };
}

// Sweeping a received payment. The one-time key is derived from the phrase on
// demand, so nothing is stored between sessions.
//
// The limit: whatever address you sweep to becomes linked to the stealth
// address on chain, so sweeping to your vault publishes the link. Breaking that
// needs a pool or a relayer, which this build does not have.
export async function sweep(keys: Keys, found: Found, to: Address, net: NetName): Promise<string> {
  const priv = openPayment(keys, found.ephemeralPubKey, found.viewTag);
  if (!priv) throw new Error("That payment is not yours.");
  const account = accountFor(priv);
  const rpc = netInfo(net).rpc;
  const value = BigInt((await anonRequest("eth_getBalance", [found.address, "latest"], rpc, "sweep")) as string);
  if (value === 0n) throw new Error("Nothing left at that address.");

  const gasPriceHex = (await anonRequest("eth_gasPrice", [], rpc, "sweep")) as string;
  const gasPrice = BigInt(gasPriceHex);
  const gas = 21_000n;
  const fee = gas * gasPrice;
  if (value <= fee) throw new Error("Not enough to cover the network fee.");
  const nonceHex = (await anonRequest("eth_getTransactionCount", [account.address, "pending"], rpc, "sweep")) as string;

  const signed = await account.signTransaction({
    chainId: net === "sepolia" ? 11155111 : 1,
    to,
    value: value - fee,
    gas,
    gasPrice,
    nonce: Number(nonceHex),
  });
  return (await anonRequest("eth_sendRawTransaction", [signed], rpc, "sweep")) as string;
}
