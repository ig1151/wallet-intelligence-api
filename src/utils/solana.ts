import https from 'https';
import { config } from './config';
import { logger } from './logger';

function getHeliusUrl(): string {
  return `https://mainnet.helius-rpc.com/?api-key=${config.helius.apiKey}`;
}

function post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(getHeliusUrl());
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON')); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

export async function getSolanaTransactions(address: string): Promise<Record<string, unknown>[]> {
  try {
    const data = await post({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [address, { limit: 100 }] });
    return (data.result as Record<string, unknown>[]) ?? [];
  } catch (err) { logger.warn({ address, err }, 'Failed to fetch Solana transactions'); return []; }
}

export async function getSolanaBalance(address: string): Promise<string> {
  try {
    const data = await post({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] });
    const lamports = (data.result as Record<string, unknown>)?.value ?? 0;
    return (Number(lamports) / 1e9).toFixed(4);
  } catch (err) { logger.warn({ address, err }, 'Failed to fetch Solana balance'); return '0'; }
}