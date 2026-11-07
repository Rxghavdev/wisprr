import { AnonRpcWorker } from "@anon-rpc/browser-extension-harness";

// Every network call goes through here.
//
// anon-rpc does not have one network, it has several. Each is a hash-pinned
// worker behind an on-chain specifier, so switching transport is a different
// specifier address and nothing else. All four below were read from the adopters
// page and verified on chain.
//
//   nox    Sphinx mixnet, Sepolia-native, 1.8 MB. Fastest to boot.
//   tor    Full Tor client in WebAssembly. 6.9 MB, needs a gateway.
//   nym    Nym mixnet. 18 MB, several seconds to bootstrap.
//   direct plain fetch. No anonymity at all, but always works.
//
// The wallet tries them in order of speed, and reports which one is live. It never
// claims anonymity it is not delivering.

export type Net = "nox" | "tor" | "nym" | "direct";

type Spec = {
  address: `0x${string}`;
  label: string;
  config?: { gateways?: string[] };
  budget: number;
};

const SPECS: Record<Exclude<Net, "direct">, Spec> = {
  // Nox: deployed on Sepolia only, which is the chain this wallet demos on.
  nox: {
    address: "0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A",
    label: "Nox mixnet",
    budget: 12_000,
  },
  // tor-js: a demonstration gateway, so it may disappear. The docs say to run your
  // own for anything real, which is why it is not the default.
  tor: {
    address: "0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e",
    label: "Tor",
    config: { gateways: ["152.236.3.22:12298:uEiCH0VdbhryzJcMtCfB0vLA4sOvHdQ4hq5w7CopcwU59bQ"] },
    budget: 15_000,
  },
  // Nym: the largest bundle and the slowest boot. Verified live on mainnet.
  nym: {
    address: "0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0",
    label: "Nym mixnet",
    budget: 20_000,
  },
};

const ORDER: Exclude<Net, "direct">[] = ["nox", "tor", "nym"];

const BOOTSTRAP = "https://ethereum-rpc.publicnode.com";
const MAINNET = "https://ethereum-rpc.publicnode.com";

let worker: AnonRpcWorker | undefined;
let booting: Promise<void> | undefined;
let net: Net = "nox";
let note = "starting";
let n = 1;

const REQUEST_TIMEOUT = 12_000;

export function mixnetNote(): string {
  return note;
}

export function currentNetName(): Net {
  return net;
}

export function netLabel(name: Net = net): string {
  return name === "direct" ? "direct" : SPECS[name].label;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms),
    ),
  ]);
}

async function plainPost(url: string, method: string, params: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message || "rpc error");
  return body.result;
}

function opts(isolationKey?: string) {
  return isolationKey ? { isolationKey } : undefined;
}

function teardown() {
  try {
    worker?.close();
  } catch {
    /* already gone */
  }
  worker = undefined;
  booting = undefined;
}

// Boots one network. Rejects if it cannot serve within its budget.
async function bootOne(name: Exclude<Net, "direct">): Promise<void> {
  const spec = SPECS[name];
  const started = Date.now();
  note = `starting ${spec.label}…`;

  const w = new AnonRpcWorker({
    address: spec.address,
    config: spec.config as { gateways?: string[] } | undefined,
    preExisting: {
      rpcProvider: { request: ({ method, params }) => plainPost(BOOTSTRAP, method, params ?? []) },
    },
  });

  try {
    await withTimeout(w.ready, spec.budget, spec.label);
  } catch (err) {
    try {
      w.close();
    } catch {
      /* ignore */
    }
    throw err;
  }

  worker = w;
  net = name;
  note = `${spec.label} · ready in ${Math.round((Date.now() - started) / 1000)}s`;
}

// Boots the first network that works, in speed order. Starting from a preferred
// one, so a manual choice is respected before the fallback chain runs.
export function boot(preferred?: Exclude<Net, "direct">): Promise<void> {
  if (worker && (!preferred || net === preferred)) return Promise.resolve();
  if (booting) return booting;

  const order = preferred ? [preferred, ...ORDER.filter((x) => x !== preferred)] : ORDER;
  booting = (async () => {
    const failures: string[] = [];
    for (const name of order) {
      try {
        await bootOne(name);
        return;
      } catch (err) {
        failures.push(`${SPECS[name].label}: ${err instanceof Error ? err.message : "failed"}`);
        teardown();
      }
    }
    // Everything failed. Direct still works, and the user is told plainly.
    net = "direct";
    note = `no anonymising network came up. Using a direct connection, so the node sees your IP.`;
    throw new Error(failures.join(" · "));
  })();
  return booting.finally(() => {
    booting = undefined;
  });
}

// Kept for the old call sites.
export function bootMixnet(): Promise<void> {
  if (net === "direct") return Promise.resolve();
  return boot();
}

export function chooseDirect(reason: string): void {
  teardown();
  net = "direct";
  note = `direct connection (${reason}). The node sees your IP.`;
}

export function chooseNet(name: Net): Promise<void> {
  if (name === "direct") {
    chooseDirect("you chose it");
    return Promise.resolve();
  }
  teardown();
  return boot(name);
}

async function viaNet<T>(run: (w: AnonRpcWorker) => Promise<T>): Promise<T> {
  if (currentNetName() === "direct") throw new Error("direct mode");
  if (!worker) await boot();
  const w = worker;
  if (currentNetName() === "direct" || !w) throw new Error("direct mode");
  return withTimeout(run(w), REQUEST_TIMEOUT, "request");
}

export async function anonGet(url: string, key?: string): Promise<unknown> {
  try {
    return await viaNet(async (w) => {
      const res = await w.fetch(url, { anonOptions: opts(key) });
      if (!res.ok) throw new Error("That lookup didn't load.");
      return res.json();
    });
  } catch (err) {
    if (!isTransport(err)) throw err;
    degrade("the network dropped a request");
    const res = await fetch(url);
    if (!res.ok) throw new Error("That lookup didn't load.");
    return res.json();
  }
}

export async function anonPost(url: string, body: unknown, key?: string): Promise<unknown> {
  try {
    return await viaNet(async (w) => {
      const res = await w.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "connect-protocol-version": "1" },
        body: JSON.stringify(body),
        anonOptions: opts(key),
      });
      if (!res.ok) throw new Error("That service didn't answer.");
      return res.json();
    });
  } catch (err) {
    if (!isTransport(err)) throw err;
    degrade("the network dropped a request");
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "connect-protocol-version": "1" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("That service didn't answer.");
    return res.json();
  }
}

export async function anonRequest(
  method: string,
  params: unknown[],
  url = MAINNET,
  key?: string,
): Promise<unknown> {
  if (net === "direct") return plainPost(url, method, params);
  const payload = { jsonrpc: "2.0", id: n++, method, params };

  try {
    return await viaNet(async (w) => {
      const res = await w.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        anonOptions: opts(key),
      });
      const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (body.error) throw new Error(body.error.message || "rpc error");
      return body.result;
    });
  } catch (err) {
    // A JSON-RPC error is a real answer; only a broken tunnel is retried.
    if (!isTransport(err)) throw err;

    // Do NOT boot the other networks here. Each boot can take 40-60 seconds, and
    // trying them all inside one request made a simple ENS lookup appear to hang.
    // The boot path (chooseNet) already cascades; a request just drops to direct.
    degrade("the network dropped a request");
    return plainPost(url, method, params);
  }
}

function degrade(reason: string) {
  chooseDirect(reason);
}

// Distinguishes "the tunnel broke" from "the node said no". Only the first should
// fall back, or a legitimate revert would be retried in the clear.
function isTransport(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return (
    /direct mode|timed out|timeout|closing|closed|websocket|network|failed to fetch|tunnel (down|broken|failed|dropped|not)|not ready|was closed|connection|could not|unavailable|signal/i.test(
      m,
    ) && !/reverted|insufficient|nonce|pruned|block range|invalid/i.test(m)
  );
}
