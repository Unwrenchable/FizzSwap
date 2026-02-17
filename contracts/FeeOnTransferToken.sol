// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice ERC20 token that charges a small fee on every transfer (fee sent to a feeReceiver)
contract FeeOnTransferToken is ERC20 {
    uint256 public feeBasisPoints; // e.g. 100 = 1%
    address public feeReceiver;

    constructor(uint256 initialSupply, uint256 _feeBasisPoints, address _feeReceiver) ERC20("Fee Token", "FEE") {
        require(_feeBasisPoints <= 1000, "Fee too high");
        feeBasisPoints = _feeBasisPoints;
        feeReceiver = _feeReceiver == address(0) ? msg.sender : _feeReceiver;
        _mint(msg.sender, initialSupply);
    }

    function _update(address from, address to, uint256 value) internal override {
        // preserve mint/burn behavior
        if (from == address(0) || to == address(0) || feeBasisPoints == 0 || from == feeReceiver || to == feeReceiver) {
            super._update(from, to, value);
            return;
        }

        uint256 fee = (value * feeBasisPoints) / 10000;
        uint256 sendAmount = value - fee;

        // transfer net amount
        super._update(from, to, sendAmount);
        // transfer fee portion to feeReceiver
        if (fee > 0) {
            super._update(from, feeReceiver, fee);
        }
    }
}