import { CollectionCatchAll } from "./client";

export function generateStaticParams() {
  return [{ slug: [] }];
}

export default function Page() {
  return <CollectionCatchAll />;
}
