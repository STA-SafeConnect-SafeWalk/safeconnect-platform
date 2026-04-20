import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  BatchGetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { createHmac, randomUUID } from 'crypto';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const client = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(client);

const SOS_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

interface GeoLocation {
  lat: number;
  lng: number;
  accuracy?: number;
}

interface CreateSOSRequest {
  safeWalkId: string;
  geoLocation?: GeoLocation;
}

interface UpdateSOSRequest {
  geoLocation?: GeoLocation;
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

function isValidGeoLocation(geo: unknown): geo is GeoLocation {
  if (!geo || typeof geo !== 'object') return false;
  const g = geo as Record<string, unknown>;
  if (typeof g.lat !== 'number' || typeof g.lng !== 'number') return false;
  if (g.lat < -90 || g.lat > 90) return false;
  if (g.lng < -180 || g.lng > 180) return false;
  if (g.accuracy !== undefined && (typeof g.accuracy !== 'number' || g.accuracy < 0)) return false;
  return true;
}

/**
 * Signs webhook payload using HMAC-SHA256.
 */
function signPayload(body: string, timestamp: string, secret: string): string {
  const data = `${timestamp}.${body}`;
  return createHmac('sha256', secret).update(data).digest('hex');
}

interface WebhookTarget {
  safeWalkId: string;
  platformId: string;
  platformUserId: string;
}

interface WebhookPayload {
  type: 'SOS_CREATED' | 'SOS_LOCATION_UPDATE' | 'SOS_CANCELLED';
  sosId: string;
  timestamp: string;
  victim: {
    safeWalkId: string;
    platformId: string;
    platformUserId: string;
    displayName: string;
  };
  targets: WebhookTarget[];
  geoLocation?: GeoLocation & { timestamp: string };
}

/**
 * Deliver signed webhook payloads to each platform's webhookUrl.
 */
async function deliverWebhooks(
  payload: WebhookPayload,
  platformWebhooks: Map<string, { webhookUrl: string; webhookSecret: string }>,
  allTargets: WebhookTarget[],
): Promise<number> {
  const promises: Promise<void>[] = [];
  let notifiedCount = 0;

  for (const [platformId, { webhookUrl, webhookSecret }] of platformWebhooks) {
    const platformTargets = allTargets.filter((t) => t.platformId === platformId);
    if (platformTargets.length === 0) continue;

    const platformPayload: WebhookPayload = { ...payload, targets: platformTargets };
    const bodyStr = JSON.stringify(platformPayload);
    const timestamp = new Date().toISOString();
    const signature = signPayload(bodyStr, timestamp, webhookSecret);

    notifiedCount += platformTargets.length;

    promises.push(
      fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SafeWalk-Signature': `sha256=${signature}`,
          'X-SafeWalk-Timestamp': timestamp,
          'X-SafeWalk-Event': payload.type,
        },
        body: bodyStr,
        signal: AbortSignal.timeout(5000),
      })
        .then((res) => {
          console.log(`Webhook delivered to platform ${platformId}: ${res.status}`);
        })
        .catch((err: Error) => {
          console.error(`Webhook delivery failed for platform ${platformId}: ${err.message}`);
        }),
    );
  }

  await Promise.allSettled(promises);
  return notifiedCount;
}

/**
 * Resolve trusted contacts who have sosSharing enabled for a given victim user.
 * Returns contacts where the victim is either the requester or target.
 */
async function resolveSOSContacts(victimSafeWalkId: string): Promise<
  Array<{ contactId: string; peerSafeWalkId: string; platformId: string }>
> {
  // Only notify contacts where the victim is the requester (outgoing direction).
  const result = await ddbDocClient.send(
    new QueryCommand({
      TableName: process.env.CONTACTS_TABLE_NAME!,
      IndexName: 'RequesterIndex',
      KeyConditionExpression: 'requesterSafeWalkId = :id',
      FilterExpression: '#s = :active AND sosSharing = :true',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':id': victimSafeWalkId,
        ':active': 'ACTIVE',
        ':true': true,
      },
    }),
  );

  return (result.Items ?? []).map((item) => ({
    contactId: item.contactId as string,
    peerSafeWalkId: item.targetSafeWalkId as string,
    platformId: item.platformId as string,
  }));
}

/**
 * Batch-fetch user records to resolve platformUserId, platformId, and name.
 */
async function resolveUsers(
  safeWalkIds: string[]
): Promise<Map<string, { safeWalkId: string; platformId: string; platformUserId: string; name: string | null }>> {
  const map = new Map<string, { safeWalkId: string; platformId: string; platformUserId: string; name: string | null }>();
  if (safeWalkIds.length === 0) return map;

  const uniqueIds = [...new Set(safeWalkIds)];
  const batches: string[][] = [];
  for (let i = 0; i < uniqueIds.length; i += 100) {
    batches.push(uniqueIds.slice(i, i + 100));
  }

  for (const batch of batches) {
    const result = await ddbDocClient.send(
      new BatchGetCommand({
        RequestItems: {
          [process.env.USERS_TABLE_NAME!]: {
            Keys: batch.map((id) => ({ safeWalkId: id })),
          },
        },
      }),
    );

    for (const item of result.Responses?.[process.env.USERS_TABLE_NAME!] ?? []) {
      map.set(item.safeWalkId as string, {
        safeWalkId: item.safeWalkId as string,
        platformId: item.platformId as string,
        platformUserId: item.platformUserId as string,
        name: (item.name as string) ?? null,
      });
    }
  }

  return map;
}

/**
 * Fetch platform records by platformId to get webhookUrl and webhookSecret.
 * Only returns platforms that have a webhookUrl configured.
 */
async function resolvePlatformWebhooks(
  platformIds: string[]
): Promise<Map<string, { webhookUrl: string; webhookSecret: string }>> {
  const map = new Map<string, { webhookUrl: string; webhookSecret: string }>();
  const uniqueIds = [...new Set(platformIds)];

  const promises = uniqueIds.map(async (platformId) => {
    const result = await ddbDocClient.send(
      new GetCommand({
        TableName: process.env.PLATFORMS_TABLE_NAME!,
        Key: { platformId },
      }),
    );
    if (result.Item?.webhookUrl && result.Item?.webhookSecret) {
      map.set(platformId, {
        webhookUrl: result.Item.webhookUrl as string,
        webhookSecret: result.Item.webhookSecret as string,
      });
    }
  });

  await Promise.all(promises);
  return map;
}

/**
 * POST /sos — Create a new SOS event
 */
async function createSOS(
  body: CreateSOSRequest,
  platformId: string,
): Promise<HandlerResponse> {
  const { safeWalkId, geoLocation } = body;

  if (!safeWalkId) {
    return jsonResponse(400, {
      error: 'Validation Error',
      message: 'safeWalkId is required',
    });
  }

  if (geoLocation !== undefined && !isValidGeoLocation(geoLocation)) {
    return jsonResponse(400, {
      error: 'Validation Error',
      message: 'Valid geoLocation with lat (-90 to 90) and lng (-180 to 180) is required',
    });
  }

  // Verify user exists and belongs to this platform
  const victim = await ddbDocClient.send(
    new GetCommand({
      TableName: process.env.USERS_TABLE_NAME!,
      Key: { safeWalkId },
    }),
  );

  if (!victim.Item) {
    return jsonResponse(404, {
      error: 'Not Found',
      message: 'User not found',
    });
  }

  if (victim.Item.platformId !== platformId) {
    return jsonResponse(403, {
      error: 'Forbidden',
      message: 'User does not belong to this platform',
    });
  }

  // Check for existing active SOS and supersede it
  const existingActive = await ddbDocClient.send(
    new QueryCommand({
      TableName: process.env.SOS_EVENTS_TABLE_NAME!,
      IndexName: 'VictimIndex',
      KeyConditionExpression: 'victimSafeWalkId = :id',
      FilterExpression: '#s = :active',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':id': safeWalkId,
        ':active': 'ACTIVE',
      },
    }),
  );

  if (existingActive.Items && existingActive.Items.length > 0) {
    const now = new Date().toISOString();
    for (const existing of existingActive.Items) {
      await ddbDocClient.send(
        new UpdateCommand({
          TableName: process.env.SOS_EVENTS_TABLE_NAME!,
          Key: { sosId: existing.sosId },
          UpdateExpression: 'SET #s = :superseded, updatedAt = :now',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':superseded': 'SUPERSEDED',
            ':now': now,
          },
        }),
      );
    }
  }

  const sosId = randomUUID();
  const now = new Date();
  const timestamp = now.toISOString();
  const ttl = Math.floor(now.getTime() / 1000) + SOS_TTL_SECONDS;

  const sosRecord = {
    sosId,
    victimSafeWalkId: safeWalkId,
    victimPlatformId: victim.Item.platformId as string,
    victimPlatformUserId: victim.Item.platformUserId as string,
    victimDisplayName: (victim.Item.name as string) || 'Unknown',
    status: 'ACTIVE',
    ...(geoLocation !== undefined && { latestGeoLocation: geoLocation }),
    createdAt: timestamp,
    updatedAt: timestamp,
    ttl,
  };

  const putCommands: Promise<unknown>[] = [
    ddbDocClient.send(
      new PutCommand({
        TableName: process.env.SOS_EVENTS_TABLE_NAME!,
        Item: sosRecord,
      }),
    ),
  ];

  if (geoLocation !== undefined) {
    putCommands.push(
      ddbDocClient.send(
        new PutCommand({
          TableName: process.env.SOS_LOCATION_AUDIT_TABLE_NAME!,
          Item: {
            sosId,
            timestamp,
            geoLocation,
            ttl,
          },
        }),
      ),
    );
  }

  await Promise.all(putCommands);

  // Resolve trusted contacts and deliver webhooks
  const contacts = await resolveSOSContacts(safeWalkId);

  let contactsNotified = 0;

  if (contacts.length > 0) {
    const peerSafeWalkIds = contacts.map((c) => c.peerSafeWalkId);
    const users = await resolveUsers(peerSafeWalkIds);

    const targetPlatformIds = new Set<string>();
    const allTargets: WebhookTarget[] = [];

    for (const contact of contacts) {
      const user = users.get(contact.peerSafeWalkId);
      if (user) {
        targetPlatformIds.add(user.platformId);
        allTargets.push({
          safeWalkId: user.safeWalkId,
          platformId: user.platformId,
          platformUserId: user.platformUserId,
        });
      }
    }

    const platformWebhooks = await resolvePlatformWebhooks([...targetPlatformIds]);

    const payload: WebhookPayload = {
      type: 'SOS_CREATED',
      sosId,
      timestamp,
      victim: {
        safeWalkId,
        platformId: victim.Item.platformId as string,
        platformUserId: victim.Item.platformUserId as string,
        displayName: (victim.Item.name as string) || 'Unknown',
      },
      targets: [],
      ...(geoLocation !== undefined && { geoLocation: { ...geoLocation, timestamp } }),
    };

    contactsNotified = await deliverWebhooks(payload, platformWebhooks, allTargets);
  }

  return jsonResponse(201, {
    success: true,
    data: {
      sosId,
      status: 'ACTIVE',
      contactsNotified,
      createdAt: timestamp,
      contactsFound: contacts.length,
    },
  });
}

/**
 * PATCH /sos/{sosId} — Update location for an active SOS
 */
async function updateSOSLocation(
  sosId: string,
  body: UpdateSOSRequest,
  platformId: string,
): Promise<HandlerResponse> {
  if (body.geoLocation !== undefined && !isValidGeoLocation(body.geoLocation)) {
    return jsonResponse(400, {
      error: 'Validation Error',
      message: 'Valid geoLocation with lat (-90 to 90) and lng (-180 to 180) is required',
    });
  }

  const existing = await ddbDocClient.send(
    new GetCommand({
      TableName: process.env.SOS_EVENTS_TABLE_NAME!,
      Key: { sosId },
    }),
  );

  if (!existing.Item) {
    return jsonResponse(404, {
      error: 'Not Found',
      message: 'SOS event not found',
    });
  }

  if (existing.Item.status !== 'ACTIVE') {
    return jsonResponse(410, {
      error: 'Gone',
      message: 'SOS event is no longer active',
    });
  }

  if (existing.Item.victimPlatformId !== platformId) {
    return jsonResponse(403, {
      error: 'Forbidden',
      message: 'Only the originating platform can update this SOS',
    });
  }

  const now = new Date();
  const timestamp = now.toISOString();

  // Update SOS record and append location audit entry in parallel
  if (body.geoLocation !== undefined) {
    await Promise.all([
      ddbDocClient.send(
        new UpdateCommand({
          TableName: process.env.SOS_EVENTS_TABLE_NAME!,
          Key: { sosId },
          UpdateExpression: 'SET latestGeoLocation = :geo, updatedAt = :now',
          ExpressionAttributeValues: {
            ':geo': body.geoLocation,
            ':now': timestamp,
          },
        }),
      ),
      ddbDocClient.send(
        new PutCommand({
          TableName: process.env.SOS_LOCATION_AUDIT_TABLE_NAME!,
          Item: {
            sosId,
            timestamp,
            geoLocation: body.geoLocation,
            ttl: existing.Item.ttl,
          },
        }),
      ),
    ]);
  } else {
    await ddbDocClient.send(
      new UpdateCommand({
        TableName: process.env.SOS_EVENTS_TABLE_NAME!,
        Key: { sosId },
        UpdateExpression: 'SET updatedAt = :now',
        ExpressionAttributeValues: { ':now': timestamp },
      }),
    );
  }

  const contacts = await resolveSOSContacts(existing.Item.victimSafeWalkId as string);

  let contactsNotified = 0;

  if (contacts.length > 0) {
    const peerSafeWalkIds = contacts.map((c) => c.peerSafeWalkId);
    const users = await resolveUsers(peerSafeWalkIds);

    const targetPlatformIds = new Set<string>();
    const allTargets: WebhookTarget[] = [];

    for (const contact of contacts) {
      const user = users.get(contact.peerSafeWalkId);
      if (user) {
        targetPlatformIds.add(user.platformId);
        allTargets.push({
          safeWalkId: user.safeWalkId,
          platformId: user.platformId,
          platformUserId: user.platformUserId,
        });
      }
    }

    const platformWebhooks = await resolvePlatformWebhooks([...targetPlatformIds]);

    const payload: WebhookPayload = {
      type: 'SOS_LOCATION_UPDATE',
      sosId,
      timestamp,
      victim: {
        safeWalkId: existing.Item.victimSafeWalkId as string,
        platformId: existing.Item.victimPlatformId as string,
        platformUserId: existing.Item.victimPlatformUserId as string,
        displayName: existing.Item.victimDisplayName as string,
      },
      targets: [],
      ...(body.geoLocation !== undefined && { geoLocation: { ...body.geoLocation, timestamp } }),
    };

    contactsNotified = await deliverWebhooks(payload, platformWebhooks, allTargets);
  }

  return jsonResponse(200, {
    success: true,
    data: {
      sosId,
      status: 'ACTIVE',
      contactsNotified,
      ...(body.geoLocation !== undefined && { latestGeoLocation: body.geoLocation }),
      updatedAt: timestamp,
    },
  });
}

/**
 * DELETE /sos/{sosId} — Cancel an active SOS
 */
async function cancelSOS(
  sosId: string,
  platformId: string,
): Promise<HandlerResponse> {
  const existing = await ddbDocClient.send(
    new GetCommand({
      TableName: process.env.SOS_EVENTS_TABLE_NAME!,
      Key: { sosId },
    }),
  );

  if (!existing.Item) {
    return jsonResponse(404, {
      error: 'Not Found',
      message: 'SOS event not found',
    });
  }

  if (existing.Item.status !== 'ACTIVE') {
    return jsonResponse(410, {
      error: 'Gone',
      message: 'SOS event is no longer active',
    });
  }

  if (existing.Item.victimPlatformId !== platformId) {
    return jsonResponse(403, {
      error: 'Forbidden',
      message: 'Only the originating platform can cancel this SOS',
    });
  }

  const timestamp = new Date().toISOString();

  await ddbDocClient.send(
    new UpdateCommand({
      TableName: process.env.SOS_EVENTS_TABLE_NAME!,
      Key: { sosId },
      UpdateExpression: 'SET #s = :cancelled, updatedAt = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':cancelled': 'CANCELLED',
        ':now': timestamp,
      },
    }),
  );

  const contacts = await resolveSOSContacts(existing.Item.victimSafeWalkId as string);

  let contactsNotified = 0;

  if (contacts.length > 0) {
    const peerSafeWalkIds = contacts.map((c) => c.peerSafeWalkId);
    const users = await resolveUsers(peerSafeWalkIds);

    const targetPlatformIds = new Set<string>();
    const allTargets: WebhookTarget[] = [];

    for (const contact of contacts) {
      const user = users.get(contact.peerSafeWalkId);
      if (user) {
        targetPlatformIds.add(user.platformId);
        allTargets.push({
          safeWalkId: user.safeWalkId,
          platformId: user.platformId,
          platformUserId: user.platformUserId,
        });
      }
    }

    const platformWebhooks = await resolvePlatformWebhooks([...targetPlatformIds]);

    const payload: WebhookPayload = {
      type: 'SOS_CANCELLED',
      sosId,
      timestamp,
      victim: {
        safeWalkId: existing.Item.victimSafeWalkId as string,
        platformId: existing.Item.victimPlatformId as string,
        platformUserId: existing.Item.victimPlatformUserId as string,
        displayName: existing.Item.victimDisplayName as string,
      },
      targets: [],
    };

    contactsNotified = await deliverWebhooks(payload, platformWebhooks, allTargets);
  }

  return jsonResponse(200, {
    success: true,
    data: {
      sosId,
      status: 'CANCELLED',
      contactsNotified,
      updatedAt: timestamp,
    },
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

    if (method === 'POST' && rawPath === '/sos') {
      let body: CreateSOSRequest;
      try {
        body = JSON.parse(event.body || '{}');
      } catch {
        return jsonResponse(400, {
          error: 'Validation Error',
          message: 'Invalid JSON body',
        });
      }
      return await createSOS(body, platformId);
    }

    if (method === 'PATCH' && rawPath.startsWith('/sos/')) {
      const sosId = event.pathParameters?.sosId;
      if (!sosId) {
        return jsonResponse(400, {
          error: 'Validation Error',
          message: 'sosId path parameter is required',
        });
      }
      let body: UpdateSOSRequest;
      try {
        body = JSON.parse(event.body || '{}');
      } catch {
        return jsonResponse(400, {
          error: 'Validation Error',
          message: 'Invalid JSON body',
        });
      }
      return await updateSOSLocation(sosId, body, platformId);
    }

    if (method === 'DELETE' && rawPath.startsWith('/sos/')) {
      const sosId = event.pathParameters?.sosId;
      if (!sosId) {
        return jsonResponse(400, {
          error: 'Validation Error',
          message: 'sosId path parameter is required',
        });
      }
      return await cancelSOS(sosId, platformId);
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
