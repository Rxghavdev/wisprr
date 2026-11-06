const KEY = "wisprr-sites";

type Record_ = { origin: string; at: number };

async function list(): Promise<Record_[]> {
  const bag = await chrome.storage.local.get(KEY);
  const raw = bag[KEY];
  if (!Array.isArray(raw)) return [];
  // Older builds stored bare origins.
  return raw.map((row) => (typeof row === "string" ? { origin: row, at: 0 } : (row as Record_)));
}

async function save(rows: Record_[]): Promise<void> {
  await chrome.storage.local.set({ [KEY]: rows });
}

export function hostOf(origin: string) {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export async function allowed(origin: string): Promise<boolean> {
  return (await list()).some((row) => row.origin === origin);
}

export async function allow(origin: string): Promise<void> {
  const rows = await list();
  if (rows.some((row) => row.origin === origin)) return;
  await save([...rows, { origin, at: Date.now() }]);
}

export async function revoke(origin: string): Promise<void> {
  await save((await list()).filter((row) => row.origin !== origin));
}

export async function origins(): Promise<string[]> {
  return (await list()).map((row) => row.origin);
}

export async function hosts(): Promise<{ host: string; origin: string; at: number }[]> {
  return (await list()).map((row) => ({ host: hostOf(row.origin), origin: row.origin, at: row.at }));
}
