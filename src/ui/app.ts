const $ = (id: string) => document.getElementById(id) as HTMLElement;

function show(name: string) {
  for (const el of document.querySelectorAll<HTMLElement>("[data-screen]")) {
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
