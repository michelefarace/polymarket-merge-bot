import winston from 'winston';
import { Market, BotConfig } from './types';
import { MARKET_PATTERNS } from './config';
import { moduleLogger } from './logger';

export class MarketScanner {
  private log: winston.Logger;
  private config: BotConfig;
  private knownMarkets: Map<string, Market> = new Map();
  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private onNewMarket: ((market: Market) => void) | null = null;

  constructor(config: BotConfig, logger: winston.Logger) {
    this.config = config;
    this.log = moduleLogger(logger, 'MarketScanner');
  }

  onMarketDiscovered(callback: (market: Market) => void): void {
    this.onNewMarket = callback;
  }

  start(): void {
    this.log.info('Starting market scanner');
    this.scan();
    this.scanInterval = setInterval(() => this.scan(), 10_000);
  }

  stop(): void {
    if (this.scanInterval) { clearInterval(this.scanInterval); this.scanInterval = null; }
    this.log.info('Market scanner stopped');
  }

  async scan(): Promise<void> { /* scans Gamma API */ }
  getActiveMarkets(): Market[] { return Array.from(this.knownMarkets.values()).filter(m => m.active); }
  markSettled(id: string): void { const m = this.knownMarkets.get(id); if(m) m.active = false; }
  cleanup(): void {}
}
