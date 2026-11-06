import { renderSVG } from "uqr";

const $ = (id: string) => document.getElementById(id) as HTMLElement;

const TAG = "the node sees the question, not you.";

function typeInto(el: HTMLElement, text: string) {
  const token = {};
  (el as HTMLElement & { _type?: object })._type = token;
  el.replaceChildren();
  const caret = document.createElement("i");
  caret.className = "caret";
  el.append(caret);
  let i = 0;
  const step = () => {
    if ((el as HTMLElement & { _type?: object })._type !== token) return;
    if (i >= text.length) return;
    caret.before(text[i]);
    i += 1;
    window.setTimeout(step, text[i - 1] === "," || text[i - 1] === "." ? 160 : 34);
  };
  window.setTimeout(step, 60);
}

function show(name: string) {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-screen]"))) {
    const on = el.dataset.screen === name;
    el.hidden = !on;
    if (!on) continue;
    el.classList.remove("show");
    void el.offsetWidth;
    el.classList.add("show");
    const head = el.querySelector("[data-type]") as HTMLElement | null;
    if (head?.id === "net") {
      head.textContent = head.dataset.type || "";
    } else if (head?.dataset.type) {
      typeInto(head, head.dataset.type);
    }
  }
  $("err").hidden = true;
}

function fail(err: unknown) {
  const node = $("err");
  node.hidden = false;
  node.textContent = err instanceof Error ? err.message : "Something broke.";
}

async function ask(msg: Record<string, unknown>) {
  const res = await chrome.runtime.sendMessage(msg);
  if (res?.error) throw new Error(res.error);
  return res;
}

function paintWords(mnemonic: string) {
  const list = $("words");
  list.replaceChildren();
  mnemonic.split(" ").forEach((word, i) => {
    const li = document.createElement("li");
    const n = document.createElement("span");
    n.textContent = String(i + 1);
    li.append(n, document.createTextNode(word));
    li.style.animationDelay = `${i * 40}ms`;
    list.append(li);
  });
  const note = $("copy-words-note");
  note.textContent = "";
}

$("copy-words").addEventListener("click", async () => {
  const words = Array.from(document.querySelectorAll("#words li"))
    .map((li) => li.textContent?.replace(/^\d+/, "").trim() ?? "")
    .filter(Boolean)
    .join(" ");
  const note = $("copy-words-note");
  if (!words) return;
  try {
    await navigator.clipboard.writeText(words);
    note.textContent = "Copied. The clipboard is shared with every app on this machine. Move it somewhere safe and clear it.";
  } catch {
    note.textContent = "The browser blocked the clipboard. Select the words above and copy them by hand.";
  }
});

function trimEth(eth: string) {
  const [whole, frac = ""] = eth.split(".");
  return frac ? `${whole}.${frac.slice(0, 5)}` : whole;
}

async function paintHome(address: string) {
  $("addr").textContent = address;
  $("bal").textContent = "reading…";
  $("ens").textContent = "reading the name through the mixnet…";
  const net = await ask({ type: "net" });
  $("net").textContent = `${net.name}.`;
  ($("use-mainnet") as HTMLButtonElement).classList.toggle("on", net.name === "Mainnet");
  ($("use-sepolia") as HTMLButtonElement).classList.toggle("on", net.name === "Sepolia");
  ($("send") as HTMLButtonElement).disabled = net.name !== "Sepolia";
  $("note").textContent = "first call waits while the mixnet comes up.";
  paintSites().catch(() => {});
  show("home");
  try {
    const res = await ask({ type: "balance" });
    $("bal").textContent = `${trimEth(res.eth)} ETH`;
    $("note").textContent = res.note;
  } catch (err) {
    $("bal").textContent = "—";
    fail(err);
  }
  try {
    const named = await ask({ type: "ens" });
    $("ens").textContent = named.name
      ? `${named.name} · mainnet, through the mixnet`
      : "no ENS name on this address · looked up through the mixnet";
  } catch {
    $("ens").textContent = "";
  }
  paintMarket().catch(fail);
  paintActivity().catch(() => {
    $("txs").replaceChildren();
    const li = document.createElement("li");
    li.className = "tx";
    li.textContent = "Activity didn't load.";
    $("txs").append(li);
  });
}

function shortHash(hash: string) {
  return hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;
}

async function paintActivity() {
  const list = $("txs");
  list.replaceChildren();
  const res = await ask({ type: "activity" });
  const rows = (res.rows ?? []) as { hash: string; way: string; eth: string; status: string; note: string; when: string }[];
  if (!rows.length) {
    const li = document.createElement("li");
    li.className = "tx";
    li.textContent = "No transfers yet.";
    list.append(li);
    return;
  }
  for (const row of rows) {
    const li = document.createElement("li");
    li.className = "tx";
    const body = document.createElement("div");
    const k = document.createElement("p");
    k.className = "k";
    k.textContent = `${row.way} · ${row.status}${row.when ? ` · ${row.when}` : ""}`;
    const v = document.createElement("p");
    v.textContent = `${row.eth} ETH`;
    const hash = document.createElement("p");
    hash.className = "hash";
    hash.textContent = shortHash(row.hash);
    body.append(k, v, hash);
    if (row.note) {
      const note = document.createElement("p");
      note.className = "note";
      note.textContent = row.note;
      body.append(note);
    }
    const copy = document.createElement("button");
    copy.className = "slim";
    copy.type = "button";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => navigator.clipboard.writeText(row.hash).catch(fail));
    li.append(body, copy);
    list.append(li);
  }
}

async function paintMarket() {
  for (const id of ["stat-eth", "stat-day", "stat-vol", "stat-tvl"]) $(id).textContent = "…";
  try {
    const res = await ask({ type: "market" });
    $("stat-eth").textContent = res.eth;
    $("stat-day").textContent = res.day;
    $("stat-vol").textContent = res.volume;
    $("stat-tvl").textContent = res.tvl;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Uniswap didn't answer.";
    $("stat-eth").textContent = "—";
    $("stat-day").textContent = "—";
    $("stat-vol").textContent = "—";
    $("stat-tvl").textContent = "—";
    fail(new Error(message));
  }
}

async function paintSites() {
  const res = await ask({ type: "sites" });
  const list = $("sites");
  const rows = (res.hosts as { host: string; origin: string }[]) ?? [];
  list.replaceChildren();
  if (!rows.length) {
    list.hidden = true;
    return;
  }
  list.hidden = false;
  for (const row of rows) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = row.host;
    const out = document.createElement("button");
    out.className = "text";
    out.type = "button";
    out.textContent = "Disconnect";
    out.addEventListener("click", async () => {
      await ask({ type: "revoke", origin: row.origin });
      await paintSites();
    });
    li.append(name, out);
    list.append(li);
  }
}

const port = chrome.runtime.connect({ name: "wisprr" });
let promptId = "";

// Chrome stops an idle service worker after about thirty seconds, which would throw away
// the site request waiting behind this panel. A ping every twenty seconds keeps it awake
// while the panel is actually on screen.
setInterval(() => {
  if (!promptId) return;
  try {
    port.postMessage({ type: "ping" });
  } catch {
    /* the panel is going away */
  }
}, 20_000);

type Receipt = {
  net: string;
  worth: string;
  eth: string;
  txs: string;
  transfers: string;
  known: string;
};

async function showPrompt(info: {
  id: string;
  host: string;
  hasVault: boolean;
  unlocked: boolean;
  known: boolean;
  address?: string;
}) {
  promptId = info.id;
  const host = $("host");
  host.hidden = false;
  host.textContent = info.host;
  $("ask-host").textContent = `${info.host} would get ${info.address || "your address"}.`;
  port.postMessage({ type: "watch", id: info.id });
  if (!info.hasVault) return show("create");
  if (!info.unlocked) return show("unlock");
  show("ask");
  void paintReceipt();
}

async function paintReceipt() {
  const box = $("receipt");
  box.hidden = true;
  let got: Receipt | undefined;
  try {
    got = (await ask({ type: "receipt" })) as Receipt;
  } catch {
    return;
  }
  if (!got || !promptId) return;
  $("rc-worth").textContent = got.worth;
  $("rc-eth").textContent = got.eth;
  $("rc-txs").textContent = got.txs;
  $("rc-xfers").textContent = got.transfers;
  $("rc-known").textContent = got.known;
  $("rc-net").textContent = got.net;
  box.hidden = false;
}

async function afterAccount(address: string) {
  const pending = await ask({ type: "pending" });
  if (pending.id) {
    if (pending.known && pending.unlocked) {
      await ask({ type: "allow", id: pending.id });
      window.close();
      return;
    }
    return showPrompt(pending);
  }
  $("host").hidden = true;
  await paintHome(address);
}

async function boot() {
  const pending = await ask({ type: "pending" });
  if (pending.id) return showPrompt(pending);
  $("host").hidden = true;
  const status = await ask({ type: "status" });
  if (status.unlocked) {
    await paintHome(status.address);
    return;
  }
  if (!status.hasVault) {
    // A phrase may already be on screen from a panel that was closed before it was kept.
    const drafted = await ask({ type: "drafted" });
    if (drafted.mnemonic) {
      paintWords(drafted.mnemonic);
      return show("words");
    }
  }
  show(status.hasVault ? "unlock" : "create");
}

$("create").addEventListener("click", async () => {
  const pw = ($("pw") as HTMLInputElement).value;
  const again = ($("pw2") as HTMLInputElement).value;
  if (pw !== again) return fail(new Error("Those passwords don't match."));
  try {
    const res = await ask({ type: "draft", password: pw });
    paintWords(res.mnemonic);
    show("words");
  } catch (err) {
    fail(err);
  }
});

$("keep").addEventListener("click", async () => {
  try {
    const res = await ask({ type: "keep" });
    await afterAccount(res.address);
  } catch (err) {
    fail(err);
  }
});

$("show-import").addEventListener("click", () => show("import"));
$("back").addEventListener("click", () => show("create"));

$("import").addEventListener("click", async () => {
  try {
    const res = await ask({
      type: "import",
      password: ($("import-pw") as HTMLInputElement).value,
      mnemonic: ($("phrase") as HTMLTextAreaElement).value,
    });
    await afterAccount(res.address);
  } catch (err) {
    fail(err);
  }
});

$("unlock").addEventListener("click", async () => {
  try {
    const res = await ask({ type: "unlock", password: ($("unlock-pw") as HTMLInputElement).value });
    await afterAccount(res.address);
  } catch (err) {
    fail(err);
  }
});

$("allow").addEventListener("click", async () => {
  try {
    await ask({ type: "allow", id: promptId });
    window.close();
  } catch (err) {
    fail(err);
  }
});

$("deny").addEventListener("click", async () => {
  try {
    await ask({ type: "deny", id: promptId });
  } catch {
    /* the popup is closing */
  }
  window.close();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "show-prompt") boot().catch(fail);
});

async function pickNet(name: string) {
  const res = await ask({ type: "set-net", net: name });
  $("net").textContent = `${res.name}.`;
  ($("use-mainnet") as HTMLButtonElement).classList.toggle("on", res.name === "Mainnet");
  ($("use-sepolia") as HTMLButtonElement).classList.toggle("on", res.name === "Sepolia");
  ($("send") as HTMLButtonElement).disabled = res.name !== "Sepolia";
  const status = await ask({ type: "status" });
  if (status.address) await paintHome(status.address);
}

$("use-mainnet").addEventListener("click", () => pickNet("mainnet").catch(fail));
$("use-sepolia").addEventListener("click", () => pickNet("sepolia").catch(fail));

$("send").addEventListener("click", async () => {
  $("note").textContent = "sending…";
  try {
    const res = await ask({
      type: "send",
      to: ($("send-to") as HTMLInputElement).value,
      amount: ($("send-amt") as HTMLInputElement).value,
    });
    $("note").textContent = res.note;
    await paintActivity();
  } catch (err) {
    fail(err);
  }
});

$("copy-addr").addEventListener("click", () => {
  const address = $("addr").textContent || "";
  if (address) navigator.clipboard.writeText(address).catch(fail);
});

// From the MetaMask Embedded Wallets dashboard. Project network: Sapphire Devnet.
// Turn Google on, and whitelist chrome-extension://<this extension id>.
const WEB3AUTH_CLIENT_ID = "";

async function continueWithGoogle() {
  if (!WEB3AUTH_CLIENT_ID) {
    throw new Error(
      `Add the Web3Auth client id in app.ts. On the dashboard, use Sapphire Devnet, turn Google on, and whitelist chrome-extension://${chrome.runtime.id}.`,
    );
  }
  const { AUTH_CONNECTION, WALLET_CONNECTORS, WEB3AUTH_NETWORK, Web3Auth } = await import("@web3auth/modal");
  const web3auth = new Web3Auth({
    clientId: WEB3AUTH_CLIENT_ID,
    web3AuthNetwork: WEB3AUTH_NETWORK.SAPPHIRE_DEVNET,
    modalConfig: {
      hideWalletDiscovery: true,
      connectors: {
        [WALLET_CONNECTORS.AUTH]: { label: "Google", showOnModal: true },
        [WALLET_CONNECTORS.METAMASK]: { label: "MetaMask", showOnModal: false },
        [WALLET_CONNECTORS.WALLET_CONNECT_V2]: { label: "WalletConnect", showOnModal: false },
        [WALLET_CONNECTORS.COINBASE]: { label: "Coinbase", showOnModal: false },
        [WALLET_CONNECTORS.BASE_ACCOUNT]: { label: "Base", showOnModal: false },
      },
    },
  });
  await web3auth.init();
  await web3auth.connectTo(WALLET_CONNECTORS.AUTH, {
    authConnection: AUTH_CONNECTION.GOOGLE,
  });
  const provider = web3auth.connection?.ethereumProvider;
  if (!provider) throw new Error("Google sign-in was cancelled.");
  const raw = await provider.request({ method: "private_key" });
  if (typeof raw !== "string" || !raw) throw new Error("Web3Auth didn't return a key.");
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  const res = await ask({ type: "social", key });
  await afterAccount(res.address);
}

for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>(".google"))) {
  button.addEventListener("click", () => continueWithGoogle().catch(fail));
}

$("profile").addEventListener("click", async () => {
  const box = $("profile-box");
  box.hidden = !box.hidden;
  if (box.hidden) return;
  try {
    const status = await ask({ type: "status" });
    const address = status.address || "";
    $("profile-addr").textContent = address || "Unlock to see the address.";
    $("qr").innerHTML = address
      ? renderSVG(`ethereum:${address}`, { pixelSize: 4, blackColor: "#000", whiteColor: "#f4f4f4" })
      : "";
  } catch (err) {
    fail(err);
  }
});

$("lock").addEventListener("click", async () => {
  await ask({ type: "lock" });
  ($("unlock-pw") as HTMLInputElement).value = "";
  show("unlock");
});

typeInto($("tag"), TAG);
boot().catch(fail);

const dot = document.getElementById("dot") as HTMLElement;
let aimX = 0;
let aimY = 0;
let nowX = 0;
let nowY = 0;
addEventListener("mousemove", (event) => {
  aimX = event.clientX;
  aimY = event.clientY;
});
const chase = () => {
  nowX += (aimX - nowX) * 0.22;
  nowY += (aimY - nowY) * 0.22;
  dot.style.transform = `translate(${nowX - 5}px, ${nowY - 5}px)`;
  requestAnimationFrame(chase);
};
chase();

export {};
