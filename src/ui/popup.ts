const line = document.getElementById("line")!;

function typeLine(text: string) {
  line.replaceChildren();
  const caret = document.createElement("i");
  caret.className = "caret";
  line.append(caret);
  let i = 0;
  const step = () => {
    if (i >= text.length) return;
    caret.before(text[i]);
    i += 1;
    window.setTimeout(step, 36);
  };
  step();
}

chrome.runtime.sendMessage({ type: "status" }).then((res) => {
  if (res?.unlocked && res.address) {
    typeLine(`${res.address.slice(0, 6)}…${res.address.slice(-4)}`);
  } else if (res?.hasVault) {
    typeLine("Locked");
  } else {
    typeLine("No wallet yet");
  }
});

document.getElementById("open")!.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("app.html") });
});
