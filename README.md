# wisprr

Ethereum wallet. Reads go out through Anon-RPC. A site can connect the way it connects any wallet. The home screen looks up the ENS name on mainnet through the mixnet, and prices ETH in USDC on the Uniswap v3 quoter. Sepolia can send a plain ETH transfer. Keys stay in the browser.

```
npm install
npm run build
```

Open `chrome://extensions`, turn on Developer mode, Load unpacked, pick `dist/unpacked`. Click the wisprr icon. The wallet opens in the side panel of that same window.
