import { mnemonicToAccount } from "viem/accounts";
import { currentNet, netFromHex, netInfo, setNet } from "./chain";
import { anonRequest } from "./rpc";
import { allow, allowed } from "./sites";
import { hasVault, sessionMnemonic } from "./vault";

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

const PROMPT = "wisprr-prompt";

type Prompt = {
  origin: string;
  host: string;
  known: boolean;
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

async function account() {
  const mnemonic = await sessionMnemonic();
  if (!mnemonic) return;
  return mnemonicToAccount(mnemonic).address;
}

function tell(msg: Record<string, unknown>) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, msg, () => void chrome.runtime.lastError);
    }
  });
}

export function publish(accounts: string[]) {
  tell({ type: "accounts", accounts });
}

export function publishChain(chainId: string) {
  tell({ type: "chain", chainId });
}

export function pageOrigin(sender: chrome.runtime.MessageSender) {
  const raw = sender.origin || "";
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  const url = sender.url || sender.tab?.url || "";
  if (url.startsWith("http://") || url.startsWith("https://")) return new URL(url).origin;
  return "";
}

export async function pageRequest(
  method: string,
  params: unknown[] | undefined,
  origin: string,
  anchor?: number,
) {
  if (method === "eth_chainId") return netInfo(await currentNet()).hex;
  if (method === "net_version") return String(netInfo(await currentNet()).id);
  if (method === "web3_clientVersion") return "wisprr";

  if (method === "eth_accounts") {
    if (!(await allowed(origin))) return [];
    const address = await account();
    return address ? [address] : [];
  }

  if (method === "eth_requestAccounts" || method === "wallet_requestPermissions") {
    const address = await ensure(origin, anchor);
    publish([address]);
    if (method === "wallet_requestPermissions") return [{ parentCapability: "eth_accounts" }];
    return [address];
  }

  if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") {
    const chainId = (params?.[0] as { chainId?: string } | undefined)?.chainId ?? "";
    const next = netFromHex(chainId);
    if (!next) throw new RpcError(4902, "wisprr has mainnet and Sepolia.");
    await setNet(next);
    publishChain(netInfo(next).hex);
    return null;
  }

  if (method === "eth_sendTransaction") {
    throw new RpcError(4200, "Send from the Sepolia form in wisprr. A site cannot spend on its own.");
  }

  if (
    method === "personal_sign" ||
    method === "eth_sign" ||
    method === "eth_signTypedData" ||
    method === "eth_signTypedData_v4" ||
    method === "eth_sendTransaction" ||
    method === "eth_sendRawTransaction"
  ) {
    throw new RpcError(4200, "Signing comes next. This build connects and reads.");
  }

  if (!READ.has(method)) throw new RpcError(-32601, `${method} is not handled.`);
  return anonRequest(method, params ?? [], netInfo(await currentNet()).rpc);
}

async function ensure(origin: string, anchor?: number) {
  const known = await allowed(origin);
  const address = await account();
  if (known && address) return address;
  return enqueue(origin, known, anchor);
}

function enqueue(origin: string, known: boolean, anchor?: number) {
  const prev = gate;
  let release: () => void = () => {};
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return prev
    .then(
      () => openPrompt(origin, known, anchor),
      () => openPrompt(origin, known, anchor),
    )
    .finally(release);
}

function openPrompt(origin: string, known: boolean, anchor?: number) {
  const id = crypto.randomUUID();
  return new Promise<string>((resolve, reject) => {
    const prompt: Prompt = { origin, host: hostOf(origin), known, resolve, reject };
    prompts.set(id, prompt);
    arm(id)
      .then(async () => {
        const windowId = anchor ?? (await chrome.windows.getCurrent()).id;
        if (windowId == null) return;
        try {
          await chrome.sidePanel.open({ windowId });
        } catch {
          /* Chrome only opens the panel from a user gesture. The badge stays. Click the icon. */
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
  return {
    host: prompt.host,
    known: prompt.known,
    hasVault: await hasVault(),
    unlocked: Boolean(await account()),
  };
}

export async function allowPrompt(id: string) {
  const prompt = prompts.get(id);
  if (!prompt) throw new Error("This request is gone.");
  const address = await account();
  if (!address) throw new Error("Locked.");
  await allow(prompt.origin);
  prompts.delete(id);
  prompt.resolve(address);
  await disarm();
}

export function denyPrompt(id: string) {
  const prompt = prompts.get(id);
  if (!prompt) return;
  prompts.delete(id);
  prompt.reject(new RpcError(4001, "User rejected the request."));
  void disarm();
}
