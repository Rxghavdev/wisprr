import { hexToString, isHex, type Hex } from "viem";
import { sessionAccount } from "./account";
import { currentNet, netFromHex, netInfo, setNet } from "./chain";
import { anonRequest } from "./rpc";
import { allow, allowed, origins } from "./sites";
import { hasVault } from "./vault";

export class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const READ = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "eth_syncing",
]);

const SIGN = new Set(["personal_sign", "eth_sign", "eth_signTypedData", "eth_signTypedData_v4"]);

const PROMPT = "wisprr-prompt";

type Prompt = {
  origin: string;
  host: string;
  resolve: (address: string) => void;
  reject: (err: Error) => void;
};

const prompts = new Map<string, Prompt>();
let gate: Promise<void> = Promise.resolve();

function hostOf(origin: string) {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export async function publish(accounts: string[]) {
  const want = new Set(await origins());
  for (const tab of await chrome.tabs.query({})) {
    if (!tab.id || !tab.url) continue;
    let origin = "";
    try {
      origin = new URL(tab.url).origin;
    } catch {
      continue;
    }
    if (!want.has(origin)) continue;
    chrome.tabs.sendMessage(tab.id, { type: "accounts", accounts }, () => void chrome.runtime.lastError);
  }
}

export async function publishChain(chainId: string) {
  const want = new Set(await origins());
  for (const tab of await chrome.tabs.query({})) {
    if (!tab.id || !tab.url) continue;
    let origin = "";
    try {
      origin = new URL(tab.url).origin;
    } catch {
      continue;
    }
    if (!want.has(origin)) continue;
    chrome.tabs.sendMessage(tab.id, { type: "chain", chainId }, () => void chrome.runtime.lastError);
  }
}

export function pageOrigin(sender: chrome.runtime.MessageSender) {
  const raw = sender.origin || "";
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  const url = sender.url || sender.tab?.url || "";
  if (url.startsWith("http://") || url.startsWith("https://")) return new URL(url).origin;
  return "";
}

export async function pageRequest(method: string, params: unknown[] | undefined, origin: string, anchor?: number) {
  if (method === "eth_chainId") return netInfo(await currentNet()).hex;
  if (method === "net_version") return String(netInfo(await currentNet()).id);
  if (method === "web3_clientVersion") return "wisprr";

  if (method === "eth_accounts") {
    if (!(await allowed(origin))) return [];
    const account = await sessionAccount();
    return account ? [account.address] : [];
  }

  if (method === "eth_requestAccounts" || method === "wallet_requestPermissions") {
    const address = await ensure(origin, anchor);
    await publish([address]);
    if (method === "wallet_requestPermissions") return [{ parentCapability: "eth_accounts" }];
    return [address];
  }

  if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") {
    const chainId = (params?.[0] as { chainId?: string } | undefined)?.chainId ?? "";
    const next = netFromHex(chainId);
    if (!next) throw new RpcError(4902, "wisprr has mainnet and Sepolia.");
    if (!(await allowed(origin))) throw new RpcError(4100, "Connect first.");
    await setNet(next);
    await publishChain(netInfo(next).hex);
    return null;
  }

  // A site never spends. Every transaction is signed inside the wallet, where the
  // user can see what it does.
  if (method === "eth_sendTransaction" || method === "eth_sendRawTransaction") {
    throw new RpcError(4200, "A site cannot spend. Send from the wisprr panel.");
  }

  if (SIGN.has(method)) {
    if (!(await allowed(origin))) throw new RpcError(4100, "Connect first.");
    const account = await sessionAccount();
    if (!account) throw new RpcError(4100, "Locked.");
    if (method === "personal_sign") {
      const first = params?.[0];
      if (typeof first !== "string") throw new RpcError(-32602, "Nothing to sign.");
      const message = isHex(first) ? hexToString(first as Hex) : first;
      return account.signMessage({ message });
    }
    if (method === "eth_sign") {
      const raw = params?.[1];
      if (typeof raw !== "string" || !isHex(raw) || raw.length !== 66) {
        throw new RpcError(-32602, "eth_sign needs a 32-byte hash.");
      }
      return account.signMessage({ message: { raw: raw as Hex } });
    }
    const raw = params?.[1];
    const typed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!typed || typeof typed !== "object") throw new RpcError(-32602, "That typed data is empty.");
    const data = typed as {
      domain?: unknown;
      types?: Record<string, unknown>;
      message?: unknown;
      primaryType?: string;
    };
    if (!data.types || !data.message || !data.primaryType) throw new RpcError(-32602, "That typed data is incomplete.");
    delete data.types.EIP712Domain;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return account.signTypedData(data as any);
  }

  if (!READ.has(method)) throw new RpcError(-32601, `${method} is not handled.`);
  return anonRequest(method, params ?? [], netInfo(await currentNet()).rpc, "site");
}

async function ensure(origin: string, anchor?: number) {
  const known = await allowed(origin);
  const account = await sessionAccount();
  if (known && account) return account.address;
  return enqueue(origin, anchor);
}

function enqueue(origin: string, anchor?: number) {
  const prev = gate;
  let release: () => void = () => {};
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return prev
    .then(
      () => openPrompt(origin, anchor),
      () => openPrompt(origin, anchor),
    )
    .finally(release);
}

function openPrompt(origin: string, anchor?: number) {
  const id = crypto.randomUUID();
  return new Promise<string>((resolve, reject) => {
    const prompt: Prompt = { origin, host: hostOf(origin), resolve, reject };
    prompts.set(id, prompt);
    arm(id)
      .then(async () => {
        const windowId = anchor ?? (await chrome.windows.getCurrent()).id;
        if (windowId == null) return;
        try {
          await chrome.sidePanel.open({ windowId });
        } catch {
          /* Chrome only opens the panel from a user gesture. The badge stays. */
        }
        chrome.runtime.sendMessage({ type: "show-prompt" }).catch(() => {});
      })
      .catch(() => {});
  });
}

async function arm(id: string) {
  await chrome.storage.session.set({ [PROMPT]: id });
  await chrome.action.setBadgeBackgroundColor({ color: "#f4f4f4" });
  await chrome.action.setBadgeText({ text: "1" });
  await chrome.action.setTitle({ title: "A site wants to connect" });
}

async function disarm() {
  await chrome.storage.session.remove(PROMPT);
  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({ title: "wisprr" });
}

export async function pendingPrompt() {
  const bag = await chrome.storage.session.get(PROMPT);
  const id = bag[PROMPT] as string | undefined;
  if (!id || !prompts.has(id)) {
    if (id) await disarm();
    return { id: "" };
  }
  return { id, ...(await describe(id)) };
}

export function popupGone(id: string) {
  const prompt = prompts.get(id);
  if (!prompt) return;
  prompts.delete(id);
  prompt.reject(new RpcError(4001, "User rejected the request."));
  void disarm();
}

export async function describe(id: string) {
  const prompt = prompts.get(id);
  if (!prompt) throw new Error("This request is gone.");
  const address = (await sessionAccount())?.address;
  return {
    host: prompt.host,
    hasVault: await hasVault(),
    unlocked: Boolean(address),
    address: address ?? "",
  };
}

export async function allowPrompt(id: string) {
  const prompt = prompts.get(id);
  if (!prompt) throw new Error("This request is gone.");
  const account = await sessionAccount();
  if (!account) throw new Error("Locked.");
  await allow(prompt.origin);
  prompts.delete(id);
  prompt.resolve(account.address);
  await disarm();
  return { address: account.address };
}

export function denyPrompt(id: string) {
  const prompt = prompts.get(id);
  if (!prompt) return;
  prompts.delete(id);
  prompt.reject(new RpcError(4001, "User rejected the request."));
  void disarm();
}
