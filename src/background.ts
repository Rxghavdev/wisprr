import { formatEther } from "viem";
import { english, generateMnemonic, mnemonicToAccount } from "viem/accounts";
import {
  allowPrompt,
  denyPrompt,
  describe,
  pageOrigin,
  pageRequest,
  pendingPrompt,
  popupGone,
  publish,
  RpcError,
} from "./lib/page";
import { ensName } from "./lib/ens";
import { quoteEthToUsdc } from "./lib/quote";
import { anonRequest, mixnetNote } from "./lib/rpc";
import { hosts } from "./lib/sites";
import { hasVault, lock, open, seal, sessionMnemonic } from "./lib/vault";

let draft: { password: string; mnemonic: string } | undefined;

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  handle(msg, sender).then(reply, (err) => reply({ error: err instanceof Error ? err.message : "failed" }));
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "wisprr") return;
  let watching = "";
  port.onMessage.addListener((msg) => {
    if (msg?.type === "watch" && typeof msg.id === "string") watching = msg.id;
  });
  port.onDisconnect.addListener(() => {
    if (watching) popupGone(watching);
  });
});

async function handle(
  msg: { type?: string; password?: string; mnemonic?: string; method?: string; params?: unknown[]; id?: string },
  sender: chrome.runtime.MessageSender,
) {
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
    publish([]);
    return { ok: true };
  }

  if (msg.type === "sites") return { hosts: await hosts() };

  if (msg.type === "pending") return pendingPrompt();
  if (msg.type === "prompt") return describe(msg.id ?? "");
  if (msg.type === "allow") {
    await allowPrompt(msg.id ?? "");
    return { ok: true };
  }
  if (msg.type === "deny") {
    denyPrompt(msg.id ?? "");
    return { ok: true };
  }

  if (msg.type === "rpc") {
    const origin = pageOrigin(sender);
    if (!origin) return { error: { code: 4100, message: "This page can't use wisprr." } };
    try {
      return { result: await pageRequest(msg.method ?? "", msg.params, origin, sender.tab?.windowId) };
    } catch (err) {
      const code = err instanceof RpcError ? err.code : -32603;
      const message = err instanceof Error ? err.message : "failed";
      return { error: { code, message } };
    }
  }

  if (msg.type === "balance") {
    const mnemonic = await sessionMnemonic();
    if (!mnemonic) throw new Error("Locked.");
    const address = mnemonicToAccount(mnemonic).address;
    const hex = (await anonRequest("eth_getBalance", [address, "latest"])) as string;
    return { eth: formatEther(BigInt(hex)), note: mixnetNote() };
  }

  if (msg.type === "ens") {
    const mnemonic = await sessionMnemonic();
    if (!mnemonic) throw new Error("Locked.");
    const address = mnemonicToAccount(mnemonic).address;
    return { name: (await ensName(address)) ?? "" };
  }

  if (msg.type === "quote") {
    const mnemonic = await sessionMnemonic();
    if (!mnemonic) throw new Error("Locked.");
    return { usdc: await quoteEthToUsdc(), note: mixnetNote() };
  }

  throw new Error("unknown message");
}
