// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title FizzToken
 * @dev Reward token for the Fizz Caps game
 */
contract FizzToken is ERC20 {
    constructor(uint256 initialSupply) ERC20("Fizz Token", "FIZZ") {
        _mint(msg.sender, initialSupply);
    }
}
