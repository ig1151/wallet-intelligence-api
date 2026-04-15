import https from 'https';
import { logger } from './logger';

const XRPL_URL = 'xrplcluster.com';

function post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: XRPL_URL,
      path: '/',
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

export async function getXrpTransactions(address: string): Promise<Record<string, unknown>[]> {
  try {
    const data = await post({ method: 'account_tx', params: [{ account: address, limit: 100, ledger_index_min: -1, ledger_index_max: -1 }] });
    const result = data.result as Record<string, unknown>;
    return (result?.transactions as Record<string, unknown>[]) ?? [];
  } catch (err) { logger.warn({ address, err }, 'Failed to fetch XRP transactions'); return []; }
}

export async function getXrpBalance(address: string): Promise<string> {
  try {
    const data = await post({ method: 'account_info', params: [{ account: address, ledger_index: 'current' }] });
    const result = data.result as Record<string, unknown>;
    const accountData = result?.account_data as Record<string, unknown>;
    const drops = String(accountData?.Balance ?? '0');
    return (Number(drops) / 1e6).toFixed(4);
  } catch (err) { logger.warn({ address, err }, 'Failed to fetch XRP balance'); return '0'; }
}

export async function getXrpAccountAge(address: string): Promise<number> {
  try {
    const data = await post({ method: 'account_tx', params: [{ account: address, limit: 1, ledger_index_min: -1, ledger_index_max: -1, forward: true }] });
    const result = data.result as Record<string, unknown>;
    const txs = (result?.transactions as Record<string, unknown>[]) ?? [];
    if (txs.length === 0) return 0;
    const tx = txs[0] as Record<string, unknown>;
    const txData = tx.tx as Record<string, unknown>;
    const date = Number(txData?.date ?? 0);
    const rippleEpoch = 946684800;
    return Math.floor((Date.now() / 1000 - (date + rippleEpoch)) / 86400);
  } catch (err) { logger.warn({ address, err }, 'Failed to fetch XRP account age'); return 0; }
}