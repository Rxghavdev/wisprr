const $ = (id: string) => document.getElementById(id) as HTMLElement;
const id = new URLSearchParams(location.search).get("id") ?? "";

function typeInto(el: HTMLElement, text: string) {
  el.replaceChildren();
  const caret = document.createElement("i");
  caret.className = "caret";
  el.append(caret);
  let i = 0;
  const step = () => {
    if (i >= text.length) return;
    caret.before(text[i]);
    i += 1;
    window.setTimeout(step, text[i - 1] === "." ? 140 : 28);
  };
  window.setTimeout(step, 40);
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
    if (head?.dataset.type) typeInto(head, head.dataset.type);
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
  if (res?.error) throw new Error(typeof res.error === "string" ? res.error : res.error.message);
  return res;
}

async function load() {
  const info = await ask({ type: "prompt", id });
  $("host").textContent = info.host;
  if (!info.hasVault) return show("empty");
  if (!info.unlocked) return show("locked");
  show("ask");
}

$("allow").addEventListener("click", async () => {
  try {
    await ask({ type: "allow", id });
    window.close();
  } catch (err) {
    fail(err);
  }
});

async function deny() {
  try {
    await ask({ type: "deny", id });
  } catch {
    /* window is going away */
  }
  window.close();
}

$("deny").addEventListener("click", deny);
$("deny-locked").addEventListener("click", deny);

$("unlock").addEventListener("click", async () => {
  try {
    await ask({ type: "unlock", password: ($("pw") as HTMLInputElement).value });
    const info = await ask({ type: "prompt", id });
    if (info.known) {
      await ask({ type: "allow", id });
      window.close();
      return;
    }
    show("ask");
  } catch (err) {
    fail(err);
  }
});

$("make").addEventListener("click", () => {
  chrome.windows.create({
    url: chrome.runtime.getURL("app.html"),
    type: "popup",
    width: 560,
    height: 820,
    focused: true,
  });
});

$("again").addEventListener("click", () => load().catch(fail));

typeInto($("tag"), "the node sees the question, not you.");
load().catch(fail);

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
