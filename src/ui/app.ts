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

async function ask(msg: Record<string, unknown>) {
  const res = await chrome.runtime.sendMessage(msg);
  if (res?.error) throw new Error(res.error);
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
  paintActivity().catch(() => {});
  paintGrants().catch(() => {});
  try {
    const res = await ask({ type: "balance" });
    $("bal").textContent = `${trimEth(res.eth)} ETH`;
    $("note").textContent = res.note;
  } catch (err) {
    $("bal").textContent = "—";
    fail(err);
  }
}

async function paintMeta() {
  const res = await ask({ type: "receive" });
  $("meta").textContent = res.meta;
}

async function paintActivity() {
  const list = $("txs");
  list.replaceChildren();
  const res = await ask({ type: "activity" });
  const rows = (res.rows ?? []) as { hash: string; way: string; eth: string; status: string }[];
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
    li.textContent = `${row.way} · ${row.eth} ETH · ${row.status} · ${short(row.hash)}`;
    list.append(li);
  }
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
  try {
    await afterAccount((await ask({ type: "unlock", password: ($("unlock-pw") as HTMLInputElement).value })).address);
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
  try {
    const res = await ask({
      type: "pay",
      meta: ($("pay-meta") as HTMLInputElement).value,
      amount: ($("pay-amt") as HTMLInputElement).value,
    });
    $("note").textContent = `paid to ${short(res.stealthAddress)} · ${res.hash.slice(0, 10)}… · ${res.note}`;
    await paintActivity();
  } catch (err) {
    fail(err);
  }
});

$("scan").addEventListener("click", async () => {
  const list = $("found");
  list.replaceChildren();
  $("note").textContent = "scanning through the mixnet…";
  try {
    const res = await ask({ type: "scan" });
    $("note").textContent = res.note;
    const rows = (res.rows ?? []) as { address: string; eth: string; spent: boolean; txHash: string }[];
    if (!rows.length) {
      const li = document.createElement("li");
      li.className = "tx";
      li.textContent = "No private payments found.";
      list.append(li);
      return;
    }
    for (const row of rows) {
      const li = document.createElement("li");
      li.className = "tx";
      const body = document.createElement("div");
      body.textContent = `${row.eth} ETH · ${short(row.address)}${row.spent ? " · swept" : ""}`;
      li.append(body);
      if (!row.spent) {
        const to = document.createElement("button");
        to.className = "text";
        to.type = "button";
        to.textContent = "Sweep";
        to.addEventListener("click", async () => {
          const target = $("addr").textContent ?? "";
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
            $("note").textContent = `swept · ${out.hash.slice(0, 10)}…`;
            $("scan").click();
          } catch (err) {
            fail(err);
          }
        });
        li.append(to);
      }
      list.append(li);
    }
  } catch (err) {
    fail(err);
  }
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

$("register").addEventListener("click", async () => {
  const note = $("reg-note");
  note.hidden = false;
  note.textContent = "publishing to the ERC-6538 registry…";
  try {
    const res = await ask({ type: "register" });
    note.textContent = `registered · ${res.hash.slice(0, 10)}… · ${res.note}`;
  } catch (err) {
    note.textContent = err instanceof Error ? err.message : "Registration failed.";
  }
});

$("lock").addEventListener("click", async () => {
  await ask({ type: "lock" });
  ($("unlock-pw") as HTMLInputElement).value = "";
  show("unlock");
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

boot().catch(fail);

export {};
