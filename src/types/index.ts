export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type WalletType = 'trader' | 'bot' | 'whale' | 'mixer' | 'scammer' | 'dormant' | 'new' | 'unknown';
export type Chain = 'ethereum' | 'solana' | 'bnb' | 'xrp' | 'auto';

export interface AnalyzeRequest {
  address: string;
  chain?: Chain;
}

export interface BatchRequest {
  wallets: AnalyzeRequest[];
}

export interface TransactionStats {
  total_transactions: number;
  first_seen?: string;
  last_seen?: string;
  wallet_age_days: number;
  unique_contracts_interacted: number;
  native_balance?: string;
  native_currency: string;
}

export interface RiskFlags {
  interacted_with_mixer: boolean;
  interacted_with_known_scam: boolean;
  high_frequency_trading: boolean;
  large_value_transfers: boolean;
  multiple_new_tokens: boolean;
  dormant_then_active: boolean;
}

export interface WalletResponse {
  id: string;
  address: string;
  chain: string;
  risk_score: number;
  risk_level: RiskLevel;
  wallet_type: WalletType;
  recommendation: string;
  transaction_stats: TransactionStats;
  risk_flags: RiskFlags;
  signals: { signal: string; severity: 'low' | 'medium' | 'high' | 'critical' }[];
  summary: string;
  latency_ms: number;
  created_at: string;
}