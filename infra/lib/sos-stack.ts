import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayIntegrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';
import * as path from 'path';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

import { PlatformStack } from './platform-stack';

export interface SOSStackProps extends cdk.StackProps {
  platformStack: PlatformStack;
  usersTable: dynamodb.ITable;
  trustedContactsTable: dynamodb.ITable;
  platformsTableName: string;
}

export class SOSStack extends cdk.Stack {
  public readonly sosEventsTable: dynamodb.Table;
  public readonly sosLocationAuditTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: SOSStackProps) {
    super(scope, id, props);

    this.sosEventsTable = new dynamodb.Table(this, 'sos-events-table', {
      tableName: 'SafeWalkSOSEvents',
      partitionKey: {
        name: 'sosId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
      timeToLiveAttribute: 'ttl',
    });

    this.sosEventsTable.addGlobalSecondaryIndex({
      indexName: 'VictimIndex',
      partitionKey: {
        name: 'victimSafeWalkId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.sosLocationAuditTable = new dynamodb.Table(this, 'sos-location-audit-table', {
      tableName: 'SafeWalkSOSLocationAudit',
      partitionKey: {
        name: 'sosId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
      timeToLiveAttribute: 'ttl',
    });

    const platformsTableRef = dynamodb.Table.fromTableName(
      this,
      'PlatformsTableRef',
      props.platformsTableName,
    );

    const sosHandler = new NodejsFunction(this, 'sos-handler', {
      functionName: 'safewalk-sos-handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      entry: path.join(__dirname, '../../lambda/sos-handler/index.ts'),
      environment: {
        SOS_EVENTS_TABLE_NAME: this.sosEventsTable.tableName,
        SOS_LOCATION_AUDIT_TABLE_NAME: this.sosLocationAuditTable.tableName,
        USERS_TABLE_NAME: props.usersTable.tableName,
        CONTACTS_TABLE_NAME: props.trustedContactsTable.tableName,
        PLATFORMS_TABLE_NAME: props.platformsTableName,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      logRetention: RetentionDays.ONE_WEEK,
    });

    this.sosEventsTable.grantReadWriteData(sosHandler);
    this.sosLocationAuditTable.grantReadWriteData(sosHandler);
    props.usersTable.grantReadData(sosHandler);
    props.trustedContactsTable.grantReadData(sosHandler);
    platformsTableRef.grantReadData(sosHandler);

    const sosIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
      'sos-integration',
      sosHandler,
    );

    props.platformStack.addProtectedRoute('CreateSOSRoute', {
      path: '/sos',
      methods: [apigateway.HttpMethod.POST],
      integration: sosIntegration,
    });

    props.platformStack.addProtectedRoute('UpdateSOSRoute', {
      path: '/sos/{sosId}',
      methods: [apigateway.HttpMethod.PATCH],
      integration: sosIntegration,
    });

    props.platformStack.addProtectedRoute('CancelSOSRoute', {
      path: '/sos/{sosId}',
      methods: [apigateway.HttpMethod.DELETE],
      integration: sosIntegration,
    });
  }
}
