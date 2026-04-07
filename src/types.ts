import Decimal from 'decimal.js';

// ============================================================
// CORE TYPES - Polymarket Merge Arbitrage Bot
// ============================================================

export interface BotConfig {
  privateKey: string;
  clobApiUrl: string;
  gammaApiUrl: string;
  polygonRpcUrl: string;
  paperTrading: boolean;
  initialCapitalUsdc: number;
  maxExposurePerMarket: number;
  maxTotalExposure: number;
  mergeThreshold: number;    // combined cost must be < this to merge (e.g., 0.97)
  minOtmPrice: number;       // lowest OTM order price (e.g., 0.03)
  maxOtmPrice: number;       // highest OTM order price (e.g., 0.15)
  maxDailyLoss: number;
  circuitBreakerLoss: number;
  logLevel: string;
  dbPath: string;
}

export interface Market {
  conditionId: string;
  questionId: string;
  slug: string;
  tokenIdUp: string;
  tokenIdDown: string;
  startTime: Date;
  endTime: Date;
  timeframe: '5m' | '15m';
  asset: 'BTC' | 'ETH' | 'BNB' | 'XRP' | 'SOL';
  active: boolean;
}

export type Side = 'UP' | 'DOWN';

export interface LadderOrder {
  side: Side;
  price: number;         // 0.01 - 0.99
  size: number;          // number of shares
  tokenId: string;
}

export interface PlacedOrder {
  orderId: string;
  side: Side;
  price: number;
  size: number;
  filledSize: number;
  tokenId: string;
  status: 'OPEN' | 'PARTIAL' | 'FILLED' | 'CANCELLED';
  timestamp: number;
}

export interface Fill {
  orderId: string;
  side: Side;
  price: number;
  size: number;
  tokenId: string;
  timestamp: number;
  makerOrTaker: 'MAKER' | 'TAKER';
}

export interface MarketPosition {
  conditionId: string;
  market: Market;

  // Down side
  downShares: Decimal;
  downTotalCost: Decimal;
  downAvgPrice: Decimal;

  // Up side
  upShares: Decimal;
  upTotalCost: Decimal;
  upAvgPrice: Decimal;

  // Merge tracking
  mergedShares: Decimal;
  mergedProfit: Decimal;

  // Orders
  openOrders: PlacedOrder[];

  // Status
  status: 'active' | 'merging' | 'settling' | 'settled';
  createdAt: number;
}

export interface MergeOpportunity {
  conditionId: string;
  mergeableShares: Decimal;
  combinedCost: Decimal;     // avg_down + avg_up (must be < 1.0 for profit)
  expectedProfit: Decimal;   // mergeableShares * (1.0 - combinedCost)
  downAvgCost: Decimal;
  upAvgCost: Decimal;
}

export interface BookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  bids: BookLevel[];   // sorted desc by price
  asks: BookLevel[];   // sorted asc by price
  bestBid: number;
  bestAsk: number;
  midPrice: number;
  timestamp: number;
}

export interface MarketBooks {
  up: OrderBook;
  down: OrderBook;
}

export interface BotStats {
  totalMergeProfit: Decimal;
  totalSettlementProfit: Decimal;
  totalProfit: Decimal;
  totalVolume: Decimal;
  marketsTraded: number;
  mergesExecuted: number;
  ordersPlaced: number;
  fillRate: number;
  avgCombinedCost: Decimal;
  dailyPnl: Decimal;
  startTime: number;
}

export interface RiskCheck {
  canTrade: boolean;
  reason?: string;
  currentExposure: Decimal;
  dailyPnl: Decimal;
}

// WebSocket message types
export interface WsBookUpdate {
  market: string;
  asset_id: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  timestamp: string;
}

export interface WsTradeUpdate {
  market: string;
  asset_id: string;
  side: string;
  price: string;
  size: string;
  timestamp: string;
}

// Events emitted by modules
export type BotEvent =
  | { type: 'NEW_MARKET'; market: Market }
  | { type: 'ORDERS_PLACED'; conditionId: string; count: number }
  | { type: 'FILL'; fill: Fill }
  | { type: 'MERGE_EXECUTED'; conditionId: string; shares: Decimal; profit: Decimal }
  | { type: 'MARKET_SETTLED'; conditionId: string; pnl: Decimal }
  | { type: 'RISK_ALERT'; message: string }
  | { type: 'CIRCUIT_BREAKER'; reason: string };
