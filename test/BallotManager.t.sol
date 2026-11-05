// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {BallotManager, ISemaphoreV4} from "../src/BallotManager.sol";

interface Vm {
    function warp(uint256 timestamp) external;

    function prank(address caller) external;

    function expectRevert(bytes4 revertData) external;
}

contract MockSemaphore is ISemaphoreV4 {
    error InvalidProof();
    error NullifierAlreadySpent();

    uint256 private nextGroupId;
    mapping(uint256 nullifier => bool) public validNullifier;
    mapping(uint256 groupId => mapping(uint256 nullifier => bool)) public nullifierSpent;

    function createGroup(address) external returns (uint256) {
        return ++nextGroupId;
    }

    function addMember(uint256, uint256) external pure {}

    function addMembers(uint256, uint256[] calldata) external pure {}

    function validateProof(uint256 groupId, SemaphoreProof calldata proof) external {
        if (!validNullifier[proof.nullifier]) revert InvalidProof();
        if (nullifierSpent[groupId][proof.nullifier]) revert NullifierAlreadySpent();
        nullifierSpent[groupId][proof.nullifier] = true;
    }

    function setValidProof(uint256 nullifier, bool valid) external {
        validNullifier[nullifier] = valid;
    }
}

contract BallotManagerTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    MockSemaphore private semaphore;
    BallotManager private manager;
    uint256 private wardId;
    uint256 private ballotId;

    function setUp() external {
        semaphore = new MockSemaphore();
        manager = new BallotManager(ISemaphoreV4(address(semaphore)));
        wardId = manager.createWard(2);

        uint256[] memory commitments = new uint256[](2);
        commitments[0] = 1001;
        commitments[1] = 1002;
        manager.addWardMembers(wardId, commitments);

        string[] memory options = new string[](2);
        options[0] = "File a formal complaint";
        options[1] = "Do not file a complaint";
        ballotId = manager.openBallot(
            wardId, "File a complaint about unsafe staffing?", options, uint64(block.timestamp + 1 days)
        );
    }

    function testValidProofIncrementsTheTallyForItsMessageAndAllowsAnySubmitter() external {
        BallotManager.Ballot memory ballot = manager.getBallot(ballotId);
        ISemaphoreV4.SemaphoreProof memory proof = _proof(81, 1, ballot.scope);
        semaphore.setValidProof(proof.nullifier, true);

        vm.prank(address(0xBEEF));
        manager.castVote(ballotId, proof);

        BallotManager.Ballot memory result = manager.getBallot(ballotId);
        require(result.tallies[0] == 0, "wrong choice was tallied");
        require(result.tallies[1] == 1, "proof message was not tallied");
        require(manager.nullifierUsed(ballotId, proof.nullifier), "nullifier was not recorded");
    }

    function testReplaySameIdentitySameBallotReverts() external {
        BallotManager.Ballot memory ballot = manager.getBallot(ballotId);
        ISemaphoreV4.SemaphoreProof memory proof = _proof(82, 0, ballot.scope);
        semaphore.setValidProof(proof.nullifier, true);

        manager.castVote(ballotId, proof);

        vm.expectRevert(BallotManager.NullifierAlreadyUsed.selector);
        manager.castVote(ballotId, proof);
    }

    function testNonMemberWithoutValidSemaphoreProofReverts() external {
        BallotManager.Ballot memory ballot = manager.getBallot(ballotId);
        ISemaphoreV4.SemaphoreProof memory proof = _proof(83, 0, ballot.scope);

        vm.expectRevert(MockSemaphore.InvalidProof.selector);
        manager.castVote(ballotId, proof);
    }

    function testCallerCannotSubstituteAChoiceForProofMessage() external {
        BallotManager.Ballot memory ballot = manager.getBallot(ballotId);
        ISemaphoreV4.SemaphoreProof memory proof = _proof(84, 2, ballot.scope);
        semaphore.setValidProof(proof.nullifier, true);

        vm.expectRevert(BallotManager.InvalidChoice.selector);
        manager.castVote(ballotId, proof);
    }

    function testProofScopeMustMatchTheBallot() external {
        BallotManager.Ballot memory ballot = manager.getBallot(ballotId);
        ISemaphoreV4.SemaphoreProof memory proof = _proof(85, 0, ballot.scope + 1);
        semaphore.setValidProof(proof.nullifier, true);

        vm.expectRevert(BallotManager.InvalidScope.selector);
        manager.castVote(ballotId, proof);
    }

    function testProofCannotBeReplayedIntoAnotherBallot() external {
        BallotManager.Ballot memory firstBallot = manager.getBallot(ballotId);
        string[] memory options = new string[](2);
        options[0] = "Yes";
        options[1] = "No";
        uint256 secondBallotId =
            manager.openBallot(wardId, "A different question?", options, uint64(block.timestamp + 1 days));
        ISemaphoreV4.SemaphoreProof memory proof = _proof(86, 0, firstBallot.scope);
        semaphore.setValidProof(proof.nullifier, true);

        vm.expectRevert(BallotManager.InvalidScope.selector);
        manager.castVote(secondBallotId, proof);
    }

    function testClosedBallotRejectsVote() external {
        BallotManager.Ballot memory ballot = manager.getBallot(ballotId);
        ISemaphoreV4.SemaphoreProof memory proof = _proof(87, 0, ballot.scope);
        semaphore.setValidProof(proof.nullifier, true);
        vm.warp(ballot.closesAt);

        vm.expectRevert(BallotManager.BallotClosed.selector);
        manager.castVote(ballotId, proof);
    }

    function testDuplicateIdentityCommitmentCannotBeEnrolledTwice() external {
        uint256 secondWardId = manager.createWard(3);
        manager.addWardMember(secondWardId, 2001);

        uint256[] memory duplicateCommitments = new uint256[](2);
        duplicateCommitments[0] = 2002;
        duplicateCommitments[1] = 2002;

        vm.expectRevert(BallotManager.InvalidMemberBatch.selector);
        manager.addWardMembers(secondWardId, duplicateCommitments);
    }

    function _proof(uint256 nullifier, uint256 message, uint256 scope)
        private
        pure
        returns (ISemaphoreV4.SemaphoreProof memory proof)
    {
        proof.merkleTreeDepth = 20;
        proof.merkleTreeRoot = 1;
        proof.nullifier = nullifier;
        proof.message = message;
        proof.scope = scope;
        proof.points[0] = 1;
    }
}
