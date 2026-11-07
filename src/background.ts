import { formatEther, parseEther, encodeFunctionData, keccak256, toHex, type Hex } from "viem";
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
  publishChain,
  RpcError,
} from "./lib/page";
import { accountFromSecret, sessionAccount } from "./lib/account";
import { currentNet, netInfo, setNet, type NetName } from "./lib/chain";
import { ensName, lookup, buildSetMeta, buildSetResolver, nameResolver, ENS } from "./lib/ens";
import { recentTxs } from "./lib/history";
import { uniswapCards } from "./lib/market";
import { quoteEthToUsdc } from "./lib/quote";
import { sendSepoliaEth } from "./lib/send";
import { anonRequest, mixnetNote, currentNetName, chooseDirect, chooseNet, boot, netLabel, type Net } from "./lib/rpc";
import { hosts, revoke } from "./lib/sites";
import { clearDraft, readDraft, writeDraft } from "./lib/draft";
import { hasVault, lock, open, openKey, seal, sessionMnemonic } from "./lib/vault";
import { keysFromSecret, metaAddress, parseMeta, REGISTRY, REGISTRY_ABI, auditGrant, auditView } from "./lib/stealth";
import { scan, scanWith, scanScoped } from "./lib/payments";
import { ANNOUNCER } from "./lib/stealth";
import { sendPrivate, sweep, sendCall } from "./lib/private";
import { authoriseToken, submit3009, USDC } from "./lib/token3009";
import { makeGrant, recordGrant, grants, revokeGrant, scopedRecogniser, check, type Grant } from "./lib/grants";
import { inspect } from "./lib/guard";
import type { Found } from "./lib/payments";

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

async function keys() {
  const secret = await sessionMnemonic();
  if (!secret) throw new Error("Locked.");
  return keysFromSecret(secret);
}

// The event signature our scanner filters on, needed when we ask specifically
// "did this address announce a payment to us?".
const TOPIC = keccak256(toHex("Announcement(uint256,address,address,bytes,bytes)"));

async function balanceOf(address: string, net: NetName, key: string) {
  const hex = (await anonRequest("eth_getBalance", [address, "latest"], netInfo(net).rpc, key)) as string;
  return formatEther(BigInt(hex));
}

// Does `to` appear as the announcement caller for this payment? If so they paid
// us, and sweeping back to them closes the loop.
async function payerSeenInLogs(net: NetName, to: string, found: Found): Promise<boolean> {
  try {
    const rows = (await anonRequest(
      "eth_getLogs",
      [
        {
          address: ANNOUNCER,
          topics: [TOPIC, null, found.address, `0x${to.slice(2).padStart(64, "0")}`],
          fromBlock: toHex(found.block),
          toBlock: toHex(found.block),
        },
      ],
      netInfo(net).rpc,
      "scan",
    )) as unknown[];
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

async function blockTime(net: NetName, block: bigint): Promise<number> {
  try {
    const blk = (await anonRequest("eth_getBlockByNumber", [toHex(block), false], netInfo(net).rpc, "scan")) as {
      timestamp?: string;
    };
    return blk?.timestamp ? Number(BigInt(blk.timestamp)) : 0;
  } catch {
    return 0;
  }
}

// Builds the context the guard needs. The two hard refusals (H1, H2) are decided
// from chain data, not from what the user typed.
async function guardSweep(net: NetName, found: Found, to: string, rows: Found[]) {
  const account = await sessionAccount();
  const vault = (account?.address ?? "").toLowerCase();
  const destinationIsOwnVault = Boolean(vault) && to.toLowerCase() === vault;
  const destinationPaidUs = await payerSeenInLogs(net, to, found);
  const eth = await balanceOf(found.address, net, "scan").catch(() => "0");
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - (await blockTime(net, found.block)));
  return inspect(
    { to: to as `0x${string}`, payment: found, others: rows, destinationIsOwnVault, destinationPaidUs },
    eth,
    seconds,
  );
}

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
    meta?: string;
    address?: string;
    full?: boolean;
    quick?: boolean;
    viewing?: string;
    spendingPub?: string;
    raw?: string;
    purpose?: string;
    windowFrom?: number;
    windowTo?: number;
    hash?: string;
    name?: string;
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
    "mode",
    "boot-mixnet",
    "set-net",
    "pending",
    "prompt",
    "allow",
    "deny",
    "balance",
    "ens",
    "ens-lookup",
    "ens-publish",
    "market",
    "quote",
    "send",
    "activity",
    "receive",
    "scan",
    "register",
    "lookup",
    "audit-key",
    "audit-scan",
    "grant",
    "grants",
    "revoke-grant",
    "pay",
    "sweep",
    "sweep-check",
    "token-balance",
    "sweep-token",
  ]);
  if (panelOnly.has(msg.type ?? "") && !fromPanel) throw new Error("That request has to come from the wallet.");

  if (msg.type === "status") {
    const account = await sessionAccount();
    return {
      hasVault: await hasVault(),
      unlocked: Boolean(account),
      address: account?.address,
      mode: currentNetName(),
      label: netLabel(),
      note: mixnetNote(),
    };
  }

  // Lets the user switch transport by hand when the mixnet is misbehaving.
  if (msg.type === "mode") {
    const want = (msg.net ?? "direct") as Net;
    try {
      await chooseNet(want);
    } catch (err) {
      return { mode: currentNetName(), label: netLabel(), note: err instanceof Error ? err.message : "failed" };
    }
    return { mode: currentNetName(), label: netLabel(), note: mixnetNote() };
  }

  if (msg.type === "boot-mixnet") {
    try {
      await boot();
      return { mode: currentNetName(), label: netLabel(), note: mixnetNote() };
    } catch (err) {
      return { mode: currentNetName(), label: netLabel(), note: err instanceof Error ? err.message : "failed" };
    }
  }

  if (msg.type === "social") {
    const key = (msg.key ?? "").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("Web3Auth didn't return a key.");
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
    await publish([mnemonicToAccount(mnemonic).address]);
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
  if (msg.type === "allow") return allowPrompt(msg.id ?? "");
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
    const hex = (await anonRequest("eth_getBalance", [account.address, "latest"], netInfo(await currentNet()).rpc, "vault")) as string;
    return { eth: formatEther(BigInt(hex)), note: mixnetNote() };
  }

  if (msg.type === "ens") {
    const account = await sessionAccount();
    if (!account) throw new Error("Locked.");
    return { name: (await ensName(account.address)) ?? "" };
  }

  // Resolve an ENS name to the meta-address it publishes, so a payer can type
  // "alice.eth" instead of pasting 141 characters.
  if (msg.type === "ens-lookup") {
    // The send path only needs the record, so it asks for one call fewer.
    const info = await lookup(msg.name ?? "", Boolean(msg.quick));
    return { ...info, note: mixnetNote() };
  }

  // The ENSv2 registry that owns .eth, read from the root at call time.
  if (msg.type === "ens-registry") {
    return { registry: await ENS.ethRegistry, resolver: ENS.resolverV2, note: mixnetNote() };
  }

  // Point a name at a resolver. Usually unnecessary: the ENS app already deploys
  // a per-account resolver proxy at registration. Exposed so a name that points
  // nowhere can be fixed.
  if (msg.type === "ens-set-resolver") {
    const secret = await sessionMnemonic();
    if (!secret) throw new Error("Locked.");
    const name = msg.name ?? "";
    const label = name.trim().toLowerCase().split(".")[0];
    const target = msg.address?.trim() || (await nameResolver(label));
    if (!target || target === "0x0000000000000000000000000000000000000000") {
      throw new Error("That name has no resolver to keep. Pass one explicitly.");
    }
    const call = buildSetResolver(name, target);
    const net = await currentNet();
    const hash = await sendCall(secret, call, net);
    return { hash, resolver: target, net: netInfo(net).name, note: mixnetNote() };
  }

  // Publish this wallet's meta-address to a name the user controls. One text
  // record, on whatever resolver that name already uses.
  if (msg.type === "ens-publish") {
    const secret = await sessionMnemonic();
    if (!secret) throw new Error("Locked.");
    const meta = metaAddress(keysFromSecret(secret));
    const call = await buildSetMeta(msg.name ?? "", meta);
    const net = await currentNet();
    const hash = await sendCall(secret, call, net);
    return { hash, name: (msg.name ?? "").trim().toLowerCase(), meta, net: netInfo(net).name, note: mixnetNote() };
  }

  if (msg.type === "market") {
    if (!(await sessionAccount())) throw new Error("Locked.");
    return uniswapCards();
  }

  if (msg.type === "quote") {
    if (!(await sessionAccount())) throw new Error("Locked.");
    return { usdc: await quoteEthToUsdc(msg.amount || "0.01"), note: mixnetNote() };
  }

  if (msg.type === "send") {
    const secret = await sessionMnemonic();
    if (!secret) throw new Error("Locked.");
    if ((await currentNet()) !== "sepolia") throw new Error("Switch to Sepolia before sending.");
    const hash = await sendSepoliaEth(secret, msg.to ?? "", parseEther((msg.amount || "").trim()), "vault");
    return { hash, note: mixnetNote() };
  }

  if (msg.type === "activity") {
    const account = await sessionAccount();
    if (!account) throw new Error("Locked.");
    return { rows: await recentTxs(account.address, await currentNet(), "vault") };
  }

  // Your meta-address. Public keys only, so it can be posted anywhere.
  if (msg.type === "receive") {
    const k = await keys();
    return { meta: metaAddress(k), note: mixnetNote() };
  }

  if (msg.type === "scan") {
    const k = await keys();
    const net = await currentNet();
    const rows = await scan(k, net, Boolean(msg.full));
    return {
      rows: rows.map((r) => ({
        address: r.address,
        txHash: r.txHash,
        block: r.block.toString(),
        eth: r.eth,
        spent: r.spent,
        ephemeralPubKey: r.ephemeralPubKey,
        viewTag: r.viewTag,
      })),
      note: mixnetNote(),
    };
  }

  // Pay someone at their meta-address. The value and the announcement both go out
  // through the mixnet, so no node has both the payment and this IP.
  if (msg.type === "pay") {
    const secret = await sessionMnemonic();
    if (!secret) throw new Error("Locked.");
    const meta = (msg.meta ?? "").trim();
    parseMeta(meta);
    const value = parseEther((msg.amount || "").trim() || "0");
    const net = await currentNet();
    const res = await sendPrivate(secret, meta, value, "vault", net);
    return { ...res, net: netInfo(net).name, note: mixnetNote() };
  }

  // Token balance of a stealth address, so the UI can offer a token sweep.
  if (msg.type === "token-balance") {
    const net = await currentNet();
    const address = (msg.address ?? "") as `0x${string}`;
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Bad address.");
    const data = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "balanceOf",
          stateMutability: "view",
          inputs: [{ name: "account", type: "address" }],
          outputs: [{ name: "", type: "uint256" }],
        },
      ] as const,
      functionName: "balanceOf",
      args: [address],
    });
    const ret = (await anonRequest("eth_call", [{ to: USDC[net], data }, "latest"], netInfo(net).rpc, "scan")) as Hex;
    return { raw: BigInt(ret || "0x0").toString(), usdc: Number(BigInt(ret || "0x0")) / 1e6 };
  }

  // Sweep USDC out of a stealth address without it ever holding gas. The stealth
  // key signs an EIP-3009 authorisation offline; this wallet submits it and pays
  // the fee. No ETH is sent to the stealth address, so no funding edge is created.
  if (msg.type === "sweep-token") {
    const secret = await sessionMnemonic();
    if (!secret) throw new Error("Locked.");
    const k = await keys();
    const net = await currentNet();
    const address = msg.address ?? "";
    const rows = await scan(k, net);
    const found = rows.find((r) => r.address.toLowerCase() === address.toLowerCase());
    if (!found) throw new Error("That payment is not in this wallet.");
    const to = (msg.to ?? "") as `0x${string}`;
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("Sweep to a valid address.");

    // The guard runs before signing, not after.
    const verdict = await guardSweep(net, found, to, rows);
    const stops = verdict.filter((l) => l.severity === "block");
    if (stops.length) throw new Error(stops.map((l) => `${l.rule}: ${l.why} ${l.instead}`).join(" "));

    const value = BigInt(msg.raw ?? "0");
    if (value <= 0n) throw new Error("Nothing to sweep.");
    const auth = await authoriseToken(k, found, to, value, net);
    const hash = await submit3009(secret, auth, net);
    return { hash, net: netInfo(net).name, note: mixnetNote() };
  }

  // What the guard would say, without sending anything. The UI shows this before
  // the user commits, so a refusal is never a surprise.
  if (msg.type === "sweep-check") {
    const k = await keys();
    const net = await currentNet();
    const rows = await scan(k, net);
    const found = rows.find((r) => r.address.toLowerCase() === (msg.address ?? "").toLowerCase());
    if (!found) throw new Error("That payment is not in this wallet.");
    const leaks = await guardSweep(net, found, (msg.to ?? "") as `0x${string}`, rows);
    return {
      leaks: leaks.map((l) => ({ rule: l.rule, severity: l.severity, why: l.why, instead: l.instead })),
      // ok means nothing will stop the signature. Warnings are surfaced but do not
      // block, which is the difference between advice and a refusal.
      ok: leaks.filter((l) => l.severity === "block").length === 0,
      blocked: leaks.filter((l) => l.severity === "block").length,
    };
  }

  if (msg.type === "sweep") {
    const k = await keys();
    const net = await currentNet();
    const address = msg.address ?? "";
    const rows = await scan(k, net);
    const found = rows.find((r) => r.address.toLowerCase() === address.toLowerCase());
    if (!found) throw new Error("That payment is not in this wallet.");
    const to = (msg.to ?? "") as `0x${string}`;
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("Sweep to a valid address.");

    // The guard runs on the signing path itself, not only in the UI. A caller that
    // skips the pre-check still cannot publish a link.
    const verdict = await guardSweep(net, found, to, rows);
    const stops = verdict.filter((l) => l.severity === "block");
    if (stops.length) {
      throw new Error(stops.map((l) => `${l.rule}: ${l.why} ${l.instead}`).join(" "));
    }

    const hash = await sweep(k, found, to, net);
    return { hash, net: netInfo(net).name, note: mixnetNote(), warnings: verdict.map((l) => l.rule) };
  }

  // Registration in the ERC-6538 registry. An address registers the meta-address
  // it wants to be paid at; payers look it up instead of being told out of band.
  if (msg.type === "register") {
    const secret = await sessionMnemonic();
    if (!secret) throw new Error("Locked.");
    const k = keysFromSecret(secret);
    const meta = metaAddress(k);
    const data = encodeFunctionData({
      abi: REGISTRY_ABI,
      functionName: "registerKeys",
      // The registry stores the meta-address without the "st:eth:" prefix.
      args: [1n, `0x${parseMeta(meta).spending.length ? meta.replace(/^st:eth:0x/, "0x") : ""}` as `0x${string}`],
    });
    const net = await currentNet();
    const hash = await sendCall(secret, { to: REGISTRY as `0x${string}`, data }, net);
    return { hash, meta, net: netInfo(net).name, note: mixnetNote() };
  }

  // Look someone up in the registry instead of asking them for their meta-address.
  if (msg.type === "lookup") {
    const who = (msg.address ?? "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(who)) throw new Error("That is not an address.");
    const net = await currentNet();
    const data = encodeFunctionData({
      abi: REGISTRY_ABI,
      functionName: "stealthMetaAddressOf",
      args: [who as `0x${string}`, 1n],
    });
    const ret = (await anonRequest("eth_call", [{ to: REGISTRY, data }, "latest"], netInfo(net).rpc, "lookup")) as Hex;
    if (!ret || ret === "0x") throw new Error("That address has not registered a meta-address.");
    return { meta: `st:eth:${ret}`, note: mixnetNote() };
  }

  // Selective disclosure: what you hand an auditor. Viewing scalar plus the
  // spending public key. Identifies every payment, cannot move any of them.
  if (msg.type === "audit-key") {
    const k = await keys();
    const grant = auditGrant(k);
    return { ...grant, note: mixnetNote() };
  }

  // A scoped grant: named grantee, stated purpose, bounded window, logged hash.
  if (msg.type === "grant") {
    const k = await keys();
    const g = makeGrant(k, msg.meta ?? "", msg.purpose ?? "", Number(msg.windowFrom ?? 0), Number(msg.windowTo ?? 0));
    const record = await recordGrant(g);
    return { grant: record, hash: record.hash, note: mixnetNote() };
  }

  if (msg.type === "grants") {
    return { rows: await grants() };
  }

  if (msg.type === "revoke-grant") {
    await revokeGrant(msg.hash ?? "");
    return { rows: await grants() };
  }

  // The auditor's side: paste a grant, see only what it permits. Anything outside
  // the window is never recognised, so it cannot appear here at all.
  if (msg.type === "audit-scan") {
    const g: Grant = {
      grantee: msg.meta ?? "",
      purpose: "",
      from: Number(msg.windowFrom ?? 0),
      to: Number(msg.windowTo ?? 0),
      viewing: (msg.viewing ?? "") as Hex,
      spendingPub: (msg.spendingPub ?? "") as Hex,
      issuedAt: 0,
    };
    if (!/^0x[0-9a-fA-F]{64}$/.test(g.viewing)) throw new Error("That viewing key looks wrong.");
    if (!/^0x[0-9a-fA-F]{66}$/.test(g.spendingPub)) throw new Error("That spending public key looks wrong.");
    const verdict = check(g, g.from);
    const net = await currentNet();
    const rows = await scanScoped((eph, tag, when) => scopedRecogniser(g, when)(eph, tag), net, { from: g.from, to: g.to });
    return {
      rows: rows.map((r) => ({ address: r.address, eth: r.eth, block: r.block.toString() })),
      allowed: verdict.allowed,
      note: mixnetNote(),
    };
  }

  throw new Error("unknown message");
}
