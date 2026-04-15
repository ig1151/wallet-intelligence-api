import https from 'https';
import { config } from './config';
import { logger } from './logger';

const BASE_URL = 'api.etherscan.io';

function get(path: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const url = `https://${BASE_URL}/v2/api${path}&apikey=${config.etherscan.apiKey}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); } });
    }).on('error', reject);
  });
}

export async function getTransactionList(address: string) {
  try {
    const data = await get(`?chainid=1&module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=100&sort=asc`);
    if (data.status === '0') return [];
    return (data.result as Record<string, unknown>[]) ?? [];
  } catch (err) { logger.warn({ address, err }, 'Failed to fetch transactions'); return []; }
}

export async function getTokenTransfers(address: string) {
  try {
    const data = await get(`?chainid=1&module=account&action=tokentx&address=${address}&startblock=0&endblock=99999999&page=1&offset=50&sort=asc`);
    if (data.status === '0') return [];
    return (data.result as Record<string, unknown>[]) ?? [];
  } catch (err) { logger.warn({ address, err }, 'Failed to fetch token transfers'); return []; }
}

export async function getBalance(address: string) {
  try {
    const data = await get(`?chainid=1&module=account&action=balance&address=${address}&tag=latest`);
    if (data.status === '0') return '0';
    const wei = BigInt(String(data.result ?? '0'));
    const eth = Number(wei) / 1e18;
    return eth.toFixed(4);
  } catch (err) { logger.warn({ address, err }, 'Failed to fetch balance'); return '0'; }
}