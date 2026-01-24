#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { UserStack } from '../lib/user-stack';
import { PipelineStack } from '../lib/pipeline-stack';
import { PlatformStack } from '../lib/platform-stack';

const app = new cdk.App();

const githubOrg = app.node.tryGetContext('githubOrg') || process.env.GITHUB_ORG;
const githubRepo = app.node.tryGetContext('githubRepo') || process.env.GITHUB_REPO;

if (!githubOrg || !githubRepo) {
  console.warn(
    'Warning: githubOrg and githubRepo not provided. The pipeline stack will not be created.\n' +
    'Provide them via context: cdk deploy -c githubOrg=<org> -c githubRepo=<repo>'
  );
}

if (githubOrg && githubRepo) {
  new PipelineStack(app, 'safewalk-pipeline-stack', {
    githubOrg,
    githubRepo,
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION,
    },
    description: 'GitHub Actions OIDC authentication and deployment role',
  });
}

const platformStack = new PlatformStack(app, 'safewalk-platform-stack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Platform registration and central API Gateway with custom authorizer',
});

new UserStack(app, 'safewalk-platform-user-stack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  platformStack,
});
