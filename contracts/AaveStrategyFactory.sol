// SPDX-License-Identifier: GPL-3.0-or-later
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

pragma solidity ^0.8.0;

import './AaveStrategy.sol';

/**
 * @title AaveStrategyFactory
 * @dev Factory contract to create AaveStrategy contracts
 */
contract AaveStrategyFactory {
    /**
     * @dev Emitted every time a new AaveStrategy is created
     */
    event StrategyCreated(AaveStrategy indexed strategy);

    IVault public immutable vault;
    ILendingPool internal immutable lendingPool;

    /**
     * @dev Initializes the factory contract
     * @param _vault Protocol vault reference
     * @param _lendingPool AAVE lending pool to be used
     */
    constructor(IVault _vault, ILendingPool _lendingPool) {
        vault = _vault;
        lendingPool = _lendingPool;
    }

    /**
     * @dev Creates a new AaveStrategy
     * @param token Token to be used as the strategy entry point
     * @param aToken aToken associated to the strategy token
     * @param slippage Slippage value to be used in order to swap rewards
     * @param metadata Metadata URI associated to the strategy
     */
    function create(IERC20 token, IERC20 aToken, uint256 slippage, string memory metadata)
        external
        returns (AaveStrategy strategy)
    {
        strategy = new AaveStrategy(vault, token, aToken, lendingPool, slippage, metadata);
        strategy.transferOwnership(msg.sender);
        emit StrategyCreated(strategy);
    }
}
