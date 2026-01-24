import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID, randomBytes } from 'crypto';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const client = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(client);

interface RegisterPlatformRequest {
  platformName: string;
  redirectUrl: string;
  contactName: string;
  contactEmail: string;
  webhookUrl?: string;
  description?: string;
}

interface UpdatePlatformRequest {
  platformName?: string;
  redirectUrl?: string;
  contactName?: string;
  contactEmail?: string;
  webhookUrl?: string;
  description?: string;
  status?: 'ACTIVE' | 'INACTIVE';
}

interface PlatformRecord {
  platformId: string;
  platformName: string;
  apiKey: string;
  apiKeyPrefix: string;
  redirectUrl: string;
  contactName: string;
  contactEmail: string;
  webhookUrl: string | null;
  description: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: string;
  updatedAt: string;
}

interface SuccessResponse {
  success: true;
  data: unknown;
}

interface ErrorResponse {
  error: string;
  message: string;
}

function generateApiKey(): string {
  const randomPart = randomBytes(16).toString('hex');
  return `sw_${randomPart}`;
}

function getApiKeyPrefix(apiKey: string): string {
  return apiKey.substring(0, 11) + '...';
}

function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

async function registerPlatform(
  body: RegisterPlatformRequest
): Promise<APIGatewayProxyResultV2<SuccessResponse | ErrorResponse>> {
  const { platformName, redirectUrl, contactName, contactEmail, webhookUrl, description } = body;

  if (!platformName || !redirectUrl || !contactName || !contactEmail) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Validation Error',
        message: 'platformName, redirectUrl, contactName, and contactEmail are required',
      }),
    };
  }

  if (!isValidEmail(contactEmail)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Validation Error',
        message: 'Invalid email format',
      }),
    };
  }

  if (!isValidUrl(redirectUrl)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Validation Error',
        message: 'Invalid redirect URL format',
      }),
    };
  }

  if (webhookUrl && !isValidUrl(webhookUrl)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Validation Error',
        message: 'Invalid webhook URL format',
      }),
    };
  }

  const platformId = randomUUID();
  const apiKey = generateApiKey();
  const timestamp = new Date().toISOString();

  const platformRecord: PlatformRecord = {
    platformId,
    platformName,
    apiKey,
    apiKeyPrefix: getApiKeyPrefix(apiKey),
    redirectUrl,
    contactName,
    contactEmail,
    webhookUrl: webhookUrl || null,
    description: description || null,
    status: 'ACTIVE',
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await ddbDocClient.send(
    new PutCommand({
      TableName: process.env.PLATFORMS_TABLE_NAME!,
      Item: platformRecord,
    })
  );

  return {
    statusCode: 201,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success: true,
      data: {
        platformId,
        platformName,
        apiKey,
        apiKeyPrefix: getApiKeyPrefix(apiKey),
        redirectUrl,
        status: 'ACTIVE',
        createdAt: timestamp,
      },
    }),
  };
}

async function getPlatform(
  platformId: string
): Promise<APIGatewayProxyResultV2<SuccessResponse | ErrorResponse>> {
  const result = await ddbDocClient.send(
    new GetCommand({
      TableName: process.env.PLATFORMS_TABLE_NAME!,
      Key: { platformId },
    })
  );

  if (!result.Item) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Not Found',
        message: 'Platform not found',
      }),
    };
  }

  const { apiKey, ...platformData } = result.Item;

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success: true,
      data: platformData,
    }),
  };
}

async function listPlatforms(): Promise<APIGatewayProxyResultV2<SuccessResponse | ErrorResponse>> {
  const result = await ddbDocClient.send(
    new ScanCommand({
      TableName: process.env.PLATFORMS_TABLE_NAME!,
      ProjectionExpression:
        'platformId, platformName, apiKeyPrefix, redirectUrl, contactName, contactEmail, #s, createdAt, updatedAt',
      ExpressionAttributeNames: {
        '#s': 'status',
      },
    })
  );

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success: true,
      data: {
        platforms: result.Items || [],
        count: result.Count || 0,
      },
    }),
  };
}

async function updatePlatform(
  platformId: string,
  body: UpdatePlatformRequest
): Promise<APIGatewayProxyResultV2<SuccessResponse | ErrorResponse>> {
  const existing = await ddbDocClient.send(
    new GetCommand({
      TableName: process.env.PLATFORMS_TABLE_NAME!,
      Key: { platformId },
    })
  );

  if (!existing.Item) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Not Found',
        message: 'Platform not found',
      }),
    };
  }

  const updateFields: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, unknown> = {};

  if (body.platformName) {
    updateFields.push('#pn = :platformName');
    expressionAttributeNames['#pn'] = 'platformName';
    expressionAttributeValues[':platformName'] = body.platformName;
  }

  if (body.redirectUrl) {
    if (!isValidUrl(body.redirectUrl)) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Validation Error',
          message: 'Invalid redirect URL format',
        }),
      };
    }
    updateFields.push('redirectUrl = :redirectUrl');
    expressionAttributeValues[':redirectUrl'] = body.redirectUrl;
  }

  if (body.contactName) {
    updateFields.push('contactName = :contactName');
    expressionAttributeValues[':contactName'] = body.contactName;
  }

  if (body.contactEmail) {
    if (!isValidEmail(body.contactEmail)) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Validation Error',
          message: 'Invalid email format',
        }),
      };
    }
    updateFields.push('contactEmail = :contactEmail');
    expressionAttributeValues[':contactEmail'] = body.contactEmail;
  }

  if (body.webhookUrl !== undefined) {
    if (body.webhookUrl && !isValidUrl(body.webhookUrl)) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Validation Error',
          message: 'Invalid webhook URL format',
        }),
      };
    }
    updateFields.push('webhookUrl = :webhookUrl');
    expressionAttributeValues[':webhookUrl'] = body.webhookUrl || null;
  }

  if (body.description !== undefined) {
    updateFields.push('description = :description');
    expressionAttributeValues[':description'] = body.description || null;
  }

  if (body.status) {
    updateFields.push('#s = :status');
    expressionAttributeNames['#s'] = 'status';
    expressionAttributeValues[':status'] = body.status;
  }

  if (updateFields.length === 0) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Validation Error',
        message: 'No fields to update',
      }),
    };
  }

  updateFields.push('updatedAt = :updatedAt');
  expressionAttributeValues[':updatedAt'] = new Date().toISOString();

  await ddbDocClient.send(
    new UpdateCommand({
      TableName: process.env.PLATFORMS_TABLE_NAME!,
      Key: { platformId },
      UpdateExpression: 'SET ' + updateFields.join(', '),
      ExpressionAttributeNames:
        Object.keys(expressionAttributeNames).length > 0 ? expressionAttributeNames : undefined,
      ExpressionAttributeValues: expressionAttributeValues,
    })
  );

  return getPlatform(platformId);
}

async function regenerateApiKey(
  platformId: string
): Promise<APIGatewayProxyResultV2<SuccessResponse | ErrorResponse>> {
  const existing = await ddbDocClient.send(
    new GetCommand({
      TableName: process.env.PLATFORMS_TABLE_NAME!,
      Key: { platformId },
    })
  );

  if (!existing.Item) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Not Found',
        message: 'Platform not found',
      }),
    };
  }

  const newApiKey = generateApiKey();
  const timestamp = new Date().toISOString();

  await ddbDocClient.send(
    new UpdateCommand({
      TableName: process.env.PLATFORMS_TABLE_NAME!,
      Key: { platformId },
      UpdateExpression: 'SET apiKey = :apiKey, apiKeyPrefix = :apiKeyPrefix, updatedAt = :updatedAt',
      ExpressionAttributeValues: {
        ':apiKey': newApiKey,
        ':apiKeyPrefix': getApiKeyPrefix(newApiKey),
        ':updatedAt': timestamp,
      },
    })
  );

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success: true,
      data: {
        platformId,
        apiKey: newApiKey, 
        apiKeyPrefix: getApiKeyPrefix(newApiKey),
        message: 'API key regenerated successfully. Store this key securely - it will not be shown again.',
      },
    }),
  };
}


export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2<SuccessResponse | ErrorResponse>> => {
  console.log('Event:', JSON.stringify(event, null, 2));

  try {
    const method = event.requestContext.http.method;
    const path = event.rawPath;
    const platformId = event.pathParameters?.platformId;

    if (method === 'POST' && path === '/admin/platforms') {
      const body: RegisterPlatformRequest = JSON.parse(event.body || '{}');
      return registerPlatform(body);
    }

    if (method === 'GET' && path === '/admin/platforms') {
      return listPlatforms();
    }

    if (method === 'GET' && platformId) {
      return getPlatform(platformId);
    }

    if (method === 'PATCH' && platformId) {
      const body: UpdatePlatformRequest = JSON.parse(event.body || '{}');
      return updatePlatform(platformId, body);
    }

    if (method === 'POST' && path.endsWith('/regenerate-key') && platformId) {
      return regenerateApiKey(platformId);
    }

    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Not Found',
        message: 'Route not found',
      }),
    };
  } catch (error: any) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Internal Server Error',
        message: error.message || 'An unexpected error occurred',
      }),
    };
  }
};
