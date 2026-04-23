import http from 'http';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  ScanCommand,
  BatchGetCommand,
} from '@aws-sdk/lib-dynamodb';

// ---- In-memory DB ----

type Item = Record<string, unknown>;

const TABLE_SCHEMAS: Record<string, { partitionKey: string; sortKey?: string }> = {
  PlatformsTable: { partitionKey: 'platformId' },
  UsersTable: { partitionKey: 'safeWalkId' },
  SharingCodesTable: { partitionKey: 'safeWalkId' },
  ContactsTable: { partitionKey: 'contactId' },
  SOSEventsTable: { partitionKey: 'sosId' },
  SOSLocationAuditTable: { partitionKey: 'sosId', sortKey: 'timestamp' },
};

class InMemoryDB {
  private tables: Map<string, Item[]> = new Map();
  constructor() { for (const t of Object.keys(TABLE_SCHEMAS)) this.tables.set(t, []); }
  reset() { for (const t of this.tables.keys()) this.tables.set(t, []); }
  private getTable(t: string): Item[] { return this.tables.get(t) ?? []; }

  put(tableName: string, item: Item, conditionExpression?: string): void {
    const s = TABLE_SCHEMAS[tableName];
    if (!s) throw new Error(`Unknown table: ${tableName}`);
    const items = this.getTable(tableName);
    if (conditionExpression?.includes('attribute_not_exists')) {
      const exists = items.find((i) => s.sortKey ? i[s.partitionKey] === item[s.partitionKey] && i[s.sortKey] === item[s.sortKey] : i[s.partitionKey] === item[s.partitionKey]);
      if (exists) { const e = new Error('ConditionalCheckFailedException') as any; e.name = 'ConditionalCheckFailedException'; throw e; }
    }
    const idx = items.findIndex((i) => s.sortKey ? i[s.partitionKey] === item[s.partitionKey] && i[s.sortKey] === item[s.sortKey] : i[s.partitionKey] === item[s.partitionKey]);
    if (idx >= 0) items[idx] = { ...item }; else items.push({ ...item });
  }

  get(tableName: string, key: Record<string, unknown>): Item | undefined {
    return this.getTable(tableName).find((item) => Object.entries(key).every(([k, v]) => item[k] === v));
  }

  batchGet(requestItems: Record<string, { Keys: Record<string, unknown>[] }>): Record<string, Item[]> {
    const r: Record<string, Item[]> = {};
    for (const [t, { Keys }] of Object.entries(requestItems)) r[t] = Keys.map((k) => this.get(t, k)).filter((i): i is Item => !!i);
    return r;
  }

  query(tableName: string, kce: string, eav: Record<string, unknown>, fe?: string, ean?: Record<string, string>, limit?: number): Item[] {
    const items = this.getTable(tableName);
    const kc = this.parseConds(kce, eav, ean);
    let f = items.filter((i) => kc.every(({ field, value }) => i[field] === value));
    if (fe) { const fc = this.parseConds(fe, eav, ean); f = f.filter((i) => fc.every(({ field, value }) => i[field] === value)); }
    return limit ? f.slice(0, limit) : f;
  }

  scan(tableName: string): Item[] { return [...this.getTable(tableName)]; }

  update(tableName: string, key: Record<string, unknown>, ue: string, eav: Record<string, unknown>, ean?: Record<string, string>): void {
    const item = this.getTable(tableName).find((i) => Object.entries(key).every(([k, v]) => i[k] === v));
    if (!item) return;
    const sm = ue.match(/SET\s+(.+?)(?:\s+REMOVE|$)/i);
    if (sm) for (const a of sm[1].split(',').map((s) => s.trim())) { const [l, r] = a.split('=').map((s) => s.trim()); item[ean?.[l] ?? l] = eav[r]; }
    const rm = ue.match(/REMOVE\s+(.+)/i);
    if (rm) for (const f of rm[1].split(',').map((s) => s.trim())) delete item[ean?.[f] ?? f];
  }

  private parseConds(expr: string, vals: Record<string, unknown>, names?: Record<string, string>) {
    const c: Array<{ field: string; value: unknown }> = [];
    for (const p of expr.split(/\s+AND\s+/i)) { const m = p.trim().match(/^([\w#]+)\s*=\s*(:\w+)$/); if (m) c.push({ field: names?.[m[1]] ?? m[1], value: vals[m[2]] }); }
    return c;
  }
}

const db = new InMemoryDB();

// ---- Set up mock BEFORE handlers load ----

const ddbMock = mockClient(DynamoDBDocumentClient);
ddbMock.on(PutCommand).callsFake((input: any) => { db.put(input.TableName, input.Item, input.ConditionExpression); return {}; });
ddbMock.on(GetCommand).callsFake((input: any) => ({ Item: db.get(input.TableName, input.Key) }));
ddbMock.on(BatchGetCommand).callsFake((input: any) => ({ Responses: db.batchGet(input.RequestItems) }));
ddbMock.on(QueryCommand).callsFake((input: any) => { const i = db.query(input.TableName, input.KeyConditionExpression, input.ExpressionAttributeValues, input.FilterExpression, input.ExpressionAttributeNames, input.Limit); return { Items: i, Count: i.length }; });
ddbMock.on(ScanCommand).callsFake((input: any) => { const i = db.scan(input.TableName); return { Items: i, Count: i.length }; });
ddbMock.on(UpdateCommand).callsFake((input: any) => { db.update(input.TableName, input.Key, input.UpdateExpression, input.ExpressionAttributeValues, input.ExpressionAttributeNames); return {}; });

// ---- Environment ----

process.env.PLATFORMS_TABLE_NAME = 'PlatformsTable';
process.env.TABLE_NAME = 'UsersTable';
process.env.USERS_TABLE_NAME = 'UsersTable';
process.env.SHARING_CODES_TABLE_NAME = 'SharingCodesTable';
process.env.CONTACTS_TABLE_NAME = 'ContactsTable';
process.env.SOS_EVENTS_TABLE_NAME = 'SOSEventsTable';
process.env.SOS_LOCATION_AUDIT_TABLE_NAME = 'SOSLocationAuditTable';

// ---- Webhook capture ----

const webhookCalls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
(globalThis as any).fetch = async (url: string, opts: any) => {
  webhookCalls.push({ url, body: opts.body, headers: opts.headers });
  return { status: 200 } as Response;
};

// ---- Routing ----

interface RouteMatch { handler: string; pathParams: Record<string, string> }

function matchRoute(method: string, p: string): RouteMatch | null {
  if (method === 'POST' && p === '/admin/platforms') return { handler: 'admin', pathParams: {} };
  if (method === 'GET' && p === '/admin/platforms') return { handler: 'admin', pathParams: {} };
  let m = p.match(/^\/admin\/platforms\/([^/]+)$/);
  if (m && (method === 'GET' || method === 'PATCH')) return { handler: 'admin', pathParams: { platformId: m[1] } };
  m = p.match(/^\/admin\/platforms\/([^/]+)\/regenerate-key$/);
  if (m && method === 'POST') return { handler: 'admin', pathParams: { platformId: m[1] } };
  m = p.match(/^\/admin\/platforms\/([^/]+)\/regenerate-webhook-secret$/);
  if (m && method === 'POST') return { handler: 'admin', pathParams: { platformId: m[1] } };
  if (method === 'POST' && p === '/register') return { handler: 'user', pathParams: {} };
  if (method === 'POST' && p === '/sharing-codes') return { handler: 'user', pathParams: {} };
  if (method === 'POST' && p === '/contacts') return { handler: 'contacts', pathParams: {} };
  m = p.match(/^\/contacts\/([^/]+)$/);
  if (m && method === 'GET') return { handler: 'contacts', pathParams: { safeWalkId: m[1] } };
  if (m && method === 'DELETE') return { handler: 'contacts', pathParams: { contactId: m[1] } };
  if (m && method === 'PATCH') return { handler: 'contacts', pathParams: { contactId: m[1] } };
  if (method === 'POST' && p === '/sos') return { handler: 'sos', pathParams: {} };
  m = p.match(/^\/sos\/([^/]+)$/);
  if (m && method === 'PATCH') return { handler: 'sos', pathParams: { sosId: m[1] } };
  if (m && method === 'DELETE') return { handler: 'sos', pathParams: { sosId: m[1] } };
  return null;
}

// ---- Dynamic imports and server start ----

async function main() {
  const { handler: adminHandler } = await import('./platform-admin-handler/index');
  const { handler: userHandler } = await import('./platform-user-handler/index');
  const { handler: authorizerHandler } = await import('./platform-authorizer/index');
  const { handler: contactsHandler } = await import('./trusted-contacts-handler/index');
  const { handler: sosHandler } = await import('./sos-handler/index');

  const handlers: Record<string, (event: any) => Promise<any>> = {
    admin: adminHandler, user: userHandler, contacts: contactsHandler, sos: sosHandler,
  };

  const server = http.createServer(async (req, res) => {
    let body = '';
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', async () => {
      const method = req.method || 'GET';
      const urlPath = req.url || '/';

      if (method === 'POST' && urlPath === '/__reset') { db.reset(); webhookCalls.length = 0; res.writeHead(200); res.end('{}'); return; }
      if (method === 'GET' && urlPath === '/__webhooks') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(webhookCalls.map(w => ({ url: w.url, body: JSON.parse(w.body), headers: w.headers })))); return; }
      if (method === 'DELETE' && urlPath === '/__webhooks') { webhookCalls.length = 0; res.writeHead(200); res.end('{}'); return; }

      const route = matchRoute(method, urlPath);
      if (!route) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not Found' })); return; }

      let platformId: string | null = null;
      let platformName: string | null = null;
      const apiKey = req.headers['x-api-key'] as string | undefined;
      if (apiKey) {
        try {
          const authResult = await authorizerHandler({ version: '2.0', type: 'REQUEST', headers: { 'x-api-key': apiKey }, requestContext: { http: { method, path: urlPath } } } as any);
          if (authResult.isAuthorized) { platformId = authResult.context.platformId; platformName = authResult.context.platformName; }
        } catch { /* auth failed */ }
      }

      const event: any = {
        version: '2.0', routeKey: '$default', rawPath: urlPath, rawQueryString: '', headers: req.headers, body: body || undefined,
        pathParameters: Object.keys(route.pathParams).length > 0 ? route.pathParams : null,
        requestContext: { http: { method, path: urlPath, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: req.headers['user-agent'] || 'e2e' }, authorizer: platformId ? { lambda: { platformId, platformName } } : {} },
      };

      try {
        const result = await handlers[route.handler](event);
        res.writeHead(result.statusCode || 200, { 'Content-Type': 'application/json', ...(result.headers || {}) });
        res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'InternalError', message: err.message }));
      }
    });
  });

  const port = parseInt(process.env.E2E_PORT || '0', 10);
  server.listen(port, '127.0.0.1', () => {
    const addr = server.address() as any;
    process.stdout.write(`SERVER_READY:${addr.port}\n`);
  });
}

main().catch((err) => { console.error('Failed to start E2E server:', err); process.exit(1); });
