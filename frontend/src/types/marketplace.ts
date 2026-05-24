export interface Listing {
  seller: `0x${string}`;
  nftContract: `0x${string}`;
  tokenId: bigint;
  price: bigint;
  quantity: bigint;
  isERC1155: boolean;
  timestamp: bigint;
}

export interface Bid {
  bidder: `0x${string}`;
  nftContract: `0x${string}`;
  tokenId: bigint;
  amount: bigint;
  quantity: bigint;
  isERC1155: boolean;
  optionalRoyaltyBps: number;
  timestamp: bigint;
}

export interface CollectionOffer {
  bidder: `0x${string}`;
  nftContract: `0x${string}`;
  amount: bigint;
  quantity: bigint;
  fulfilled: bigint;
  isERC1155: boolean;
  optionalRoyaltyBps: number;
  timestamp: bigint;
}

export interface ListingWithId extends Listing {
  listingId: bigint;
}

export interface BidWithId extends Bid {
  bidId: bigint;
}

export interface CollectionOfferWithId extends CollectionOffer {
  offerId: bigint;
}
