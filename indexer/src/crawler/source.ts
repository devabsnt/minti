/**
 * Abstraction over "where does this indexer get its chain data from."
 *
 * Today the only implementation will be `RpcSource` (multi-RPC pool with
 * round-robin + health tracking). If we ever need to swap to Hypersync,
 * a paid Alchemy/QuickNode endpoint, or any other event source, we
 * implement this interface and the crawler loop doesn't care.
 *
 * Methods are intentionally narrow: get the current tip, get logs in a
 * range. That's all the crawler asks for.
 */

export interface ChainLog {
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
  address: string; // contract that emitted, lowercased
  topics: readonly string[]; // hex strings
  data: string; // hex
  removed?: boolean;
}

export interface LogFilter {
  /** Inclusive start block. */
  fromBlock: number;
  /** Inclusive end block. */
  toBlock: number;
  /**
   * Topic[0] filters to OR together. The first topic position is
   * almost always the event signature, so this is "give me events
   * with sig X or Y or Z". `null` slots in subsequent positions
   * (handled in implementations) wildcard.
   */
  eventSignatures: readonly `0x${string}`[];
  /**
   * Restrict to specific contracts if known (e.g. marketplace).
   * Leave undefined for chain-wide queries (e.g. all Transfers).
   */
  addresses?: readonly `0x${string}`[];
}

export interface ChainSource {
  /** Latest block the source can serve. */
  getCurrentBlock(): Promise<number>;
  /**
   * Fetch logs for the given filter. Implementations are responsible
   * for handling provider-specific block-range limits internally — the
   * caller asks for [fromBlock, toBlock] and gets every matching log
   * in that range, even if the implementation has to paginate.
   */
  getLogs(filter: LogFilter): Promise<ChainLog[]>;
}
