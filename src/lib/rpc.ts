import { AnonRpcWorker } from "@anon-rpc/browser-extension-harness";

// Nym worker, published on Ethereum mainnet.
// https://ethereum.github.io/anon-rpc/adopters/
const NYM = "0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0";
const BOOTSTRAP = "https://ethereum-rpc.publicnode.com";
const MAINNET = "https://ethereum-rpc.publicnode.com";

let worker: AnonRpcWorker | undefined;
let pending: Promise<void> | undefined;
let note = "mixnet idle";
let n = 1;

async function post(url: string, method: string, params: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message || "rpc error");
  return body.result;
}

export function mixnetNote(): string {
  return note;
}

// The specifier read uses BOOTSTRAP in the open. The harness docs say that one call is not anonymous.
export function bootMixnet(): Promise<void> {
  if (worker) return Promise.resolve();
  if (pending) return pending;
  const started = Date.now();
  note = "mixnet starting";
  pending = (async () => {
    const w = new AnonRpcWorker({
      address: NYM,
      preExisting: {
        rpcProvider: {
          request: ({ method, params }) => post(BOOTSTRAP, method, params ?? []),
        },
      },
    });
    try {
      await w.ready;
    } catch (err) {
      w.close();
      pending = undefined;
      note = "mixnet failed";
      throw err;
    }
    worker = w;
    note = `through the mixnet, ${Math.round((Date.now() - started) / 1000)}s`;
  })();
  return pending;
}

export async function anonGet(url: string): Promise<unknown> {
  await bootMixnet();
  const res = await worker!.fetch(url);
  if (!res.ok) throw new Error("History didn't load.");
  return res.json();
}

export async function anonPost(url: string, body: unknown): Promise<unknown> {
  await bootMixnet();
  const res = await worker!.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "connect-protocol-version": "1" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Uniswap didn't answer.");
  return res.json();
}

export async function anonRequest(method: string, params: unknown[], url = MAINNET): Promise<unknown> {
  await bootMixnet();
  const res = await worker!.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: n++, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message || "rpc error");
  return body.result;
}
