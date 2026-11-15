// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Luu ma bam SHA-256 cua cac moc bao tri xe may. Du lieu chi tiet nam o DB off-chain.
contract MotoMaintenanceChain {
    struct Rec { address garage; uint256 ts; }

    address public owner;
    mapping(address => bool) public authorizedGarages;
    mapping(bytes32 => Rec) public records;

    event Anchored(bytes32 indexed hash, address indexed garage, uint256 ts);
    event GarageSet(address indexed garage, bool allowed);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor() { owner = msg.sender; authorizedGarages[msg.sender] = true; }

    function setGarage(address g, bool allowed) external onlyOwner {
        authorizedGarages[g] = allowed;
        emit GarageSet(g, allowed);
    }

    function anchor(bytes32 h) external {
        require(authorizedGarages[msg.sender], "garage not authorized");
        require(records[h].ts == 0, "already anchored");
        records[h] = Rec(msg.sender, block.timestamp);
        emit Anchored(h, msg.sender, block.timestamp);
    }
}
