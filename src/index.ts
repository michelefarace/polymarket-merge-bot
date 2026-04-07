import { loadConfig } from './config';
import { createLogger } from './logger';
import { Orchestrator } from './orchestrator';

/**
 * POLYMARKET MERGE ARBITRAGE BOT
 * ==============================
 *
 * Strategy: Dual-Side Ladder + Merge Arbitrage
 *
 * 1. For each crypto Up/Down 5-min market:
 *    - Place MAKER limit orders on BOTH sides (Up and Down)
 *    - ITM side (favored): ladder from 55c to 85c
 *    - OTM side (underdog): ladder from 3c to 15c
 *
 * 2. When orders fill on both sides:
 *    - Combined cost < $1.00 (e.g., Down@70c + Up@6c = 76c)
 *    - MERGE the paired shares â receive $1.00 per pair
 *    - Profit per pair = $1.00 - combined cost = 24c (guaranteed!)
 *
 * 3. Excess OTM shares are "free lottery tickets":
 *    - Cost already covered by merge profit
 *    - If market reverses: massive payout ($0 cost â $1 per share)
 *
 * Based on analysis of wallet 0xb27bc932bf8110d8f78e55da7d5f0497a18b5b82
 * which made $392K+ using this exact strategy.
 *
 * USAGE:
 *   Paper trading: PAPER_TRADING=true npm run dev
 *   Live trading:  PAPER_TRADING=false npm start
 *
 * REQUIREMENTS:
 *   - VPS in UK/Ireland (Polymarket is restricted in Italy)
 *   - Funded Polygon wallet with USDC + MATIC for gas
 *   - @polymarket/clob-client installed for live trading
 */

async function main(): Promise<void> {
  // Load configuration from .env
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  logger.info('='.repeat(60));
  logger.info('  POLYMARKET MERGE ARBITRAGE BOT');
  logger.info(`  Mode: ${config.paperTrading ? 'ð PAPER TRADING' : 'ð´ LIVE TRADING'}`);
  logger.info(`  Capital: $${config.initialCapitalUsdc}`);
  logger.info(`  Merge threshold: ${config.mergeThreshold}`);
  logger.info(`  OTM range: ${config.minOtmPrice}-${config.maxOtmPrice}`);
  logger.info(`  Max exposure per market: $${config.maxExposurePerMarket}`);
  logger.info(`  Max total exposure: $${config.maxTotalExposure}`);
  logger.info(`  Max daily loss: $${config.maxDailyLoss}`);
  logger.info(`  Circuit breaker: $${config.circuitBreakerLoss}`);
  logger.info('='.repeat(60));

  // Create and start orchestrator
  const orchestrator = new Orchestrator(config, logger);

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    await orchestrator.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Handle uncaught errors
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack });
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason: String(reason) });
  });

  // Start the bot
  try {
    await orchestrator.start();

    // Keep alive
    logger.info('Bot running. Press Ctrl+C to stop.');
  } catch (err) {
    logger.error('Failed to start bot', { error: (err as Error).message });
    process.exit(1);
  }
}

// Entry point
main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
