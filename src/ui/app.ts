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
}

function trimEth(eth: string) {
  const [whole, frac = ""] = eth.split(".");
  return frac ? `${whole}.${frac.slice(0, 5)}` : whole;
}

async function paintHome(address: string) {
  $("addr").textContent = address;
  $("bal").textContent = "reading…";
  $("note").textContent = "first call waits while the mixnet comes up.";
  show("home");
  try {
    const res = await ask({ type: "balance" });
    $("bal").textContent = `${trimEth(res.eth)} ETH`;
    $("note").textContent = res.note;
  } catch (err) {
    $("bal").textContent = "—";
    fail(err);
  }
}

async function boot() {
  const status = await ask({ type: "status" });
  if (status.unlocked) {
    await paintHome(status.address);
    return;
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
    await paintHome(res.address);
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
    await paintHome(res.address);
  } catch (err) {
    fail(err);
  }
});

$("unlock").addEventListener("click", async () => {
  try {
    const res = await ask({ type: "unlock", password: ($("unlock-pw") as HTMLInputElement).value });
    await paintHome(res.address);
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
