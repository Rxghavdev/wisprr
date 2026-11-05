const KEY = "wisprr-sites";

async function list(): Promise<string[]> {
  const bag = await chrome.storage.local.get(KEY);
  return (bag[KEY] as string[] | undefined) ?? [];
}

export async function allowed(origin: string): Promise<boolean> {
  return (await list()).includes(origin);
}

export async function allow(origin: string): Promise<void> {
  const have = new Set(await list());
  have.add(origin);
  await chrome.storage.local.set({ [KEY]: [...have] });
}

export async function hosts(): Promise<string[]> {
  return (await list()).map((origin) => {
    try {
      return new URL(origin).host;
    } catch {
      return origin;
    }
  });
}
