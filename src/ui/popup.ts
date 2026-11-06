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

const dot = document.getElementById("dot") as HTMLElement;
let aimX = 0;
let aimY = 0;
let nowX = 0;
let nowY = 0;
addEventListener("mousemove", (event) => {
  aimX = event.clientX;
  aimY = event.clientY;
  const hit = document.elementFromPoint(event.clientX, event.clientY);
  document.body.classList.toggle(
    "pointing",
    Boolean(hit?.closest("button, a, summary, input, textarea")),
  );
});
const chase = () => {
  nowX += (aimX - nowX) * 0.28;
  nowY += (aimY - nowY) * 0.28;
  dot.style.transform = `translate(${nowX - 4}px, ${nowY - 4}px)`;
  requestAnimationFrame(chase);
};
chase();

document.getElementById("open")!.addEventListener("click", () => {
  window.close();
});

export {};
