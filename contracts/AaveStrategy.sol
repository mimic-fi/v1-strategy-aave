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

import '@mimic-fi/v1-vault/contracts/interfaces/IStrategy.sol';
import '@mimic-fi/v1-vault/contracts/interfaces/ISwapConnector.sol';
import '@mimic-fi/v1-vault/contracts/interfaces/IPriceOracle.sol';
import '@mimic-fi/v1-vault/contracts/interfaces/IVault.sol';
import '@mimic-fi/v1-vault/contracts/libraries/FixedPoint.sol';

import '@openzeppelin/contracts/access/Ownable.sol';
import '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';
import '@openzeppelin/contracts/utils/math/SafeMath.sol';

import './aave/ILendingPool.sol';

contract AaveStrategy is IStrategy, Ownable {
    using FixedPoint for uint256;
    using SafeERC20 for IERC20;

    uint256 private constant VAULT_EXIT_RATIO_PRECISION = 1e18;

    IVault internal immutable _vault;
    IERC20 internal immutable _token;

    string private _metadataURI;

    uint256 internal immutable _slippage;

    IERC20 internal immutable _aToken;
    ILendingPool internal immutable _lendingPool;

    modifier onlyVault() {
        require(address(_vault) == msg.sender, 'CALLER_IS_NOT_VAULT');
        _;
    }

    constructor(
        IVault vault,
        IERC20 token,
        IERC20 aToken,
        ILendingPool lendingPool,
        uint256 slippage,
        string memory metadataURI
    ) {
        require(slippage <= FixedPoint.ONE, 'SWAP_SLIPPAGE_ABOVE_1');

        _vault = vault;
        _token = token;
        _aToken = aToken;
        _lendingPool = lendingPool;
        _slippage = slippage;

        _setMetadataURI(metadataURI);
    }

    function getVault() external view returns (address) {
        return address(_vault);
    }

    function getToken() external view override returns (address) {
        return address(_token);
    }

    function getAToken() external view returns (address) {
        return address(_aToken);
    }

    function getLendingPool() external view returns (address) {
        return address(_lendingPool);
    }

    function getMetadataURI() external view override returns (string memory) {
        return _metadataURI;
    }

    function getSlippage() public view returns (uint256) {
        return _slippage;
    }

    function getValueRate() external pure override returns (uint256) {
        return FixedPoint.ONE;
    }

    function getTotalValue() external view override returns (uint256) {
        return _getATokenBalance();
    }

    function setMetadataURI(string memory metadataURI) external onlyOwner {
        _setMetadataURI(metadataURI);
    }

    function withdraw(IERC20 token, address recipient) external onlyOwner {
        if (token != _token && token != _aToken) {
            uint256 balance = token.balanceOf(address(this));
            token.transfer(recipient, balance);
        }
    }

    function onJoin(uint256 amount, bytes memory)
        external
        override
        onlyVault
        returns (uint256 value, uint256 totalValue)
    {
        invest(_token);

        value = amount;
        totalValue = _getATokenBalance();
    }

    function onExit(uint256 ratio, bool emergency, bytes memory)
        external
        override
        onlyVault
        returns (address token, uint256 amount, uint256 value, uint256 totalValue)
    {
        // Invests before exiting only if it is a normal exit
        if (!emergency) {
            invest(_token);
        }

        amount = SafeMath.div(_getATokenBalance().mulDown(ratio), VAULT_EXIT_RATIO_PRECISION);
        _lendingPool.withdraw(address(_token), amount, address(this));

        _token.approve(address(_vault), amount);

        token = address(_token);
        value = amount;
        totalValue = _getATokenBalance();
    }

    function invest(IERC20 token) public {
        require(token != _aToken, 'AAVE_INTERNAL_TOKEN');

        uint256 balance = token.balanceOf(address(this));
        if (balance > 0) {
            if (token != _token) {
                _swap(token, _token, balance, getSlippage());
            }
            uint256 amount = _token.balanceOf(address(this));
            _token.approve(address(_lendingPool), amount);
            _lendingPool.deposit(address(_token), amount, address(this), 0);
        }
    }

    function _swap(IERC20 tokenIn, IERC20 tokenOut, uint256 amountIn, uint256 slippage) internal returns (uint256) {
        require(tokenIn != tokenOut, 'SWAP_SAME_TOKEN');

        uint256 minAmountOut = _getMinAmountOut(tokenIn, tokenOut, amountIn, slippage);
        ISwapConnector swapConnector = ISwapConnector(_vault.swapConnector());
        uint256 expectedAmountOut = swapConnector.getAmountOut(address(tokenIn), address(tokenOut), amountIn);
        require(expectedAmountOut >= minAmountOut, 'EXPECTED_SWAP_MIN_AMOUNT');

        if (amountIn > 0) {
            tokenIn.safeTransfer(address(swapConnector), amountIn);
        }

        uint256 preBalanceIn = tokenIn.balanceOf(address(this));
        uint256 preBalanceOut = tokenOut.balanceOf(address(this));
        (uint256 remainingIn, uint256 amountOut) = swapConnector.swap(
            address(tokenIn),
            address(tokenOut),
            amountIn,
            minAmountOut,
            block.timestamp,
            new bytes(0)
        );

        require(amountOut >= minAmountOut, 'SWAP_MIN_AMOUNT');
        uint256 postBalanceIn = tokenIn.balanceOf(address(this));
        require(postBalanceIn >= preBalanceIn.add(remainingIn), 'SWAP_INVALID_REMAINING_IN');
        uint256 postBalanceOut = tokenOut.balanceOf(address(this));
        require(postBalanceOut >= preBalanceOut.add(amountOut), 'SWAP_INVALID_AMOUNT_OUT');
        return amountOut;
    }

    function _getMinAmountOut(IERC20 tokenIn, IERC20 tokenOut, uint256 amountIn, uint256 slippage)
        internal
        view
        returns (uint256 minAmountOut)
    {
        uint256 price = IPriceOracle(_vault.priceOracle()).getTokenPrice(address(tokenOut), address(tokenIn));
        minAmountOut = amountIn.mulUp(price).mulUp(FixedPoint.ONE - slippage);
    }

    function _getATokenBalance() internal view returns (uint256) {
        return _aToken.balanceOf(address(this));
    }

    function _setMetadataURI(string memory metadataURI) private {
        _metadataURI = metadataURI;
        emit SetMetadataURI(metadataURI);
    }
}
