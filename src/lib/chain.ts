const KEY = "wisprr-net";

export const MAINNET_RPC = "https://ethereum-rpc.publicnode.com";
// Answered eth_chainId 0xaa36a7 when asked.
export const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

export type NetName = "mainnet" | "sepolia";

export async function currentNet(): Promise<NetName> {
  const bag = await chrome.storage.local.get(KEY);
  return bag[KEY] === "sepolia" ? "sepolia" : "mainnet";
}

export async function setNet(name: NetName): Promise<void> {
  await chrome.storage.local.set({ [KEY]: name });
}

export function netInfo(name: NetName) {
  if (name === "sepolia") {
    return {
      name: "Sepolia",
      hex: "0xaa36a7",
      id: 11155111,
      rpc: SEPOLIA_RPC,
      explorer: "https://eth-sepolia.blockscout.com",
    };
  }
  return {
    name: "Mainnet",
    hex: "0x1",
    id: 1,
    rpc: MAINNET_RPC,
    explorer: "https://eth.blockscout.com",
  };
}

// A link a user can open to see the transaction themselves, including its status.
export function txUrl(name: NetName, hash: string): string {
  return `${netInfo(name).explorer}/tx/${hash}`;
}

export function addressUrl(name: NetName, address: string): string {
  return `${netInfo(name).explorer}/address/${address}`;
}

export function netFromHex(hex: string): NetName | undefined {
  const id = hex.toLowerCase();
  if (id === "0x1" || id === "0x01") return "mainnet";
  if (id === "0xaa36a7") return "sepolia";
}
