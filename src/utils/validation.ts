import Joi from 'joi';

export function detectChain(address: string): 'ethereum' | 'solana' | 'bnb' | 'xrp' | 'unknown' {
  // Ethereum/BNB — 0x + 40 hex chars
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) return 'ethereum';
  // XRP — starts with r, 25-35 base58 chars
  if (/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address)) return 'xrp';
  // Solana — 32-44 base58 chars (checked after XRP to avoid conflict)
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return 'solana';
  return 'unknown';
}

export const analyzeSchema = Joi.object({
  address: Joi.string().required().messages({ 'any.required': 'address is required' }),
  chain: Joi.string().valid('ethereum', 'solana', 'bnb', 'xrp', 'auto').default('auto'),
});

export const batchSchema = Joi.object({
  wallets: Joi.array().items(analyzeSchema).min(1).max(10).required().messages({ 'array.max': 'Batch accepts a maximum of 10 wallets per request' }),
});