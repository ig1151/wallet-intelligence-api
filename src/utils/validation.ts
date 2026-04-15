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
