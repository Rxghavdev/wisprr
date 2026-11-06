import { decodeFunctionResult, encodeFunctionData, formatUnits, parseEther } from "viem";
import { anonRequest } from "./rpc";

// Quoter on Ethereum mainnet, from Uniswap v3-periphery deploys.md.
// https://github.com/Uniswap/v3-periphery/blob/v1.0.0/deploys.md
const QUOTER = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";
// Pair used in the Uniswap deployments example: WETH / USDC, fee 3000.
// https://docs.uniswap.org/contracts/v3/reference/deployments/
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const quoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "amountIn", type: "uint256" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

// WETH in, USDC out. The Quoter simulates the swap and returns the amount.
export async function quoteEthToUsdc(eth: string): Promise<string> {
  const amountIn = parseEther(eth.trim() || "0");
  if (amountIn <= 0n) throw new Error("Amount has to be more than zero.");
  const data = encodeFunctionData({
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [WETH, USDC, 3000, amountIn, 0n],
  });
  const hex = (await anonRequest("eth_call", [{ to: QUOTER, data }, "latest"])) as `0x${string}`;
  const amount = decodeFunctionResult({
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    data: hex,
  });
  const [whole, frac = ""] = formatUnits(amount, 6).split(".");
  return frac ? `${whole}.${frac.slice(0, 2)}` : whole;
}
