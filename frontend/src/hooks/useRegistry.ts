"use client";

import { useQuery } from "@tanstack/react-query";

import { useRpc } from "@/providers/RpcProvider";
import { useBrowseChain } from "@/providers/ChainProvider";
import {
  EVMFS_COLLECTION_REGISTRY_ABI,
  type CollectionRecord,
} from "@/lib/abi/EVMFSCollectionRegistry";
import { MINTI_COLLECTION_REGISTRY, isRegistryDeployed } from "@/lib/evmfs";

export interface RegisteredCollection extends CollectionRecord {
  id: number;
  verified: boolean;
  tags: string[];
}

const PAGE_SIZE = 24;

export function useRegisteredCollections(page = 0) {
  const { browseChainId } = useBrowseChain();
  const { getPublicClient } = useRpc();
  const registryAddr = MINTI_COLLECTION_REGISTRY[browseChainId];

  return useQuery({
    queryKey: ["evmfs-registry", browseChainId, page],
    enabled: isRegistryDeployed(browseChainId),
    staleTime: 30_000,
    queryFn: async (): Promise<{ collections: RegisteredCollection[]; total: number }> => {
      const client = getPublicClient(browseChainId);
      const count = (await client.readContract({
        address: registryAddr,
        abi: EVMFS_COLLECTION_REGISTRY_ABI,
        functionName: "count",
      })) as bigint;

      const total = Number(count);
      if (total === 0) return { collections: [], total: 0 };

      const offset = BigInt(page * PAGE_SIZE);
      const limit = BigInt(PAGE_SIZE);
      const rows = (await client.readContract({
        address: registryAddr,
        abi: EVMFS_COLLECTION_REGISTRY_ABI,
        functionName: "getCollections",
        args: [offset, limit],
      })) as CollectionRecord[];

      const startId = page * PAGE_SIZE + 1;
      const ids = rows.map((_, i) => BigInt(startId + i));

      // Fan out the verified + tags reads in parallel — small N (page size 24)
      // so this is fine; if pagination grows, swap for Multicall3.
      const [verifiedFlags, tagSets] = await Promise.all([
        Promise.all(
          rows.map((row) =>
            client.readContract({
              address: registryAddr,
              abi: EVMFS_COLLECTION_REGISTRY_ABI,
              functionName: "verified",
              args: [row.nftContract],
            }) as Promise<boolean>,
          ),
        ),
        Promise.all(
          ids.map((id) =>
            client.readContract({
              address: registryAddr,
              abi: EVMFS_COLLECTION_REGISTRY_ABI,
              functionName: "getTags",
              args: [id],
            }) as Promise<readonly string[]>,
          ),
        ),
      ]);

      const collections: RegisteredCollection[] = rows.map((row, i) => ({
        ...row,
        id: startId + i,
        verified: verifiedFlags[i],
        tags: [...tagSets[i]],
      }));
      return { collections, total };
    },
  });
}

export function useRegisteredCollectionByNft(nft: `0x${string}` | undefined) {
  const { browseChainId } = useBrowseChain();
  const { getPublicClient } = useRpc();
  const registryAddr = MINTI_COLLECTION_REGISTRY[browseChainId];

  return useQuery({
    queryKey: ["evmfs-registry-by-nft", browseChainId, nft],
    enabled: !!nft && isRegistryDeployed(browseChainId),
    staleTime: 60_000,
    queryFn: async (): Promise<RegisteredCollection | null> => {
      const client = getPublicClient(browseChainId);
      const id = (await client.readContract({
        address: registryAddr,
        abi: EVMFS_COLLECTION_REGISTRY_ABI,
        functionName: "collectionIdByNft",
        args: [nft!],
      })) as bigint;
      if (id === 0n) return null;
      const [row, isVerified, tagSet] = await Promise.all([
        client.readContract({
          address: registryAddr,
          abi: EVMFS_COLLECTION_REGISTRY_ABI,
          functionName: "getCollection",
          args: [id],
        }) as Promise<CollectionRecord>,
        client.readContract({
          address: registryAddr,
          abi: EVMFS_COLLECTION_REGISTRY_ABI,
          functionName: "verified",
          args: [nft!],
        }) as Promise<boolean>,
        client.readContract({
          address: registryAddr,
          abi: EVMFS_COLLECTION_REGISTRY_ABI,
          functionName: "getTags",
          args: [id],
        }) as Promise<readonly string[]>,
      ]);
      return { ...row, id: Number(id), verified: isVerified, tags: [...tagSet] };
    },
  });
}

export function useCreatorCollections(creator: `0x${string}` | undefined) {
  const { browseChainId } = useBrowseChain();
  const { getPublicClient } = useRpc();
  const registryAddr = MINTI_COLLECTION_REGISTRY[browseChainId];

  return useQuery({
    queryKey: ["evmfs-registry-by-creator", browseChainId, creator],
    enabled: !!creator && isRegistryDeployed(browseChainId),
    staleTime: 30_000,
    queryFn: async (): Promise<RegisteredCollection[]> => {
      const client = getPublicClient(browseChainId);
      const ids = (await client.readContract({
        address: registryAddr,
        abi: EVMFS_COLLECTION_REGISTRY_ABI,
        functionName: "collectionsByCreator",
        args: [creator!],
      })) as bigint[];
      if (ids.length === 0) return [];
      const rows = await Promise.all(
        ids.map(
          (id) =>
            client.readContract({
              address: registryAddr,
              abi: EVMFS_COLLECTION_REGISTRY_ABI,
              functionName: "getCollection",
              args: [id],
            }) as Promise<CollectionRecord>,
        ),
      );
      const verifiedFlags = await Promise.all(
        rows.map(
          (r) =>
            client.readContract({
              address: registryAddr,
              abi: EVMFS_COLLECTION_REGISTRY_ABI,
              functionName: "verified",
              args: [r.nftContract],
            }) as Promise<boolean>,
        ),
      );
      const tagSets = await Promise.all(
        ids.map(
          (id) =>
            client.readContract({
              address: registryAddr,
              abi: EVMFS_COLLECTION_REGISTRY_ABI,
              functionName: "getTags",
              args: [id],
            }) as Promise<readonly string[]>,
        ),
      );
      return rows.map((r, i) => ({
        ...r,
        id: Number(ids[i]),
        verified: verifiedFlags[i],
        tags: [...tagSets[i]],
      }));
    },
  });
}

export { PAGE_SIZE as REGISTRY_PAGE_SIZE };
