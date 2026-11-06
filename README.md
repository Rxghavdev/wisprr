# wisprr

A privacy wallet for Ethereum. Chrome extension, own keys, no backend.

## What it does

**Hides your IP from the RPC.** Reads, broadcasts and log queries all go through
Anon-RPC, which routes them over Nym. The node still sees which address you asked
about. It doesn't see where the question came from.

**Hides who owns a payment.** ERC-5564 stealth addresses. You publish a
meta-address, which isn't an address. Each payment to it gets its own throwaway one,
derived from an ephemeral key the sender picks. Two payments can't be connected to
the same person, even by the sender.

**Lets you prove your history to one person.** A grant names an auditor, states a
purpose, and covers a date range. They see payments inside it. Payments outside it
aren't filtered out, they're never recognised. The key can't move money and the
grant expires.

**Moves tokens out of a stealth address with no gas.** USDC implements ERC-3009, so
the stealth address signs an authorisation offline and this wallet submits it and
pays the fee. No ETH touches the stealth address, so there's no funding transaction
pointing back at you.

## The part that's different

The wallet won't sign a sweep that publishes a link between a stealth address and
you. Most wallets warn. This one refuses, at signing, not just in the UI. Five rules
from the published deanonymisation work:

| Rule | What it catches | Blocks? |
|---|---|---|
| H1 destination reuse | Sweeping to your own vault, tying every private payment to one public address | yes |
| H2 round trip | Sweeping back to whoever paid you | yes |
| H3 collector pattern | Draining several stealth addresses close together | warns |
| H4 gas funding | Sending ETH to a stealth address so it can pay for itself | warns |
| H5 timing | Sweeping minutes after receipt | warns |

This doesn't make the wallet private and doesn't fix the destination link. It stops
the mistakes people actually make. Across three generations of these systems 44% to
73% of recipients end up linkable, and the leak is at the spend step.

## Running it

```sh
npm install
npm run build
npm test
```

Then `chrome://extensions`, turn on Developer mode, Load unpacked, pick
`dist/unpacked`. Click the icon and the wallet opens in the side panel.

`npm test` runs 37 assertions. It covers the stealth maths, the guard rules, and
the grant windows. It does not cover the UI or the mixnet, because those need a real
browser. `TESTING.md` has the manual steps for that part.

## CROPS

**C - censorship resistance.** No server, no API, no relayer, no domain. Recovery is
twelve words, no vendor. The only outside dependency is a public RPC, and you can
swap it.

**O - open source.** MIT. `npm install && npm run build` builds the extension from
the repo with nothing private involved.

**P - what third parties learn.**

| Third party | Learns | Doesn't learn |
|---|---|---|
| RPC provider, reads | The address or call you asked about | Your IP, it comes through Nym |
| RPC provider, broadcasts | The signed transaction | Your IP |
| Blockscout, Uniswap data API | The address being looked up | Your IP |
| ERC-5564 announcer | A stealth address and an ephemeral key | Who owns it |
| ERC-6538 registry | Your meta-address, if you publish it | Your address or balances |
| A site you connect | Your address | Your stealth payments |
| An auditor you grant | Payments inside the window | Anything outside it, and they can't spend |

Two things do go out in the clear. The anon-rpc specifier read, which only reveals
that someone at that IP runs an anon-rpc client, with no address attached. And the
bundle fetch, which reveals an IP but not an address.

No analytics, no telemetry, no trackers.

**S - keys and trust.** The phrase is sealed with AES-GCM under PBKDF2 (120k,
SHA-256) in `chrome.storage.local`, and lives unlocked in `chrome.storage.session`,
which is memory only. Every key comes from that phrase when needed and is never
written down.

What you trust: your own device, secp256k1, and nothing else in the privacy path.
No operator, notary, TEE or server. The announcer is a public contract that can't
withhold announcements from you, and you can scan it yourself. The anon-rpc worker
runs in a sandboxed iframe at a null origin with no extension APIs, so it can't
reach your keys.

## Where this stops

1. **Almost nobody uses the standard.** The ERC-5564 announcer has 222 transactions
   in its whole mainnet history. The ERC-6538 registry has 10. About 250 addresses
   have received a stealth payment on L1. That's the anonymity set.

2. **Sweeping to your main wallet is a public link.** The stealth address and your
   vault end up in the same transaction. Privacy when you receive, not when you
   spend. Fixing it needs a shielded pool or a relayer, and this build has neither.

3. **Timing correlates.** Receive at 14:02, sweep at 14:03, obviously the same
   person. Median gap in the published data is under a day.

4. **A viewing key is retroactive and irrevocable.** Grants add scope, expiry and a
   log, but anyone who has already seen data can't be made to forget it.

5. **No screening.** Nothing proves you're not on a sanctions list, and a
   counterparty can't ask you for that yet.

6. **Amounts are visible.** A stealth address hides who, not how much.

7. **The payer is visible.** When you pay privately your address is the `from`.
   This protects the recipient, not you.

8. **ERC-20 sweeps depend on the token.** ERC-3009 works because USDC implements it.

9. **Mainnet history needs an archive RPC.** Public nodes won't serve deep
   `eth_getLogs` without a token.

10. **Not audited.** Nobody else has read this code.

## Addresses

Everything below is the same on every chain, deployed with CREATE2.

- ERC-5564 announcer: `0x55649E01B5Df198D18D95b5cc5051630cfD45564`
- ERC-6538 registry: `0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538`
- Sepolia USDC (ERC-3009): `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`
- Mainnet USDC (ERC-3009): `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`
