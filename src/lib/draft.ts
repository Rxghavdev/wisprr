const KEY = "wisprr-draft";

export type Draft = { password: string; mnemonic: string; at: number };

// A phrase that has been shown but not sealed yet. Chrome stops the service worker
// when it goes idle, so this cannot live in a variable. Session storage keeps it for
// the browser session only, never on disk, and the background owns it.
export async function writeDraft(draft: Omit<Draft, "at">): Promise<void> {
  await chrome.storage.session.set({ [KEY]: { ...draft, at: Date.now() } });
}

export async function readDraft(): Promise<Draft | undefined> {
  const bag = await chrome.storage.session.get(KEY);
  const draft = bag[KEY] as Draft | undefined;
  if (!draft?.mnemonic) return;
  // Reading twelve words takes a minute. Ten is long enough to survive a reload of the panel.
  if (Date.now() - draft.at > 10 * 60_000) {
    await clearDraft();
    return;
  }
  return draft;
}

export async function clearDraft(): Promise<void> {
  await chrome.storage.session.remove(KEY);
}
