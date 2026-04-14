import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  BatchGetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { createHash, randomUUID } from 'crypto';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const client = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(client);

interface CreateTrustedContactRequest {
  requesterSafeWalkId: string;
  sharingCode: string;
}

interface TrustedContactRecord {
  contactId: string;
  requesterSafeWalkId: string;
  targetSafeWalkId: string;
  platformId: string;
  webhookUrl: string | null;
  status: 'ACTIVE' | 'REVOKED';
  sharingCodeHash: string;
  locationSharing: boolean;
  sosSharing: boolean;
  createdAt: string;
  updatedAt: string;
}

interface UpdateTrustedContactRequest {
  safeWalkId: string;
  locationSharing?: boolean;
  sosSharing?: boolean;
}

interface SuccessResponse {
  success: true;
  data: unknown;
}

interface ErrorResponse {
  error: string;
  message: string;
}

type HandlerResponse = APIGatewayProxyResultV2<SuccessResponse | ErrorResponse>;

function jsonResponse(statusCode: number, body: SuccessResponse | ErrorResponse): HandlerResponse {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * One-way hash of the sharing code so the raw code is never persisted in contacts.
 */
function hashSharingCode(code: string): string {
  return createHash('sha256').update(code.toUpperCase().trim()).digest('hex');
}

interface SharingCodeLookupResult {
  safeWalkId: string;
  expired: boolean;
}

/**
 * Look up a sharing code in the SharingCodes table and check its validity.
 */
async function resolveSharingCode(sharingCode: string): Promise<SharingCodeLookupResult | null> {
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: process.env.SHARING_CODES_TABLE_NAME!,
      IndexName: 'SharingCodeIndex',
      KeyConditionExpression: 'sharingCode = :code',
      ExpressionAttributeValues: { ':code': sharingCode.toUpperCase().trim() },
      Limit: 1,
    })
  );

  if (!result.Items || result.Items.length === 0) return null;

  const record = result.Items[0];
  const expired = new Date(record.expiresAt as string) <= new Date();
  return { safeWalkId: record.safeWalkId as string, expired };
}

async function resolveUserBySafeWalkId(safeWalkId: string) {
  const result = await ddbDocClient.send(
    new GetCommand({
      TableName: process.env.USERS_TABLE_NAME!,
      Key: { safeWalkId },
    })
  );
  return result?.Item ?? null;
}

async function resolvePlatformWebhookUrl(platformId: string): Promise<string | null> {
  const result = await ddbDocClient.send(
    new GetCommand({
      TableName: process.env.PLATFORMS_TABLE_NAME!,
      Key: { platformId },
    })
  );
  return result.Item?.webhookUrl ?? null;
}

/**
 * POST /contacts
 *
 * A 3rd-party platform sends its user's safeWalkId together with the
 * sharing code of the person they want to add as a trusted contact.
 */
async function createTrustedContact(
  body: CreateTrustedContactRequest,
  platformId: string
): Promise<HandlerResponse> {
  const { requesterSafeWalkId, sharingCode } = body;

  if (!requesterSafeWalkId || !sharingCode) {
    return jsonResponse(400, {
      error: 'Validation Error',
      message: 'requesterSafeWalkId and sharingCode are required',
    });
  }

  const requester = await resolveUserBySafeWalkId(requesterSafeWalkId);
  if (!requester) {
    return jsonResponse(404, {
      error: 'Not Found',
      message: 'Requester safeWalkId not found',
    });
  }

  const sharingCodeResult = await resolveSharingCode(sharingCode);
  if (!sharingCodeResult) {
    return jsonResponse(404, {
      error: 'Not Found',
      message: 'No user found for the provided sharing code',
    });
  }

  if (sharingCodeResult.expired) {
    return jsonResponse(410, {
      error: 'Gone',
      message: 'The sharing code has expired. Please request a new one.',
    });
  }

  const targetSafeWalkId = sharingCodeResult.safeWalkId;

  if (requester.safeWalkId === targetSafeWalkId) {
    return jsonResponse(400, {
      error: 'Validation Error',
      message: 'A user cannot add themselves as a trusted contact',
    });
  }

  const existingResult = await ddbDocClient.send(
    new QueryCommand({
      TableName: process.env.CONTACTS_TABLE_NAME!,
      IndexName: 'RequesterIndex',
      KeyConditionExpression: 'requesterSafeWalkId = :rid',
      FilterExpression: 'targetSafeWalkId = :tid AND platformId = :pid AND #s = :active',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':rid': requester.safeWalkId,
        ':tid': targetSafeWalkId,
        ':pid': platformId,
        ':active': 'ACTIVE',
      },
    })
  );

  if (existingResult.Items && existingResult.Items.length > 0) {
    return jsonResponse(409, {
      error: 'Conflict',
      message: 'This trusted contact relationship already exists',
    });
  }

  const webhookUrl = await resolvePlatformWebhookUrl(platformId);

  const timestamp = new Date().toISOString();
  const contactId = randomUUID();

  const record: TrustedContactRecord = {
    contactId,
    requesterSafeWalkId: requester.safeWalkId,
    targetSafeWalkId,
    platformId,
    webhookUrl,
    status: 'ACTIVE',
    sharingCodeHash: hashSharingCode(sharingCode),
    locationSharing: true,
    sosSharing: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await ddbDocClient.send(
    new PutCommand({
      TableName: process.env.CONTACTS_TABLE_NAME!,
      Item: record,
    })
  );

  return jsonResponse(201, {
    success: true,
    data: {
      contactId,
      requesterSafeWalkId: requester.safeWalkId,
      targetSafeWalkId,
      status: 'ACTIVE',
      locationSharing: true,
      sosSharing: true,
      createdAt: timestamp,
    },
  });
}

/**
 * PATCH /contacts/{contactId}
 *
 * Updates locationSharing and/or sosSharing preferences for a trusted contact.
 * The requesting user (identified by safeWalkId in the body) must be either
 * the requester or target of the relationship.
 */
async function updateTrustedContact(
  contactId: string,
  body: UpdateTrustedContactRequest,
  platformId: string
): Promise<HandlerResponse> {
  const { safeWalkId, locationSharing, sosSharing } = body;

  if (!safeWalkId) {
    return jsonResponse(400, {
      error: 'Validation Error',
      message: 'safeWalkId is required',
    });
  }

  if (locationSharing === undefined && sosSharing === undefined) {
    return jsonResponse(400, {
      error: 'Validation Error',
      message: 'At least one of locationSharing or sosSharing must be provided',
    });
  }

  const existing = await ddbDocClient.send(
    new GetCommand({
      TableName: process.env.CONTACTS_TABLE_NAME!,
      Key: { contactId },
    })
  );

  if (!existing.Item) {
    return jsonResponse(404, {
      error: 'Not Found',
      message: 'Trusted contact not found',
    });
  }

  if (existing.Item.platformId !== platformId) {
    return jsonResponse(403, {
      error: 'Forbidden',
      message: 'You can only update contacts created by your platform',
    });
  }

  const { requesterSafeWalkId, targetSafeWalkId } = existing.Item as TrustedContactRecord;
  if (safeWalkId !== requesterSafeWalkId && safeWalkId !== targetSafeWalkId) {
    return jsonResponse(403, {
      error: 'Forbidden',
      message: 'The provided safeWalkId is not part of this contact relationship',
    });
  }

  if (existing.Item.status === 'REVOKED') {
    return jsonResponse(400, {
      error: 'Bad Request',
      message: 'Cannot update a revoked trusted contact',
    });
  }

  const updateParts: string[] = ['updatedAt = :now'];
  const expressionAttributeValues: Record<string, unknown> = {
    ':now': new Date().toISOString(),
  };

  if (locationSharing !== undefined) {
    updateParts.push('locationSharing = :ls');
    expressionAttributeValues[':ls'] = locationSharing;
  }

  if (sosSharing !== undefined) {
    updateParts.push('sosSharing = :ss');
    expressionAttributeValues[':ss'] = sosSharing;
  }

  await ddbDocClient.send(
    new UpdateCommand({
      TableName: process.env.CONTACTS_TABLE_NAME!,
      Key: { contactId },
      UpdateExpression: `SET ${updateParts.join(', ')}`,
      ExpressionAttributeValues: expressionAttributeValues,
    })
  );

  return jsonResponse(200, {
    success: true,
    data: {
      contactId,
      locationSharing: locationSharing ?? existing.Item.locationSharing,
      sosSharing: sosSharing ?? existing.Item.sosSharing,
      updatedAt: expressionAttributeValues[':now'],
    },
  });
}

/**
 * GET /contacts/{safeWalkId}
 *
 * Returns all ACTIVE trusted contacts where the given user is either the
 * requester or the target.
 */
async function listTrustedContacts(
  safeWalkId: string,
  platformId: string
): Promise<HandlerResponse> {
  const user = await resolveUserBySafeWalkId(safeWalkId);
  if (!user) {
    return jsonResponse(404, {
      error: 'Not Found',
      message: 'safeWalkId not found',
    });
  }

  // Contacts where user is the requester
  const asRequester = await ddbDocClient.send(
    new QueryCommand({
      TableName: process.env.CONTACTS_TABLE_NAME!,
      IndexName: 'RequesterIndex',
      KeyConditionExpression: 'requesterSafeWalkId = :id',
      FilterExpression: 'platformId = :pid AND #s = :active',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':id': safeWalkId,
        ':pid': platformId,
        ':active': 'ACTIVE',
      },
    })
  );

  // Contacts where user is the target
  const asTarget = await ddbDocClient.send(
    new QueryCommand({
      TableName: process.env.CONTACTS_TABLE_NAME!,
      IndexName: 'TargetIndex',
      KeyConditionExpression: 'targetSafeWalkId = :id',
      FilterExpression: 'platformId = :pid AND #s = :active',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':id': safeWalkId,
        ':pid': platformId,
        ':active': 'ACTIVE',
      },
    })
  );

  const contacts = [
    ...(asRequester.Items ?? []).map((c) => ({ ...c, direction: 'outgoing' as const })),
    ...(asTarget.Items ?? []).map((c) => ({ ...c, direction: 'incoming' as const })),
  ];

  // Collect the safeWalkIds of the *other* side of each relationship
  const peerIds = new Set<string>();
  for (const c of contacts) {
    const peer = c.direction === 'outgoing'
      ? (c as Record<string, unknown>).targetSafeWalkId
      : (c as Record<string, unknown>).requesterSafeWalkId;
    if (peer) peerIds.add(peer as string);
  }

  // Batch-fetch user records to resolve names
  const nameMap = new Map<string, string | null>();
  if (peerIds.size > 0) {
    const keys = [...peerIds].map((id) => ({ safeWalkId: id }));
    const batchResult = await ddbDocClient.send(
      new BatchGetCommand({
        RequestItems: {
          [process.env.USERS_TABLE_NAME!]: {
            Keys: keys,
            ProjectionExpression: 'safeWalkId, #n',
            ExpressionAttributeNames: { '#n': 'name' },
          },
        },
      })
    );
    const items = batchResult.Responses?.[process.env.USERS_TABLE_NAME!] ?? [];
    for (const item of items) {
      nameMap.set(item.safeWalkId as string, (item.name as string) ?? null);
    }
  }

  // Strip internal fields and attach peer name
  const sanitised = contacts.map((c) => {
    const rec = c as Record<string, unknown>;
    const { sharingCodeHash, ...rest } = rec;
    const peerId = (c.direction === 'outgoing' ? rec.targetSafeWalkId : rec.requesterSafeWalkId) as string;
    return { ...rest, peerName: nameMap.get(peerId) ?? null };
  });

  return jsonResponse(200, {
    success: true,
    data: { contacts: sanitised, count: sanitised.length },
  });
}

/**
 * DELETE /contacts/{contactId}
 *
 * Soft-revoke a trusted contact relationship.
 */
async function revokeTrustedContact(
  contactId: string,
  platformId: string
): Promise<HandlerResponse> {
  const existing = await ddbDocClient.send(
    new GetCommand({
      TableName: process.env.CONTACTS_TABLE_NAME!,
      Key: { contactId },
    })
  );

  if (!existing.Item) {
    return jsonResponse(404, {
      error: 'Not Found',
      message: 'Trusted contact not found',
    });
  }

  if (existing.Item.platformId !== platformId) {
    return jsonResponse(403, {
      error: 'Forbidden',
      message: 'You can only revoke contacts created by your platform',
    });
  }

  if (existing.Item.status === 'REVOKED') {
    return jsonResponse(400, {
      error: 'Bad Request',
      message: 'This trusted contact has already been revoked',
    });
  }

  await ddbDocClient.send(
    new UpdateCommand({
      TableName: process.env.CONTACTS_TABLE_NAME!,
      Key: { contactId },
      UpdateExpression: 'SET #s = :revoked, updatedAt = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':revoked': 'REVOKED',
        ':now': new Date().toISOString(),
      },
    })
  );

  return jsonResponse(200, {
    success: true,
    data: { contactId, status: 'REVOKED' },
  });
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<HandlerResponse> => {
  console.log('Event:', JSON.stringify(event, null, 2));

  try {
    const requestContext = event.requestContext as any;
    const authorizerContext = requestContext.authorizer?.lambda;
    const platformId = authorizerContext?.platformId as string;

    if (!platformId) {
      return jsonResponse(401, {
        error: 'Unauthorized',
        message: 'Invalid platform authentication',
      });
    }

    const method = event.requestContext.http.method;
    const rawPath = event.rawPath;

    if (method === 'POST' && rawPath === '/contacts') {
      const body: CreateTrustedContactRequest = JSON.parse(event.body || '{}');
      return await createTrustedContact(body, platformId);
    }

    if (method === 'GET' && rawPath.startsWith('/contacts/')) {
      const safeWalkId = event.pathParameters?.safeWalkId;
      if (!safeWalkId) {
        return jsonResponse(400, {
          error: 'Validation Error',
          message: 'safeWalkId path parameter is required',
        });
      }
      return await listTrustedContacts(safeWalkId, platformId);
    }

    if (method === 'DELETE' && rawPath.startsWith('/contacts/')) {
      const contactId = event.pathParameters?.contactId;
      if (!contactId) {
        return jsonResponse(400, {
          error: 'Validation Error',
          message: 'contactId path parameter is required',
        });
      }
      return await revokeTrustedContact(contactId, platformId);
    }

    if (method === 'PATCH' && rawPath.startsWith('/contacts/')) {
      const contactId = event.pathParameters?.contactId;
      if (!contactId) {
        return jsonResponse(400, {
          error: 'Validation Error',
          message: 'contactId path parameter is required',
        });
      }
      const body: UpdateTrustedContactRequest = JSON.parse(event.body || '{}');
      return await updateTrustedContact(contactId, body, platformId);
    }

    return jsonResponse(404, {
      error: 'Not Found',
      message: 'Route not found',
    });
  } catch (error: any) {
    console.error('Error:', error);
    return jsonResponse(500, {
      error: 'Internal Server Error',
      message: error.message || 'An unexpected error occurred',
    });
  }
};
