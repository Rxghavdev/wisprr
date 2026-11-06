# Testing

```sh
npm run typecheck   # types
npm test            # 37 assertions
npm run build       # writes dist/unpacked
```

`npm test` runs without a browser. The UI and the mixnet need a real Chrome,
because an extension cannot load in a headless runner.

## What npm test covers

| Area | What it checks |
|---|---|
| Stealth addresses | Meta-address format, 20 payments give 20 distinct addresses, all recoverable, wrong view tag rejected, a stranger cannot open one, the phrase restores the same meta-address, the derived key signs for the address |
| Disclosure | Auditor identifies every payment, foreign payments stay invisible, the grant holds no spending key |
| Grants | Inside the window identified, outside refused, exact boundaries, expiry enforced, hash commits to grantee and window |
| Leak guard | H1 and H2 block, H3 to H5 warn, silent when they should be, spent payments don't count toward H3 |
| Signing | personal_sign and typed data both verify |

## Checking it by hand

### 1. It loads

`chrome://extensions`, Developer mode, Load unpacked, pick `dist/unpacked`.

No error banner, icon in the toolbar, clicking it opens the side panel on the
create-wallet screen.

If the service worker reports an error, open it and read the console. Usually a
stale `dist`, or the anon-rpc assets were not copied. Check that
`dist/unpacked/anon-rpc/` contains a folder with a version and hash in its name.

### 2. Creating a wallet

Password of 8 or more characters, write the twelve words down, confirm.

You should land on the home screen with a balance and a note saying it came
through the mixnet.

The first call takes 10 to 60 seconds. That is the mixnet booting: resolving the
worker from an on-chain specifier, then fetching its bundle. The UI says "mixnet
starting" while it happens.

If it never resolves, the versioned folder under `dist/unpacked/anon-rpc/` does
not match the bundled harness. Rebuild rather than copying files around.

### 3. Receiving

Open the **Receive** tab and copy the meta-address. It starts `st:eth:0x`
followed by 132 hex characters.

In a second wallet, on another Chrome profile, go to the **Send** tab on Sepolia
and paste it. That submits two transactions: the transfer, then `announce()`.

On Sepolia Blockscout you should see a transfer to an address you have never seen
before, and an `Announcement` log on `0x55649E01B5Df198D18D95b5cc5051630cfD45564`.

### 4. Scanning

Back on the first wallet, **Receive** tab, Scan for payments.

If the payment does not show up:

- Check the announce transaction went through, not just the transfer.
- Check the view tag. It is the first byte of the announcement's `metadata`.
- Only that announcer address is scanned. A different contract will never appear.

### 5. The guard

This is the part worth demonstrating, so test it directly.

Sweep a payment to the wallet's own address (the one in the hero at the top).
It should be blocked, with an explanation.

Then sweep to an address that has never touched this wallet. That should go
through, possibly with warnings about timing or gas.

The UI check is not the enforcement. The message handler refuses as well, so a
caller that skips the pre-check still cannot sign. To prove it, from the service
worker console:

```js
chrome.runtime.sendMessage({ type: "sweep", address: "<stealth address>", to: "<your vault>" })
  .then(console.log)
// expected: { error: "H1 destination reuse: ..." }
```

If that returns a transaction hash instead, the guard is not wired and the
central claim is false.

### 6. Grants

**Audit** tab. Grantee `Auditor AG`, purpose `Q3 2026`, and a window that covers
your test payment. Issue it and copy the viewing key and spending key.

Open the auditor view, paste both, set the same window, scan. The payment appears.

Now change the window so it does not cover the payment. Scan again. You should get
nothing back. That refusal is the point, so try it with a window in a different
month entirely.

### 7. Token sweep

Needs USDC sitting at a stealth address on Sepolia:
`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`.

The stealth address holds zero ETH before, during and after. That is correct, and
it is why the token sweep exists.

You should see a `transferWithAuthorization` transaction sent from your vault to
the USDC contract. If it reverts with `invalid signature`, the EIP-712 domain is
wrong for that chain. The code uses name `USDC`, version `2`, and the chain id.

## When something is wrong

| Symptom | First thing to check |
|---|---|
| Side panel is blank | Service worker console, then the panel console |
| "mixnet failed" | The specifier read. Is `https://ethereum-rpc.publicnode.com` reachable? |
| Scan finds nothing | The announce transaction, then the announcer address, then the view tag |
| Sweep says the payment is not yours | It was scanned under a different phrase |
| Auditor scan returns everything | The window was ignored. Check `scopedRecogniser` is used, not `auditView` |

## Not tested

- No audit. Nobody else has read this code.
- No mainnet run. Everything above is Sepolia.
- The mixnet boot under concurrency. One worker, one identity.
- Restoring from a backup on a second machine and scanning real payments.
