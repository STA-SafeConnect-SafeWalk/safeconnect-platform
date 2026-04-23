import { APIGatewayProxyEventV2 } from 'aws-lambda';

interface EventOptions {
  method: string;
  path: string;
  body?: unknown;
  pathParameters?: Record<string, string>;
  platformId?: string;
  platformName?: string;
  headers?: Record<string, string>;
  noAuth?: boolean;
}

export function buildApiEvent(options: EventOptions): APIGatewayProxyEventV2 {
  const {
    method,
    path,
    body,
    pathParameters,
    platformId = 'test-platform-id',
    platformName = 'Test Platform',
    headers = {},
    noAuth = false,
  } = options;

  const authorizer = noAuth
    ? {}
    : { lambda: { platformId, platformName } };

  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: { 'content-type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    pathParameters: pathParameters ?? null,
    requestContext: {
      http: {
        method,
        path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'integration-test',
      },
      authorizer,
    } as any,
  } as any;
}

export function parseResponse(result: any): { status: number; body: any } {
  return {
    status: result.statusCode,
    body: typeof result.body === 'string' ? JSON.parse(result.body) : result.body,
  };
}
