import {
  createPublicClient,
  getAddress,
  http,
  type Address,
} from "viem";

const ballotAbi = [
  {
    type: "event",
    name: "VoteCast",
    inputs: [
      { indexed: true, name: "ballotId", type: "uint256" },
      { indexed: true, name: "nullifier", type: "uint256" },
      { indexed: false, name: "choice", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getBallot",
    stateMutability: "view",
    inputs: [{ name: "ballotId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "wardId", type: "uint256" },
          { name: "scope", type: "uint256" },
          { name: "closesAt", type: "uint64" },
          { name: "question", type: "string" },
          { name: "options", type: "string[]" },
          { name: "tallies", type: "uint256[]" },
        ],
      },
    ],
  },
] as const;

const rpcUrl = process.env.RPC_URL;
const ballotManagerAddress = process.env.BALLOT_MANAGER_ADDRESS;
const ballotIdInput = process.argv[2];

if (!rpcUrl || !ballotManagerAddress || !ballotIdInput) {
  throw new Error(
    "Set RPC_URL and BALLOT_MANAGER_ADDRESS, then pass a ballot ID.",
  );
}

if (!/^[1-9]\d*$/.test(ballotIdInput)) {
  throw new Error("Ballot ID must be a positive integer.");
}

const address: Address = getAddress(ballotManagerAddress);
const ballotId = BigInt(ballotIdInput);
const client = createPublicClient({ transport: http(rpcUrl) });
const [ballot, latestBlock] = await Promise.all([
  client.readContract({
    address,
    abi: ballotAbi,
    functionName: "getBallot",
    args: [ballotId],
  }),
  client.getBlockNumber(),
]);
const votes = await client.getLogs({
  address,
  event: ballotAbi[0],
  args: { ballotId },
  fromBlock: 0n,
  toBlock: latestBlock,
});

const reconstructed = Array.from({ length: ballot.tallies.length }, () => 0n);
const seenNullifiers = new Set<string>();

for (const vote of votes) {
  const { nullifier, choice } = vote.args;
  if (nullifier === undefined || choice === undefined) {
    throw new Error(`VoteCast log ${vote.logIndex} is missing decoded fields.`);
  }
  if (choice >= BigInt(reconstructed.length)) {
    throw new Error(
      `VoteCast log ${vote.logIndex} has out-of-range choice ${choice}.`,
    );
  }

  const nullifierKey = nullifier.toString();
  if (seenNullifiers.has(nullifierKey)) {
    throw new Error(`Nullifier ${nullifierKey} appears more than once.`);
  }
  seenNullifiers.add(nullifierKey);
  reconstructed[Number(choice)] += 1n;
}

const mismatches = ballot.tallies.flatMap((onChain, index) =>
  onChain === reconstructed[index]
    ? []
    : [
        `option ${index} (${ballot.options[index]}): state=${onChain}, logs=${reconstructed[index]}`,
      ],
);

if (mismatches.length > 0) {
  throw new Error(`Tally verification failed:\n${mismatches.join("\n")}`);
}

console.log(`Verified ballot ${ballotId} at block ${latestBlock}.`);
console.log(`Question: ${ballot.question}`);
ballot.options.forEach((option, index) => {
  console.log(`${index}. ${option}: ${reconstructed[index]}`);
});
console.log(`Unique VoteCast nullifiers: ${seenNullifiers.size}`);
