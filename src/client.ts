import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Identity } from "@semaphore-protocol/identity"
import { Group } from "@semaphore-protocol/group"
import { generateProof } from "@semaphore-protocol/proof"
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"

const ballotAbi = parseAbi([
  "function wardCount() view returns (uint256)",
  "function ballotCount() view returns (uint256)",
  "function wards(uint256 wardId) view returns (address admin, uint256 semaphoreGroupId, uint32 expectedVoters, uint32 enrolledVoters, bool rosterFrozen)",
  "function getBallot(uint256 ballotId) view returns ((uint256 wardId, uint256 scope, uint64 closesAt, string question, string[] options, uint256[] tallies))",
  "function createWard(uint32 expectedVoters) returns (uint256 wardId)",
  "function addWardMember(uint256 wardId, uint256 identityCommitment)",
  "function addWardMembers(uint256 wardId, uint256[] identityCommitments)",
  "function openBallot(uint256 wardId, string question, string[] options, uint64 closesAt) returns (uint256 ballotId)",
  "function castVote(uint256 ballotId, (uint256 merkleTreeDepth, uint256 merkleTreeRoot, uint256 nullifier, uint256 message, uint256 scope, uint256[8] points) proof)",
])

const semaphoreAbi = parseAbi([
  "function getMerkleTreeDepth(uint256 groupId) view returns (uint256)",
  "function getMerkleTreeRoot(uint256 groupId) view returns (uint256)",
  "function getMerkleTreeSize(uint256 groupId) view returns (uint256)",
  "event MemberAdded(uint256 indexed groupId, uint256 index, uint256 identityCommitment, uint256 merkleTreeRoot)",
  "event MembersAdded(uint256 indexed groupId, uint256 startIndex, uint256[] identityCommitments, uint256 merkleTreeRoot)",
])

type SemaphoreProof = Awaited<ReturnType<typeof generateProof>>

export async function createLocalIdentity(identityPath: string): Promise<void> {
  const identity = new Identity()
  const destination = resolve(identityPath)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(
    destination,
    JSON.stringify({ secret: identity.export() }) + "\n",
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  )
  await chmod(destination, 0o600)
  console.log(`Identity created locally. Share only this commitment with the ward admin: ${identity.commitment}`)
}

export async function loadIdentity(identityPath: string): Promise<Identity> {
  const record: unknown = JSON.parse(await readFile(resolve(identityPath), "utf8"))
  if (
    typeof record !== "object" ||
    record === null ||
    !("secret" in record) ||
    typeof record.secret !== "string"
  ) {
    throw new Error("Identity file is invalid.")
  }
  return Identity.import(record.secret)
}

export async function makeProof(
  identity: Identity,
  ballotId: bigint,
  choice: bigint,
): Promise<SemaphoreProof> {
  const { publicClient, managerAddress, semaphoreAddress } = await getPublicClients()
  const ballot = await publicClient.readContract({
    address: managerAddress,
    abi: ballotAbi,
    functionName: "getBallot",
    args: [ballotId],
  })
  const ward = await publicClient.readContract({
    address: managerAddress,
    abi: ballotAbi,
    functionName: "wards",
    args: [ballot.wardId],
  })
  const groupId = ward[1]

  if (choice >= BigInt(ballot.options.length)) {
    throw new Error("Choice index is outside the ballot's option list.")
  }

  const [depth, root, size] = await Promise.all([
    publicClient.readContract({
      address: semaphoreAddress,
      abi: semaphoreAbi,
      functionName: "getMerkleTreeDepth",
      args: [groupId],
    }),
    publicClient.readContract({
      address: semaphoreAddress,
      abi: semaphoreAbi,
      functionName: "getMerkleTreeRoot",
      args: [groupId],
    }),
    publicClient.readContract({
      address: semaphoreAddress,
      abi: semaphoreAbi,
      functionName: "getMerkleTreeSize",
      args: [groupId],
    }),
  ])
  const members = await readGroupMembers(publicClient, groupId, semaphoreAddress)
  if (BigInt(members.length) !== size) {
    throw new Error("Semaphore member events do not match the on-chain group size.")
  }

  const group = new Group(members)
  if (group.root !== root || BigInt(group.depth) !== depth) {
    throw new Error("Reconstructed Semaphore group root does not match the chain.")
  }

  return generateProof(identity, group, choice, ballot.scope)
}

export function toContractProof(proof: SemaphoreProof) {
  if (proof.points.length !== 8) {
    throw new Error("Semaphore returned an unexpected proof point count.")
  }

  const points: [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint] = [
    BigInt(proof.points[0]),
    BigInt(proof.points[1]),
    BigInt(proof.points[2]),
    BigInt(proof.points[3]),
    BigInt(proof.points[4]),
    BigInt(proof.points[5]),
    BigInt(proof.points[6]),
    BigInt(proof.points[7]),
  ]

  return {
    merkleTreeDepth: BigInt(proof.merkleTreeDepth),
    merkleTreeRoot: BigInt(proof.merkleTreeRoot),
    nullifier: BigInt(proof.nullifier),
    message: BigInt(proof.message),
    scope: BigInt(proof.scope),
    points,
  } as const
}

export async function castProof(ballotId: bigint, proof: SemaphoreProof): Promise<void> {
  const { publicClient, walletClient, managerAddress } = await getWalletClients()
  const hash = await walletClient.writeContract({
    account: walletClient.account,
    address: managerAddress,
    abi: ballotAbi,
    functionName: "castVote",
    args: [ballotId, toContractProof(proof)],
  })
  await publicClient.waitForTransactionReceipt({ hash })
}

export async function readBallot(ballotId: bigint) {
  const { publicClient, managerAddress } = await getPublicClients()
  return publicClient.readContract({
    address: managerAddress,
    abi: ballotAbi,
    functionName: "getBallot",
    args: [ballotId],
  })
}

export async function createWard(expectedVoters: number): Promise<void> {
  const { publicClient, walletClient, managerAddress } = await getWalletClients()
  const hash = await walletClient.writeContract({
    account: walletClient.account,
    address: managerAddress,
    abi: ballotAbi,
    functionName: "createWard",
    args: [expectedVoters],
  })
  await publicClient.waitForTransactionReceipt({ hash })
}

export async function addWardMembers(wardId: bigint, commitments: bigint[]): Promise<void> {
  const { publicClient, walletClient, managerAddress } = await getWalletClients()
  const hash = await walletClient.writeContract({
    account: walletClient.account,
    address: managerAddress,
    abi: ballotAbi,
    functionName: "addWardMembers",
    args: [wardId, commitments],
  })
  await publicClient.waitForTransactionReceipt({ hash })
}

export async function openBallot(
  wardId: bigint,
  question: string,
  options: string[],
  closesAt: bigint,
): Promise<void> {
  const { publicClient, walletClient, managerAddress } = await getWalletClients()
  const hash = await walletClient.writeContract({
    account: walletClient.account,
    address: managerAddress,
    abi: ballotAbi,
    functionName: "openBallot",
    args: [wardId, question, options, closesAt],
  })
  await publicClient.waitForTransactionReceipt({ hash })
}

export async function simulateVote(ballotId: bigint, proof: SemaphoreProof): Promise<void> {
  const { publicClient, walletClient, managerAddress } = await getWalletClients()
  await publicClient.simulateContract({
    account: walletClient.account,
    address: managerAddress,
    abi: ballotAbi,
    functionName: "castVote",
    args: [ballotId, toContractProof(proof)],
  })
}

export async function getCurrentTime(): Promise<bigint> {
  const { publicClient } = await getPublicClients()
  const block = await publicClient.getBlock()
  return block.timestamp
}

export async function getWardCount(): Promise<bigint> {
  const { publicClient, managerAddress } = await getPublicClients()
  return publicClient.readContract({
    address: managerAddress,
    abi: ballotAbi,
    functionName: "wardCount",
  })
}

export async function getBallotCount(): Promise<bigint> {
  const { publicClient, managerAddress } = await getPublicClients()
  return publicClient.readContract({
    address: managerAddress,
    abi: ballotAbi,
    functionName: "ballotCount",
  })
}

export async function getRpcUrl(): Promise<string> {
  return requiredEnv("RPC_URL")
}

export async function mineAt(timestamp: bigint): Promise<void> {
  const rpcUrl = await getRpcUrl()
  await anvilRpc(rpcUrl, "evm_setNextBlockTimestamp", [Number(timestamp)])
  await anvilRpc(rpcUrl, "evm_mine", [])
}

async function readGroupMembers(
  publicClient: Awaited<ReturnType<typeof getPublicClients>>["publicClient"],
  groupId: bigint,
  semaphoreAddress: Address,
): Promise<bigint[]> {
  const [singleAdds, batchAdds] = await Promise.all([
    publicClient.getContractEvents({
      address: semaphoreAddress,
      abi: semaphoreAbi,
      eventName: "MemberAdded",
      args: { groupId },
      fromBlock: 0n,
    }),
    publicClient.getContractEvents({
      address: semaphoreAddress,
      abi: semaphoreAbi,
      eventName: "MembersAdded",
      args: { groupId },
      fromBlock: 0n,
    }),
  ])

  const indexed: Array<{ index: bigint; commitment: bigint }> = []
  for (const event of singleAdds) {
    if (event.args.index === undefined || event.args.identityCommitment === undefined) {
      throw new Error("Semaphore emitted an incomplete member-added event.")
    }
    indexed.push({ index: event.args.index, commitment: event.args.identityCommitment })
  }
  for (const event of batchAdds) {
    const startIndex = event.args.startIndex
    const identityCommitments = event.args.identityCommitments
    if (startIndex === undefined || identityCommitments === undefined) {
      throw new Error("Semaphore emitted an incomplete members-added event.")
    }
    identityCommitments.forEach((commitment, offset) => {
      indexed.push({ index: startIndex + BigInt(offset), commitment })
    })
  }

  indexed.sort((left, right) => (left.index < right.index ? -1 : left.index > right.index ? 1 : 0))
  indexed.forEach((member, index) => {
    if (member.index !== BigInt(index)) {
      throw new Error("Semaphore group member indexes are missing or duplicated.")
    }
  })
  return indexed.map(({ commitment }) => commitment)
}

async function getPublicClients() {
  const rpcUrl = requiredEnv("RPC_URL")
  const managerAddress = addressEnv("BALLOT_MANAGER_ADDRESS")
  const semaphoreAddress = addressEnv("SEMAPHORE_ADDRESS")
  const transport = http(rpcUrl)
  const publicClient = createPublicClient({ transport })
  return { publicClient, managerAddress, semaphoreAddress, rpcUrl }
}

async function getWalletClients() {
  const { publicClient, managerAddress, semaphoreAddress, rpcUrl } = await getPublicClients()
  const privateKey = requiredEnv("TRANSACTION_PRIVATE_KEY")
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("TRANSACTION_PRIVATE_KEY must be a 32-byte hex key.")
  }

  const chainId = await publicClient.getChainId()
  const transport = http(rpcUrl)
  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  })
  const account = privateKeyToAccount(privateKey as Hex)
  const walletClient = createWalletClient({ account, chain, transport })

  return { publicClient, walletClient, managerAddress, semaphoreAddress }
}

async function anvilRpc(url: string, method: string, params: unknown[]): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  if (!response.ok) throw new Error(`Local RPC returned HTTP ${response.status}.`)
  const body: { error?: { message?: string } } = await response.json()
  if (body.error) throw new Error(body.error.message ?? `${method} failed.`)
}

function addressEnv(name: string): Address {
  const value = requiredEnv(name)
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${name} must be a 20-byte hex address.`)
  return value as Address
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Set ${name} in the environment.`)
  return value
}

function argumentAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag)
  if (index < 0 || !args[index + 1]) throw new Error(`Missing ${flag} value.`)
  return args[index + 1]
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  if (command === "identity") {
    await createLocalIdentity(argumentAfter(args, "--out"))
    return
  }

  if (command === "vote") {
    const ballotText = args[0]
    const choiceText = args[1]
    if (!ballotText || !choiceText || !/^\d+$/.test(ballotText) || !/^\d+$/.test(choiceText)) {
      throw new Error("Usage: npm run identity -- vote <ballot-id> <choice-index> --identity <file>")
    }
    const identity = await loadIdentity(argumentAfter(args, "--identity"))
    const proof = await makeProof(identity, BigInt(ballotText), BigInt(choiceText))
    await castProof(BigInt(ballotText), proof)
    console.log("Vote submitted. The transaction contains a proof, not an identity commitment.")
    return
  }

  throw new Error(
    "Usage: npm run identity -- identity --out <new-file> | vote <ballot-id> <choice-index> --identity <file>",
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
    .then(() => exitAfterOutput(0))
    .catch((error: unknown) => {
      console.error(error)
      exitAfterOutput(1)
    })
}

function exitAfterOutput(code: number): void {
  let pending = 2
  const finish = (): void => {
    pending -= 1
    if (pending === 0) process.exit(code)
  }
  process.stdout.write("", finish)
  process.stderr.write("", finish)
}
