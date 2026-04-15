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
