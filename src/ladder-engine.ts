import Decimal from 'decimal.js';
import winston from 'winston';
import { Market, LadderOrder, PlacedOrder, BotConfig, Side, OrderBook, MarketBooks } from './types';
import { LADDER_CONFIG } from './config';
import { moduleLogger } from './logger';

export class LadderEngine {
  private log: winston.Logger;
  private config: BotConfig;
  private activeOrders: Map<string, PlacedOrder[]> = new Map();
  private clobClient: any;

  constructor(config: BotConfig, logger: winston.Logger) {
    this.config = config;
    this.log = moduleLogger(logger, 'LadderEngine');
  }

  setClobClient(client: any): void { this.clobClient = client; }

  async deployLadder(market: Market, books?: MarketBooks): Promise<LadderOrder[]> {
    const fairValueDown = this.estimateFairValue(market, books);
    const orders = this.computeLadder(market, fairValueDown);
    if (this.config.paperTrading) {
      this.log.info('[PAPER] Would place orders', { count: orders.length });
    } else {
      await this.placeOrders(market, orders);
    }
    return orders;
  }

  estimateFairValue(market: Market, books?: MarketBooks): Decimal {
    if (books?.down && books.down.midPrice > 0) {
      const implied = new Decimal(books.down.midPrice);
      if (implied.gte(0.20) && implied.lte(0.80)) return implied;
    }
    switch (market.asset) {
      case 'BTC': return new Decimal(0.55);
      case 'ETH': return new Decimal(0.52);
      default: return new Decimal(0.50);
    }
  }

  computeLadder(market: Market, fairValueDown: Decimal): LadderOrder[] {
    const orders: LadderOrder[] = [];
    const lc = LADDER_CONFIG;
    const downIsItm = fairValueDown.gte(0.50);
    const itmSide: Side = downIsItm ? 'DOWN' : 'UP';
    const otmSide: Side = downIsItm ? 'UP' : 'DOWN';
    const itmFairValue = downIsItm ? fairValueDown : new Decimal(1).minus(fairValueDown);
    const itmTokenId = itmSide === 'DOWN' ? market.tokenIdDown : market.tokenIdUp;
    const otmTokenId = otmSide === 'DOWN' ? market.tokenIdDown : market.tokenIdUp;

    let itmCount = 0;
    for (let p = 30; p <= 90; p++) {
      const price = p / 100;
      const d = Math.abs(price - itmFairValue.toNumber());
      let size = 0;
      if (d < lc.itm.coreBand) size = lc.itm.coreSize;
      else if (d < lc.itm.midBand) size = lc.itm.midSize;
      else if (d < lc.itm.outerBand) size = lc.itm.outerSize;
      if (size >= lc.minOrderSize && itmCount < lc.maxOrdersPerSide) {
        orders.push({ side: itmSide, price, size, tokenId: itmTokenId });
        itmCount++;
      }
    }

    let otmCount = 0;
    const minOtm = Math.max(Math.round(this.config.minOtmPrice * 100), 1);
    const maxOtm = Math.round(this.config.maxOtmPrice * 100);
    for (let p = minOtm; p <= maxOtm; p++) {
      if (otmCount < lc.maxOrdersPerSide) {
        orders.push({ side: otmSide, price: p/100, size: lc.otm.defaultSize, tokenId: otmTokenId });
        otmCount++;
      }
    }
    return orders;
  }

  async placeOrders(market: Market, orders: LadderOrder[]): Promise<PlacedOrder[]> {
    const placed: PlacedOrder[] = [];
    if (!this.clobClient) return placed;
    for (const order of orders) {
      try {
        const signed = await this.clobClient.createOrder({ tokenID: order.tokenId, price: order.price, side: 'BUY', size: order.size });
        const resp = await this.clobClient.postOrder(signed, 'GTC');
        placed.push({ orderId: resp.orderID || '', side: order.side, price: order.price, size: order.size, filledSize: 0, tokenId: order.tokenId, status: 'OPEN', timestamp: Date.now() });
      } catch (err) { this.log.warn('Failed to place order', { error: (err as Error).message }); }
    }
    this.activeOrders.set(market.conditionId, placed);
    return placed;
  }

  async cancelAllOrders(conditionId: string): Promise<void> {
    const orders = this.activeOrders.get(conditionId);
    if (!orders || !this.clobClient) return;
    for (const o of orders.filter(oo => oo.status === 'OPEN')) {
      try { await this.clobClient.cancelOrder(o.orderId); o.status = 'CANCELLED'; }
      catch (err) { this.log.warn('Cancel failed', { error: (err as Error).message }); }
    }
  }

  recordFill(conditionId: string, orderId: string, filledSize: number): void {
    const orders = this.activeOrders.get(conditionId);
    if (!orders) return;
    const o = orders.find(x => x.orderId === orderId);
    if (o) { o.filledSize += filledSize; o.status = o.filledSize >= o.size ? 'FILLED' : 'PARTIAL'; }
  }

  getOpenOrders(conditionId: string): PlacedOrder[] {
    return (this.activeOrders.get(conditionId) || []).filter(o => o.status === 'OPEN' || o.status === 'PARTIAL');
  }
}
