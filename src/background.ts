import { english, generateMnemonic, mnemonicToAccount } from "viem/accounts";
import { hasVault, lock, open, seal, sessionMnemonic } from "./lib/vault";

let draft: { password: string; mnemonic: string } | undefined;

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  handle(msg).then(reply, (err) => reply({ error: err instanceof Error ? err.message : "failed" }));
  return true;
});

async function handle(msg: { type?: string; password?: string; mnemonic?: string }) {
  if (msg.type === "status") {
    const mnemonic = await sessionMnemonic();
    const account = mnemonic ? mnemonicToAccount(mnemonic) : undefined;
    return { hasVault: await hasVault(), unlocked: Boolean(account), address: account?.address };
  }

  if (msg.type === "draft") {
    const password = msg.password?.trim() ?? "";
    if (password.length < 8) throw new Error("Use at least 8 characters.");
    draft = { password, mnemonic: generateMnemonic(english) };
    return { mnemonic: draft.mnemonic };
  }

  if (msg.type === "keep") {
    if (!draft) throw new Error("The phrase expired. Start again.");
    await seal(draft.password, draft.mnemonic);
    await open(draft.password);
    const address = mnemonicToAccount(draft.mnemonic).address;
    draft = undefined;
    return { address };
  }

  if (msg.type === "import") {
    const password = msg.password?.trim() ?? "";
    const mnemonic = msg.mnemonic?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
    if (password.length < 8) throw new Error("Use at least 8 characters.");
    let address: string;
    try {
      address = mnemonicToAccount(mnemonic).address;
    } catch {
      throw new Error("That phrase doesn't look right.");
    }
    await seal(password, mnemonic);
    await open(password);
    return { address };
  }

  if (msg.type === "unlock") {
    const mnemonic = await open(msg.password ?? "");
    return { address: mnemonicToAccount(mnemonic).address };
  }

  if (msg.type === "lock") {
    await lock();
    return { ok: true };
  }

  throw new Error("unknown message");
}
