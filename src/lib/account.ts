import type { Hex } from "viem";
import { mnemonicToAccount, privateKeyToAccount, type LocalAccount } from "viem/accounts";
import { sessionMnemonic } from "./vault";

export function accountFromSecret(secret: string): LocalAccount {
  if (/^0x[0-9a-fA-F]{64}$/.test(secret)) return privateKeyToAccount(secret as Hex);
  return mnemonicToAccount(secret);
}

export async function sessionAccount(): Promise<LocalAccount | undefined> {
  const secret = await sessionMnemonic();
  if (!secret) return;
  return accountFromSecret(secret);
}
