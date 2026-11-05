// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

interface ISemaphoreV4 {
    struct SemaphoreProof {
        uint256 merkleTreeDepth;
        uint256 merkleTreeRoot;
        uint256 nullifier;
        uint256 message;
        uint256 scope;
        uint256[8] points;
    }

    function createGroup(address admin) external returns (uint256);

    function addMember(uint256 groupId, uint256 identityCommitment) external;

    function addMembers(uint256 groupId, uint256[] calldata identityCommitments) external;

    function validateProof(uint256 groupId, SemaphoreProof calldata proof) external;
}

contract BallotManager {
    uint256 public constant MAX_VOTERS_PER_WARD = 1 << 20;
    uint256 private constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    error InvalidExpectedVoters();
    error InvalidMemberBatch();
    error NotWardAdmin();
    error RosterIncomplete();
    error RosterFrozen();
    error InvalidBallot();
    error InvalidQuestion();
    error InvalidOptions();
    error InvalidClosingTime();
    error BallotClosed();
    error InvalidScope();
    error InvalidChoice();
    error NullifierAlreadyUsed();

    struct Ward {
        address admin;
        uint256 semaphoreGroupId;
        uint32 expectedVoters;
        uint32 enrolledVoters;
        bool rosterFrozen;
    }

    struct Ballot {
        uint256 wardId;
        uint256 scope;
        uint64 closesAt;
        string question;
        string[] options;
        uint256[] tallies;
    }

    ISemaphoreV4 public immutable semaphore;
    uint256 public wardCount;
    uint256 public ballotCount;

    mapping(uint256 wardId => Ward) public wards;
    mapping(uint256 ballotId => Ballot) private ballots;
    mapping(uint256 wardId => mapping(uint256 identityCommitment => bool)) public isWardMember;
    mapping(uint256 ballotId => mapping(uint256 nullifier => bool)) public nullifierUsed;

    event WardCreated(uint256 indexed wardId, uint256 indexed semaphoreGroupId, address indexed admin);
    event WardMembersAdded(uint256 indexed wardId, uint32 totalEnrolled);
    event BallotOpened(
        uint256 indexed ballotId,
        uint256 indexed wardId,
        uint256 scope,
        string question,
        string[] options,
        uint64 closesAt
    );
    event VoteCast(uint256 indexed ballotId, uint256 indexed nullifier, uint256 choice);

    constructor(ISemaphoreV4 semaphore_) {
        semaphore = semaphore_;
    }

    function createWard(uint32 expectedVoters) external returns (uint256 wardId) {
        if (expectedVoters == 0 || expectedVoters > MAX_VOTERS_PER_WARD) {
            revert InvalidExpectedVoters();
        }

        wardId = ++wardCount;
        uint256 groupId = semaphore.createGroup(address(this));
        wards[wardId] = Ward({
            admin: msg.sender,
            semaphoreGroupId: groupId,
            expectedVoters: expectedVoters,
            enrolledVoters: 0,
            rosterFrozen: false
        });

        emit WardCreated(wardId, groupId, msg.sender);
    }

    function addWardMember(uint256 wardId, uint256 identityCommitment) external {
        uint256[] memory commitments = new uint256[](1);
        commitments[0] = identityCommitment;
        _addWardMembers(wardId, commitments);
    }

    function addWardMembers(uint256 wardId, uint256[] calldata identityCommitments) external {
        _addWardMembers(wardId, identityCommitments);
    }

    function openBallot(uint256 wardId, string calldata question, string[] calldata options, uint64 closesAt)
        external
        returns (uint256 ballotId)
    {
        Ward storage ward = wards[wardId];
        if (ward.admin == address(0)) revert InvalidBallot();
        if (msg.sender != ward.admin) revert NotWardAdmin();
        if (ward.enrolledVoters != ward.expectedVoters) revert RosterIncomplete();
        if (bytes(question).length == 0 || bytes(question).length > 512) revert InvalidQuestion();
        if (options.length < 2 || options.length > 8) revert InvalidOptions();
        if (closesAt <= block.timestamp) revert InvalidClosingTime();

        ward.rosterFrozen = true;
        ballotId = ++ballotCount;

        Ballot storage ballot = ballots[ballotId];
        ballot.wardId = wardId;
        ballot.scope = uint256(keccak256(abi.encode(block.chainid, address(this), ballotId))) % SNARK_SCALAR_FIELD;
        ballot.closesAt = closesAt;
        ballot.question = question;

        for (uint256 i = 0; i < options.length; i++) {
            if (bytes(options[i]).length == 0 || bytes(options[i]).length > 128) {
                revert InvalidOptions();
            }
            ballot.options.push(options[i]);
            ballot.tallies.push(0);
        }

        emit BallotOpened(ballotId, wardId, ballot.scope, question, options, closesAt);
    }

    function castVote(uint256 ballotId, ISemaphoreV4.SemaphoreProof calldata proof) external {
        Ballot storage ballot = ballots[ballotId];
        if (ballot.wardId == 0) revert InvalidBallot();
        if (block.timestamp >= ballot.closesAt) revert BallotClosed();
        if (proof.scope != ballot.scope) revert InvalidScope();
        if (proof.message >= ballot.options.length) revert InvalidChoice();
        if (nullifierUsed[ballotId][proof.nullifier]) revert NullifierAlreadyUsed();

        Ward storage ward = wards[ballot.wardId];

        // Semaphore validates membership and persists its group-scoped nullifier here.
        semaphore.validateProof(ward.semaphoreGroupId, proof);
        nullifierUsed[ballotId][proof.nullifier] = true;
        ballot.tallies[proof.message] += 1;

        emit VoteCast(ballotId, proof.nullifier, proof.message);
    }

    function getBallot(uint256 ballotId) external view returns (Ballot memory) {
        if (ballots[ballotId].wardId == 0) revert InvalidBallot();
        return ballots[ballotId];
    }

    function _addWardMembers(uint256 wardId, uint256[] memory identityCommitments) private {
        Ward storage ward = wards[wardId];
        if (ward.admin == address(0)) revert InvalidBallot();
        if (msg.sender != ward.admin) revert NotWardAdmin();
        if (ward.rosterFrozen) revert RosterFrozen();
        if (identityCommitments.length == 0) revert InvalidMemberBatch();
        if (uint256(ward.enrolledVoters) + identityCommitments.length > ward.expectedVoters) {
            revert InvalidMemberBatch();
        }

        for (uint256 i = 0; i < identityCommitments.length; i++) {
            uint256 commitment = identityCommitments[i];
            if (commitment == 0 || isWardMember[wardId][commitment]) revert InvalidMemberBatch();
            isWardMember[wardId][commitment] = true;
        }

        semaphore.addMembers(ward.semaphoreGroupId, identityCommitments);
        ward.enrolledVoters += uint32(identityCommitments.length);

        emit WardMembersAdded(wardId, ward.enrolledVoters);
    }
}
