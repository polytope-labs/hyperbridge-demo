require("log-timestamp");

import { HyperClient, MessageStatusWithMeta } from "@polytope-labs/hyperclient";
import { config } from "dotenv";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  formatEther,
  fromHex,
  getContract,
  http,
  parseAbi,
  parseEventLogs,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet, optimismSepolia } from "viem/chains";

import ERC6160 from "./abis/erc6160";
import PING_MODULE from "./abis/pingModule";
import EVM_HOST from "./abis/evmHost";
import HANDLER from "./abis/handler";

/*
  Using a viem client, dispatches an onchain transaction to the ping module.
  The ping module contract, dispatches an ISMP request to Hyperbridge.
  Then tracks the resulting ISMP request using Hyperclient.
*/
async function sendCrossChainMessage() {
  const blockNumber = await bscTestnetClient.getBlockNumber();
  console.log("Latest block number: ", blockNumber);

  let balance = await feeToken.read.balanceOf([account.address as any]);
  console.log("FeeToken balance: $", formatEther(balance));

  // Get fee tokens from faucet
  if (balance === BigInt(0)) {
    const hash = await tokenFaucet.write.drip([feeToken.address]);
    await bscTestnetClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
    });
    balance = await feeToken.read.balanceOf([account.address as any]);

    console.log("New FeeToken balance: $", formatEther(balance));
  }

  const allowance = await feeToken.read.allowance([
    account.address!,
    PING_MODULE_ADDRESS,
  ]);

  if (allowance === BigInt(0)) {
    console.log("Setting allownce .. ");
    // set allowance to type(uint256).max
    const hash = await feeToken.write.approve([
      PING_MODULE_ADDRESS,
      fromHex(
        "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "bigint",
      ),
    ]);
    await bscTestnetClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
    });
  }

  const hash = await ping.write.ping([
    {
      dest: toHex("OPTI"),
      count: BigInt(1),
      fee: BigInt(0),
      module: PING_MODULE_ADDRESS,
      timeout: BigInt(60 * 60),
    },
  ]);

  const receipt = await bscTestnetClient.waitForTransactionReceipt({
    hash,
    confirmations: 1,
  });

  console.log(
    `Transaction reciept: ${bscTestnet.blockExplorers.default.url}/tx/${hash}`,
  );
  console.log("Block: ", receipt.blockNumber);

  // parse EvmHost PostRequestEvent emitted in the transcation logs
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
    ...request,
    height: receipt.blockNumber,
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
        const { args, functionName } = decodeFunctionData({
          abi: HANDLER.ABI,
          data: status.calldata,
        });

        try {
          const hash = await opSepoliaHandler.write.handlePostRequests(
            args as any,
          );
          await opSepoliaClient.waitForTransactionReceipt({
            hash,
            confirmations: 1,
          });

          console.log(
            `Transaction submitted: https://sepolia-optimism.etherscan.io/tx/${hash}`,
          );
        } catch (e) {
          console.error("Error self-relaying: ", e);
        }

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

const PING_MODULE_ADDRESS = "0x8E4Ca395cfAa033A71fC618792Fce99106633B90";

const account = privateKeyToAccount(process.env.PRIVATE_KEY as any);

const bscWalletClient = createWalletClient({
  chain: bscTestnet,
  account,
  transport: http(),
});

const opWalletClient = createWalletClient({
  chain: optimismSepolia,
  account,
  transport: http(),
});

const bscTestnetClient = createPublicClient({
  chain: bscTestnet,
  transport: http(),
});

const opSepoliaClient = createPublicClient({
  chain: optimismSepolia,
  transport: http(),
});

const feeToken = getContract({
  address: "0x83311D74692ce1A8859F908880b3EdEC67f05997",
  abi: ERC6160.ABI,
  client: { public: bscTestnetClient, wallet: bscWalletClient },
});

const opSepoliaHandler = getContract({
  address: "0xB9Ffd43C720A695d40C14896494c1461f3fBb8A7",
  abi: HANDLER.ABI,
  client: { public: opSepoliaClient, wallet: opWalletClient },
});

const tokenFaucet = getContract({
  address: "0x5b90b886d302c7DEbA10a2E02c521B3bE930070B",
  abi: parseAbi(["function drip(address token) public"]),
  client: { public: bscTestnetClient, wallet: bscWalletClient },
});

const ping = getContract({
  address: PING_MODULE_ADDRESS,
  abi: PING_MODULE.ABI,
  client: { public: bscTestnetClient, wallet: bscWalletClient },
});

const BSC = {
  consensus_state_id: "BSC0",
  host_address: "0x9494400D1A8285F81604AC04ACFD839385B3b843",
  state_machine: "BSC",
};

const OP = {
  consensus_state_id: "ETH0",
  host_address: "0x265FafEb401ac6491da7344F01E724c38bC68FED",
  state_machine: "OPTI",
};

sendCrossChainMessage();
