import {
  advanceTime,
  assertEvent,
  bn,
  deploy,
  fp,
  getSigners,
  HOUR,
  impersonate,
  instanceAt,
} from '@mimic-fi/v1-helpers'
import {SignerWithAddress} from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address'
import {expect} from 'chai'
import {BigNumber, Contract} from 'ethers'

/* eslint-disable no-secrets/no-secrets */

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const AUSDC = '0xBcca60bB61934080951369a648Fb03DF4F96263C'
const LENDING_POOL = '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9'
const WHALE_WITH_USDC = '0x55FE002aefF02F77364de339a1292923A15844B8'

const UNISWAP_V2_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'
const UNISWAP_V3_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564'
const BALANCER_V2_VAULT = '0xBA12222222228d8Ba445958a75a0704d566BF2C8'

const CHAINLINK_ORACLE_USDC_ETH = '0x986b5E1e1755e3C2440e960477f25201B0a8bbD4'
const PRICE_ONE_ORACLE = '0x1111111111111111111111111111111111111111'

describe('AaveStrategy - USDC', function () {
  let whale: SignerWithAddress, owner: SignerWithAddress, trader: SignerWithAddress
  let vault: Contract, strategy: Contract, usdc: Contract, weth: Contract, aToken: Contract

  const toUSDC = (amount: number) => fp(amount).div(1e12)

  const expectWithError = (actual: BigNumber, expected: BigNumber) => {
    expect(actual).to.be.at.least(bn(expected).sub(1))
    expect(actual).to.be.at.most(bn(expected).add(1))
  }

  const JOIN_AMOUNT = toUSDC(50)

  before('load signers', async () => {
    // eslint-disable-next-line prettier/prettier
    [owner, trader] = await getSigners(2)
    whale = await impersonate(WHALE_WITH_USDC, fp(100))
  })

  before('deploy vault', async () => {
    const maxSlippage = fp(0.02)
    const protocolFee = fp(0.00003)
    const whitelistedTokens: string[] = []
    const whitelistedStrategies: string[] = []
    const priceOracleTokens: string[] = [USDC, WETH]
    const priceOracleFeeds: string[] = [CHAINLINK_ORACLE_USDC_ETH, PRICE_ONE_ORACLE]

    const priceOracle = await deploy(
      '@mimic-fi/v1-chainlink-price-oracle/artifacts/contracts/ChainLinkPriceOracle.sol/ChainLinkPriceOracle',
      [priceOracleTokens, priceOracleFeeds]
    )

    const swapConnector = await deploy(
      '@mimic-fi/v1-swap-connector/artifacts/contracts/SwapConnector.sol/SwapConnector',
      [priceOracle.address, UNISWAP_V3_ROUTER, UNISWAP_V2_ROUTER, BALANCER_V2_VAULT]
    )

    await swapConnector.setUniswapV2Path(USDC, WETH)

    vault = await deploy('@mimic-fi/v1-vault/artifacts/contracts/Vault.sol/Vault', [
      maxSlippage,
      protocolFee,
      priceOracle.address,
      swapConnector.address,
      whitelistedTokens,
      whitelistedStrategies,
    ])
  })

  before('deploy strategy', async () => {
    const slippage = fp(0.01)
    const factory = await deploy('AaveStrategyFactory', [vault.address, LENDING_POOL])
    const createTx = await factory.connect(owner).create(USDC, AUSDC, slippage, 'metadata:uri')
    const { args } = await assertEvent(createTx, 'StrategyCreated')
    strategy = await instanceAt('AaveStrategy', args.strategy)
  })

  before('load dependencies', async () => {
    usdc = await instanceAt('IERC20', USDC)
    weth = await instanceAt('IWETH', WETH)
    aToken = await instanceAt('IERC20', AUSDC)
  })

  before('deposit tokens', async () => {
    await usdc.connect(whale).approve(vault.address, toUSDC(100))
    await vault.connect(whale).deposit(whale.address, usdc.address, toUSDC(100), '0x')
  })

  before('fund trader', async () => {
    await usdc.connect(whale).transfer(trader.address, toUSDC(2500000))
    await weth.connect(trader).deposit({ value: fp(50) })
  })

  it('has the correct owner', async () => {
    expect(await strategy.owner()).to.be.equal(owner.address)
  })

  it('sets metadata', async () => {
    await strategy.connect(owner).setMetadataURI('metadata:uri:2.0')
    expect(await strategy.getMetadataURI()).to.be.equal('metadata:uri:2.0')
  })

  it('joins the strategy', async () => {
    const previousVaultBalance = await usdc.balanceOf(vault.address)
    expect(previousVaultBalance).to.be.equal(toUSDC(100))

    const previousStrategyBalance = await usdc.balanceOf(strategy.address)
    expect(previousStrategyBalance).to.be.equal(0)

    await vault.connect(whale).join(whale.address, strategy.address, JOIN_AMOUNT, '0x')

    const currentVaultBalance = await usdc.balanceOf(vault.address)
    expect(currentVaultBalance).to.be.equal(previousVaultBalance.sub(JOIN_AMOUNT))

    const currentStrategyBalance = await usdc.balanceOf(strategy.address)
    expect(currentStrategyBalance).to.be.equal(previousStrategyBalance)

    const expectedValue = await aToken.balanceOf(strategy.address)
    const { invested, shares } = await vault.getAccountInvestment(whale.address, strategy.address)
    expectWithError(invested, expectedValue)
    expectWithError(shares, expectedValue)

    const strategyShares = await vault.getStrategyShares(strategy.address)
    expectWithError(shares, strategyShares)

    const strategyShareValue = await vault.getStrategyShareValue(strategy.address)
    const accountValue = await vault.getAccountCurrentValue(whale.address, strategy.address)
    expectWithError(accountValue, strategyShares.mul(strategyShareValue).div(fp(1)))
  })

  it('accrues value over time', async () => {
    const previousValue = await vault.getAccountCurrentValue(whale.address, strategy.address)

    await advanceTime(HOUR)

    const currentValue = await vault.getAccountCurrentValue(whale.address, strategy.address)
    expect(currentValue).to.be.gt(previousValue)
  })

  it('exits with a 50%', async () => {
    const previousBalance = await vault.getAccountBalance(whale.address, usdc.address)
    const previousInvestment = await vault.getAccountInvestment(whale.address, strategy.address)

    const exitRatio = fp(0.5)
    await vault.connect(whale).exit(whale.address, strategy.address, exitRatio, false, '0x')

    // The user should at least have some gains
    const currentBalance = await vault.getAccountBalance(whale.address, usdc.address)
    const minExpectedBalance = JOIN_AMOUNT.mul(exitRatio).div(fp(1))
    expect(currentBalance.sub(previousBalance)).to.be.gt(minExpectedBalance)

    // There should not be any remaining tokens in the strategy
    const currentStrategyBalance = await usdc.balanceOf(strategy.address)
    expect(currentStrategyBalance).to.be.equal(0)

    const expectedValue = await aToken.balanceOf(strategy.address)
    const currentInvestment = await vault.getAccountInvestment(whale.address, strategy.address)
    expectWithError(currentInvestment.invested, expectedValue)

    const expectedShares = previousInvestment.shares.sub(previousInvestment.shares.mul(exitRatio).div(fp(1)))
    expectWithError(currentInvestment.shares, expectedShares)

    const strategyShares = await vault.getStrategyShares(strategy.address)
    expectWithError(strategyShares, currentInvestment.shares)

    const strategyShareValue = await vault.getStrategyShareValue(strategy.address)
    const accountValue = await vault.getAccountCurrentValue(whale.address, strategy.address)
    expectWithError(accountValue, strategyShares.mul(strategyShareValue).div(fp(1)))

    const totalValue = await strategy.getTotalValue()
    const strategyShareValueScaled = totalValue.mul(bn(1e36)).div(strategyShares)
    expectWithError(accountValue, strategyShares.mul(strategyShareValueScaled).div(bn(1e36)))
  })

  it('handles USDC airdrops', async () => {
    const previousValue = await vault.getAccountCurrentValue(whale.address, strategy.address)

    // Airdrop 1000 USDC and invest it
    usdc.connect(trader).transfer(strategy.address, toUSDC(100))
    await strategy.invest(usdc.address)

    const currentValue = await vault.getAccountCurrentValue(whale.address, strategy.address)
    expect(currentValue).to.be.gt(previousValue)
  })

  it('handles wETH airdrops', async () => {
    const previousValue = await vault.getAccountCurrentValue(whale.address, strategy.address)

    // Airdrop 50 wETH and invest
    weth.connect(trader).transfer(strategy.address, fp(50))
    await strategy.invest(weth.address)

    const currentValue = await vault.getAccountCurrentValue(whale.address, strategy.address)
    expect(currentValue).to.be.gt(previousValue)
  })

  it('exits with a 100%', async () => {
    const previousBalance = await vault.getAccountBalance(whale.address, usdc.address)

    const exitRatio = fp(1)
    await vault.connect(whale).exit(whale.address, strategy.address, exitRatio, false, '0x')

    // The user should at least have some gains
    const currentBalance = await vault.getAccountBalance(whale.address, usdc.address)
    const minExpectedBalance = JOIN_AMOUNT.mul(exitRatio).div(fp(1))
    expect(currentBalance.sub(previousBalance)).to.be.gt(minExpectedBalance)

    // There should not be any remaining tokens in the strategy
    const currentStrategyBalance = await usdc.balanceOf(strategy.address)
    expect(currentStrategyBalance).to.be.equal(0)

    const { invested, shares } = await vault.getAccountInvestment(whale.address, strategy.address)
    expectWithError(invested, bn(0))
    expectWithError(shares, bn(0))

    const strategyShares = await vault.getStrategyShares(strategy.address)
    expectWithError(strategyShares, bn(0))

    const accountValue = await vault.getAccountCurrentValue(whale.address, strategy.address)
    expectWithError(accountValue, bn(0))
  })
})
