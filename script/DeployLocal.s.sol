// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {BallotManager, ISemaphoreV4} from "../src/BallotManager.sol";
import {Semaphore} from "@semaphore/contracts/Semaphore.sol";
import {SemaphoreVerifier} from "@semaphore/contracts/base/SemaphoreVerifier.sol";
import {ISemaphoreVerifier} from "@semaphore/contracts/interfaces/ISemaphoreVerifier.sol";

interface Vm {
    function envUint(string calldata name) external returns (uint256 value);

    function startBroadcast(uint256 privateKey) external;

    function stopBroadcast() external;
}

contract DeployLocal {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (address ballotManagerAddress, address semaphoreAddress, address verifierAddress) {
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));

        SemaphoreVerifier verifier = new SemaphoreVerifier();
        Semaphore semaphore = new Semaphore(ISemaphoreVerifier(address(verifier)));
        BallotManager ballotManager = new BallotManager(ISemaphoreV4(address(semaphore)));

        vm.stopBroadcast();

        return (address(ballotManager), address(semaphore), address(verifier));
    }
}
