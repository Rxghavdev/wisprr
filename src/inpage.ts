declare global {
  interface Window {
    ethereum?: {
      isWisprr?: boolean;
      providers?: unknown[];
      request?: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }
}

// EIP-6963. Another wallet can keep window.ethereum. Sites that ask still find wisprr.
const ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none"><rect x="1.25" y="1.25" width="29.5" height="29.5" rx="8" stroke="#f4f4f4" stroke-width="1.5"/><path d="M9 11.5h12" stroke="#f4f4f4" stroke-width="2.2" stroke-linecap="round"/><path d="M9 16h8" stroke="#f4f4f4" stroke-width="2.2" stroke-linecap="round" opacity=".62"/><path d="M9 20.5h5" stroke="#f4f4f4" stroke-width="2.2" stroke-linecap="round" opacity=".32"/></svg>',
  );

type Handler = (...args: unknown[]) => void;

const listeners = new Map<string, Set<Handler>>();
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let seq = 1;

function emit(event: string, arg: unknown) {
  for (const fn of listeners.get(event) ?? []) fn(arg);
}

function call(method: string, params?: unknown[]) {
  const id = seq++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    window.postMessage({ ch: "wisprr", id, method, params: params ?? [] }, "*");
  });
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data) return;
  if (data.ch === "wisprr-reply") {
    const wait = pending.get(data.id);
    if (!wait) return;
    pending.delete(data.id);
    if (data.error) {
      const err = new Error(data.error.message || "Request failed.") as Error & { code?: number };
      err.code = data.error.code ?? -32603;
      wait.reject(err);
      return;
    }
    wait.resolve(data.result);
    return;
  }
  if (data.ch === "wisprr-event" && data.event === "accountsChanged" && Array.isArray(data.data)) {
    provider.selectedAddress = data.data[0] ?? null;
    emit("accountsChanged", data.data);
  }
});

const provider = {
  isWisprr: true,
  providers: [] as unknown[],
  chainId: "0x1",
  selectedAddress: null as string | null,
  request(args: { method: string; params?: unknown[] }) {
    return call(args.method, args.params).then((result) => {
      if (args.method === "eth_requestAccounts" || args.method === "eth_accounts") {
        const accounts = Array.isArray(result) ? (result as string[]) : [];
        provider.selectedAddress = accounts[0] ?? null;
        emit("accountsChanged", accounts);
      }
      if (args.method === "eth_chainId" && typeof result === "string") {
        provider.chainId = result;
        emit("chainChanged", result);
      }
      return result;
    });
  },
  enable() {
    return provider.request({ method: "eth_requestAccounts" });
  },
  send(methodOrPayload: string | { method: string; params?: unknown[]; id?: number }, paramsOrCb?: unknown) {
    if (typeof methodOrPayload === "string") {
      return provider.request({ method: methodOrPayload, params: paramsOrCb as unknown[] });
    }
    const done = typeof paramsOrCb === "function" ? (paramsOrCb as (err: Error | null, res: unknown) => void) : undefined;
    const pendingCall = provider.request({ method: methodOrPayload.method, params: methodOrPayload.params });
    if (!done) return pendingCall;
    pendingCall.then(
      (result) => done(null, { id: methodOrPayload.id, jsonrpc: "2.0", result }),
      (err) => done(err as Error, null),
    );
  },
  on(event: string, fn: Handler) {
    const set = listeners.get(event) ?? new Set();
    set.add(fn);
    listeners.set(event, set);
    return provider;
  },
  removeListener(event: string, fn: Handler) {
    listeners.get(event)?.delete(fn);
    return provider;
  },
};

const info = Object.freeze({
  uuid: "4f6a9c2e-8b17-4d55-a0e3-91c7d2b6e448",
  name: "wisprr",
  icon: ICON,
  rdns: "com.github.rxghavdev.wisprr",
});

function announce() {
  window.dispatchEvent(
    new CustomEvent("eip6963:announceProvider", {
      detail: Object.freeze({ info, provider }),
    }),
  );
}

window.addEventListener("eip6963:requestProvider", announce);
announce();

function claim() {
  const other = window.ethereum as { isWisprr?: boolean; providers?: unknown[] } | undefined;
  if (other && other !== provider && !other.isWisprr) {
    const prev = Array.isArray(other.providers) ? other.providers : [other];
    provider.providers = [provider, ...prev.filter((item) => item !== provider)];
  }
  try {
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      enumerable: true,
      get: () => provider,
      set: (next) => {
        if (!next || next === provider) return;
        const prev = provider.providers.filter((item) => item !== next);
        provider.providers = [provider, next, ...prev];
      },
    });
  } catch {
    window.ethereum = provider;
  }
}

claim();

window.setTimeout(() => {
  provider.request({ method: "eth_accounts" }).catch(() => {});
}, 50);

export {};
