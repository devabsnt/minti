export interface NftMetadata {
  name: string;
  description: string;
  image: string;
  rawImageUri?: string; // original URI before gateway resolution (e.g. ipfs://...)
  animationUrl?: string;
  attributes?: NftAttribute[];
  externalUrl?: string;
  raw: Record<string, unknown>;
}

export interface NftAttribute {
  trait_type: string;
  value: string | number;
  display_type?: string;
}

export interface NftToken {
  contractAddress: `0x${string}`;
  tokenId: bigint;
  isERC1155: boolean;
  metadata?: NftMetadata;
  owner?: `0x${string}`;
}
