import { encodeFunctionData, keccak256, toHex, type Hex } from "viem";
import { accountFor, openPayment, type Keys } from "./stealth";
import type { Found } from "./payments";
import { netInfo, type NetName } from "./chain";
import { anonRequest } from "./rpc";

// Moving tokens out of a stealth address without giving it gas.
//
// USDC implements EIP-3009, so the stealth address can sign an authorisation
// offline and anyone can submit it and pay the fee. The address holds zero ETH
// before, during and after, so there is no funding transaction pointing at
// whoever owns it.
//
// This is the difference between "private receiving" and "private money" for
// tokens. It does not fix the destination link: whoever receives the USDC is
// still publicly connected to the stealth address.

export const USDC: Record<NetName, Hex> = {
  mainnet: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  sepolia: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
};

export const CHAIN_ID: Record<NetName, number> = { mainnet: 1, sepolia: 11155111 };

const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const USDC_ABI = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export type Authorisation = {
  from: Hex;
  to: Hex;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  signature: Hex;
  token: Hex;
  chainId: number;
};

// Signs an ERC-3009 authorisation with the stealth key. No network call: the
// stealth address never has to be online, funded, or touched.
export async function authoriseToken(
  keys: Keys,
  found: Found,
  to: Hex,
  value: bigint,
  net: NetName,
  windowSeconds = 3600n,
): Promise<Authorisation> {
  const priv = openPayment(keys, found.ephemeralPubKey, found.viewTag);
  if (!priv) throw new Error("That payment is not yours.");
  if (value <= 0n) throw new Error("Amount has to be more than zero.");

  const account = accountFor(priv);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const nonce = keccak256(toHex(`${found.address}:${to}:${value}:${now}`));
  const message = {
    from: account.address,
    to,
    value,
    validAfter: now - 600n,
    validBefore: now + windowSeconds,
    nonce,
  };

  const signature = await account.signTypedData({
    domain: { name: "USDC", version: "2", chainId: CHAIN_ID[net], verifyingContract: USDC[net] },
    types: TRANSFER_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  });

  return { ...message, signature, token: USDC[net], chainId: CHAIN_ID[net] };
}

// Any account can submit it. This one uses the wallet's own address, which pays
// the gas. That is the point: the *submitter* is public, the stealth address is
// not linked to anyone, and no ETH ever entered it.
export function encode3009(a: Authorisation): Hex {
  const r = a.signature.slice(0, 66) as Hex;
  const s = `0x${a.signature.slice(66, 130)}` as Hex;
  const v = parseInt(a.signature.slice(130, 132), 16);
  return encodeFunctionData({
    abi: USDC_ABI,
    functionName: "transferWithAuthorization",
    args: [a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, v, r, s],
  });
}

export async function submit3009(secret: string, a: Authorisation, net: NetName): Promise<string> {
  const { accountFromSecret } = await import("./account");
  const account = accountFromSecret(secret);
  const rpc = netInfo(net).rpc;
  const data = encode3009(a);
  const call = { from: account.address, to: a.token, data };

  let gas: bigint;
  try {
    const est = (await anonRequest("eth_estimateGas", [call], rpc, "sweep")) as string;
    gas = (BigInt(est) * 12n) / 10n;
  } catch (err) {
    const message = err instanceof Error ? err.message : "That transfer would fail.";
    throw new Error(message);
  }
  const nonceHex = (await anonRequest("eth_getTransactionCount", [account.address, "pending"], rpc, "sweep")) as string;
  const gasPriceHex = (await anonRequest("eth_gasPrice", [], rpc, "sweep")) as string;

  const signed = await account.signTransaction({
    chainId: CHAIN_ID[net],
    to: a.token,
    data,
    gas,
    gasPrice: BigInt(gasPriceHex),
    nonce: Number(nonceHex),
  });
  return (await anonRequest("eth_sendRawTransaction", [signed], rpc, "sweep")) as string;
}
