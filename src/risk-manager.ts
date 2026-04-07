import Decimal from 'decimal.js';
import winston from 'winston';
import { RiskCheck, BotConfig } from './types';
import { moduleLogger } from './logger';
import { PositionTracker } from './position-tracker';

/**
 * RiskManager - Enforces trading limits and circuit breakers
 *
 * Checks before every order:
 * - Per-market exposure limit
 * - Total portfolio exposure limit
 * - Daily loss limit
 * - Circuit breaker (kills the bot if losses exceed threshold)
 */
export class RiskManager {
  private log: winston.Logger;
  private config: BotConfig;
  private positionTracker: PositionTracker;
  private circuitBroken: boolean = false;
  private pausedUntil: number = 0;

  constructor(
    config: BotConfig,
    positionTracker: PositionTracker,
    logger: winston.Logger
  ) {
    this.config = config;
    this.positionTracker = positionTracker;
    this.log = moduleLogger(logger, 'RiskManager');
  }

  /**
   * Check if we can place a new order
   */
  canPlaceOrder(conditionId: string, orderCostUsdc: number): RiskCheck {
    const orderCost = new Decimal(orderCostUsdc);

    // Circuit breaker check
    if (this.circuitBroken) {
      return {
        canTrade: false,
        reason: 'CIRCUIT BREAKER ACTIVE â bot stopped',
        currentExposure: this.positionTracker.getTotalExposure(),
        dailyPnl: this.positionTracker.getStats().dailyPnl,
      };
    }

    // Pause check
    if (Date.now() < this.pausedUntil) {
      const remaining = Math.ceil((this.pausedUntil - Date.now()) / 60_000);
      return {
        canTrade: false,
        reason: `Bot paused for ${remaining} more minutes`,
        currentExposure: this.positionTracker.getTotalExposure(),
        dailyPnl: this.positionTracker.getStats().dailyPnl,
      };
    }

    // Per-market exposure check
    const marketExposure = this.positionTracker.getMarketExposure(conditionId);
    if (marketExposure.plus(orderCost).gt(this.config.maxExposurePerMarket)) {
      return {
        canTrade: false,
        reason: `Market exposure would exceed $${this.config.maxExposurePerMarket} (current: $${marketExposure.toFixed(2)})`,
        currentExposure: this.positionTracker.getTotalExposure(),
        dailyPnl: this.positionTracker.getStats().dailyPnl,
      };
    }

    // Total portfolio exposure check
    const totalExposure = this.positionTracker.getTotalExposure();
    if (totalExposure.plus(orderCost).gt(this.config.maxTotalExposure)) {
      return {
        canTrade: false,
        reason: `Total exposure would exceed $${this.config.maxTotalExposure} (current: $${totalExposure.toFixed(2)})`,
        currentExposure: totalExposure,
        dailyPnl: this.positionTracker.getStats().dailyPnl,
      };
    }

    // Daily loss check
    const stats = this.positionTracker.getStats();
    if (stats.dailyPnl.lt(-this.config.maxDailyLoss)) {
      this.log.warn(`Daily loss limit hit: $${stats.dailyPnl.toFixed(2)}`);
      this.pausedUntil = Date.now() + 3600_000; // Pause 1 hour
      return {
        canTrade: false,
        reason: `Daily loss exceeds $${this.config.maxDailyLoss}. Pausing for 1 hour.`,
        currentExposure: totalExposure,
        dailyPnl: stats.dailyPnl,
      };
    }

    // Circuit breaker check
    if (stats.dailyPnl.lt(-this.config.circuitBreakerLoss)) {
      this.circuitBroken = true;
      this.log.error(`CIRCUIT BREAKER TRIGGERED! Daily loss: $${stats.dailyPnl.toFixed(2)}`);
      return {
        canTrade: false,
        reason: `CIRCUIT BREAKER: Daily loss exceeds $${this.config.circuitBreakerLoss}`,
        currentExposure: totalExposure,
        dailyPnl: stats.dailyPnl,
      };
    }

    // All checks passed
    return {
      canTrade: true,
      currentExposure: totalExposure,
      dailyPnl: stats.dailyPnl,
    };
  }

  /**
   * Periodic risk check â called every minute
   * Returns true if everything is ok, false if action needed
   */
  periodicCheck(): boolean {
    if (this.circuitBroken) return false;

    const stats = this.positionTracker.getStats();
    const totalExposure = this.positionTracker.getTotalExposure();

    // Log risk metrics
    this.log.info('Risk check', {
      totalExposure: `$${totalExposure.toFixed(2)}`,
      dailyPnl: `$${stats.dailyPnl.toFixed(2)}`,
      mergeProfit: `$${stats.totalMergeProfit.toFixed(2)}`,
      mergesExecuted: stats.mergesExecuted,
    });

    // Check unrealized loss threshold
    // If we're losing more than 20% of max exposure, reduce positions
    const unrealizedLossThreshold = new Decimal(this.config.maxTotalExposure).times(0.20);
    if (stats.dailyPnl.lt(unrealizedLossThreshold.neg())) {
      this.log.warn('Unrealized loss exceeds 20% of max exposure â consider reducing');
      return false;
    }

    return true;
  }

  /**
   * Check if the circuit breaker is active
   */
  isCircuitBroken(): boolean {
    return this.circuitBroken;
  }

  /**
   * Manually reset the circuit breaker (admin action)
   */
  resetCircuitBreaker(): void {
    this.circuitBroken = false;
    this.pausedUntil = 0;
    this.log.info('Circuit breaker manually reset');
  }

  /**
   * Get current risk status summary
   */
  getStatus(): {
    circuitBroken: boolean;
    paused: boolean;
    pauseRemainingMs: number;
    totalExposure: string;
    dailyPnl: string;
    maxExposure: number;
    maxDailyLoss: number;
  } {
    const now = Date.now();
    return {
      circuitBroken: this.circuitBroken,
      paused: now < this.pausedUntil,
      pauseRemainingMs: Math.max(0, this.pausedUntil - now),
      totalExposure: this.positionTracker.getTotalExposure().toFixed(2),
      dailyPnl: this.positionTracker.getStats().dailyPnl.toFixed(2),
      maxExposure: this.config.maxTotalExposure,
      maxDailyLoss: this.config.maxDailyLoss,
    };
  }
}
