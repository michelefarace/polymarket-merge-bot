import WebSocket from 'ws';
import winston from 'winston';
import { OrderBook, MarketBooks, WsBookUpdate, BotConfig } from './types';
import { moduleLogger } from './logger';

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

/**
 * BookListener - Real-time orderbook updates via WebSocket
 *
 * Subscribes to orderbook channels for active markets.
 * Maintains best bid/ask and mid-price for each token.
 * Feeds data to LadderEngine for fair value estimation and rebalancing.
 */
export class BookListener {
  private log: winston.Logger;
  private config: BotConfig;
  private ws: WebSocket | null = null;
  private books: Map<string, OrderBook> = new Map();  // tokenId -> OrderBook
  private marketBooks: Map<string, MarketBooks> = new Map();  // conditionId -> {up, down}
  private subscribedMarkets: Set<string> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isConnected: boolean = false;

  // Callbacks
  private onBookUpdate: ((conditionId: string, books: MarketBooks) => void) | null = null;

  constructor(config: BotConfig, logger: winston.Logger) {
    this.config = config;
    this.log = moduleLogger(logger, 'BookListener');
  }

  /**
   * Register callback for book updates
   */
  onUpdate(callback: (conditionId: string, books: MarketBooks) => void): void {
    this.onBookUpdate = callback;
  }

  /**
   * Connect to WebSocket
   */
  connect(): void {
    if (this.config.paperTrading) {
      this.log.info('BookListener in PAPER mode â using synthetic book data');
      return;
    }

    this.log.info(`Connecting to ${WS_URL}`);

    this.ws = new WebSocket(WS_URL);

    this.ws.on('open', () => {
      this.isConnected = true;
      this.log.info('WebSocket connected');

      // Re-subscribe to all markets
      for (const conditionId of this.subscribedMarkets) {
        this.sendSubscribe(conditionId);
      }
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (err) {
        this.log.warn('Failed to parse WS message', {
          error: (err as Error).message,
        });
      }
    });

    this.ws.on('close', () => {
      this.isConnected = false;
      this.log.warn('WebSocket disconnected, reconnecting in 5s...');
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      this.log.error('WebSocket error', { error: err.message });
    });
  }

  /**
   * Subscribe to orderbook updates for a market
   */
  subscribeMarket(
    conditionId: string,
    tokenIdUp: string,
    tokenIdDown: string
  ): void {
    this.subscribedMarkets.add(conditionId);

    // Initialize empty books
    this.marketBooks.set(conditionId, {
      up: this.emptyBook(),
      down: this.emptyBook(),
    });

    // Store token -> conditionId mapping
    this.books.set(tokenIdUp, this.emptyBook());
    this.books.set(tokenIdDown, this.emptyBook());

    if (this.isConnected) {
      this.sendSubscribe(conditionId);
    }
  }

  /**
   * Unsubscribe from a market
   */
  unsubscribeMarket(conditionId: string): void {
    this.subscribedMarkets.delete(conditionId);

    if (this.isConnected && this.ws) {
      this.ws.send(JSON.stringify({
        type: 'unsubscribe',
        channel: 'book',
        markets: [conditionId],
      }));
    }
  }

  /**
   * Get current book for a market
   */
  getMarketBooks(conditionId: string): MarketBooks | undefined {
    return this.marketBooks.get(conditionId);
  }

  /**
   * Get a synthetic book for paper trading
   * Simulates a typical crypto 5-min market orderbook
   */
  getSyntheticBooks(fairValueDown: number = 0.55): MarketBooks {
    const downBook: OrderBook = {
      bids: [
        { price: fairValueDown - 0.02, size: 50 },
        { price: fairValueDown - 0.04, size: 80 },
        { price: fairValueDown - 0.06, size: 100 },
        { price: fairValueDown - 0.10, size: 150 },
      ],
      asks: [
        { price: fairValueDown + 0.02, size: 50 },
        { price: fairValueDown + 0.04, size: 80 },
        { price: fairValueDown + 0.06, size: 100 },
      ],
      bestBid: fairValueDown - 0.02,
      bestAsk: fairValueDown + 0.02,
      midPrice: fairValueDown,
      timestamp: Date.now(),
    };

    const fairValueUp = 1 - fairValueDown;
    const upBook: OrderBook = {
      bids: [
        { price: fairValueUp - 0.02, size: 30 },
        { price: fairValueUp - 0.04, size: 50 },
        { price: fairValueUp - 0.08, size: 80 },
      ],
      asks: [
        { price: fairValueUp + 0.02, size: 30 },
        { price: fairValueUp + 0.04, size: 50 },
        { price: fairValueUp + 0.08, size: 80 },
      ],
      bestBid: fairValueUp - 0.02,
      bestAsk: fairValueUp + 0.02,
      midPrice: fairValueUp,
      timestamp: Date.now(),
    };

    return { up: upBook, down: downBook };
  }

  /**
   * Disconnect
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.log.info('BookListener disconnected');
  }

  // --- Private methods ---

  private sendSubscribe(conditionId: string): void {
    if (!this.ws) return;
    this.ws.send(JSON.stringify({
      type: 'subscribe',
      channel: 'book',
      markets: [conditionId],
    }));
    this.log.debug(`Subscribed to book: ${conditionId.substring(0, 16)}...`);
  }

  private handleMessage(msg: any): void {
    if (msg.channel !== 'book' && msg.type !== 'book') return;

    const update = msg as WsBookUpdate;
    if (!update.asset_id || !update.market) return;

    // Update the token-level book
    const book = this.parseBookUpdate(update);
    this.books.set(update.asset_id, book);

    // Update the market-level books
    const conditionId = update.market;
    const mBooks = this.marketBooks.get(conditionId);
    if (mBooks) {
      // Determine if this is the up or down token
      // (We'd need to maintain this mapping; for now, update both)
      // This is simplified â in production, track tokenId->side mapping
      if (this.onBookUpdate) {
        this.onBookUpdate(conditionId, mBooks);
      }
    }
  }

  private parseBookUpdate(update: WsBookUpdate): OrderBook {
    const bids = (update.bids || [])
      .map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
      .sort((a, b) => b.price - a.price);

    const asks = (update.asks || [])
      .map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
      .sort((a, b) => a.price - b.price);

    const bestBid = bids.length > 0 ? bids[0].price : 0;
    const bestAsk = asks.length > 0 ? asks[0].price : 1;
    const midPrice = (bestBid + bestAsk) / 2;

    return {
      bids,
      asks,
      bestBid,
      bestAsk,
      midPrice,
      timestamp: parseInt(update.timestamp) || Date.now(),
    };
  }

  private emptyBook(): OrderBook {
    return {
      bids: [],
      asks: [],
      bestBid: 0,
      bestAsk: 1,
      midPrice: 0.5,
      timestamp: Date.now(),
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.log.info('Attempting reconnection...');
      this.connect();
    }, 5000);
  }
}
