import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { getTransactionList, getTokenTransfers, getBalance } from '../utils/etherscan';
import { getBnbTransactionList, getBnbTokenTransfers, getBnbBalance } from '../utils/bnb';
import { getSolanaTransactions, getSolanaBalance } from '../utils/solana';
import { getXrpTransactions, getXrpBalance, getXrpAccountAge } from '../utils/xrp';
import { detectMixerInteraction, detectScamInteraction, detectHighFrequency, detectLargeTransfers, getUniqueContracts, getWalletAge } from '../utils/risk';
import { detectChain } from '../utils/validation';
import type { AnalyzeRequest, WalletResponse, RiskLevel, WalletType, WalletIntent } from '../types/index';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

function getRiskLevel(score: number): RiskLevel { return score >= 80 ? 'critical' : score >= 50 ? 'high' : score >= 20 ? 'medium' : 'low'; }

function getRecommendation(score: number): string {
  if (score >= 80) return 'block — high fraud risk';
  if (score >= 50) return 'review — suspicious activity detected';
  if (score >= 20) return 'monitor — some risk signals present';
  return 'allow — low risk wallet';
}

function detectIntent(params: {
  mixerInteraction: boolean;
  highFrequency: boolean;
  largeTransfers: boolean;
  multipleNewTokens: boolean;
  dormantThenActive: boolean;
  ageDays: number;
  txCount: number;
  uniqueContracts: number;
}): { intent: WalletIntent; confidence: number; behaviors: string[] } {
  const behaviors: string[] = [];

  if (params.mixerInteraction) behaviors.push('mixer_usage');
  if (params.highFrequency) behaviors.push('high_frequency_trading');
  if (params.largeTransfers) behaviors.push('large_value_transfers');
  if (params.multipleNewTokens) behaviors.push('interacts_with_new_contracts');
  if (params.dormantThenActive) behaviors.push('dormant_reactivation');
  if (params.ageDays < 30 && params.txCount > 10) behaviors.push('rapid_activity_new_wallet');
  if (params.uniqueContracts > 20) behaviors.push('high_contract_diversity');
  if (params.txCount > 0 && params.uniqueContracts / params.txCount > 0.5) behaviors.push('contract_hopping');

  // Determine intent
  let intent: WalletIntent = 'unknown';
  let confidence = 0.5;

  if (params.mixerInteraction) {
    intent = 'mixer_usage';
    confidence = 0.90;
  } else if (params.highFrequency && params.multipleNewTokens && params.ageDays < 90) {
    intent = 'airdrop_farming';
    confidence = 0.82;
    behaviors.push('low_token_retention');
  } else if (params.highFrequency && !params.multipleNewTokens) {
    intent = 'bot_trading';
    confidence = 0.78;
  } else if (params.largeTransfers && !params.highFrequency) {
    intent = 'whale_accumulation';
    confidence = 0.75;
  } else if (params.multipleNewTokens && params.uniqueContracts > 15) {
    intent = 'liquidity_farming';
    confidence = 0.72;
  } else if (params.ageDays < 7 || params.txCount === 0) {
    intent = 'new_wallet';
    confidence = 0.95;
  } else if (behaviors.length === 0) {
    intent = 'normal_usage';
    confidence = 0.80;
  }

  if (behaviors.length === 0) behaviors.push('normal_transaction_patterns');

  return { intent, confidence, behaviors };
}

type ResolvedChain = 'ethereum' | 'solana' | 'bnb' | 'xrp';

async function analyzeEthereum(address: string) {
  const [txList, tokenTransfers, balance] = await Promise.all([
    getTransactionList(address), getTokenTransfers(address), getBalance(address),
  ]);
  return { txList, tokenTransfers, balance, currency: 'ETH' };
}

async function analyzeBnb(address: string) {
  const [txList, tokenTransfers, balance] = await Promise.all([
    getBnbTransactionList(address), getBnbTokenTransfers(address), getBnbBalance(address),
  ]);
  return { txList, tokenTransfers, balance, currency: 'BNB' };
}

async function analyzeSolana(address: string) {
  const [txList, balance] = await Promise.all([
    getSolanaTransactions(address), getSolanaBalance(address),
  ]);
  const ageDays = txList.length > 0
    ? Math.floor((Date.now() / 1000 - Number((txList[txList.length - 1] as Record<string, unknown>)?.blockTime ?? 0)) / 86400)
    : 0;
  return { txList, tokenTransfers: [] as Record<string, unknown>[], balance, currency: 'SOL', ageDays };
}

async function analyzeXrp(address: string) {
  const [txList, balance, ageDays] = await Promise.all([
    getXrpTransactions(address), getXrpBalance(address), getXrpAccountAge(address),
  ]);
  return { txList, tokenTransfers: [] as Record<string, unknown>[], balance, currency: 'XRP', ageDays };
}

export async function analyzeWallet(req: AnalyzeRequest): Promise<WalletResponse> {
  const id = `wallet_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
  const t0 = Date.now();
  const address = req.address;

  let chain: ResolvedChain;
  if (!req.chain || req.chain === 'auto') {
    const detected = detectChain(address);
    chain = (detected === 'unknown' ? 'ethereum' : detected) as ResolvedChain;
  } else {
    chain = req.chain as ResolvedChain;
  }

  logger.info({ id, address, chain }, 'Starting wallet analysis');

  let txList: Record<string, unknown>[] = [];
  let tokenTransfers: Record<string, unknown>[] = [];
  let balance = '0';
  let currency = 'ETH';
  let ageDays = 0;
  let firstSeen: string | undefined;
  let lastSeen: string | undefined;

  if (chain === 'ethereum') {
    const result = await analyzeEthereum(address.toLowerCase());
    txList = result.txList; tokenTransfers = result.tokenTransfers;
    balance = result.balance; currency = result.currency;
    const age = getWalletAge(txList);
    ageDays = age.ageDays; firstSeen = age.firstSeen; lastSeen = age.lastSeen;
  } else if (chain === 'bnb') {
    const result = await analyzeBnb(address.toLowerCase());
    txList = result.txList; tokenTransfers = result.tokenTransfers;
    balance = result.balance; currency = result.currency;
    const age = getWalletAge(txList);
    ageDays = age.ageDays; firstSeen = age.firstSeen; lastSeen = age.lastSeen;
  } else if (chain === 'solana') {
    const result = await analyzeSolana(address);
    txList = result.txList; tokenTransfers = result.tokenTransfers;
    balance = result.balance; currency = result.currency; ageDays = result.ageDays;
  } else if (chain === 'xrp') {
    const result = await analyzeXrp(address);
    txList = result.txList; tokenTransfers = result.tokenTransfers;
    balance = result.balance; currency = result.currency; ageDays = result.ageDays;
  }

  const uniqueContracts = chain === 'ethereum' || chain === 'bnb' ? getUniqueContracts(txList) : 0;
  const mixerInteraction = chain === 'ethereum' || chain === 'bnb' ? detectMixerInteraction([...txList, ...tokenTransfers]) : false;
  const scamInteraction = chain === 'ethereum' || chain === 'bnb' ? detectScamInteraction(txList) : false;
  const highFrequency = detectHighFrequency(txList);
  const largeTransfers = chain === 'ethereum' || chain === 'bnb' ? detectLargeTransfers(txList) : Number(balance) > 10000;
  const multipleNewTokens = tokenTransfers.length > 20;
  const dormantThenActive = ageDays > 365 && txList.length > 0;

  const signals: WalletResponse['signals'] = [];
  let riskScore = 0;

  if (mixerInteraction) { riskScore += 60; signals.push({ signal: 'Interaction with known mixer (Tornado Cash or similar)', severity: 'critical' }); }
  if (scamInteraction) { riskScore += 50; signals.push({ signal: 'Interaction with known scam or exploit contract', severity: 'critical' }); }
  if (highFrequency) { riskScore += 30; signals.push({ signal: 'High frequency trading pattern detected', severity: 'high' }); }
  if (largeTransfers) { riskScore += 20; signals.push({ signal: 'Large value transfers detected', severity: 'medium' }); }
  if (multipleNewTokens) { riskScore += 15; signals.push({ signal: 'Interactions with many new/unknown tokens', severity: 'medium' }); }
  if (dormantThenActive) { riskScore += 25; signals.push({ signal: 'Dormant wallet recently became active', severity: 'high' }); }
  if (ageDays < 7) { riskScore += 15; signals.push({ signal: 'Very new wallet (less than 7 days old)', severity: 'medium' }); }
  if (txList.length === 0) signals.push({ signal: 'No transaction history found', severity: 'low' });
  if (signals.length === 0) signals.push({ signal: 'No risk signals detected', severity: 'low' });

  riskScore = Math.min(100, riskScore);

  // Detect intent and behaviors
  const { intent, confidence: intentConfidence, behaviors } = detectIntent({
    mixerInteraction, highFrequency, largeTransfers, multipleNewTokens,
    dormantThenActive, ageDays, txCount: txList.length, uniqueContracts,
  });

  let walletType: WalletType = 'unknown';
  let summary = '';

  try {
    const prompt = `Analyze this ${chain} wallet and classify it.
Address: ${address}
Balance: ${balance} ${currency}
Total transactions: ${txList.length}
Wallet age: ${ageDays} days
Unique contracts: ${uniqueContracts}
Token transfers: ${tokenTransfers.length}
Detected intent: ${intent}
Risk flags: mixer=${mixerInteraction}, scam=${scamInteraction}, highFreq=${highFrequency}, large=${largeTransfers}

Return ONLY valid JSON:
{
  "wallet_type": "<trader|bot|whale|mixer|scammer|dormant|new|unknown>",
  "summary": "<2-3 sentence plain English summary of this wallet behavior, intent and risk>"
}`;

    const response = await client.messages.create({
      model: config.anthropic.model, max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = response.content.find(b => b.type === 'text')?.text ?? '{}';
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    walletType = (parsed.wallet_type ?? 'unknown') as WalletType;
    summary = parsed.summary ?? '';
  } catch (err) {
    logger.warn({ id, err }, 'Claude classification failed');
    walletType = txList.length === 0 ? 'new' : highFrequency ? 'bot' : largeTransfers ? 'whale' : 'unknown';
    summary = `Wallet ${address} has ${txList.length} transactions over ${ageDays} days with a balance of ${balance} ${currency}. Detected intent: ${intent}.`;
  }

  logger.info({ id, chain, riskScore, walletType, intent }, 'Wallet analysis complete');

  return {
    id, address, chain,
    risk_score: riskScore,
    risk_level: getRiskLevel(riskScore),
    wallet_type: walletType,
    intent,
    intent_confidence: intentConfidence,
    behaviors,
    recommendation: getRecommendation(riskScore),
    transaction_stats: {
      total_transactions: txList.length,
      first_seen: firstSeen,
      last_seen: lastSeen,
      wallet_age_days: ageDays,
      unique_contracts_interacted: uniqueContracts,
      native_balance: balance,
      native_currency: currency,
    },
    risk_flags: {
      interacted_with_mixer: mixerInteraction,
      interacted_with_known_scam: scamInteraction,
      high_frequency_trading: highFrequency,
      large_value_transfers: largeTransfers,
      multiple_new_tokens: multipleNewTokens,
      dormant_then_active: dormantThenActive,
    },
    signals, summary,
    latency_ms: Date.now() - t0,
    created_at: new Date().toISOString(),
  };
}