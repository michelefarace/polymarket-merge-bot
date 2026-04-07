import Decimal from 'decimal.js';
import winston from 'winston';
import { ethers } from 'ethers';
import { MergeOpportunity, MarketPosition, BotConfig } from './types';
import { CONTRACTS } from './config';
import { moduleLogger } from './logger';
import { PositionTracker } from './position-tracker';

// Minimal ABI for CTFExchange merge function
const CTF_EXCHANGE_ABI = [
  'function mergePositions(bytes32 conditionId, uint256 amount) external',
  'function splitPosition(bytes32 conditionId, uint256 amount) external',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
];

const ERC1155_ABI = [
  'function setApprovalForAll(address operator, bool approved) external',
  'function isApprovedForAll(address account, address operator) external view returns (bool)',
];

/**
 * MergeEngine - Detects and executes merge arbitrage opportunities
 *
 * When the bot holds both Up and Down shares for the same market:
 * - Calculates the combined cost (avg_down_price + avg_up_price)
 * - If combined cost < merge threshold (e.g., 0.97):
 *   â Merge min(downShares, upShares) pairs
 *   â Each pair returns $1.00 USDC
 *   â Profit = mergedShares * (1.00 - combinedCost)
 *
 * The merge is executed on-chain via the CTFExchange contract on Polygon.
 */
export class MergeEngine {
  private log: winston.Logger;
  private config: BotConfig;
  private positionTracker: PositionTracker;

  // Polygon provider and signer
  private provider: ethers.JsonRpcProvider | null = null;
  private signer: ethers.Wallet | null = null;
  private ctfExchange: ethers.Contract | null = null;
  private conditionalTokens: ethers.Contract | null = null;

  // Approval state
  private hasApprovedCTF: boolean = false;

  constructor(
    config: BotConfig,
    positionTracker: PositionTracker,
    logger: winston.Logger
  ) {
    this.config = config;
    this.positionTracker = positionTracker;
    this.log = moduleLogger(logger, 'MergeEngine');
  }

  /**
   * Initialize Polygon connection for on-chain merges
   */
  async initialize(): Promise<void> {
    if (this.config.paperTrading) {
      this.log.info('MergeEngine initialized in PAPER mode (no on-chain txns)');
      return;
    }

    try {
      this.provider = new ethers.JsonRpcProvider(this.config.polygonRpcUrl);
      this.signer = new ethers.Wallet(this.config.privateKey, this.provider);

      this.ctfExchange = new ethers.Contract(
        CONTRACTS.CTF_EXCHANGE,
        CTF_EXCHANGE_ABI,
        this.signer
      );

      this.conditionalTokens = new ethers.Contract(
        CONTRACTS.CONDITIONAL_TOKENS,
        ERC1155_ABI,
        this.signer
      );

      // Ensure ERC1155 approval for CTFExchange
      await this.ensureApprovals();

      const balance = await this.provider.getBalance(this.signer.address);
      this.log.info(`MergeEngine initialized on Polygon`, {
        address: this.signer.address,
        maticBalance: ethers.formatEther(balance),
      });
    } catch (err) {
      this.log.error('Failed to initialize MergeEngine', {
        error: (err as Error).message,
      });
    }
  }

  /**
   * Ensure the CTFExchange has approval to transfer our conditional tokens
   */
  private async ensureApprovals(): Promise<void> {
    if (this.hasApprovedCTF || !this.conditionalTokens || !this.signer) return;

    try {
      const isApproved = await this.conditionalTokens.isApprovedForAll(
        this.signer.address,
        CONTRACTS.CTF_EXCHANGE
      );

      if (!isApproved) {
        this.log.info('Setting ERC1155 approval for CTFExchange...');
        const tx = await this.conditionalTokens.setApprovalForAll(
          CONTRACTS.CTF_EXCHANGE,
          true
        );
        await tx.wait();
        this.log.info('Approval set successfully');
      }

      this.hasApprovedCTF = true;
    } catch (err) {
      this.log.error('Failed to set approvals', {
        error: (err as Error).message,
      });
    }
  }

  /**
   * Check all active positions for merge opportunities
   */
  checkAllPositions(): MergeOpportunity[] {
    const opportunities: MergeOpportunity[] = [];
    const positions = this.positionTracker.getActivePositions();

    for (const pos of positions) {
      const opp = this.checkPosition(pos);
      if (opp) {
        opportunities.push(opp);
      }
    }

    return opportunities;
  }

  /**
   * Check a single position for merge opportunity
   */
  checkPosition(pos: MarketPosition): MergeOpportunity | null {
    // Need shares on BOTH sides
    if (pos.downShares.lte(0) || pos.upShares.lte(0)) return null;

    const mergeableShares = Decimal.min(pos.downShares, pos.upShares);
    if (mergeableShares.lt(1)) return null;

    // Calculate combined cost
    const combinedCost = pos.downAvgPrice.plus(pos.upAvgPrice);

    // Only merge if combined cost is below threshold
    if (combinedCost.gte(this.config.mergeThreshold)) {
      this.log.debug(`Merge skipped: combined cost ${combinedCost.toFixed(4)} >= threshold ${this.config.mergeThreshold}`, {
        conditionId: pos.conditionId.substring(0, 16),
      });
      return null;
    }

    const expectedProfit = mergeableShares.times(new Decimal(1).minus(combinedCost));

    return {
      conditionId: pos.conditionId,
      mergeableShares,
      combinedCost,
      expectedProfit,
      downAvgCost: pos.downAvgPrice,
      upAvgCost: pos.upAvgPrice,
    };
  }

  /**
   * Execute a merge opportunity
   */
  async executeMerge(opportunity: MergeOpportunity): Promise<boolean> {
    const { conditionId, mergeableShares, combinedCost, expectedProfit } = opportunity;

    this.log.info(`Executing merge: ${mergeableShares.toFixed(2)} shares`, {
      conditionId: conditionId.substring(0, 16),
      combinedCost: combinedCost.toFixed(4),
      expectedProfit: `$${expectedProfit.toFixed(4)}`,
    });

    if (this.config.paperTrading) {
      this.log.info(`[PAPER] Merge simulated: +$${expectedProfit.toFixed(4)}`);
      // Record in position tracker even in paper mode
      this.positionTracker.recordMerge(conditionId, mergeableShares, expectedProfit);
      return true;
    }

    // Execute on-chain merge
    try {
      if (!this.ctfExchange) {
        this.log.error('CTFExchange contract not initialized');
        return false;
      }

      // Convert shares to on-chain amount (USDC has 6 decimals)
      // Conditional tokens use the same decimal precision
      const amount = ethers.parseUnits(mergeableShares.toFixed(6), 6);

      // Execute merge transaction
      const tx = await this.ctfExchange.mergePositions(
        conditionId,
        amount,
        {
          gasLimit: 300_000,
          // Use current gas price with small priority fee
        }
      );

      this.log.info(`Merge TX submitted: ${tx.hash}`);

      // Wait for confirmation
      const receipt = await tx.wait(1); // 1 confirmation

      if (receipt && receipt.status === 1) {
        this.log.info(`Merge confirmed in block ${receipt.blockNumber}`);
        // Record in position tracker
        this.positionTracker.recordMerge(conditionId, mergeableShares, expectedProfit);
        return true;
      } else {
        this.log.error('Merge transaction reverted');
        return false;
      }
    } catch (err) {
      this.log.error('Merge execution failed', {
        error: (err as Error).message,
        conditionId: conditionId.substring(0, 16),
      });
      return false;
    }
  }

  /**
   * Execute all profitable merge opportunities
   */
  async executeAllMerges(): Promise<{ total: number; successful: number; profit: Decimal }> {
    const opportunities = this.checkAllPositions();
    let successful = 0;
    let totalProfit = new Decimal(0);

    // Sort by profit descending â execute most profitable first
    opportunities.sort((a, b) => b.expectedProfit.minus(a.expectedProfit).toNumber());

    for (const opp of opportunities) {
      const success = await this.executeMerge(opp);
      if (success) {
        successful++;
        totalProfit = totalProfit.plus(opp.expectedProfit);
      }

      // Small delay between merges to avoid nonce issues
      if (!this.config.paperTrading && opportunities.length > 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    if (opportunities.length > 0) {
      this.log.info(`Merge batch complete: ${successful}/${opportunities.length} | profit: $${totalProfit.toFixed(4)}`);
    }

    return { total: opportunities.length, successful, profit: totalProfit };
  }
}
