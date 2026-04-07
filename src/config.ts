import dotenv from 'dotenv';
import { BotConfig } from './types';

dotenv.config();

function envOrThrow(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function envOrDefault(key: string, defaultVal: string): string {
  return process.env[key] || defaultVal;
}

export function loadConfig(): BotConfig {
  return {
    privateKey: envOrThrow('PRIVATE_KEY'),
    clobApiUrl: envOrDefault('CLOB_API_URL', 'https://clob.polymarket.com'),
    gammaApiUrl: envOrDefault('GAMMA_API_URL', 'https://gamma-api.polymarket.com'),
    polygonRpcUrl: envOrDefault('POLYGON_RPC_URL', 'https://polygon-rpc.com'),
    paperTrading: envOrDefault('PAPER_TRADING', 'true') === 'true',
    initialCapitalUsdc: Number(envOrDefault('INITIAL_CAPITAL_USDC', '1000')),
    maxExposurePerMarket: Number(envOrDefault('MAX_EXPOSURE_PER_MARKET', '4000')),
    maxTotalExposure: Number(envOrDefault('MAX_TOTAL_EXPOSURE', '50000')),
    mergeThreshold: Number(envOrDefault('MERGE_THRESHOLD', '0.97')),
    minOtmPrice: Number(envOrDefault('MIN_OTM_PRICE', '0.03')),
    maxOtmPrice: Number(envOrDefault('MAX_OTM_PRICE', '0.15')),
    maxDailyLoss: Number(envOrDefault('MAX_DAILY_LOSS', '5000')),
    circuitBreakerLoss: Number(envOrDefault('CIRCUIT_BREAKER_LOSS', '10000')),
    logLevel: envOrDefault('LOG_LEVEL', 'info'),
    dbPath: envOrDefault('DB_PATH', './data/bot.db'),
  };
}

// Polymarket contract addresses on Polygon
export const CONTRACTS = {
  CTF_EXCHANGE: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  NEG_RISK_CTF_EXCHANGE: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
  USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',        // USDC on Polygon
  CONDITIONAL_TOKENS: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
} as const;

// Market detection patterns
export const MARKET_PATTERNS = {
  slugPatterns: [
    /^(btc|eth|bnb|xrp|sol)-updown-5m-/,
    /^(btc|eth|bnb|xrp|sol)-updown-15m-/,
  ],
  assets: ['BTC', 'ETH', 'BNB', 'XRP', 'SOL'] as const,
  timeframes: ['5m', '15m'] as const,
} as const;

// Ladder configuration
export const LADDER_CONFIG = {
  // ITM side (the favored outcome)
  itm: {
    coreBand: 0.10,      // +/- 10% around fair value
    coreSize: 20,
    midBand: 0.20,       // +/- 20%
    midSize: 10,
    outerBand: 0.35,     // +/- 35%
    outerSize: 5,
  },
  // OTM side (the underdog)
  otm: {
    minPrice: 0.03,
    maxPrice: 0.15,
    stepSize: 0.01,       // 1 cent steps
    defaultSize: 10,
  },
  // General
  priceStep: 0.01,
  minOrderSize: 5,
  maxOrdersPerSide: 30,
} as const;
