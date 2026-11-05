const $ = (id: string) => document.getElementById(id) as HTMLElement;

let typing = 0;

function typeInto(el: HTMLElement, text: string) {
  const run = ++typing;
  el.replaceChildren();
  const caret = document.createElement("i");
  caret.className = "caret";
  el.append(caret);
  let i = 0;
  const step = () => {
    if (run !== typing) return;
    if (i >= text.length) return;
    caret.before(text[i]);
    i += 1;
    window.setTimeout(step, text[i - 1] === "." ? 180 : 38);
  };
  window.setTimeout(step, 80);
}

function show(name: string) {
  for (const el of document.querySelectorAll<HTMLElement>("[data-screen]")) {
    const on = el.dataset.screen === name;
    el.hidden = !on;
    if (!on) continue;
    el.classList.remove("show");
    void el.offsetWidth;
    el.classList.add("show");
    const head = el.querySelector<HTMLElement>("[data-type]");
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

async function boot() {
  const status = await ask({ type: "status" });
  if (status.unlocked) {
    $("addr").textContent = status.address;
    show("home");
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
    $("addr").textContent = res.address;
    show("home");
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
    $("addr").textContent = res.address;
    show("home");
  } catch (err) {
    fail(err);
  }
});

$("unlock").addEventListener("click", async () => {
  try {
    const res = await ask({ type: "unlock", password: ($("unlock-pw") as HTMLInputElement).value });
    $("addr").textContent = res.address;
    show("home");
  } catch (err) {
    fail(err);
  }
});

$("lock").addEventListener("click", async () => {
  await ask({ type: "lock" });
  ($("unlock-pw") as HTMLInputElement).value = "";
  show("unlock");
});

boot().catch(fail);
