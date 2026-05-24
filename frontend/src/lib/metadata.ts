import { IPFS_GATEWAYS } from "@/config/constants";
import type { NftMetadata } from "@/types/nft";

export function resolveUri(uri: string, gatewayIndex = 0): string {
  if (!uri) return "";
  if (uri.startsWith("ipfs://")) {
    const gateway = IPFS_GATEWAYS[gatewayIndex % IPFS_GATEWAYS.length];
    return gateway + uri.slice("ipfs://".length);
  }
  if (uri.startsWith("ar://")) {
    return "https://arweave.net/" + uri.slice("ar://".length);
  }
  return uri;
}

async function fetchWithGatewayFallback(uri: string): Promise<string> {
  // For non-IPFS URIs, just fetch directly
  if (!uri.startsWith("ipfs://")) {
    const response = await fetch(resolveUri(uri));
    if (!response.ok) {
      throw new Error(`Failed to fetch metadata: ${response.status}`);
    }
    return response.text();
  }

  // Try each IPFS gateway until one works
  let lastError: Error | null = null;
  for (let i = 0; i < IPFS_GATEWAYS.length; i++) {
    try {
      const url = resolveUri(uri, i);
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) {
        return response.text();
      }
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError || new Error("All IPFS gateways failed");
}

export async function resolveMetadata(
  uri: string,
  tokenId: bigint
): Promise<NftMetadata> {
  let jsonString: string;

  if (uri.startsWith("data:application/json;base64,")) {
    jsonString = atob(uri.slice("data:application/json;base64,".length));
  } else if (uri.startsWith("data:application/json,")) {
    jsonString = decodeURIComponent(
      uri.slice("data:application/json,".length)
    );
  } else if (uri.startsWith("data:application/json;utf8,")) {
    jsonString = uri.slice("data:application/json;utf8,".length);
  } else {
    jsonString = await fetchWithGatewayFallback(uri);
  }

  const raw = JSON.parse(jsonString);
  const imageRaw: string = raw.image || raw.image_url || raw.image_data || "";

  return {
    name: raw.name || `#${tokenId.toString()}`,
    description: raw.description || "",
    image: resolveUri(imageRaw),
    rawImageUri: imageRaw.startsWith("ipfs://") || imageRaw.startsWith("ar://") ? imageRaw : undefined,
    animationUrl: raw.animation_url ? resolveUri(raw.animation_url) : undefined,
    attributes: raw.attributes || [],
    externalUrl: raw.external_url,
    raw,
  };
}
