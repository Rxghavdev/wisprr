const VAULT = "wisprr-vault";
const OPEN = "wisprr-open";

type Sealed = { salt: string; iv: string; ct: string };

const enc = new TextEncoder();
const dec = new TextDecoder();

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function unhex(s: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function key(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: 120_000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function hasVault(): Promise<boolean> {
  const bag = await chrome.storage.local.get(VAULT);
  return Boolean(bag[VAULT]);
}

export async function seal(password: string, mnemonic: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await key(password, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, enc.encode(mnemonic)));
  const sealed: Sealed = { salt: hex(salt), iv: hex(iv), ct: hex(ct) };
  await chrome.storage.local.set({ [VAULT]: sealed });
}

export async function open(password: string): Promise<string> {
  const bag = await chrome.storage.local.get(VAULT);
  const sealed = bag[VAULT] as Sealed | undefined;
  if (!sealed) throw new Error("no wallet on this browser yet");
  const k = await key(password, unhex(sealed.salt));
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unhex(sealed.iv) }, k, unhex(sealed.ct));
    const mnemonic = dec.decode(plain);
    await chrome.storage.session.set({ [OPEN]: mnemonic });
    return mnemonic;
  } catch {
    throw new Error("wrong password");
  }
}

export async function lock(): Promise<void> {
  await chrome.storage.session.remove(OPEN);
}

export async function sessionMnemonic(): Promise<string | undefined> {
  const bag = await chrome.storage.session.get(OPEN);
  return bag[OPEN] as string | undefined;
}
