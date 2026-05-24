import { WalletCatchAll } from "./client";

export function generateStaticParams() {
  return [{ slug: [] }];
}

export default function Page() {
  return <WalletCatchAll />;
}
