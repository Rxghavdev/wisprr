const $ = (id: string) => document.getElementById(id) as HTMLElement;

function show(name: string) {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-screen]"))) {
    el.hidden = el.dataset.screen !== name;
  }
  $("err").hidden = true;
}

function fail(err: unknown) {
  const node = $("err");
  node.hidden = false;
  node.textContent = err instanceof Error ? err.message : "Something broke.";
}

async function ask(msg: Record<string, unknown>, timeoutMs = 0) {
  const send = chrome.runtime.sendMessage(msg);
  if (!timeoutMs) {
    const res = await send;
    if (res?.error) throw new Error(res.error);
    return res;
  }
  // Chrome stops an idle service worker. If that happens mid-request the promise
  // never settles, which is how the scan ticker reached 900 seconds. This bounds
  // it, so the UI can report a failure instead of pretending to work.
  const res = await Promise.race([
    send,
    new Promise((_, reject) =>
      window.setTimeout(() => reject(new Error("The wallet stopped responding. Try again.")), timeoutMs),
    ),
  ]);
  if ((res as { error?: string })?.error) throw new Error((res as { error: string }).error);
  return res;
}

function trimEth(eth: string) {
  const [whole, frac = ""] = eth.split(".");
  return frac ? `${whole}.${frac.slice(0, 5)}` : whole;
}

function short(s: string) {
  return s.length > 20 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s;
}

function paintWords(mnemonic: string) {
  const list = $("words");
  list.replaceChildren();
  mnemonic.split(" ").forEach((word, i) => {
    const li = document.createElement("li");
    const n = document.createElement("span");
    n.textContent = String(i + 1);
    li.append(n, document.createTextNode(word));
    list.append(li);
  });
  $("copy-words-note").textContent = "";
}

$("copy-words").addEventListener("click", async () => {
  const words = Array.from(document.querySelectorAll("#words li"))
    .map((li) => li.textContent?.replace(/^\d+/, "").trim() ?? "")
    .filter(Boolean)
    .join(" ");
  if (!words) return;
  try {
    await navigator.clipboard.writeText(words);
    $("copy-words-note").textContent = "Copied. Clear your clipboard when you're done.";
  } catch {
    fail(new Error("The browser blocked the clipboard."));
  }
});

async function paintHome(address: string) {
  $("addr").textContent = address;
  $("bal").textContent = "…";
  const net = await ask({ type: "net" });
  ($("use-mainnet") as HTMLButtonElement).classList.toggle("on", net.name === "Mainnet");
  ($("use-sepolia") as HTMLButtonElement).classList.toggle("on", net.name === "Sepolia");
  show("home");
  paintSites().catch(() => {});
  paintMeta().catch(() => {});
  paintGrants().catch(() => {});
  // Balance first: it is the thing the user waits for.
  await paintBalance();
  paintActivity().catch(() => {});
}
// Kept separate from paintHome so a send or a sweep can refresh just the number
// without rebuilding the whole screen.
//
// The first call after reopening the panel has to boot the mixnet, which takes
// seconds, and the service worker may have been suspended since. Without a timeout
// the promise simply never settles and the balance sits on the ellipsis forever.
async function paintBalance(attempt = 1): Promise<void> {
  const bal = $("bal");
  const note = $("note");
  bal.textContent = attempt === 1 ? "…" : "…";
  note.textContent = attempt === 1 ? "reading through the mixnet…" : "still waiting on the mixnet…";

  try {
    const res = await ask({ type: "balance" }, 90_000);
    bal.textContent = `${trimEth(res.eth)} ETH`;
    note.textContent = res.note;
    bal.classList.remove("stale");
  } catch (err) {
    // One retry, because the usual cause is a suspended worker rather than a real
    // failure, and waking it is enough.
    if (attempt < 2) {
      window.setTimeout(() => void paintBalance(attempt + 1), 400);
      return;
    }
    bal.textContent = "—";
    bal.classList.add("stale");
    note.textContent = "Could not read the balance. Tap the balance to retry.";
    fail(err);
  }
}

// Tapping the balance retries, so a dead first read is never a dead end.
function wireBalanceRetry() {
  const bal = $("bal");
  bal.style.cursor = "none";
  bal.addEventListener("click", () => void paintBalance());
}

// A generation token. Every paint bumps it; an older response that lands late
// sees a newer token and drops itself, so a slow first call can never overwrite
// a fast second one.
let activityGen = 0;
let scanGen = 0;

function placeholder(list: HTMLElement, text: string) {
  list.replaceChildren();
  const li = document.createElement("li");
  li.className = "tx pending";
  li.textContent = text;
  list.append(li);
}

async function paintActivity() {
  const list = $("txs");
  const gen = ++activityGen;
  placeholder(list, "loading activity…");
  let pending = false;
  try {
    const res = await ask({ type: "activity" });
    if (gen !== activityGen) return;
    const net = (await ask({ type: "net" })) as { name: string };
    const rows = (res.rows ?? []) as {
      hash: string;
      way: string;
      eth: string;
      status: string;
      when?: string;
    }[];
    list.replaceChildren();
    if (!rows.length) {
      const li = document.createElement("li");
      li.className = "tx";
      li.textContent = "Nothing yet.";
      list.append(li);
      return;
    }
    for (const row of rows) {
      const li = document.createElement("li");
      li.className = "tx";

      const body = document.createElement("div");
      const head = document.createElement("p");
      head.className = "k";
      // A pending row says so, rather than looking like a verdict.
      const verdict = row.status === "pending" ? "confirming…" : row.status;
      head.textContent = `${row.way} · ${row.eth} ETH · ${verdict}${row.when ? ` · ${row.when}` : ""}`;
      body.append(head);
      if (row.status === "pending") {
        const note = document.createElement("p");
        note.className = "hash";
        note.textContent = "Not mined yet. This will update on its own.";
        body.append(note);
        pending = true;
      }
      li.append(body);

      // Full hash and a link, so any row can be checked on the explorer.
      const actions = document.createElement("div");
      actions.className = "row-actions";
      const copy = document.createElement("button");
      copy.className = "mini";
      copy.type = "button";
      copy.textContent = "Copy";
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(row.hash);
          copy.textContent = "Copied";
          window.setTimeout(() => (copy.textContent = "Copy"), 1600);
        } catch {
          copy.textContent = "Blocked";
        }
      });
      const open = document.createElement("a");
      open.className = "mini link";
      open.textContent = "Explorer";
      open.target = "_blank";
      open.rel = "noreferrer noopener";
      open.href = `https://${net.name === "Sepolia" ? "eth-sepolia" : "eth"}.blockscout.com/tx/${row.hash}`;
      actions.append(copy, open);
      li.append(actions);

      const hash = document.createElement("code");
      hash.className = "receipt-hash";
      hash.textContent = row.hash;
      li.append(hash);

      list.append(li);
    }
  } catch (err) {
    if (gen !== activityGen) return;
    list.replaceChildren();
    const li = document.createElement("li");
    li.className = "tx";
    li.textContent = err instanceof Error ? err.message : "Activity didn't load.";
    list.append(li);
    pending = false;
  }

  // A transaction that was still mining when the list loaded resolves in a few
  // seconds. Re-read once so the row does not sit on "confirming" forever.
  if (pending) {
    window.setTimeout(() => {
      if (gen === activityGen) void paintActivity();
    }, 6000);
  }
}

async function paintMeta() {
  const res = await ask({ type: "receive" });
  $("meta").textContent = res.meta;
}

/* --------------------------------------------------------------- receipts */

type Receipt = { label: string; hash: string; net?: string; ok?: boolean };

// A finished transaction, shown in full. The hash is never truncated, because a
// user checking a payment needs to paste it into an explorer and that is the only
// proof this actually happened.
function receiptNode(r: Receipt): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "receipt" + (r.ok === false ? " bad" : "");

  const head = document.createElement("p");
  head.className = "receipt-label";
  head.textContent = r.label;
  wrap.append(head);

  const hash = document.createElement("code");
  hash.className = "receipt-hash";
  hash.textContent = r.hash;
  wrap.append(hash);

  const actions = document.createElement("div");
  actions.className = "receipt-actions";

  const copy = document.createElement("button");
  copy.className = "ghost";
  copy.type = "button";
  copy.textContent = "Copy hash";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(r.hash);
      copy.textContent = "Copied";
      window.setTimeout(() => (copy.textContent = "Copy hash"), 1600);
    } catch {
      copy.textContent = "Blocked";
    }
  });

  const open = document.createElement("a");
  open.className = "receipt-link";
  open.textContent = "View on explorer";
  open.target = "_blank";
  open.rel = "noreferrer noopener";
  open.href = `https://${r.net === "Sepolia" ? "eth-sepolia" : "eth"}.blockscout.com/tx/${r.hash}`;

  actions.append(copy, open);
  wrap.append(actions);
  return wrap;
}

// Replaces the old one-line note with a real receipt.
function showReceipt(target: HTMLElement, r: Receipt) {
  target.replaceChildren(receiptNode(r));
  target.hidden = false;
}

async function paintSites() {
  const res = await ask({ type: "sites" });
  const list = $("sites");
  const rows = (res.hosts ?? []) as { host: string; origin: string }[];
  list.replaceChildren();
  if (!rows.length) {
    const li = document.createElement("li");
    li.textContent = "No site connected.";
    list.append(li);
    return;
  }
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

setInterval(() => {
  if (!promptId) return;
  try {
    port.postMessage({ type: "ping" });
  } catch {
    /* the panel is going away */
  }
}, 20_000);

async function showPrompt(info: { id: string; host: string; hasVault: boolean; unlocked: boolean }) {
  promptId = info.id;
  $("ask-host").textContent = info.host;
  port.postMessage({ type: "watch", id: info.id });
  if (!info.hasVault) return show("create");
  if (!info.unlocked) return show("unlock");
  show("ask");
}

async function afterAccount(address: string) {
  const pending = await ask({ type: "pending" });
  if (pending.id) {
    if (pending.unlocked) {
      await ask({ type: "allow", id: pending.id });
      window.close();
      return;
    }
    return showPrompt(pending);
  }
  await paintHome(address);
}

async function boot() {
  const pending = await ask({ type: "pending" });
  if (pending.id) return showPrompt(pending);
  const status = await ask({ type: "status" });
  if (status.unlocked) return paintHome(status.address);
  if (!status.hasVault) {
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
  if (pw !== ($("pw2") as HTMLInputElement).value) return fail(new Error("Those passwords don't match."));
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
    await afterAccount((await ask({ type: "keep" })).address);
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
  const btn = $("unlock") as HTMLButtonElement;
  const field = $("unlock-pw") as HTMLInputElement;
  btn.disabled = true;
  $("note").textContent = "unlocking…";
  try {
    const res = await ask({ type: "unlock", password: field.value }, 20_000);
    field.value = "";
    await afterAccount(res.address);
  } catch (err) {
    $("note").textContent = "";
    fail(err);
  } finally {
    btn.disabled = false;
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
    /* closing */
  }
  window.close();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "show-prompt") boot().catch(fail);
});

async function pickNet(name: string) {
  await ask({ type: "set-net", net: name });
  const status = await ask({ type: "status" });
  if (status.address) await paintHome(status.address);
}

$("use-mainnet").addEventListener("click", () => pickNet("mainnet").catch(fail));
$("use-sepolia").addEventListener("click", () => pickNet("sepolia").catch(fail));

$("copy-meta").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("meta").textContent ?? "");
    $("note").textContent = "Meta-address copied. Anyone can pay it; nobody can trace what lands.";
  } catch {
    fail(new Error("The browser blocked the clipboard."));
  }
});

$("pay").addEventListener("click", async () => {
  $("note").textContent = "paying…";
  $("pay-result").hidden = true;
  try {
    const res = await ask({
      type: "pay",
      meta: ($("pay-meta") as HTMLInputElement).value,
      amount: ($("pay-amt") as HTMLInputElement).value,
    });
    $("note").textContent = `paid to ${short(res.stealthAddress)}`;
    showReceipt($("pay-result"), {
      label: "Payment sent. Both transactions are in this hash, the transfer and the announcement.",
      hash: res.hash,
      net: res.net,
    });
    // Balance and activity both changed, so refresh both.
    await paintBalance();
    paintActivity().catch(() => {});
  } catch (err) {
    fail(err);
  }
});

async function runScan(deep: boolean) {
  const list = $("found");
  const gen = ++scanGen;
  const limitMs = deep ? 180_000 : 70_000;
  placeholder(list, "scanning…");
  $("note").textContent = deep ? "scanning further back through the mixnet…" : "scanning through the mixnet…";

  const began = Date.now();
  const ticker = window.setInterval(() => {
    const secs = Math.round((Date.now() - began) / 1000);
    placeholder(list, `scanning… ${secs}s${deep ? " (deep scan)" : ""}`);
    // Never let the label outlive the timeout: if the worker died, say so.
    if (Date.now() - began > limitMs) {
      window.clearInterval(ticker);
      placeholder(list, "The wallet stopped responding. Reopen the panel and try again.");
    }
  }, 1000);

  try {
    const res = await ask({ type: "scan", full: deep }, limitMs);
    if (gen !== scanGen) return;
    window.clearInterval(ticker);
    const rows = (res.rows ?? []) as { address: string; eth: string; spent: boolean; txHash: string }[];

    // Say plainly that it finished. Before this the list just stopped changing,
    // which is indistinguishable from a scan that died.
    const took = Math.round((Date.now() - began) / 1000);
    $("note").textContent = `scan finished in ${took}s · ${rows.length} payment${rows.length === 1 ? "" : "s"} found`;

    list.replaceChildren();
    if (!rows.length) {
      const li = document.createElement("li");
      li.className = "tx";
      li.textContent = deep
        ? "Scan finished. No private payments, even looking further back."
        : "Scan finished. Nothing in the last few hours. Try Scan further back.";
      list.append(li);
      return;
    }
    for (const row of rows) {
      const li = document.createElement("li");
      li.className = "tx";
      const body = document.createElement("div");
      body.textContent = `${row.eth} ETH · ${short(row.address)}${row.spent ? " · swept" : ""}`;
      li.append(body);

      // Show USDC as well, since a payment can arrive as a token and would
      // otherwise look empty at 0 ETH.
      const tok = document.createElement("p");
      tok.className = "hash";
      tok.textContent = "reading USDC…";
      li.append(tok);
      ask({ type: "token-balance", address: row.address }, 20_000)
        .then((t: { usdc: number }) => {
          tok.textContent = t.usdc > 0 ? `${t.usdc} USDC` : "no USDC";
          if (t.usdc > 0) {
            (document.getElementById("tk-addr") as HTMLInputElement).value = row.address;
          }
        })
        .catch(() => {
          tok.textContent = "";
        });
      if (!row.spent) {
        const to = document.createElement("button");
        to.className = "text";
        to.type = "button";
        to.textContent = "Sweep";
        to.addEventListener("click", async () => {
          const target = destinationInput();
          if (!target) return;
          const box = document.createElement("ul");
          box.className = "txs";
          li.append(box);
          try {
            // Check the destination before committing, so a refusal is explained
            // rather than thrown.
            const verdict = await ask({ type: "sweep-check", address: row.address, to: target });
            box.replaceChildren();
            for (const leak of verdict.leaks ?? []) {
              const item = document.createElement("li");
              item.className = leak.severity === "block" ? "leak block" : "leak warn";
              item.textContent = `${leak.rule}: ${leak.why} ${leak.instead}`;
              box.append(item);
            }
            if (!verdict.ok) {
              $("note").textContent = "That sweep is blocked. Pick a destination that does not create a public link.";
              return;
            }
            $("note").textContent = "sweeping…";
            const out = await ask({ type: "sweep", address: row.address, to: target });
            // Same treatment as a payment: full hash plus a link.
            const holder = document.createElement("div");
            box.append(holder);
            showReceipt(holder, { label: "Sweep sent.", hash: out.hash, net: out.net });
            await paintBalance();
          } catch (err) {
            fail(err);
          }
        });
        li.append(to);
      }
      list.append(li);
    }
  } catch (err) {
    window.clearInterval(ticker);
    if (gen !== scanGen) return;
    list.replaceChildren();
    const li = document.createElement("li");
    li.className = "tx";
    li.textContent = err instanceof Error ? err.message : "The scan didn't finish.";
    list.append(li);
    fail(err);
  }
}

$("scan").addEventListener("click", () => {
  runScan(false);
});

$("scan-deep").addEventListener("click", () => {
  runScan(true);
});

const dayStart = (v: string) => (v ? Math.floor(new Date(`${v}T00:00:00Z`).getTime() / 1000) : 0);
const dayEnd = (v: string) => (v ? Math.floor(new Date(`${v}T23:59:59Z`).getTime() / 1000) : 0);

async function paintGrants() {
  const list = $("g-list");
  list.replaceChildren();
  const res = await ask({ type: "grants" });
  const rows = (res.rows ?? []) as { grantee: string; purpose: string; from: number; to: number; hash: string; revokedAt?: number }[];
  if (!rows.length) {
    const li = document.createElement("li");
    li.className = "tx";
    li.textContent = "No grants issued.";
    list.append(li);
    return;
  }
  for (const row of rows) {
    const li = document.createElement("li");
    li.className = "tx";
    const body = document.createElement("div");
    const head = document.createElement("p");
    head.textContent = `${row.grantee} · ${row.purpose}`;
    const span = document.createElement("p");
    span.className = "hash";
    span.textContent = `${new Date(row.from * 1000).toISOString().slice(0, 10)} → ${new Date(row.to * 1000).toISOString().slice(0, 10)}${row.revokedAt ? " · revoked" : ""}`;
    body.append(head, span);
    li.append(body);
    if (!row.revokedAt) {
      const kill = document.createElement("button");
      kill.className = "text";
      kill.type = "button";
      kill.textContent = "Revoke";
      kill.addEventListener("click", async () => {
        await ask({ type: "revoke-grant", hash: row.hash });
        await paintGrants();
      });
      li.append(kill);
    }
    list.append(li);
  }
}

$("g-make").addEventListener("click", async () => {
  const out = $("g-out");
  out.hidden = false;
  try {
    const res = await ask({
      type: "grant",
      meta: ($("g-who") as HTMLInputElement).value,
      purpose: ($("g-why") as HTMLInputElement).value,
      windowFrom: dayStart(($("g-from") as HTMLInputElement).value),
      windowTo: dayEnd(($("g-to") as HTMLInputElement).value),
    });
    const g = res.grant;
    out.textContent = `grant ${res.hash}\nviewing   ${g.viewing}\nspending  ${g.spendingPub}`;
    await paintGrants();
  } catch (err) {
    out.textContent = err instanceof Error ? err.message : "Could not issue the grant.";
  }
});

$("a-scan").addEventListener("click", async () => {
  const list = $("a-found");
  list.replaceChildren();
  $("note").textContent = "auditing inside the mandate…";
  try {
    const res = await ask({
      type: "audit-scan",
      hash: ($("a-hash") as HTMLInputElement).value.trim(),
      viewing: ($("a-view") as HTMLInputElement).value.trim(),
      spendingPub: ($("a-spend") as HTMLInputElement).value.trim(),
      windowFrom: dayStart(($("a-from") as HTMLInputElement).value),
      windowTo: dayEnd(($("a-to") as HTMLInputElement).value),
    });
    $("note").textContent = res.note;
    if (!res.allowed) {
      const li = document.createElement("li");
      li.className = "tx";
      li.textContent = "That mandate does not permit a scan.";
      list.append(li);
      return;
    }
    const rows = (res.rows ?? []) as { address: string; eth: string }[];
    if (!rows.length) {
      const li = document.createElement("li");
      li.className = "tx";
      li.textContent = "No payments inside this window.";
      list.append(li);
      return;
    }
    for (const row of rows) {
      const li = document.createElement("li");
      li.className = "tx";
      li.textContent = `${row.eth} ETH · ${short(row.address)}`;
      list.append(li);
    }
  } catch (err) {
    fail(err);
  }
});

$("lock").addEventListener("click", async () => {
  await ask({ type: "lock" });
  ($("unlock-pw") as HTMLInputElement).value = "";
  show("unlock");
});

// Where a sweep goes. Asked once per sweep, because the answer should change:
// reusing one address is exactly the link the guard exists to prevent.
function destinationInput(): string {
  const value = window.prompt(
    "Send this payment to which address?\n\nDo not use your vault address. The guard will refuse it.",
    "",
  );
  if (value === null) return "";
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    $("note").textContent = "That is not an address.";
    return "";
  }
  return trimmed;
}

// Shows which network is carrying requests. Anonymised means the node cannot see
// your IP; direct means it can, and says so.
let transportMode = "nox";

async function paintTransport() {
  try {
    const status = await ask({ type: "status" }, 15_000);
    transportMode = status.mode ?? "nox";
    const dot = $("mode-dot");
    dot.classList.toggle("direct", transportMode === "direct");
    $("mode-text").textContent =
      transportMode === "direct"
        ? "direct · the node sees your IP"
        : `${status.label ?? transportMode} · the node sees the question, not you`;
    const pick = $("net-pick") as HTMLSelectElement;
    if (transportMode !== "direct") pick.value = transportMode;
    if (status.note) $("note").textContent = status.note;
  } catch {
    $("mode-text").textContent = "network unknown";
  }
}

$("net-pick").addEventListener("change", async () => {
  const pick = $("net-pick") as HTMLSelectElement;
  pick.disabled = true;
  $("mode-text").textContent = `switching to ${pick.value}…`;
  try {
    const res = await ask({ type: "mode", net: pick.value }, 70_000);
    $("mode-text").textContent = res.note ?? res.mode;
    await paintTransport();
    await paintBalance();
  } catch (err) {
    fail(err);
    await paintTransport();
  } finally {
    pick.disabled = false;
  }
});

/* ------------------------------------------------------------ token sweep */

// USDC sweep. The point is that the stealth address never holds ETH: the key
// signs an EIP-3009 authorisation offline and this wallet submits it and pays.
$("tk-check").addEventListener("click", async () => {
  const note = $("tk-note");
  note.hidden = false;
  note.textContent = "reading the USDC balance…";
  try {
    const res = await ask({ type: "token-balance", address: ($("tk-addr") as HTMLInputElement).value.trim() }, 30_000);
    note.textContent = `${res.usdc} USDC at that address.`;
  } catch (err) {
    note.textContent = err instanceof Error ? err.message : "Could not read it.";
  }
});

$("tk-sweep").addEventListener("click", async () => {
  const note = $("tk-note");
  note.hidden = false;
  note.textContent = "sweeping USDC…";
  const addr = ($("tk-addr") as HTMLInputElement).value.trim();
  const to = ($("tk-to") as HTMLInputElement).value.trim();
  try {
    const bal = await ask({ type: "token-balance", address: addr }, 30_000);
    if (!bal.raw || bal.raw === "0") throw new Error("No USDC at that address.");
    const out = await ask({ type: "sweep-token", address: addr, to, raw: bal.raw }, 120_000);
    note.replaceChildren(receiptNode({ label: "USDC swept. The stealth address never held ETH.", hash: out.hash, net: out.net }));
  } catch (err) {
    note.textContent = err instanceof Error ? err.message : "Sweep failed.";
  }
});

/* ----------------------------------------------------------- guard demo */

// Names the five rules and what each one is for, so the guard is inspectable
// rather than a claim you have to take on trust.
$("guard-demo").addEventListener("click", () => {
  const list = $("guard-out");
  list.replaceChildren();
  const rules: [string, string, string][] = [
    ["H1 destination reuse", "blocks", "Sweeping to a wallet you are known at ties every private payment to it."],
    ["H2 round trip", "blocks", "Sweeping back to whoever paid you makes the payment circular."],
    ["H3 collector pattern", "warns", "Draining several stealth addresses together shows one owner."],
    ["H4 gas funding", "warns", "Sending ETH to a stealth address links it to the funder."],
    ["H5 timing", "warns", "A sweep minutes after receipt is the strongest link there is."],
  ];
  for (const [rule, kind, why] of rules) {
    const li = document.createElement("li");
    li.className = kind === "blocks" ? "leak block" : "leak warn";
    li.textContent = `${rule} · ${kind} — ${why}`;
    list.append(li);
  }
});

$("register").addEventListener("click", async () => {
  const note = $("reg-note");
  note.hidden = false;
  note.textContent = "publishing to the ERC-6538 registry…";
  try {
    const res = await ask({ type: "register" });
    note.replaceChildren(receiptNode({ label: "Meta-address registered.", hash: res.hash, net: res.net }));
  } catch (err) {
    note.textContent = err instanceof Error ? err.message : "Registration failed.";
  }
});

/* ------------------------------------------------------------------ tabs */

function pickTab(name: string) {
  for (const tab of Array.from(document.querySelectorAll<HTMLElement>(".tab"))) {
    tab.classList.toggle("on", tab.dataset.tab === name);
  }
  for (const body of Array.from(document.querySelectorAll<HTMLElement>("[data-body]"))) {
    const on = body.dataset.body === name;
    body.hidden = !on;
    body.classList.toggle("show", on);
  }
}

for (const tab of Array.from(document.querySelectorAll<HTMLElement>(".tab"))) {
  tab.addEventListener("click", () => pickTab(tab.dataset.tab ?? "receive"));
}

/* ---------------------------------------------------------------- cursor */

// The pointer has to follow the mouse or there is nothing to aim with: the body
// sets cursor: none so this element stands in for it.
const dot = document.getElementById("dot") as HTMLElement;
let aimX = window.innerWidth / 2;
let aimY = window.innerHeight / 2;
let nowX = aimX;
let nowY = aimY;

addEventListener("mousemove", (event) => {
  aimX = event.clientX;
  aimY = event.clientY;
  // Anything clickable makes the dot grow, which is the only hover affordance.
  const hit = document.elementFromPoint(event.clientX, event.clientY);
  const clickable = Boolean(hit?.closest("button, a, summary, input, textarea, .tab"));
  document.body.classList.toggle("pointing", clickable);
});

const chase = () => {
  nowX += (aimX - nowX) * 0.35;
  nowY += (aimY - nowY) * 0.35;
  dot.style.transform = `translate(${nowX - 4}px, ${nowY - 4}px)`;
  requestAnimationFrame(chase);
};
chase();

/* ------------------------------------------------------------------ rain */

// A cursor-reactive ambient field.
//
// Three layers, in order: a drifting field of glyphs, a soft pool of light under
// the pointer, and white sparks thrown off while it moves. The glyphs are pushed
// aside near the cursor and relax back, which is what makes the hover feel smooth
// rather than like a hard edge.
//
// Density is derived from the panel area, so a narrow side panel and a wide window
// both stay calm. Honours prefers-reduced-motion.
function rain() {
  const canvas = document.getElementById("rain") as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const glyphs = "0123456789abcdef";
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;

  type Node = { x: number; y: number; vy: number; char: string; dx: number; dy: number };
  type Spark = { x: number; y: number; vx: number; vy: number; life: number; max: number; char: string };

  let nodes: Node[] = [];
  let sparks: Spark[] = [];
  let width = 0;
  let height = 0;

  const build = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

    const target = Math.min(120, Math.max(28, Math.round((width * height) / 13000)));
    nodes = Array.from({ length: target }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vy: 6 + Math.random() * 22,
      char: glyphs[Math.floor(Math.random() * glyphs.length)],
      dx: 0,
      dy: 0,
    }));
  };

  build();
  addEventListener("resize", build);

  const MAX_SPARKS = 150;
  const FIELD = 155;

  let last = performance.now();
  let prevX = aimX;
  let prevY = aimY;
  let rollClock = 0;
  let spawnClock = 0;

  const frame = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    const px = aimX;
    const py = aimY;
    // Pointer speed, normalised. A fast flick throws more debris than a slow drift.
    const speed = Math.hypot(px - prevX, py - prevY) / Math.max(dt, 0.001);
    prevX = px;
    prevY = py;
    const energy = Math.min(speed / 900, 1);

    // White crisps, thrown off while the pointer moves.
    if (!calm && energy > 0.02) {
      spawnClock += dt;
      if (spawnClock > 0.016) {
        spawnClock = 0;
        const count = 1 + Math.floor(energy * 3);
        for (let i = 0; i < count && sparks.length < MAX_SPARKS; i++) {
          const angle = Math.random() * Math.PI * 2;
          const kick = 20 + Math.random() * 80 * energy;
          sparks.push({
            x: px + (Math.random() - 0.5) * 10,
            y: py + (Math.random() - 0.5) * 10,
            vx: Math.cos(angle) * kick,
            vy: Math.sin(angle) * kick - 10,
            life: 0,
            max: 0.3 + Math.random() * 0.5,
            char: glyphs[Math.floor(Math.random() * glyphs.length)],
          });
        }
      }
    }

    ctx.clearRect(0, 0, width, height);
    ctx.font = "12px 'Courier New', monospace";
    ctx.textAlign = "left";

    // The smooth hover: a wide, very faint pool of light under the pointer.
    if (!calm) {
      const glow = ctx.createRadialGradient(px, py, 0, px, py, 140);
      glow.addColorStop(0, "rgba(244,244,244,0.06)");
      glow.addColorStop(0.5, "rgba(244,244,244,0.02)");
      glow.addColorStop(1, "rgba(244,244,244,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(px - 140, py - 140, 280, 280);
    }

    rollClock += dt;
    const reroll = rollClock > 0.1;
    if (reroll) rollClock = 0;

    for (const n of nodes) {
      n.y += n.vy * dt;
      if (n.y > height + 16) {
        n.y = -16;
        n.x = Math.random() * width;
        n.vy = 6 + Math.random() * 22;
        if (reroll) n.char = glyphs[Math.floor(Math.random() * glyphs.length)];
      }

      let near = 0;
      if (!calm) {
        const ddx = n.x - px;
        const ddy = n.y - py;
        const dist2 = ddx * ddx + ddy * ddy;
        if (dist2 < FIELD * FIELD && dist2 > 1) {
          const dist = Math.sqrt(dist2);
          near = 1 - dist / FIELD;
          // Push outward from the pointer. Closer glyphs move further.
          const push = (near * near * 52 * dt) / dist;
          n.dx += ddx * push;
          n.dy += ddy * push;
        }
      }

      // Relax back toward the column it belongs to.
      const relax = 1 - Math.min(1, 3.6 * dt);
      n.dx *= relax;
      n.dy *= relax;

      if (reroll && Math.random() < 0.06) {
        n.char = glyphs[Math.floor(Math.random() * glyphs.length)];
      }

      const fall = 1 - Math.min(1, n.y / (height + 16));
      const alpha = Math.min(0.05 + fall * 0.1 + near * 0.55, 0.78);
      ctx.fillStyle = `rgba(244,244,244,${alpha.toFixed(3)})`;
      ctx.fillText(n.char, n.x + n.dx, n.y + n.dy);
    }

    if (sparks.length) {
      const alive: Spark[] = [];
      for (const s of sparks) {
        s.life += dt;
        if (s.life >= s.max) continue;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.vy += 130 * dt;
        s.vx *= 1 - Math.min(1, 1.7 * dt);
        const alpha = (1 - s.life / s.max) * 0.9;
        ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
        ctx.fillText(s.char, s.x, s.y);
        alive.push(s);
      }
      sparks = alive;
    }

    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}

rain();

wireBalanceRetry();
paintTransport().catch(() => {});
boot().catch(fail);

export {};
