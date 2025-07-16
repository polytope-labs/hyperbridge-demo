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
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Account } from "@ethereumjs/util";

import ERC6160 from "./abis/erc6160";
import PING_MODULE from "./abis/pingModule";
import EVM_HOST from "./abis/evmHost";
import HANDLER from "./abis/handler";

const PING_MODULE_ADDRESS = "0xFE9f23F0F2fE83b8B9576d3FC94e9a7458DdDD35";

/*
  Using a viem client, dispatches an onchain transaction to the ping module.
  The ping module contract, dispatches an ISMP request to Hyperbridge.
  Then tracks the resulting ISMP request using Hyperclient.
*/
async function testPostAndGetRequest() {
  const {
    bscTestnetClient,
    bscFeeToken,
    BSC,
    OP,
    account,
    tokenFaucet,
    opSepoliaHandler,
    bscHandler,
    bscPing,
    opSepoliaClient,
    opSepoliaIsmpHost,
  } = await setUp();
  const blockNumber = await bscTestnetClient.getBlockNumber();
  console.log("Latest block number: ", blockNumber);

  let balance = await bscFeeToken.read.balanceOf([account.address as any]);
  console.log("FeeToken balance: $", formatEther(balance));

  // Get fee tokens from faucet
  if (balance === BigInt(0)) {
    const hash = await tokenFaucet.write.drip([bscFeeToken.address]);
    await bscTestnetClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
    });
    balance = await bscFeeToken.read.balanceOf([account.address as any]);

    console.log("New FeeToken balance: $", formatEther(balance));
  }

  const allowance = await bscFeeToken.read.allowance([account.address!, PING_MODULE_ADDRESS]);

  if (allowance === BigInt(0)) {
    console.log("Setting allowance .. ");
    // set allowance to type(uint256).max
    const hash = await bscFeeToken.write.approve([
      PING_MODULE_ADDRESS,
      fromHex("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", "bigint"),
    ]);
    await bscTestnetClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
    });
  }

  console.log("Setting up hyperclient");

  const HyperbridgeConfig = {
    // rpc_url: "ws://127.0.0.1:9001",
    state_machine: "KUSAMA-4009",
    rpc_url: "wss://hyperbridge-paseo-rpc.blockops.network",
  };

  console.log(
    JSON.stringify(
      {
        source: BSC,
        dest: OP,
        hyperbridge: HyperbridgeConfig,
        indexer: "",
      },
      null,
      4,
    ),
  );

  const hyperclient = await HyperClient.init({
    source: BSC,
    dest: OP,
    hyperbridge: HyperbridgeConfig,
    indexer: "",
  });

  // send GetRequest
  console.log("\n\nSending Get Request\n\n");

  const wsProvider = new WsProvider(HyperbridgeConfig.rpc_url);
  const api = await ApiPromise.create({ provider: wsProvider });
  const height = (
    await api.query.ismp.latestStateMachineHeight({
      stateId: {
        Evm: 11155420,
      },
      consensusStateId: "ETH0",
    })
  ).toJSON() as number;

  const txHash = await bscPing.write.dispatch([
    {
      source: "0x",
      dest: OP.state_machine,
      nonce: 0n,
      context: "0x",
      from: account.address,
      keys: [account.address, opSepoliaIsmpHost.address, opSepoliaHandler.address],
      height: BigInt(height), // latest height
      timeoutTimestamp: 0n,
    },
  ]);

  const txReceipt = await bscTestnetClient.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 1,
  });

  console.log(`Transaction reciept: ${bscTestnet.blockExplorers.default.url}/tx/${txHash}`);
  console.log("Block: ", txReceipt.blockNumber);

  // parse EvmHost PostRequestEvent emitted in the transcation logs
  const txEvent = parseEventLogs({ abi: EVM_HOST.ABI, logs: txReceipt.logs })[0];

  if (txEvent.eventName !== "GetRequestEvent") {
    throw new Error("Unexpected Event type");
  }

  const txRequest = txEvent.args;

  console.log({ txRequest });

  const getRequest = {
    ...txRequest,
  };

  const statusStream = await hyperclient.get_request_status_stream(getRequest as any, {
    Dispatched: txReceipt.blockNumber,
  });

  for await (const item of statusStream) {
    let status: MessageStatusWithMeta;
    if (item instanceof Map) {
      status = Object.fromEntries((item as any).entries()) as MessageStatusWithMeta;
    } else {
      status = item;
    }

    console.log({ status });

    switch (status.kind) {
      case "SourceFinalized": {
        console.log(
          `Status ${status.kind}, Transaction: https://gargantua.statescan.io/#/extrinsics/${status.transaction_hash}`,
        );
        break;
      }
      case "HyperbridgeVerified": {
        console.log(
          `Status ${status.kind}, Transaction: https://gargantua.statescan.io/#/extrinsics/${status.transaction_hash}`,
        );
        break;
      }
      case "HyperbridgeFinalized": {
        console.log(
          `Status ${status.kind}, Transaction: ${bscTestnet.blockExplorers.default.url}/tx/${status.transaction_hash}`,
        );
        const { args, functionName } = decodeFunctionData({
          abi: HANDLER.ABI,
          data: status.calldata,
        });

        try {
          const hash = await bscHandler.write.handleGetResponses(args as any);
          const getResponseReceipt = await bscTestnetClient.waitForTransactionReceipt({
            hash,
            confirmations: 1,
          });

          console.log(`Transaction submitted: ${bscTestnet.blockExplorers.default.url}/tx/${hash}`);

          const event = parseEventLogs({ abi: PING_MODULE.ABI, logs: getResponseReceipt.logs })[0];

          if (event.eventName === "GetResponseReceived") {
            // we requested the raw account in the world state, here we decode the response
            for (const { key, value } of event.args.message) {
              console.log({
                address: key,
                account: Account.fromRlpSerializedAccount(value as any),
              });
            }
          }
        } catch (e) {
          console.error("Error self-relaying: ", e);
        }
        break;
      }
      case "DestinationDelivered": {
        console.log(
          `Status ${status.kind}, Transaction: ${bscTestnet.blockExplorers.default.url}/tx/${status.transaction_hash}`,
        );
        break;
      }
    }
  }
}

async function setUp() {
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

  const bscPing = getContract({
    address: PING_MODULE_ADDRESS,
    abi: PING_MODULE.ABI,
    client: { public: bscTestnetClient, wallet: bscWalletClient },
  });

  const bscIsmpHostAddress = await bscPing.read.host();

  const bscIsmpHost = getContract({
    address: bscIsmpHostAddress,
    abi: EVM_HOST.ABI,
    client: bscTestnetClient,
  });

  const bscHostParams = await bscIsmpHost.read.hostParams();

  const bscHandler = getContract({
    address: bscHostParams.handler,
    abi: HANDLER.ABI,
    client: { public: bscTestnetClient, wallet: bscWalletClient },
  });

  const bscFeeToken = getContract({
    address: bscHostParams.feeToken,
    abi: ERC6160.ABI,
    client: { public: bscTestnetClient, wallet: bscWalletClient },
  });

  const opSepoliaPing = getContract({
    address: PING_MODULE_ADDRESS,
    abi: PING_MODULE.ABI,
    client: opSepoliaClient,
  });

  const opSepoliaIsmpHostAddress = await opSepoliaPing.read.host();

  const opSepoliaIsmpHost = getContract({
    address: opSepoliaIsmpHostAddress,
    abi: EVM_HOST.ABI,
    client: opSepoliaClient,
  });

  const opSepoliaHostParams = await opSepoliaIsmpHost.read.hostParams();

  const opSepoliaHandler = getContract({
    address: opSepoliaHostParams.handler,
    abi: HANDLER.ABI,
    client: { public: opSepoliaClient, wallet: opWalletClient },
  });

  const tokenFaucet = getContract({
    address: "0x1794aB22388303ce9Cb798bE966eeEBeFe59C3a3",
    abi: parseAbi(["function drip(address token) public"]),
    client: { public: bscTestnetClient, wallet: bscWalletClient },
  });

  const BSC = {
    rpc_url: process.env.BSC_URL!,
    consensus_state_id: "BSC0",
    host_address: bscIsmpHostAddress,
    state_machine: await bscIsmpHost.read.host(),
  };

  const OP = {
    rpc_url: process.env.OP_URL!,
    consensus_state_id: "ETH0",
    host_address: opSepoliaIsmpHostAddress,
    state_machine: await opSepoliaIsmpHost.read.host(),
  };

  return {
    bscTestnetClient,
    bscFeeToken,
    account,
    tokenFaucet,
    BSC,
    OP,
    opSepoliaHandler,
    bscHandler,
    bscPing,
    opSepoliaClient,
    opSepoliaIsmpHost,
  };
}

config();

testPostAndGetRequest();
