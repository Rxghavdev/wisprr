import { formatEther, parseEther } from "viem";
import { english, generateMnemonic, mnemonicToAccount } from "viem/accounts";
import {
  allowPrompt,
  denyPrompt,
  describe,
  pageOrigin,
  pageRequest,
  pendingPrompt,
  popupGone,
  publishChain,
  receipt,
  publish,
  RpcError,
} from "./lib/page";
import { accountFromSecret, sessionAccount } from "./lib/account";
import { currentNet, netInfo, setNet, type NetName } from "./lib/chain";
import { ensName } from "./lib/ens";
import { recentTxs } from "./lib/history";
import { uniswapCards } from "./lib/market";
import { quoteEthToUsdc } from "./lib/quote";
import { sendSepoliaEth } from "./lib/send";
import { anonRequest, mixnetNote } from "./lib/rpc";
import { hosts, revoke } from "./lib/sites";
import { clearDraft, readDraft, writeDraft } from "./lib/draft";
import { hasVault, lock, open, openKey, seal, sessionMnemonic } from "./lib/vault";

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
    // A ping is only here to keep this worker alive while a panel is asking for a site.
  });
  port.onDisconnect.addListener(() => {
    if (watching) popupGone(watching);
  });
});

async function handle(
  msg: {
    type?: string;
    password?: string;
    mnemonic?: string;
    method?: string;
    params?: unknown[];
    id?: string;
    amount?: string;
    to?: string;
    net?: string;
    key?: string;
    origin?: string;
  },
  sender: chrome.runtime.MessageSender,
) {
  const fromPanel = (sender.url ?? "").startsWith(`chrome-extension://${chrome.runtime.id}/`);
  const panelOnly = new Set([
    "status",
    "social",
    "draft",
    "keep",
    "import",
    "drafted",
    "unlock",
    "lock",
    "sites",
    "revoke",
    "net",
    "set-net",
    "pending",
    "prompt",
    "receipt",
    "allow",
    "deny",
    "balance",
    "ens",
    "market",
    "quote",
    "send",
    "activity",
  ]);
  if (panelOnly.has(msg.type ?? "") && !fromPanel) throw new Error("That request has to come from the wallet.");

  if (msg.type === "status") {
    const account = await sessionAccount();
    return { hasVault: await hasVault(), unlocked: Boolean(account), address: account?.address };
  }

  if (msg.type === "social") {
    const key = (msg.key ?? "").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("Web3Auth didn't return a key.");
    accountFromSecret(key);
    await openKey(key);
    return { address: accountFromSecret(key).address };
  }

  if (msg.type === "draft") {
    const password = msg.password?.trim() ?? "";
    if (password.length < 8) throw new Error("Use at least 8 characters.");
    const mnemonic = generateMnemonic(english);
    await writeDraft({ password, mnemonic });
    return { mnemonic };
  }

  if (msg.type === "keep") {
    const draft = await readDraft();
    if (!draft) throw new Error("The phrase expired. Start again.");
    await seal(draft.password, draft.mnemonic);
    await open(draft.password);
    const address = mnemonicToAccount(draft.mnemonic).address;
    await clearDraft();
    return { address };
  }

  if (msg.type === "drafted") {
    const draft = await readDraft();
    return { mnemonic: draft?.mnemonic ?? "" };
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
    await publish([]);
    return { ok: true };
  }

  if (msg.type === "open-panel") {
    const windowId = sender.tab?.windowId;
    if (windowId == null) return { ok: false };
    await chrome.sidePanel.open({ windowId });
    return { ok: true };
  }

  if (msg.type === "sites") return { hosts: await hosts() };

  if (msg.type === "revoke") {
    await revoke(msg.origin ?? "");
    await publish([]);
    await publishChain(netInfo(await currentNet()).hex);
    return { hosts: await hosts() };
  }

  if (msg.type === "net") {
    const info = netInfo(await currentNet());
    return { name: info.name, hex: info.hex };
  }

  if (msg.type === "set-net") {
    const name: NetName = msg.net === "sepolia" ? "sepolia" : "mainnet";
    await setNet(name);
    const info = netInfo(name);
    await publishChain(info.hex);
    return { name: info.name, hex: info.hex };
  }

  if (msg.type === "pending") return pendingPrompt();
  if (msg.type === "prompt") return describe(msg.id ?? "");
  if (msg.type === "receipt") return receipt();
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
    const account = await sessionAccount();
    if (!account) throw new Error("Locked.");
    const address = account.address;
    const hex = (await anonRequest("eth_getBalance", [address, "latest"], netInfo(await currentNet()).rpc)) as string;
    return { eth: formatEther(BigInt(hex)), note: mixnetNote() };
  }

  if (msg.type === "ens") {
    const account = await sessionAccount();
    if (!account) throw new Error("Locked.");
    return { name: (await ensName(account.address)) ?? "" };
  }

  if (msg.type === "market") {
    const account = await sessionAccount();
    if (!account) throw new Error("Locked.");
    return uniswapCards();
  }

  if (msg.type === "quote") {
    const account = await sessionAccount();
    if (!account) throw new Error("Locked.");
    return { usdc: await quoteEthToUsdc(msg.amount || "0.01"), note: mixnetNote() };
  }

  if (msg.type === "send") {
    const secret = await sessionMnemonic();
    if (!secret) throw new Error("Locked.");
    if ((await currentNet()) !== "sepolia") throw new Error("Switch to Sepolia before sending.");
    const hash = await sendSepoliaEth(secret, msg.to ?? "", parseEther((msg.amount || "").trim()));
    return { hash, note: mixnetNote() };
  }

  if (msg.type === "activity") {
    const account = await sessionAccount();
    if (!account) throw new Error("Locked.");
    const net = await currentNet();
    return { rows: await recentTxs(account.address, net) };
  }

  throw new Error("unknown message");
}
