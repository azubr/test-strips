/* SPDX-License-Identifier: GPL-3.0-or-later */
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract RewardToken is ERC20, Ownable {
    constructor() ERC20("Reward", "RWD") {
    }

    function mint(address account, uint256 amount) onlyOwner external {
        _mint(account, amount);
    }
}
