const line = document.getElementById("line")!;
const tag = document.getElementById("tag")!;

function typeLine(el: HTMLElement, text: string) {
  el.replaceChildren();
  const caret = document.createElement("i");
  caret.className = "caret";
  el.append(caret);
  let i = 0;
  const step = () => {
    if (i >= text.length) return;
    caret.before(text[i]);
    i += 1;
    window.setTimeout(step, 32);
  };
  step();
}

typeLine(tag, "the node sees the question, not you.");

chrome.runtime.sendMessage({ type: "status" }).then((res) => {
  if (res?.unlocked && res.address) {
    typeLine(line, `${res.address.slice(0, 6)}…${res.address.slice(-4)}`);
  } else if (res?.hasVault) {
    typeLine(line, "Locked");
  } else {
    typeLine(line, "No wallet yet");
  }
});

document.getElementById("open")!.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("app.html") });
});
