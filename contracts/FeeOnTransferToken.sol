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

    // Use OpenZeppelin-compatible hook by overriding `_transfer`.
    function _transfer(address from, address to, uint256 amount) internal virtual override {
        // preserve mint/burn behavior
        if (from == address(0) || to == address(0) || feeBasisPoints == 0 || from == feeReceiver || to == feeReceiver) {
            super._transfer(from, to, amount);
            return;
        }

        uint256 fee = (amount * feeBasisPoints) / 10000;
        uint256 sendAmount = amount - fee;

        // transfer net amount
        super._transfer(from, to, sendAmount);
        // transfer fee portion to feeReceiver
        if (fee > 0) {
            super._transfer(from, feeReceiver, fee);
        }
    }
}