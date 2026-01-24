import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayRequestAuthorizerEventV2 } from 'aws-lambda';
import { handler } from '../platform-authorizer/index';

const ddbMock = mockClient(DynamoDBDocumentClient);

describe('platform-authorizer', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    ddbMock.reset();
    process.env = { ...originalEnv };
    process.env.PLATFORMS_TABLE_NAME = 'PlatformsTable';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  const generateEvent = (apiKey?: string, headerName = 'x-api-key'): APIGatewayRequestAuthorizerEventV2 => {
    return {
      version: '2.0',
      routeKey: '$default',
      rawPath: '/',
      rawQueryString: '',
      headers: apiKey ? { [headerName]: apiKey } : {},
      requestContext: {} as any,
      type: 'REQUEST',
      routeArn: 'arn:aws:execute-api:us-east-1:123456789012:api-id/stage/route-key',
      identitySource: [],
      cookies: [],
    };
  };

  it('should return unauthorized if no API key is provided', async () => {
    const event = generateEvent(undefined);
    const result = await handler(event);
    expect(result.isAuthorized).toBe(false);
  });

  it('should support X-Api-Key case insensitive header', async () => {
    ddbMock.on(QueryCommand).resolves({
        Items: [{ platformId: 'p1', platformName: 'Test', status: 'ACTIVE' }]
    });
    
    const event = generateEvent('secret-key', 'X-Api-Key');
    const result = await handler(event);
    expect(result.isAuthorized).toBe(true);
    expect(result.context).toEqual({ platformId: 'p1', platformName: 'Test' });
  });

  it('should return unauthorized if API key is not found', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = generateEvent('invalid-key');
    const result = await handler(event);
    expect(result.isAuthorized).toBe(false);
  });

  it('should return unauthorized if platform is not ACTIVE', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ platformId: 'p1', platformName: 'Test', status: 'INACTIVE' }],
    });

    const event = generateEvent('inactive-key');
    const result = await handler(event);
    expect(result.isAuthorized).toBe(false);
  });

  it('should return authorized context if API key is valid and active', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ platformId: 'p1', platformName: 'Test', status: 'ACTIVE' }],
    });

    const event = generateEvent('valid-key');
    const result = await handler(event);

    expect(result.isAuthorized).toBe(true);
    expect(result.context).toEqual({
      platformId: 'p1',
      platformName: 'Test',
    });

    expect(ddbMock.commandCalls(QueryCommand).length).toBe(1);
    const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.TableName).toBe('PlatformsTable');
    expect(input.IndexName).toBe('ApiKeyIndex');
    expect(input.ExpressionAttributeValues?.[':apiKey']).toBe('valid-key');
  });

  it('should return unauthorized on DynamoDB error', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('DB Error'));

    const event = generateEvent('valid-key');
    const result = await handler(event);
    expect(result.isAuthorized).toBe(false);
  });
});
