const line = document.getElementById("line")!;

chrome.runtime.sendMessage({ type: "status" }).then((res) => {
  if (res?.unlocked && res.address) {
    line.textContent = `${res.address.slice(0, 6)}…${res.address.slice(-4)}`;
  } else if (res?.hasVault) {
    line.textContent = "Locked";
  } else {
    line.textContent = "No wallet yet";
  }
});

document.getElementById("open")!.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("app.html") });
});
