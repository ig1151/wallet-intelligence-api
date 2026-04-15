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
