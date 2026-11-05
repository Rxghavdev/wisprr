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
  if (msg?.type !== "accounts" || !Array.isArray(msg.accounts)) return;
  window.postMessage({ ch: "wisprr-event", event: "accountsChanged", data: msg.accounts }, "*");
});

export {};
