require("log-timestamp");

import { HyperClient, MessageStatusWithMeta } from "@polytope-labs/hyperclient";
import { config } from "dotenv";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  fromHex,
  getContract,
  http,
  parseAbi,
  parseEther,
  parseEventLogs,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

import ERC6160 from "./abis/erc6160";
import PING_MODULE from "./abis/pingModule";
import EVM_HOST from "./abis/evmHost";

/*
  Using a viem client, dispatches an onchain transaction to the ping module.
  The ping module contract, dispatches an ISMP request to Hyperbridge.
  Then tracks the resulting ISMP request using Hyperclient.
*/
async function sendCrossChainMessage() {
  const blockNumber = await bscClient.getBlockNumber();

  console.log("Latest block number: ", blockNumber);

  let balance = await feeToken.read.balanceOf([account.address as any]);

  console.log("FeeToken balance: $", formatEther(balance));

  // Get fee tokens from faucet
  if (balance === BigInt(0)) {
    await tokenFaucet.write.drip();
    balance = await feeToken.read.balanceOf([account.address as any]);

    console.log("New FeeToken balance: $", formatEther(balance));
  }

  const allowance = await feeToken.read.allowance([
    account.address!,
    PING_MODULE_ADDRESS,
  ]);

  if (allowance === BigInt(0)) {
    console.log("Setting allownce");
    // set allowance to type(uint256).max
    feeToken.write.approve([
      PING_MODULE_ADDRESS,
      fromHex(
        "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "bigint",
      ),
    ]);
  }

  const hash = await ping.write.ping([
    {
      dest: toHex("OPTI"),
      count: BigInt(50),
      fee: parseEther("0.1"), // $0.1
      module: PING_MODULE_ADDRESS,
      timeout: BigInt(60 * 60),
    },
  ]);

  const receipt = await bscClient.waitForTransactionReceipt({
    hash,
    confirmations: 1,
  });

  console.log(
    `Transaction reciept: ${bscTestnet.blockExplorers.default.url}/tx/${hash}`,
  );
  console.log("Block: ", receipt.blockNumber);

  const event = parseEventLogs({ abi: EVM_HOST.ABI, logs: receipt.logs })[0];

  if (event.eventName !== "PostRequestEvent") {
    throw new Error("Unexpected Event type");
  }

  const request = event.args;

  console.log({ request });

  console.log("Setting up hyperclient");

  const hyperclient = await HyperClient.init({
    source: {
      ...BSC,
      rpc_url: process.env.BSC_URL!,
    },
    dest: {
      ...OP,
      rpc_url: process.env.OP_URL!,
    },
    hyperbridge: {
      rpc_url: "wss://hyperbridge-paseo-rpc.blockops.network",
    },
    indexer: "",
  });

  const postRequest = {
    source: request.source,
    dest: request.dest,
    from: request.from,
    to: request.to,
    data: request.data,
    height: receipt.blockNumber,
    nonce: request.nonce,
    timeout_timestamp: request.timeoutTimestamp,
  };

  const status = await hyperclient.query_request_status(postRequest);

  console.log("Request status: ", status);

  const stream = await hyperclient.request_status_stream(postRequest);

  for await (const item of stream) {
    const status = Object.fromEntries(
      (item as any).entries(),
    ) as MessageStatusWithMeta;

    console.log({ status });

    switch (status.kind) {
      case "SourceFinalized": {
        console.log(
          `Status ${status.kind}, Transaction: https://gargantua.statescan.io/#/extrinsics/${status.transaction_hash}`,
        );
        break;
      }
      case "HyperbridgeDelivered": {
        console.log(
          `Status ${status.kind}, Transaction: https://gargantua.statescan.io/#/extrinsics/${status.transaction_hash}`,
        );
        break;
      }
      case "HyperbridgeFinalized": {
        console.log(
          `Status ${status.kind}, Transaction: https://sepolia-optimism.etherscan.io/tx/${status.transaction_hash}`,
        );
        break;
      }
      case "DestinationDelivered": {
        console.log(
          `Status ${status.kind}, Transaction: https://sepolia-optimism.etherscan.io/tx/${status.transaction_hash}`,
        );
        return;
      }
    }
  }
}

config();

const PING_MODULE_ADDRESS = "0x9Cc29770F3d643F4094Ee591f3D2E3c98C349761";

const account = privateKeyToAccount(process.env.PRIVATE_KEY as any);

const walletClient = createWalletClient({
  chain: bscTestnet,
  account,
  transport: http(),
});

const bscClient = createPublicClient({
  chain: bscTestnet,
  transport: http(),
});

const feeToken = getContract({
  address: "0x6B0e814557b15D67db6F0F147702d209DBEd8D1A",
  abi: ERC6160.ABI,
  client: { public: bscClient, wallet: walletClient },
});

const tokenFaucet = getContract({
  address: "0x5DB219e4A535E211a70DA94BaFa291Fc1a51f865",
  abi: parseAbi(["function drip() public"]),
  client: { public: bscClient, wallet: walletClient },
});

const ping = getContract({
  address: PING_MODULE_ADDRESS,
  abi: PING_MODULE.ABI,
  client: { public: bscClient, wallet: walletClient },
});

const BSC = {
  consensus_state_id: "BSC0",
  host_address: "0xE6bd95737DD35Fd0e5f134771A832405671f06e9",
  handler_address: "0xBA82A7c413BfbE26ee025DA221088319b895A8E6",
  state_machine: "BSC",
};

const OP = {
  consensus_state_id: "ETH0",
  host_address: "0x0D811D581D615AA44A36aa638825403F9b434E18",
  handler_address: "0x6DbcA7CAEBd47D377E230ec3EFaBDdf0A7afA395",
  state_machine: "OPTI",
};

sendCrossChainMessage();

0x2b0207ea2d401d5b6592d3f755ed6ae125db76f4b6423ce2d4cd537be33811fa643618a9007023ed38de168f55e7c0b7460ca8f2c1be0145bdc0c40ea66479ac8e44c53cecdc5bb7e6189b6563f918ac72b27daa4ea98b28421cd82c17813a61831d5f1526228d82dd6dacd2db82acddbc3b12842ed9ff684b4df03001d0c9f3aa1186751f8c83f6c6689b013c3afd04d0b9e96d537e28397203e19161aade1bc26a6f0f6d029c029dcce116b81d07839cfde9b7f929779a4fd410e584239d9dc9f31c74a299d43833944b90a11c7b4c663956a98ef37e12c1651dd0460f0a6c71dd9fdf7757c0f7df2d55999376b90b1a3f640b7205ab354266b23c50edc942;
