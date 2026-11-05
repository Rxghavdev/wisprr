# wisprr

Ethereum mainnet wallet. Reads go out through Anon-RPC. A site can connect the way it connects any wallet. The home screen looks up the ENS name for the address, and can price 0.01 ETH in USDC on the Uniswap v3 quoter. Signing is not in this build yet. Keys stay in the browser.

```
npm install
npm run build
```

Open `chrome://extensions`, turn on Developer mode, Load unpacked, pick `dist/unpacked`. Click the wisprr icon. The wallet opens in the side panel of that same window.
