#!/bin/bash
set -e

echo "🚀 Building Wallet Intelligence API..."

cat > src/types/index.ts << 'HEREDOC'
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type WalletType = 'trader' | 'bot' | 'whale' | 'mixer' | 'scammer' | 'dormant' | 'new' | 'unknown';
export type Chain = 'ethereum' | 'polygon' | 'bsc';

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
  eth_balance?: string;
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
  chain: Chain;
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
HEREDOC

cat > src/utils/config.ts << 'HEREDOC'
import 'dotenv/config';
function required(key: string): string { const val = process.env[key]; if (!val) throw new Error(`Missing required env var: ${key}`); return val; }
function optional(key: string, fallback: string): string { return process.env[key] ?? fallback; }
export const config = {
  anthropic: { apiKey: required('ANTHROPIC_API_KEY'), model: optional('ANTHROPIC_MODEL', 'claude-sonnet-4-20250514') },
  etherscan: { apiKey: required('ETHERSCAN_API_KEY') },
  server: { port: parseInt(optional('PORT', '3000'), 10), nodeEnv: optional('NODE_ENV', 'development'), apiVersion: optional('API_VERSION', 'v1') },
  rateLimit: { windowMs: parseInt(optional('RATE_LIMIT_WINDOW_MS', '60000'), 10), maxFree: parseInt(optional('RATE_LIMIT_MAX_FREE', '10'), 10), maxPro: parseInt(optional('RATE_LIMIT_MAX_PRO', '500'), 10) },
  logging: { level: optional('LOG_LEVEL', 'info') },
} as const;
HEREDOC

cat > src/utils/logger.ts << 'HEREDOC'
import pino from 'pino';
import { config } from './config';
export const logger = pino({
  level: config.logging.level,
  transport: config.server.nodeEnv === 'development' ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
  base: { service: 'wallet-intelligence-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: ['req.headers.authorization'], censor: '[REDACTED]' },
});
HEREDOC

cat > src/utils/validation.ts << 'HEREDOC'
import Joi from 'joi';
const ETH_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
export const analyzeSchema = Joi.object({
  address: Joi.string().pattern(ETH_ADDRESS_REGEX).required().messages({
    'string.pattern.base': 'address must be a valid Ethereum address (0x followed by 40 hex characters)',
    'any.required': 'address is required',
  }),
  chain: Joi.string().valid('ethereum', 'polygon', 'bsc').default('ethereum'),
});
export const batchSchema = Joi.object({
  wallets: Joi.array().items(analyzeSchema).min(1).max(10).required().messages({ 'array.max': 'Batch accepts a maximum of 10 wallets per request' }),
});
HEREDOC

cat > src/utils/etherscan.ts << 'HEREDOC'
import https from 'https';
import { config } from './config';
import { logger } from './logger';

const BASE_URL = 'api.etherscan.io';

function get(path: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const url = `https://${BASE_URL}/api${path}&apikey=${config.etherscan.apiKey}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); } });
    }).on('error', reject);
  });
}

export async function getTransactionList(address: string) {
  try {
    const data = await get(`?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=100&sort=asc`);
    if (data.status === '0') return [];
    return (data.result as Record<string, unknown>[]) ?? [];
  } catch (err) { logger.warn({ address, err }, 'Failed to fetch transactions'); return []; }
}

export async function getTokenTransfers(address: string) {
  try {
    const data = await get(`?module=account&action=tokentx&address=${address}&startblock=0&endblock=99999999&page=1&offset=50&sort=asc`);
    if (data.status === '0') return [];
    return (data.result as Record<string, unknown>[]) ?? [];
  } catch (err) { logger.warn({ address, err }, 'Failed to fetch token transfers'); return []; }
}

export async function getBalance(address: string) {
  try {
    const data = await get(`?module=account&action=balance&address=${address}&tag=latest`);
    if (data.status === '0') return '0';
    const wei = BigInt(String(data.result ?? '0'));
    const eth = Number(wei) / 1e18;
    return eth.toFixed(4);
  } catch (err) { logger.warn({ address, err }, 'Failed to fetch balance'); return '0'; }
}
HEREDOC

cat > src/utils/risk.ts << 'HEREDOC'
const KNOWN_MIXERS = [
  'tornado.cash', 'tornados', '0x722122df12d4e14e13ac3b6895a86e84145b6967',
  '0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936', 'cyclone', 'privcoin',
  'aztec', 'railgun',
];

const KNOWN_SCAM_PATTERNS = [
  'phish', 'scam', 'hack', 'exploit', 'rug', 'drain',
];

export function detectMixerInteraction(txList: Record<string, unknown>[]): boolean {
  return txList.some(tx => {
    const to = String(tx.to ?? '').toLowerCase();
    const from = String(tx.from ?? '').toLowerCase();
    return KNOWN_MIXERS.some(mixer => to.includes(mixer) || from.includes(mixer));
  });
}

export function detectScamInteraction(txList: Record<string, unknown>[]): boolean {
  return txList.some(tx => {
    const input = String(tx.input ?? '').toLowerCase();
    const methodId = String(tx.methodId ?? '').toLowerCase();
    return KNOWN_SCAM_PATTERNS.some(p => input.includes(p) || methodId.includes(p));
  });
}

export function detectHighFrequency(txList: Record<string, unknown>[]): boolean {
  if (txList.length < 10) return false;
  const timestamps = txList.map(tx => parseInt(String(tx.timeStamp ?? '0'), 10)).sort();
  let rapidCount = 0;
  for (let i = 1; i < timestamps.length; i++) {
    if ((timestamps[i] - timestamps[i - 1]) < 60) rapidCount++;
  }
  return rapidCount > txList.length * 0.3;
}

export function detectLargeTransfers(txList: Record<string, unknown>[]): boolean {
  return txList.some(tx => {
    const value = BigInt(String(tx.value ?? '0'));
    return value > BigInt('10000000000000000000'); // > 10 ETH
  });
}

export function getUniqueContracts(txList: Record<string, unknown>[]): number {
  const contracts = new Set(txList.map(tx => String(tx.to ?? '')).filter(Boolean));
  return contracts.size;
}

export function getWalletAge(txList: Record<string, unknown>[]): { ageDays: number; firstSeen?: string; lastSeen?: string } {
  if (txList.length === 0) return { ageDays: 0 };
  const timestamps = txList.map(tx => parseInt(String(tx.timeStamp ?? '0'), 10));
  const first = Math.min(...timestamps);
  const last = Math.max(...timestamps);
  const ageDays = Math.floor((Date.now() / 1000 - first) / 86400);
  return {
    ageDays,
    firstSeen: new Date(first * 1000).toISOString(),
    lastSeen: new Date(last * 1000).toISOString(),
  };
}
HEREDOC

cat > src/services/wallet.service.ts << 'HEREDOC'
import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { getTransactionList, getTokenTransfers, getBalance } from '../utils/etherscan';
import { detectMixerInteraction, detectScamInteraction, detectHighFrequency, detectLargeTransfers, getUniqueContracts, getWalletAge } from '../utils/risk';
import type { AnalyzeRequest, WalletResponse, RiskLevel, WalletType, Chain } from '../types/index';

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

  // Use Claude to classify wallet type and generate summary
  let walletType: WalletType = 'unknown';
  let summary = '';

  try {
    const txSummary = txList.slice(0, 20).map(tx => ({
      to: tx.to, value: String(BigInt(String(tx.value ?? '0')) / BigInt('1000000000000000')) + ' mETH',
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
  "summary": "<2-3 sentence plain English summary of this wallet's behavior and risk>"
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
HEREDOC

cat > src/middleware/error.middleware.ts << 'HEREDOC'
import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  logger.error({ err, path: req.path }, 'Unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
}
export function notFound(req: Request, res: Response): void { res.status(404).json({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` } }); }
HEREDOC

cat > src/middleware/ratelimit.middleware.ts << 'HEREDOC'
import rateLimit from 'express-rate-limit';
import { config } from '../utils/config';
export const rateLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs, max: config.rateLimit.maxFree,
  standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => req.headers['authorization']?.replace('Bearer ', '') ?? req.ip ?? 'unknown',
  handler: (_req, res) => { res.status(429).json({ error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests.' } }); },
});
HEREDOC

cat > src/routes/health.route.ts << 'HEREDOC'
import { Router, Request, Response } from 'express';
export const healthRouter = Router();
const startTime = Date.now();
healthRouter.get('/', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', version: '1.0.0', uptime_seconds: Math.floor((Date.now() - startTime) / 1000), timestamp: new Date().toISOString() });
});
HEREDOC

cat > src/routes/wallet.route.ts << 'HEREDOC'
import { Router, Request, Response, NextFunction } from 'express';
import { analyzeSchema, batchSchema } from '../utils/validation';
import { analyzeWallet } from '../services/wallet.service';
import type { AnalyzeRequest, BatchRequest } from '../types/index';
export const walletRouter = Router();

walletRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { error, value } = analyzeSchema.validate({ address: req.query.address, chain: req.query.chain }, { abortEarly: false });
    if (error) { res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: error.details.map(d => d.message) } }); return; }
    res.status(200).json(await analyzeWallet(value as AnalyzeRequest));
  } catch (err) { next(err); }
});

walletRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { error, value } = analyzeSchema.validate(req.body, { abortEarly: false });
    if (error) { res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: error.details.map(d => d.message) } }); return; }
    res.status(200).json(await analyzeWallet(value as AnalyzeRequest));
  } catch (err) { next(err); }
});

walletRouter.post('/batch', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { error, value } = batchSchema.validate(req.body, { abortEarly: false });
    if (error) { res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: error.details.map(d => d.message) } }); return; }
    const t0 = Date.now();
    const results = await Promise.allSettled((value as BatchRequest).wallets.map((w: AnalyzeRequest) => analyzeWallet(w)));
    const out = results.map(r => r.status === 'fulfilled' ? r.value : { error: r.reason instanceof Error ? r.reason.message : 'Unknown' });
    res.status(200).json({ batch_id: `batch_${Date.now()}`, total: (value as BatchRequest).wallets.length, results: out, latency_ms: Date.now() - t0 });
  } catch (err) { next(err); }
});
HEREDOC

cat > src/routes/openapi.route.ts << 'HEREDOC'
import { Router, Request, Response } from 'express';
import { config } from '../utils/config';
export const openapiRouter = Router();
export const docsRouter = Router();

const docsHtml = `<!DOCTYPE html>
<html>
<head>
  <title>Wallet Intelligence API — Docs</title>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; color: #333; }
    h1 { font-size: 1.8rem; margin-bottom: 0.25rem; }
    h2 { font-size: 1.2rem; margin-top: 2rem; border-bottom: 1px solid #eee; padding-bottom: 0.5rem; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; margin-right: 8px; }
    .get { background: #e3f2fd; color: #1565c0; }
    .post { background: #e8f5e9; color: #2e7d32; }
    .endpoint { background: #f5f5f5; padding: 1rem; border-radius: 8px; margin-bottom: 1rem; }
    .path { font-family: monospace; font-size: 1rem; font-weight: bold; }
    .desc { color: #666; font-size: 0.9rem; margin-top: 0.25rem; }
    pre { background: #1e1e1e; color: #d4d4d4; padding: 1rem; border-radius: 6px; overflow-x: auto; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 8px; }
    th, td { text-align: left; padding: 8px; border: 1px solid #ddd; }
    th { background: #f5f5f5; }
  </style>
</head>
<body>
  <h1>Wallet Intelligence API</h1>
  <p>Analyze any Ethereum wallet for risk scoring, behavioral classification and fraud detection.</p>
  <p><strong>Base URL:</strong> <code>https://wallet-intelligence-api.onrender.com</code></p>

  <h2>Quick start</h2>
  <pre>const res = await fetch("https://wallet-intelligence-api.onrender.com/v1/analyze?address=0x742d35Cc6634C0532925a3b844Bc454e4438f44e");
const { risk_score, risk_level, wallet_type, recommendation } = await res.json();
if (risk_score > 70) blockTransaction();
else if (risk_score > 40) requireKYC();</pre>

  <h2>Endpoints</h2>
  <div class="endpoint">
    <div><span class="badge get">GET</span><span class="path">/v1/analyze</span></div>
    <div class="desc">Analyze a wallet via query parameter</div>
    <pre>curl "https://wallet-intelligence-api.onrender.com/v1/analyze?address=0x742d35Cc6634C0532925a3b844Bc454e4438f44e"</pre>
  </div>
  <div class="endpoint">
    <div><span class="badge post">POST</span><span class="path">/v1/analyze</span></div>
    <div class="desc">Analyze a wallet via request body</div>
    <pre>curl -X POST https://wallet-intelligence-api.onrender.com/v1/analyze \\
  -H "Content-Type: application/json" \\
  -d '{"address": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", "chain": "ethereum"}'</pre>
  </div>
  <div class="endpoint">
    <div><span class="badge post">POST</span><span class="path">/v1/analyze/batch</span></div>
    <div class="desc">Analyze up to 10 wallets in one request</div>
    <pre>curl -X POST https://wallet-intelligence-api.onrender.com/v1/analyze/batch \\
  -H "Content-Type: application/json" \\
  -d '{"wallets": [{"address": "0x..."}, {"address": "0x..."}]}'</pre>
  </div>

  <h2>Wallet types</h2>
  <table>
    <tr><th>Type</th><th>Description</th></tr>
    <tr><td>trader</td><td>Regular buy/sell activity on DEXes</td></tr>
    <tr><td>bot</td><td>Automated high-frequency trading patterns</td></tr>
    <tr><td>whale</td><td>Large value holder with significant transfers</td></tr>
    <tr><td>mixer</td><td>Uses mixing services for privacy/obfuscation</td></tr>
    <tr><td>scammer</td><td>Associated with known scam activity</td></tr>
    <tr><td>dormant</td><td>Long inactive wallet that recently activated</td></tr>
    <tr><td>new</td><td>Recently created wallet with minimal history</td></tr>
    <tr><td>unknown</td><td>Insufficient data to classify</td></tr>
  </table>

  <h2>Risk scoring</h2>
  <table>
    <tr><th>Signal</th><th>Risk added</th></tr>
    <tr><td>Mixer interaction (Tornado Cash etc.)</td><td>+60</td></tr>
    <tr><td>Known scam/exploit interaction</td><td>+50</td></tr>
    <tr><td>Dormant wallet recently active</td><td>+25</td></tr>
    <tr><td>High frequency trading pattern</td><td>+30</td></tr>
    <tr><td>Large value transfers (&gt;10 ETH)</td><td>+20</td></tr>
    <tr><td>Many new/unknown token interactions</td><td>+15</td></tr>
    <tr><td>Very new wallet (&lt;7 days)</td><td>+15</td></tr>
  </table>

  <h2>OpenAPI Spec</h2>
  <p><a href="/openapi.json">Download openapi.json</a></p>
</body>
</html>`;

docsRouter.get('/', (_req: Request, res: Response) => { res.setHeader('Content-Type', 'text/html'); res.send(docsHtml); });

openapiRouter.get('/', (_req: Request, res: Response) => {
  res.status(200).json({
    openapi: '3.0.3',
    info: { title: 'Wallet Intelligence API', version: '1.0.0', description: 'Analyze Ethereum wallets for risk scoring, behavioral classification and fraud detection.' },
    servers: [{ url: 'https://wallet-intelligence-api.onrender.com', description: 'Production' }, { url: `http://localhost:${config.server.port}`, description: 'Local' }],
    paths: {
      '/v1/health': { get: { summary: 'Health check', operationId: 'getHealth', responses: { '200': { description: 'OK' } } } },
      '/v1/analyze': {
        get: { summary: 'Analyze a wallet via GET', operationId: 'analyzeGet', parameters: [{ name: 'address', in: 'query', required: true, schema: { type: 'string' } }, { name: 'chain', in: 'query', schema: { type: 'string', enum: ['ethereum', 'polygon', 'bsc'] } }], responses: { '200': { description: 'Wallet analysis' } } },
        post: { summary: 'Analyze a wallet via POST', operationId: 'analyzePost', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/AnalyzeRequest' } } } }, responses: { '200': { description: 'Wallet analysis' } } },
      },
      '/v1/analyze/batch': { post: { summary: 'Analyze up to 10 wallets', operationId: 'analyzeBatch', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/BatchRequest' } } } }, responses: { '200': { description: 'Batch results' } } } },
    },
    components: {
      schemas: {
        AnalyzeRequest: { type: 'object', required: ['address'], properties: { address: { type: 'string', example: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e' }, chain: { type: 'string', enum: ['ethereum', 'polygon', 'bsc'], default: 'ethereum' } } },
        BatchRequest: { type: 'object', required: ['wallets'], properties: { wallets: { type: 'array', items: { $ref: '#/components/schemas/AnalyzeRequest' }, minItems: 1, maxItems: 10 } } },
      },
    },
  });
});
HEREDOC

cat > src/app.ts << 'HEREDOC'
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import pinoHttp from 'pino-http';
import { walletRouter } from './routes/wallet.route';
import { healthRouter } from './routes/health.route';
import { openapiRouter, docsRouter } from './routes/openapi.route';
import { errorHandler, notFound } from './middleware/error.middleware';
import { rateLimiter } from './middleware/ratelimit.middleware';
import { logger } from './utils/logger';
import { config } from './utils/config';
const app = express();
app.use(helmet()); app.use(cors()); app.use(compression());
app.use(pinoHttp({ logger }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(`/${config.server.apiVersion}/analyze`, rateLimiter);
app.use(`/${config.server.apiVersion}/analyze`, walletRouter);
app.use(`/${config.server.apiVersion}/health`, healthRouter);
app.use('/openapi.json', openapiRouter);
app.use('/docs', docsRouter);
app.get('/', (_req, res) => res.redirect(`/${config.server.apiVersion}/health`));
app.use(notFound);
app.use(errorHandler);
export { app };
HEREDOC

cat > src/index.ts << 'HEREDOC'
import { app } from './app';
import { config } from './utils/config';
import { logger } from './utils/logger';
const server = app.listen(config.server.port, () => { logger.info({ port: config.server.port, env: config.server.nodeEnv }, '🚀 Wallet Intelligence API started'); });
const shutdown = (signal: string) => { logger.info({ signal }, 'Shutting down'); server.close(() => { logger.info('Closed'); process.exit(0); }); setTimeout(() => process.exit(1), 10_000); };
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error({ reason }, 'Unhandled rejection'));
process.on('uncaughtException', (err) => { logger.fatal({ err }, 'Uncaught exception'); process.exit(1); });
HEREDOC

cat > jest.config.js << 'HEREDOC'
module.exports = { preset: 'ts-jest', testEnvironment: 'node', rootDir: '.', testMatch: ['**/tests/**/*.test.ts'], collectCoverageFrom: ['src/**/*.ts', '!src/index.ts'], setupFiles: ['<rootDir>/tests/setup.ts'] };
HEREDOC

cat > tests/setup.ts << 'HEREDOC'
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
process.env.ETHERSCAN_API_KEY = 'test-key';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
HEREDOC

cat > .gitignore << 'HEREDOC'
node_modules/
dist/
.env
coverage/
*.log
.DS_Store
HEREDOC

cat > render.yaml << 'HEREDOC'
services:
  - type: web
    name: wallet-intelligence-api
    runtime: node
    buildCommand: npm install && npm run build
    startCommand: node dist/index.js
    healthCheckPath: /v1/health
    envVars:
      - key: NODE_ENV
        value: production
      - key: LOG_LEVEL
        value: info
      - key: ANTHROPIC_API_KEY
        sync: false
      - key: ETHERSCAN_API_KEY
        sync: false
HEREDOC

echo ""
echo "✅ All files created! Run: npm install"