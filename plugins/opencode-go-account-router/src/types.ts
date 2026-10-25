export type Account = {
  id: string; label: string; apiKey: string; enabled: boolean; priority: number;
};
export type Window = { percent: number; status: string; resetsAt: number | null };
export type Quota = { checkedAt: number; rolling: Window; weekly: Window; monthly: Window };
export type Block = { until: number; reason: string };
export type State = {
  version: 1;
  accounts: Account[];
  quotas: Record<string, Quota>;
  blocks: Record<string, Record<string, Block>>;
  sessions: Record<string, { accountId: string; updatedAt: number }>;
  events: Array<{ at: number; session: string; accountId: string; previous?: string; reason: string }>;
};
export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
