import { mockClient, AwsClientStub } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  ScanCommand,
  BatchGetCommand,
} from '@aws-sdk/lib-dynamodb';

type Item = Record<string, unknown>;

interface TableSchema {
  partitionKey: string;
  sortKey?: string;
  gsiDefinitions?: Array<{
    indexName: string;
    partitionKey: string;
    sortKey?: string;
  }>;
}

const TABLE_SCHEMAS: Record<string, TableSchema> = {
  PlatformsTable: {
    partitionKey: 'platformId',
    gsiDefinitions: [
      { indexName: 'ApiKeyIndex', partitionKey: 'apiKey' },
      { indexName: 'PlatformNameIndex', partitionKey: 'platformName' },
    ],
  },
  UsersTable: {
    partitionKey: 'safeWalkId',
    gsiDefinitions: [
      { indexName: 'PlatformUserIndex', partitionKey: 'platformId', sortKey: 'platformUserId' },
    ],
  },
  SharingCodesTable: {
    partitionKey: 'safeWalkId',
    gsiDefinitions: [
      { indexName: 'SharingCodeIndex', partitionKey: 'sharingCode' },
    ],
  },
  ContactsTable: {
    partitionKey: 'contactId',
    gsiDefinitions: [
      { indexName: 'RequesterIndex', partitionKey: 'requesterSafeWalkId', sortKey: 'createdAt' },
      { indexName: 'TargetIndex', partitionKey: 'targetSafeWalkId', sortKey: 'createdAt' },
    ],
  },
  SOSEventsTable: {
    partitionKey: 'sosId',
    gsiDefinitions: [
      { indexName: 'VictimIndex', partitionKey: 'victimSafeWalkId', sortKey: 'createdAt' },
    ],
  },
  SOSLocationAuditTable: {
    partitionKey: 'sosId',
    sortKey: 'timestamp',
  },
};

class InMemoryDB {
  private tables: Map<string, Item[]> = new Map();

  constructor() {
    for (const tableName of Object.keys(TABLE_SCHEMAS)) {
      this.tables.set(tableName, []);
    }
  }

  reset() {
    for (const tableName of this.tables.keys()) {
      this.tables.set(tableName, []);
    }
  }

  private getTable(tableName: string): Item[] {
    return this.tables.get(tableName) ?? [];
  }

  put(tableName: string, item: Item, conditionExpression?: string): void {
    const schema = TABLE_SCHEMAS[tableName];
    if (!schema) throw new Error(`Unknown table: ${tableName}`);

    const pk = schema.partitionKey;
    const sk = schema.sortKey;
    const items = this.getTable(tableName);

    if (conditionExpression?.includes('attribute_not_exists')) {
      const existing = items.find((i) => {
        if (sk) return i[pk] === item[pk] && i[sk] === item[sk];
        return i[pk] === item[pk];
      });
      if (existing) {
        const err = new Error('ConditionalCheckFailedException') as any;
        err.name = 'ConditionalCheckFailedException';
        throw err;
      }
    }

    const existingIndex = items.findIndex((i) => {
      if (sk) return i[pk] === item[pk] && i[sk] === item[sk];
      return i[pk] === item[pk];
    });

    if (existingIndex >= 0) {
      items[existingIndex] = { ...item };
    } else {
      items.push({ ...item });
    }
  }

  get(tableName: string, key: Record<string, unknown>): Item | undefined {
    const items = this.getTable(tableName);
    return items.find((item) =>
      Object.entries(key).every(([k, v]) => item[k] === v)
    );
  }

  batchGet(
    requestItems: Record<string, { Keys: Record<string, unknown>[] }>
  ): Record<string, Item[]> {
    const responses: Record<string, Item[]> = {};
    for (const [tableName, { Keys }] of Object.entries(requestItems)) {
      responses[tableName] = Keys.map((key) => this.get(tableName, key)).filter(
        (item): item is Item => item !== undefined
      );
    }
    return responses;
  }

  query(
    tableName: string,
    indexName: string | undefined,
    keyConditionExpression: string,
    expressionAttributeValues: Record<string, unknown>,
    filterExpression?: string,
    expressionAttributeNames?: Record<string, string>,
    limit?: number
  ): Item[] {
    const items = this.getTable(tableName);

    const keyConditions = this.parseConditions(
      keyConditionExpression,
      expressionAttributeValues,
      expressionAttributeNames
    );

    let filtered = items.filter((item) =>
      keyConditions.every(({ field, value }) => item[field] === value)
    );

    if (filterExpression) {
      const filterConditions = this.parseConditions(
        filterExpression,
        expressionAttributeValues,
        expressionAttributeNames
      );
      filtered = filtered.filter((item) =>
        filterConditions.every(({ field, value }) => item[field] === value)
      );
    }

    if (limit) {
      filtered = filtered.slice(0, limit);
    }

    return filtered;
  }

  scan(tableName: string): Item[] {
    return [...this.getTable(tableName)];
  }

  update(
    tableName: string,
    key: Record<string, unknown>,
    updateExpression: string,
    expressionAttributeValues: Record<string, unknown>,
    expressionAttributeNames?: Record<string, string>
  ): void {
    const items = this.getTable(tableName);
    const item = items.find((i) =>
      Object.entries(key).every(([k, v]) => i[k] === v)
    );
    if (!item) return;

    const setMatch = updateExpression.match(/SET\s+(.+?)(?:\s+REMOVE|$)/i);
    if (setMatch) {
      const assignments = setMatch[1].split(',').map((s) => s.trim());
      for (const assignment of assignments) {
        const [left, right] = assignment.split('=').map((s) => s.trim());
        const resolvedField = expressionAttributeNames?.[left] ?? left;
        const value = expressionAttributeValues[right];
        item[resolvedField] = value;
      }
    }

    const removeMatch = updateExpression.match(/REMOVE\s+(.+)/i);
    if (removeMatch) {
      const fields = removeMatch[1].split(',').map((s) => s.trim());
      for (const field of fields) {
        const resolvedField = expressionAttributeNames?.[field] ?? field;
        delete item[resolvedField];
      }
    }
  }

  private parseConditions(
    expression: string,
    values: Record<string, unknown>,
    names?: Record<string, string>
  ): Array<{ field: string; value: unknown }> {
    const conditions: Array<{ field: string; value: unknown }> = [];
    const parts = expression.split(/\s+AND\s+/i);
    for (const part of parts) {
      const match = part.trim().match(/^([\w#]+)\s*=\s*(:\w+)$/);
      if (match) {
        const rawField = match[1];
        const valueKey = match[2];
        const field = names?.[rawField] ?? rawField;
        conditions.push({ field, value: values[valueKey] });
      }
    }
    return conditions;
  }
}

export function createInMemoryDDBMock(): {
  db: InMemoryDB;
  mock: AwsClientStub<DynamoDBDocumentClient>;
} {
  const db = new InMemoryDB();
  const mock = mockClient(DynamoDBDocumentClient);

  mock.on(PutCommand).callsFake((input: any) => {
    db.put(input.TableName, input.Item, input.ConditionExpression);
    return {};
  });

  mock.on(GetCommand).callsFake((input: any) => {
    const item = db.get(input.TableName, input.Key);
    return { Item: item };
  });

  mock.on(BatchGetCommand).callsFake((input: any) => {
    const responses = db.batchGet(input.RequestItems);
    return { Responses: responses };
  });

  mock.on(QueryCommand).callsFake((input: any) => {
    const items = db.query(
      input.TableName,
      input.IndexName,
      input.KeyConditionExpression,
      input.ExpressionAttributeValues,
      input.FilterExpression,
      input.ExpressionAttributeNames,
      input.Limit
    );
    return { Items: items, Count: items.length };
  });

  mock.on(ScanCommand).callsFake((input: any) => {
    const items = db.scan(input.TableName);
    return { Items: items, Count: items.length };
  });

  mock.on(UpdateCommand).callsFake((input: any) => {
    db.update(
      input.TableName,
      input.Key,
      input.UpdateExpression,
      input.ExpressionAttributeValues,
      input.ExpressionAttributeNames
    );
    return {};
  });

  return { db, mock };
}

export function setupIntegrationEnv() {
  process.env.PLATFORMS_TABLE_NAME = 'PlatformsTable';
  process.env.TABLE_NAME = 'UsersTable';
  process.env.USERS_TABLE_NAME = 'UsersTable';
  process.env.SHARING_CODES_TABLE_NAME = 'SharingCodesTable';
  process.env.CONTACTS_TABLE_NAME = 'ContactsTable';
  process.env.SOS_EVENTS_TABLE_NAME = 'SOSEventsTable';
  process.env.SOS_LOCATION_AUDIT_TABLE_NAME = 'SOSLocationAuditTable';
}
