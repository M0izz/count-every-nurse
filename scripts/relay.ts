import { createServer } from "node:http"
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
  "function castVote(uint256 ballotId, (uint256 merkleTreeDepth, uint256 merkleTreeRoot, uint256 nullifier, uint256 message, uint256 scope, uint256[8] points) proof)",
])

type RelayProof = {
  merkleTreeDepth: bigint
  merkleTreeRoot: bigint
  nullifier: bigint
  message: bigint
  scope: bigint
  points: [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]
}

const rpcUrl = requiredEnv("RPC_URL")
const privateKey = requiredEnv("TRANSACTION_PRIVATE_KEY")
const managerAddress = requiredAddress("BALLOT_MANAGER_ADDRESS")
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
  throw new Error("TRANSACTION_PRIVATE_KEY must be a 32-byte hex key.")
}

const portText = process.env.RELAY_PORT ?? "8787"
if (!/^[1-9]\d*$/.test(portText) || Number(portText) > 65535) {
  throw new Error("RELAY_PORT must be a valid TCP port.")
}
const host = process.env.RELAY_HOST ?? "127.0.0.1"
const port = Number(portText)
const publicClient = createPublicClient({ transport: http(rpcUrl) })
const chainId = await publicClient.getChainId()
const chain = defineChain({
  id: chainId,
  name: `chain-${chainId}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
})
const account = privateKeyToAccount(privateKey as Hex)
const walletClient = createWalletClient({
  account,
  chain,
  transport: http(rpcUrl),
})

const server = createServer(async (request, response) => {
  response.setHeader("cache-control", "no-store")
  response.setHeader("content-type", "application/json; charset=utf-8")

  if (request.method !== "POST" || request.url !== "/vote") {
    sendJson(response, 404, { error: "Not found." })
    return
  }
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    sendJson(response, 415, { error: "Content-Type must be application/json." })
    return
  }

  try {
    const body = await readBody(request)
    const parsed: unknown = JSON.parse(body)
    const { ballotId, proof } = parseRequest(parsed)
    const { request: simulatedRequest } = await publicClient.simulateContract({
      account,
      address: managerAddress,
      abi: ballotAbi,
      functionName: "castVote",
      args: [ballotId, proof],
    })
    const transactionHash = await walletClient.writeContract(simulatedRequest)
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: transactionHash,
    })
    if (receipt.status !== "success") {
      sendJson(response, 422, {
        error: "The vote transaction reverted.",
        transactionHash,
      })
      return
    }

    sendJson(response, 200, { transactionHash })
  } catch (error) {
    const status = error instanceof SyntaxError ? 400 : 422
    sendJson(response, status, {
      error: error instanceof Error ? error.message : "Vote relay failed.",
    })
  }
})

server.listen(port, host, () => {
  console.log(`Vote relay listening at http://${host}:${port}/vote`)
  console.log("The relay does not log request bodies or client addresses.")
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    console.warn(
      "WARNING: relay is reachable beyond this machine. Add production-grade abuse controls and a privacy review before exposing it.",
    )
  }
})

function parseRequest(value: unknown): { ballotId: bigint; proof: RelayProof } {
  if (typeof value !== "object" || value === null || !("ballotId" in value) || !("proof" in value)) {
    throw new Error("Request must contain ballotId and proof.")
  }

  if (typeof value.ballotId !== "string" || !/^[1-9]\d*$/.test(value.ballotId)) {
    throw new Error("ballotId must be a positive decimal string.")
  }
  if (typeof value.proof !== "object" || value.proof === null) {
    throw new Error("proof must be an object.")
  }
  const raw = value.proof
  const merkleTreeRoot = decimalField(raw, "merkleTreeRoot")
  const nullifier = decimalField(raw, "nullifier")
  const message = decimalField(raw, "message")
  const scope = decimalField(raw, "scope")
  const merkleTreeDepth = decimalField(raw, "merkleTreeDepth")
  if (
    !("points" in raw) ||
    !Array.isArray(raw.points) ||
    raw.points.length !== 8 ||
    raw.points.some((point) => typeof point !== "string" || !/^\d+$/.test(point))
  ) {
    throw new Error("points must contain exactly 8 decimal strings.")
  }

  return {
    ballotId: BigInt(value.ballotId),
    proof: {
      merkleTreeDepth,
      merkleTreeRoot,
      nullifier,
      message,
      scope,
      points: raw.points.map((point) => BigInt(point)) as RelayProof["points"],
    },
  }
}

function decimalField(value: object, key: string): bigint {
  if (!(key in value)) throw new Error(`${key} is required.`)
  const field = value[key as keyof typeof value]
  if (
    (typeof field !== "string" && typeof field !== "number") ||
    !/^\d+$/.test(String(field))
  ) {
    throw new Error(`${key} must be a decimal integer.`)
  }
  return BigInt(field)
}

async function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 16_384) throw new Error("Request body exceeds 16 KiB.")
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString("utf8")
}

function sendJson(
  response: import("node:http").ServerResponse,
  statusCode: number,
  body: object,
): void {
  response.writeHead(statusCode)
  response.end(JSON.stringify(body))
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Set ${name} in the environment.`)
  return value
}

function requiredAddress(name: string): Address {
  const value = requiredEnv(name)
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} must be a 20-byte hex address.`)
  }
  return value as Address
}
