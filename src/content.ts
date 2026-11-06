let openOnThisClick = false;

document.addEventListener("wisprr-open", () => {
  openOnThisClick = true;
  queueMicrotask(() => {
    openOnThisClick = false;
  });
});

// The site's click is the user gesture. A made-up event from the page is not.
document.addEventListener("click", () => {
  if (!openOnThisClick) return;
  openOnThisClick = false;
  chrome.runtime.sendMessage({ type: "open-panel" });
});

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.ch !== "wisprr" || typeof data.id !== "number") return;
  chrome.runtime.sendMessage({ type: "rpc", method: data.method, params: data.params }, (res) => {
    const failed = chrome.runtime.lastError?.message;
    let error: { code: number; message: string } | undefined;
    if (failed) error = { code: -32603, message: failed };
    else if (typeof res?.error === "string") error = { code: -32603, message: res.error };
    else if (res?.error?.message) error = res.error;
    window.postMessage({ ch: "wisprr-reply", id: data.id, result: res?.result, error }, "*");
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "accounts" && Array.isArray(msg.accounts)) {
    window.postMessage({ ch: "wisprr-event", event: "accountsChanged", data: msg.accounts }, "*");
  }
  if (msg?.type === "chain" && typeof msg.chainId === "string") {
    window.postMessage({ ch: "wisprr-event", event: "chainChanged", data: msg.chainId }, "*");
  }
});

export {};
