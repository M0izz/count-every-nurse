import { BaseError, ContractFunctionRevertedError } from "viem"
import { Group } from "@semaphore-protocol/group"
import { Identity } from "@semaphore-protocol/identity"
import { generateProof } from "@semaphore-protocol/proof"
import {
  castProof,
  addWardMembers,
  createWard,
  getBallotCount,
  getCurrentTime,
  getWardCount,
  makeProof,
  mineAt,
  openBallot,
  readBallot,
  simulateVote,
} from "../src/client.js"

const VOTER_COUNT = 38
const CHOICE_COUNT = 2
const OPTIONS = ["File a formal complaint", "Do not file a complaint"]

async function main(): Promise<void> {
  const identities = Array.from({ length: VOTER_COUNT }, () => new Identity())
  const commitments = identities.map(({ commitment }) => commitment)
  const previousWardCount = await getWardCount()

  await createWard(VOTER_COUNT)
  const wardId = previousWardCount + 1n
  await addWardMembers(wardId, commitments)

  const now = await getCurrentTime()
  const closesAt = now + 24n * 60n * 60n
  const previousBallotCount = await getBallotCount()
  await openBallot(
    wardId,
    "Should the ward file a formal complaint about unsafe staffing?",
    OPTIONS,
    closesAt,
  )
  const ballotId = previousBallotCount + 1n

  const group = new Group(commitments)
  let firstProof: Awaited<ReturnType<typeof generateProof>> | undefined
  const expectedTallies = [0, 0]

  for (let index = 0; index < identities.length; index++) {
    const choice = index < VOTER_COUNT / 2 ? 0 : 1
    const proof = await makeProof(identities[index], ballotId, BigInt(choice))
    await castProof(ballotId, proof)
    expectedTallies[choice] += 1
    if (index === 0) firstProof = proof
  }

  if (!firstProof) throw new Error("No proof was generated.")
  const result = await readBallot(ballotId)
  if (
    result.tallies[0] !== BigInt(expectedTallies[0]) ||
    result.tallies[1] !== BigInt(expectedTallies[1])
  ) {
    throw new Error("On-chain tally does not match the 38 generated votes.")
  }
  if (result.tallies.reduce((sum, tally) => sum + tally, 0n) !== BigInt(VOTER_COUNT)) {
    throw new Error("The on-chain tally does not contain exactly 38 votes.")
  }
  console.log(`PASS: 38 valid proofs counted; tally ${result.tallies[0]}–${result.tallies[1]}.`)

  await expectContractRevert("same identity, same ballot", () => simulateVote(ballotId, firstProof))

  try {
    await generateProof(new Identity(), group, 0n, result.scope)
    throw new Error("A non-member unexpectedly generated a proof.")
  } catch (error) {
    if (!(error instanceof Error) || !error.message.toLowerCase().includes("does not exist")) throw error
    console.log("PASS: non-member cannot construct a membership proof.")
  }

  const malformedChoice = await makeOutOfRangeProof(identities[0], group, result.scope)
  await expectContractRevert("choice outside the option list", () => simulateVote(ballotId, malformedChoice))

  const nextNow = await getCurrentTime()
  const secondCloseAt = nextNow + 60n * 60n
  const secondPreviousCount = await getBallotCount()
  await openBallot(
    wardId,
    "A separate ballot for replay testing?",
    OPTIONS,
    secondCloseAt,
  )
  const secondBallotId = secondPreviousCount + 1n
  await expectContractRevert("vote replayed into another ballot", () => simulateVote(secondBallotId, firstProof))

  const secondBallot = await readBallot(secondBallotId)
  const proofForClosedBallot = await makeProof(identities[0], secondBallotId, 0n)
  await mineAt(secondBallot.closesAt)
  await expectContractRevert("vote after the closing time", () =>
    simulateVote(secondBallotId, proofForClosedBallot),
  )

  console.log("PASS: replay, non-member, malformed-choice, cross-ballot, and closed-ballot checks completed.")
  console.log(`Demo submitter: one local transaction account; ballot ${ballotId} is independently readable on-chain.`)
  console.log("Demo-only note: all 38 throwaway identities run in this process; this does not model production metadata privacy.")
}

async function makeOutOfRangeProof(
  identity: Identity,
  group: Group,
  scope: bigint,
): Promise<Awaited<ReturnType<typeof generateProof>>> {
  const proof = await generateProof(identity, group, BigInt(CHOICE_COUNT), scope)
  return proof
}

async function expectContractRevert(label: string, action: () => Promise<void>): Promise<void> {
  try {
    await action()
  } catch (error) {
    if (
      error instanceof BaseError &&
      error.walk((cause) => cause instanceof ContractFunctionRevertedError)
    ) {
      console.log(`PASS: ${label} rejected.`)
      return
    }
    throw error
  }
  throw new Error(`Expected contract to reject ${label}.`)
}

void main()
  .then(() => exitAfterOutput(0))
  .catch((error: unknown) => {
    console.error(error)
    exitAfterOutput(1)
  })

function exitAfterOutput(code: number): void {
  let pending = 2
  const finish = (): void => {
    pending -= 1
    if (pending === 0) process.exit(code)
  }
  process.stdout.write("", finish)
  process.stderr.write("", finish)
}
