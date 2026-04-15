import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { getTransactionList, getTokenTransfers, getBalance } from '../utils/etherscan';
import { detectMixerInteraction, detectScamInteraction, detectHighFrequency, detectLargeTransfers, getUniqueContracts, getWalletAge } from '../utils/risk';
import type { AnalyzeRequest, WalletResponse, RiskLevel, WalletType } from '../types/index';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

function getRiskLevel(score: number): RiskLevel { return score >= 80 ? 'critical' : score >= 50 ? 'high' : score >= 20 ? 'medium' : 'low'; }

function getRecommendation(score: number): string {
  if (score >= 80) return 'block — high fraud risk';
  if (score >= 50) return 'review — suspicious activity detected';
  if (score >= 20) return 'monitor — some risk signals present';
  return 'allow — low risk wallet';
}

export async function analyzeWallet(req: AnalyzeRequest): Promise<WalletResponse> {
  const id = `wallet_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
  const t0 = Date.now();
  const address = req.address.toLowerCase();
  const chain = req.chain ?? 'ethereum';

  logger.info({ id, address, chain }, 'Starting wallet analysis');

  const [txList, tokenTransfers, balance] = await Promise.all([
    getTransactionList(address),
    getTokenTransfers(address),
    getBalance(address),
  ]);

  const { ageDays, firstSeen, lastSeen } = getWalletAge(txList);
  const uniqueContracts = getUniqueContracts(txList);
  const mixerInteraction = detectMixerInteraction([...txList, ...tokenTransfers]);
  const scamInteraction = detectScamInteraction(txList);
  const highFrequency = detectHighFrequency(txList);
  const largeTransfers = detectLargeTransfers(txList);
  const multipleNewTokens = tokenTransfers.length > 20;
  const dormantThenActive = ageDays > 365 && txList.length > 0 && txList.slice(-10).length > 5;

  const signals: WalletResponse['signals'] = [];
  let riskScore = 0;

  if (mixerInteraction) { riskScore += 60; signals.push({ signal: 'Interaction with known mixer (Tornado Cash or similar)', severity: 'critical' }); }
  if (scamInteraction) { riskScore += 50; signals.push({ signal: 'Interaction with known scam or exploit contract', severity: 'critical' }); }
  if (highFrequency) { riskScore += 30; signals.push({ signal: 'High frequency trading pattern detected', severity: 'high' }); }
  if (largeTransfers) { riskScore += 20; signals.push({ signal: 'Large value transfers detected (>10 ETH)', severity: 'medium' }); }
  if (multipleNewTokens) { riskScore += 15; signals.push({ signal: 'Interactions with many new/unknown tokens', severity: 'medium' }); }
  if (dormantThenActive) { riskScore += 25; signals.push({ signal: 'Dormant wallet recently became active', severity: 'high' }); }
  if (ageDays < 7) { riskScore += 15; signals.push({ signal: 'Very new wallet (less than 7 days old)', severity: 'medium' }); }
  if (txList.length === 0) { signals.push({ signal: 'No transaction history found', severity: 'low' }); }
  if (signals.length === 0) signals.push({ signal: 'No risk signals detected', severity: 'low' });

  riskScore = Math.min(100, riskScore);

  let walletType: WalletType = 'unknown';
  let summary = '';

  try {
    const txSummary = txList.slice(0, 20).map(tx => ({
      to: tx.to,
      value: String(BigInt(String(tx.value ?? '0')) / BigInt('1000000000000000')) + ' mETH',
      method: tx.functionName || tx.methodId || 'transfer',
    }));

    const prompt = `Analyze this Ethereum wallet and classify it.

Address: ${address}
Balance: ${balance} ETH
Total transactions: ${txList.length}
Wallet age: ${ageDays} days
Unique contracts interacted: ${uniqueContracts}
Token transfers: ${tokenTransfers.length}
Risk flags: mixer=${mixerInteraction}, scam=${scamInteraction}, highFreq=${highFrequency}, large=${largeTransfers}

Recent transactions (last 20):
${JSON.stringify(txSummary, null, 2)}

Return ONLY valid JSON:
{
  "wallet_type": "<trader|bot|whale|mixer|scammer|dormant|new|unknown>",
  "summary": "<2-3 sentence plain English summary of this wallet behavior and risk>"
}`;

    const response = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = response.content.find(b => b.type === 'text')?.text ?? '{}';
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    walletType = (parsed.wallet_type ?? 'unknown') as WalletType;
    summary = parsed.summary ?? '';
  } catch (err) {
    logger.warn({ id, err }, 'Claude classification failed — using defaults');
    walletType = txList.length === 0 ? 'new' : highFrequency ? 'bot' : largeTransfers ? 'whale' : 'unknown';
    summary = `Wallet ${address} has ${txList.length} transactions over ${ageDays} days with a balance of ${balance} ETH.`;
  }

  logger.info({ id, riskScore, walletType }, 'Wallet analysis complete');

  return {
    id, address, chain,
    risk_score: riskScore,
    risk_level: getRiskLevel(riskScore),
    wallet_type: walletType,
    recommendation: getRecommendation(riskScore),
    transaction_stats: {
      total_transactions: txList.length,
      first_seen: firstSeen,
      last_seen: lastSeen,
      wallet_age_days: ageDays,
      unique_contracts_interacted: uniqueContracts,
      eth_balance: balance,
    },
    risk_flags: {
      interacted_with_mixer: mixerInteraction,
      interacted_with_known_scam: scamInteraction,
      high_frequency_trading: highFrequency,
      large_value_transfers: largeTransfers,
      multiple_new_tokens: multipleNewTokens,
      dormant_then_active: dormantThenActive,
    },
    signals,
    summary,
    latency_ms: Date.now() - t0,
    created_at: new Date().toISOString(),
  };
}