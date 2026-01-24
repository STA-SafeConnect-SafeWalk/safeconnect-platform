import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { handler } from '../platform-admin-handler/index';

const ddbMock = mockClient(DynamoDBDocumentClient);

describe('platform-admin-handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    ddbMock.reset();
    process.env = { ...originalEnv };
    process.env.PLATFORMS_TABLE_NAME = 'PlatformsTable';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  const generateEvent = (
    method: string,
    path: string,
    body?: any,
    pathParameters?: any
  ): APIGatewayProxyEventV2 => {
    return {
      version: '2.0',
      routeKey: '$default',
      rawPath: path,
      rawQueryString: '',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      pathParameters,
      requestContext: {
        http: { method, path, protocol: 'HTTP/1.1', sourceIp: '1.2.3.4', userAgent: 'test' },
      } as any,
    } as any;
  };

  describe('POST /admin/platforms (Register)', () => {
    it('should register a new platform successfully', async () => {
      ddbMock.on(PutCommand).resolves({});

      const body = {
        platformName: 'Test App',
        redirectUrl: 'https://test.app/cb',
        contactName: 'Tester',
        contactEmail: 'test@test.app',
      };

      const event = generateEvent('POST', '/admin/platforms', body);
      const result = (await handler(event)) as any;

      expect(result.statusCode).toBe(201);
      const data = JSON.parse(result.body).data;
      expect(data.platformName).toBe('Test App');
      expect(data.apiKey).toBeDefined();
      expect(data.apiKeyPrefix).toBeDefined();

      expect(ddbMock.commandCalls(PutCommand).length).toBe(1);
    });

    it('should validate required fields', async () => {
      const body = { platformName: 'Test' }; 
      const event = generateEvent('POST', '/admin/platforms', body);
      const result = (await handler(event)) as any;
      expect(result.statusCode).toBe(400);
    });

    it('should validate email format', async () => {
        const body = {
            platformName: 'Test App',
            redirectUrl: 'https://test.app/cb',
            contactName: 'Tester',
            contactEmail: 'invalid-email',
          };
      const event = generateEvent('POST', '/admin/platforms', body);
      const result = (await handler(event)) as any;
      expect(result.statusCode).toBe(400);
    });
  });

  describe('GET /admin/platforms (List)', () => {
    it('should list platforms', async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [
            { platformId: 'p1', platformName: 'App 1', status: 'ACTIVE' },
            { platformId: 'p2', platformName: 'App 2', status: 'INACTIVE' },
        ],
        Count: 2
      });

      const event = generateEvent('GET', '/admin/platforms');
      const result = (await handler(event)) as any;

      expect(result.statusCode).toBe(200);
      const data = JSON.parse(result.body).data;
      expect(data.platforms.length).toBe(2);
      expect(data.count).toBe(2);
    });
  });

  describe('GET /admin/platforms/{id}', () => {
    it('should return platform details without secret api key', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
            platformId: 'p1',
            platformName: 'App 1',
            apiKey: 'secret',
            apiKeyPrefix: 'prefix...',
        },
      });

      const event = generateEvent('GET', '/admin/platforms/p1', undefined, { platformId: 'p1' });
      const result = (await handler(event)) as any;

      expect(result.statusCode).toBe(200);
      const data = JSON.parse(result.body).data;
      expect(data.platformId).toBe('p1');
      expect(data.apiKeyPrefix).toBe('prefix...');
      expect(data.apiKey).toBeUndefined(); // Should not return secret
    });

    it('should return 404 if not found', async () => {
        ddbMock.on(GetCommand).resolves({});
  
        const event = generateEvent('GET', '/admin/platforms/unknown', undefined, { platformId: 'unknown' });
        const result = (await handler(event)) as any;
  
        expect(result.statusCode).toBe(404);
      });
  });

  describe('PATCH /admin/platforms/{id}', () => {
    it('should update platform fields', async () => {
        ddbMock.on(GetCommand).resolves({ Item: { platformId: 'p1' } });
        ddbMock.on(UpdateCommand).resolves({});

        const body = { platformName: 'New Name' };
        const event = generateEvent('PATCH', '/admin/platforms/p1', body, { platformId: 'p1' });
        
        ddbMock.reset(); 
        ddbMock.on(GetCommand)
            .resolvesOnce({ Item: { platformId: 'p1', platformName: 'Old' } })
            .resolvesOnce({ Item: { platformId: 'p1', platformName: 'New Name' } });
        ddbMock.on(UpdateCommand).resolves({});

        const result = (await handler(event)) as any;

        expect(result.statusCode).toBe(200);
        expect(ddbMock.commandCalls(UpdateCommand).length).toBe(1);
    });

    it('should return 404 if platform to update does not exist', async () => {
        ddbMock.on(GetCommand).resolves({});
        
        const event = generateEvent('PATCH', '/admin/platforms/p1', {}, { platformId: 'p1' });
        const result = (await handler(event)) as any;
        expect(result.statusCode).toBe(404);
    });
  });

  describe('POST /admin/platforms/{id}/regenerate-key', () => {
      it('should regenerate api key', async () => {
        ddbMock.on(GetCommand).resolves({ Item: { platformId: 'p1' } });
        ddbMock.on(UpdateCommand).resolves({});

        const event = generateEvent('POST', '/admin/platforms/p1/regenerate-key', undefined, { platformId: 'p1' });
        const result = (await handler(event)) as any;

        expect(result.statusCode).toBe(200);
        const data = JSON.parse(result.body).data;
        expect(data.apiKey).toBeDefined();
        expect(data.message).toContain('regenerated');
        
        expect(ddbMock.commandCalls(UpdateCommand).length).toBe(1);
      });
  });
});
