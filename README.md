# wisprr

Ethereum wallet. Reads go out through Anon-RPC. A site can connect the way it connects any wallet. The home screen looks up the ENS name on mainnet through the mixnet, and shows the ETH price, daily change, volume, and TVL from Uniswap. A plain ETH transfer sends on Sepolia. Keys stay in the browser.

```
npm install
npm run build
```

Open `chrome://extensions`, turn on Developer mode, Load unpacked, pick `dist/unpacked`. Click the wisprr icon. The wallet opens in the side panel of that same window.
