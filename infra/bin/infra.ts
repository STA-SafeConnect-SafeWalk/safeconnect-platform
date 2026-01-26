#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { UserStack } from '../lib/user-stack';
import { PipelineStack } from '../lib/pipeline-stack';
import { PlatformStack } from '../lib/platform-stack';

const app = new cdk.App();

const githubOrg = app.node.tryGetContext('githubOrg') || process.env.GITHUB_ORG;
const githubAppRepo = app.node.tryGetContext('githubAppRepo') || process.env.GITHUB_APP_REPO;
const githubPlatformRepo = app.node.tryGetContext('githubPlatformRepo') || process.env.GITHUB_PLATFORM_REPO;

if (!githubOrg || !githubAppRepo || !githubPlatformRepo) {
  console.warn(
    'Warning: githubOrg and githubRepo not provided. The pipeline stack will not be created.\n' +
    'Provide them via context: cdk deploy -c githubOrg=<org> -c githubAppRepo=<repo> -c githubPlatformRepo=<repo>'
  );
}

if (githubOrg && githubAppRepo && githubPlatformRepo) {
  new PipelineStack(app, 'safewalk-pipeline-stack', {
    githubOrg,
    githubAppRepo,
    githubPlatformRepo,
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
