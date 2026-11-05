# Count Every Nurse, Name None of Them

A small, runnable anonymous ballot using Semaphore V4, Foundry, TypeScript, and viem. A ward admin enrolls identity commitments into a Semaphore group, opens a ballot, and freezes that roster. A voter creates an identity and generates a zero-knowledge proof on their own device. The contract verifies the proof, consumes its ballot-scoped nullifier, and increments the choice encoded in the proof.

This design hides the link between a group commitment and a vote at the contract level; it does **not** promise absolute anonymity or prove that a real-world person is eligible.

## What is public

- The ward admin address, the expected and enrolled member counts, Semaphore group ID, member commitments, and enrollment transactions/events.
- Ballot question, options, closing time, ballot scope, individual vote message, nullifier, proof, tally, and transaction submitter address.
- The final tally is `getBallot(ballotId).tallies`; `BallotOpened`, Semaphore `ProofValidated`, and `VoteCast` events are public and can be checked against contract state by anyone.
- No name, employee identifier, identity secret, or `msg.sender`/`tx.origin` value is read, stored, or emitted by `castVote`. `VoteCast` includes only the ballot, the ballot-specific nullifier, and the choice. Semaphore's nullifier is also public.

Each ballot stores a scope derived from the chain ID, ballot contract address, and ballot ID. The voter proof must use that exact scope. Semaphore's nullifier is derived for that scope, so a valid proof cannot be reused on another ballot; the contract separately records consumed nullifiers before tallying. The choice is taken only from `proof.message`, and the vote function has no separate choice parameter.

## Privacy and trust assumptions

- The ward admin controls the roster and ballot setup. Only the admin may add commitments, and the configured number must be enrolled before a ballot opens; membership changes are disabled after the first ballot. The chain cannot establish that the roster contains exactly the real nurses or that no eligible person was omitted.
- A commitment is not a name, but the admin may know which nurse supplied it. If anyone associates a commitment with a nurse, public enrollment timing and other outside information can add correlation risk. Never publish identity secrets or share the same identity across contexts.
- A valid vote proves membership of the frozen group, not who submitted the transaction. The voter proof is generated locally and does not contain the voter's wallet address, but the transaction sender, timing, IP/network metadata, and gas-funding path are observable outside the contract. **Do not use a transaction account publicly linked to the voter.** A relayer or batching service can reduce direct sender linkage, but introduces its own trust, availability, and metadata assumptions. The included CLI sends directly and is a development tool, not a production relayer.
- The identity file contains the exported identity secret in base64, not encrypted form. Keep it on the voter's device, protect it with OS-level disk encryption and access controls, and never commit or send it to the ward admin.
- Individual choices and nullifiers are public. The contract makes no on-chain mapping from membership commitments to choices, but timing analysis, endpoint compromise, a malicious client, coercion, or a voluntary disclosure can undermine practical privacy.
- Cryptography cannot guarantee that every nurse participates, votes freely, or votes without pressure. No unanimity or voluntariness claim is made.
- Semaphore V4 and its proof system must be trusted as implemented and deployed. Production deployment needs an audited, pinned dependency and independently reviewed configuration. A permissionless tally is independently checkable from contract state and events; voters and observers should verify the deployed code and group/ballot configuration.

## Requirements

- Node.js 20+
- `npm install` installs Foundry's native `forge`, `anvil`, and `cast` binaries for supported Windows, Linux, and macOS targets; install Foundry separately if npm skips the platform package.

Install the JavaScript dependencies:

```sh
npm install
```

The Foundry imports resolve the official Semaphore V4 Solidity package from `node_modules`. Compile and run the contract tests:

```sh
npm run build
npm test
npm run typecheck
```

The Foundry unit tests use a deliberately small Semaphore mock to isolate ballot-level checks (scope, message, close time, submitter independence, duplicate nullifier, and cross-ballot replay). They do not claim to implement or prove Semaphore cryptography. The 38-voter demonstration below uses the real Semaphore V4 verifier and the version-matched `@semaphore-protocol/identity`, `@semaphore-protocol/group`, and `@semaphore-protocol/proof` packages. These are the components re-exported by `@semaphore-protocol/core`; the client imports them directly because the 4.14.5 aggregate package's type exports do not resolve correctly under NodeNext.

The current npm lockfile's audit reports 14 transitive dependency findings (5 moderate, 9 high), including older nested `snarkjs` and `ws` versions; some have no fix in this dependency tree. Review the audit and upgrade path before any production deployment.

## Local 38-voter proof demonstration

In terminal 1, start a local chain:

```sh
npx anvil
```

In terminal 2, use one of the throwaway private keys printed by that local Anvil process as an environment variable, deploy the official Semaphore verifier, Semaphore, and ballot manager, and copy the three addresses from the deployment output:

```sh
$env:DEPLOYER_PRIVATE_KEY = "<throwaway Anvil key>"
npx forge script script/DeployLocal.s.sol:DeployLocal --rpc-url http://127.0.0.1:8545 --broadcast
$env:RPC_URL = "http://127.0.0.1:8545"
$env:TRANSACTION_PRIVATE_KEY = "<throwaway Anvil key>"
$env:BALLOT_MANAGER_ADDRESS = "<deployed BallotManager address>"
$env:SEMAPHORE_ADDRESS = "<deployed Semaphore address>"
npm run demo:38
```

The script generates 38 throwaway Semaphore identities in process, enrolls their commitments, creates a ballot, generates 38 real local proofs, submits them, and checks that the public on-chain tally is exactly 38 (19/19). It then verifies rejection of a repeated proof, a non-member proof attempt, a malformed choice, a proof replayed into another ballot, and a vote after closing. The identities are not written to disk by this demo. All transactions share one local submitter, so this demonstrates contract/proof behavior and tally verification—not production anonymity, independent voter devices, or resistance to metadata correlation.

## Voter-side CLI

Set `RPC_URL`, `BALLOT_MANAGER_ADDRESS`, `SEMAPHORE_ADDRESS`, and `TRANSACTION_PRIVATE_KEY` in the shell that will run the client. The transaction key is only a development submission account; it is not the Semaphore identity.

Create a new identity on the voter's device and store its secret in a local, ignored file:

```sh
npm run identity -- identity --out .\identities\my-vote.identity
```

The command prints the identity commitment for the ward admin to enroll. Share only that commitment; protect and back up the identity file. After the admin enrolls the commitment and opens a ballot, generate and submit a vote locally:

```sh
npm run identity -- vote <ballot-id> <choice-index> --identity .\identities\my-vote.identity
```

The client reconstructs the group from Semaphore's public membership events, checks the reconstructed root and size against chain state, and generates a proof locally. It aborts rather than proving against a mismatched roster. `choice-index` is zero-based in the published option order.

## Scope and deployment

This is a minimal contract/client demonstration, not a hospital identity provider, production relay, or audited deployment. A real deployment needs an independently reviewed membership process, secure voter devices, a pinned and reproducibly built dependency set, reliable chain access, independent contract verification, and a privacy-preserving transaction submission strategy. Do not treat an untrusted or public RPC, browser extension, relay, or hosted prover as private by default.
