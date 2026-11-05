const WIDTH = 360;
const HEIGHT = 600;

// Chrome often ignores width and height on windows.create, and a popup can
// come back maximized. The size has to be applied again after create.
export async function showPanel(url: string, anchorWindowId?: number) {
  const place = await corner(anchorWindowId);
  const existing = await find(url);
  if (existing) {
    if (existing.tabId != null && existing.tabUrl !== url) {
      await chrome.tabs.update(existing.tabId, { url, active: true });
    }
    await squeeze(existing.windowId, place);
    return existing.windowId;
  }
  const created = await chrome.windows.create({
    url,
    type: "popup",
    width: WIDTH,
    height: HEIGHT,
    left: place.left,
    top: place.top,
    focused: true,
  });
  if (created?.id == null) return;
  await squeeze(created.id, place);
  return created.id;
}

async function find(url: string) {
  const base = url.split("?")[0];
  const wins = await chrome.windows.getAll({ populate: true });
  for (const win of wins) {
    const tab = win.tabs?.find((item) => (item.url || "").split("?")[0] === base);
    if (!tab || win.id == null) continue;
    const alone = (win.tabs?.length ?? 0) === 1;
    if (win.type === "popup" || alone) return { windowId: win.id, tabId: tab.id, tabUrl: tab.url };
    if (tab.id != null) await chrome.tabs.remove(tab.id);
  }
}

async function corner(anchorWindowId?: number) {
  let left = 24;
  let top = 48;
  try {
    const parent =
      anchorWindowId != null
        ? await chrome.windows.get(anchorWindowId)
        : await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (parent.type !== "popup" && parent.left != null && parent.top != null && parent.width != null) {
      left = Math.max(0, Math.round(parent.left + parent.width - WIDTH - 24));
      top = Math.max(0, Math.round(parent.top + 64));
    }
  } catch {
    /* keep the fallback corner */
  }
  return { left, top };
}

async function squeeze(id: number, place: { left: number; top: number }) {
  const fit = async () => {
    await chrome.windows.update(id, { state: "normal" });
    await chrome.windows.update(id, {
      left: place.left,
      top: place.top,
      width: WIDTH,
      height: HEIGHT,
      focused: true,
    });
  };
  try {
    await fit();
  } catch {
    return;
  }
  setTimeout(() => fit().catch(() => {}), 120);
  setTimeout(() => fit().catch(() => {}), 360);
}
