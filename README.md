# SafeConnect Platform
This repository contains the SafeConnect platform's business logic and infrastructure. The SafeConnect platform enables 3rd party public safety apps to securely exchange SOS events and therefore eliminate vendor-lockins for users concerned for their everyday safety. 

## Setup
In order to configure the platform for local development, follow the instructions given below.

### Deploy Infrastructure
The infrastructure deployment requires a properly configured AWS account. Make sure the AWS CLI and Cloud Development Kit (CDK) are authorised correctly using your preferred authentication flow (access keys recommended for local development only). 

#### Node Packages
Install all required Node packages via ```npm ci ``` in the respective folders:

```sh
cd infra && npm ci
cd lambda/platform-admin-handler && npm ci
cd lambda/platform-authorizer && npm ci
cd lambda/platform-user-handler && npm ci
cd lambda/trusted-contacts-handler && npm ci
cd lambda/sos-handler && npm ci
cd lambda && npm ci
npm ci
```

#### GitHub OIDC 
To benefit from the [CDK CLI](https://docs.aws.amazon.com/cdk/v2/guide/getting-started.html), install it by using the following command:
```sh
sudo npm install -g aws-cdk
```

In order to use the contained CI/CD pipeline, make sure to deploy the ```pipeline-stack``` independently using the following command:

```sh
cdk deploy safewalk-pipeline-stack -c githubOrg=YOUR_GITHUB_ORG -c githubRepo=YOUR_GITHUB_REPO -c githubAppRepo=YOUR_GITHUB_APP_REPO
```

In case you deploy for the SafeWalk organisation, use the following: ```githubOrg=STA-SafeConnect-SafeWalk```, ```githubAppRepo=safewalk-app``` and ```githubRepo=safeconnect-platform```.

NOTE: This has to be done only ONCE by one team member, not individually.

#### Deploy Remaining Stacks
Once the above steps are completed, you may deploy the stacks to your AWS account using:

```sh
cdk deploy --all
```

## Platform Usage as a SC Admin
The following section describes the SafeConnect Platform management as a designated administrator. 

### Authenticate as a SafeConnect Admin
3rd party platform registrations can only be performed by SafeConnect admins. In order to authenticate as a SafeConnect admin follow these steps.

#### Create your Admin Account
Navigate to the ```safewalk-admin-user-pool``` in AWS Cognito and create a new user for yourself. Make sure to check 'Don't send an invitation' and 'Mark email address as verified'. 

#### Set your new Password
As a new user, you are required to set a new password after registering. The user pool id can be found in AWS Cognito > safewalk-admin-user-pool > Overview.
```sh
aws cognito-idp admin-set-user-password \
  --user-pool-id <SafeWalkUserPoolId> \
  --username admin@example.com \
  --password 'YourSecurePassword123!' \
  --permanent
```

#### Retrieve an Access Token
In order to manually send verified requests (since there currently is not Admin interface), request a JWT Access and Refresh token using the following command. The client id can be found in AWS Cognito > safewalk-admin-user-pool > App clients > safewalk-admin-api-client.

```sh
aws cognito-idp initiate-auth \
  --auth-flow USER_PASSWORD_AUTH \
  --client-id <SafeWalkUserPoolClientId> \
  --auth-parameters "USERNAME=admin@example.com,PASSWORD=YourSecurePassword123!"
```

Make sure to store the access key safely. You may now use it to authenticate your requests by adding the header ```Authorization: Bearer <AccessToken>```.

### Register a new Platform
In order to register a new 3rd party platform for SafeWalk and to obtain an API key for said platform to register users with SafeWalk, send an authenticated ```POST``` request to ```safewalk-platform-stack.apiendpoint/admin/platforms``` with the following body:

```json
{
  "platformName": "Partner Platform Name",
  "redirectUrl": "https://partner.app/callback",
  "contactName": "John Doe",
  "contactEmail": "johndoe@partner.app",
  "webhookUrl": "https://partner.app/webhook", # Webhook for SOS events, can also be added later
  "description": "Partner integration for testing purposes" # Optional
}
```

Positive response after successful validation:
```json
{
  "success": true,
  "data": {
    "platformId": "uuid",
    "platformName": "Partner Platform Name",
    "apiKey": "sw_abc123...", # Only shown once!
    "apiKeyPrefix": "sw_abc123...",
    "redirectUrl": "https://partner.app/callback",
    "status": "ACTIVE",
    "createdAt": "2026-01-24T..."
  }
}
```

Make sure to securely store the ```apiKey``` and forward it to the responsible contact person if necessary. This is the key used by the 3rd party platform to verify their requests heading to SafeWalk. 

### List all Platforms
You may list all platforms by sending a ```GET``` request to ```safewalk-platform-stack.apiendpoint/admin/platforms```.

### Information about a Platform
You may list all information regarding a certain platform by sending a ```GET``` request to ```safewalk-platform-stack.apiendpoint/admin/platforms/{platformId}```.

### Generate new API Key
In case you or a platform manager have lost their API key, you may generate a new API key by sending a ```POST``` request to ```safewalk-platform-stack.apiendpoint/admin/platforms/{platformId}/regenerate-key```

NOTE: Equally to registering a new platform, the newly generated API key is only shown ONCE!

### Update an existing Platform
Updates to an existing platform's data can be made using a ```PATCH``` request to ```safewalk-platform-stack.apiendpoint/admin/platforms/{platformId}```.

A request body may look like the following, however all fields are optional.

```json
{
  "platformName": "Updated Name",
  "redirectUrl": "https://new.url/callback",
  "contactName": "Jane Doe",
  "contactEmail": "jane@partner.app",
  "webhookUrl": "https://new.url/webhook",
  "description": "Updated description",
  "status": "INACTIVE"
}
```

### Platform Data Model
Note the data model used for 3rd party apps.

| Field | Type | Description |
|-------|------|-------------|
| platformId | String | Unique identifier (UUID) |
| platformName | String | Display name of the platform |
| apiKey | String | Secret API key (format: `sw_<32 hex chars>`) |
| apiKeyPrefix | String | First 11 chars for safe display |
| redirectUrl | String | OAuth callback URL |
| contactName | String | Primary contact name |
| contactEmail | String | Primary contact email |
| webhookUrl | String? | Optional webhook URL for events |
| webhookSecret | String | Secret for webhook HMAC signing (format: `swsec_<64 hex chars>`) |
| webhookSecretPrefix | String | First 14 chars for safe display |
| description | String? | Optional description |
| status | String | ACTIVE or INACTIVE |
| createdAt | String | ISO timestamp |
| updatedAt | String | ISO timestamp |

## Platform Usage as a 3rd Party App
The following section describes the interaction with the platform as a 3rd party platform/application.

### Authorization
To authorize all of the requests described in this section, the API Key for the platform needs to be used by setting the header ```x-api-key: <API_Key>```

### Register a User for the Platform
In order to register one of your platform's users for the vendor-independent SW platform, you may send a ```POST``` request to ```safewalk-platform-stack.apiendpoint/register```

The request body may look like this:
```json
{
  "platformUserId": "123456789",
  "email": "user@example.com",
  "name": "John User"
}
```

Note: ```email``` and ```name``` are optional fields.

Expect the following OK-response on successful validation:
```json
{
  "success": true,
  "data": {
    "safeWalkId": "12345678-1234-1234-1234-1234abcd1234"
  }
}
```

Store the ```safeWalkId``` securely. It is required for all subsequent operations concerning this user (e.g. generating sharing codes and creating trusted contacts).

### Generate a Sharing Code
Sharing codes are temporary 6-character codes that allow other users to add your user as a trusted contact. Each code is valid for **24 hours**. Generating a new code automatically invalidates any previously active code for the same user.

To generate a sharing code, send a ```POST``` request to ```safewalk-platform-stack.apiendpoint/sharing-codes```

The request body:
```json
{
  "safeWalkId": "12345678-1234-1234-1234-1234abcd1234"
}
```

Expect the following response:
```json
{
  "success": true,
  "data": {
    "sharingCode": "ABCDEF",
    "safeWalkId": "12345678-1234-1234-1234-1234abcd1234",
    "createdAt": "2026-02-21T12:00:00.000Z",
    "expiresAt": "2026-02-22T12:00:00.000Z"
  }
}
```

The sharing code shall be forwarded to the end-user so they can share it with their contacts to facilitate trusted contact requests via their respective platforms. This sharing code can only be processed by SafeWalk.

NOTE: Each new code generation replaces the previous one. Only the most recent code is valid.

### Create a Trusted Contact
To add a trusted contact relationship for one of your users, send a ```POST``` request to ```safewalk-platform-stack.apiendpoint/contacts```

Headers:
- `Content-Type: application/json`
- `x-api-key: <your-platform-api-key>`

The request body supports two shapes.

1) Sharing-code connect (existing flow):
```json
{
  "requesterSafeWalkId": "12345678-1234-1234-1234-1234abcd1234",
  "sharingCode": "ABCDEF"
}
```

2) Reverse connect / share-back without sharing code:
```json
{
  "requesterSafeWalkId": "12345678-1234-1234-1234-1234abcd1234",
  "targetSafeWalkId": "98765432-9876-9876-9876-9876fedc9876"
}
```

Expect the following response on successful creation:
```json
{
  "success": true,
  "data": {
    "contactId": "87654321-4321-4321-4321-4321dcba4321",
    "requesterSafeWalkId": "12345678-1234-1234-1234-1234abcd1234",
    "targetSafeWalkId": "98765432-9876-9876-9876-9876fedc9876",
    "status": "ACTIVE",
    "createdAt": "2026-02-21T..."
  }
}
```

The `requesterSafeWalkId` is the SafeWalk ID of your user who wants to add a contact.
Use `sharingCode` for code-based connect, or `targetSafeWalkId` for reverse connect when a trusted-contact link is created from the other side and your user wants to share back location/SOS without exchanging a new sharing code.

Possible error responses:
- **404 Not Found** – The sharing code does not match any user.
- **404 Not Found** – The target `safeWalkId` does not exist.
- **410 Gone** – The sharing code has expired. The target user must generate a new one.
- **400 Validation Error** – A user cannot add themselves as a trusted contact.
- **409 Conflict** – This trusted contact relationship already exists.

### List Trusted Contacts
To retrieve all active trusted contacts for a user, send a ```GET``` request to ```safewalk-platform-stack.apiendpoint/contacts/{safeWalkId}```

Replace `{safeWalkId}` with the user's SafeWalk ID.

Expect the following response:
```json
{
  "success": true,
  "data": {
    "contacts": [
      {
        "contactId": "87654321-4321-4321-4321-4321dcba4321",
        "requesterSafeWalkId": "12345678-1234-1234-1234-1234abcd1234",
        "targetSafeWalkId": "98765432-9876-9876-9876-9876fedc9876",
        "platformId": "abcd1234-0000-0000-0000-abcd1234abcd",
        "webhookUrl": "https://partner.app/webhook",
        "status": "ACTIVE",
        "createdAt": "2026-02-21T...",
        "updatedAt": "2026-02-21T...",
        "direction": "outgoing"
      },
      {
        "contactId": "11111111-1111-1111-1111-111111111111",
        "requesterSafeWalkId": "98765432-9876-9876-9876-9876fedc9876",
        "targetSafeWalkId": "12345678-1234-1234-1234-1234abcd1234",
        "platformId": "abcd1234-0000-0000-0000-abcd1234abcd",
        "webhookUrl": "https://partner.app/webhook",
        "status": "ACTIVE",
        "createdAt": "2026-02-20T...",
        "updatedAt": "2026-02-20T...",
        "direction": "incoming"
      }
    ],
    "count": 2
  }
}
```

The `direction` field indicates whether the user initiated the contact relationship (`outgoing` -> receives SOS-alarms) or received it (`incoming` -> sends SOS alarms to trusted contact).

### Revoke a Trusted Contact
To revoke/remove a trusted contact relationship, send a ```DELETE``` request to ```safewalk-platform-stack.apiendpoint/contacts/{contactId}```

Replace `{contactId}` with the ID of the contact relationship you want to revoke.

Expect the following response:
```json
{
  "success": true,
  "data": {
    "contactId": "87654321-4321-4321-4321-4321dcba4321",
    "status": "REVOKED"
  }
}
```

Note: You can only revoke contacts that were created by your platform. Attempting to revoke a contact from another platform will result in a 403 Forbidden error. 

### SOS Events
The SOS feature enables users to trigger emergency alerts that are forwarded to their trusted contacts' platforms via webhooks. Trusted contacts with `sosSharing: true` are automatically resolved and their companion platforms are notified.

#### Trigger an SOS
To trigger a new SOS event, send a `POST` request to `safewalk-platform-stack.apiendpoint/sos`

```json
{
  "safeWalkId": "12345678-1234-1234-1234-1234abcd1234",
  "geoLocation": {
    "lat": 48.8566,
    "lng": 2.3522,
    "accuracy": 10
  }
}
```

Response:
```json
{
  "success": true,
  "data": {
    "sosId": "sos-uuid",
    "status": "ACTIVE",
    "contactsNotified": 3,
    "createdAt": "2026-04-15T..."
  }
}
```

Notes:
- If the user already has an active SOS, it will be superseded and trusted contacts will be notified afresh.
- The `accuracy` field is optional (meters).
- SOS records are automatically deleted after **30 days** (GDPR compliance via DynamoDB TTL).

#### Update SOS Location
To send a location update for an active SOS, send a `PATCH` request to `safewalk-platform-stack.apiendpoint/sos/{sosId}`

```json
{
  "geoLocation": {
    "lat": 48.8584,
    "lng": 2.2945,
    "accuracy": 5
  }
}
```

Response:
```json
{
  "success": true,
  "data": {
    "sosId": "sos-uuid",
    "status": "ACTIVE",
    "contactsNotified": 3,
    "latestGeoLocation": { "lat": 48.8584, "lng": 2.2945, "accuracy": 5 },
    "updatedAt": "2026-04-15T..."
  }
}
```

Location updates trigger `SOS_LOCATION_UPDATE` webhooks (NOT `SOS_CREATED`). Each location update is persisted in a separate audit table for full location history.

#### Cancel an SOS
To cancel an active SOS, send a `DELETE` request to `safewalk-platform-stack.apiendpoint/sos/{sosId}`

Response:
```json
{
  "success": true,
  "data": {
    "sosId": "sos-uuid",
    "status": "CANCELLED",
    "contactsNotified": 3,
    "updatedAt": "2026-04-15T..."
  }
}
```

Cancellations trigger `SOS_CANCELLED` webhooks to all trusted contacts' platforms.

#### Webhook Payload
Companion platforms receive signed webhook payloads at their configured `webhookUrl`. There are three event types:

| Event | Description |
|-------|-------------|
| `SOS_CREATED` | New SOS triggered — includes geo location |
| `SOS_LOCATION_UPDATE` | Location update for active SOS — includes updated geo location |
| `SOS_CANCELLED` | SOS cancelled — no geo location |

Payload structure:
```json
{
  "type": "SOS_CREATED",
  "sosId": "sos-uuid",
  "timestamp": "2026-04-15T...",
  "victim": {
    "safeWalkId": "victim-safewalk-id",
    "platformId": "victim-platform-id",
    "platformUserId": "victim-platform-user-id",
    "displayName": "Victim Name"
  },
  "targets": [
    {
      "safeWalkId": "target-safewalk-id",
      "platformId": "your-platform-id",
      "platformUserId": "target-platform-user-id"
    }
  ],
  "geoLocation": {
    "lat": 48.8566,
    "lng": 2.3522,
    "accuracy": 10,
    "timestamp": "2026-04-15T..."
  }
}
```

The `targets` array is filtered to only include users belonging to the receiving platform. The `geoLocation` field is omitted on `SOS_CANCELLED` events.

#### Webhook Signature Verification
Each webhook request includes HMAC-SHA256 signatures for authenticity verification. Use the `webhookSecret` provided at platform registration to verify.

Headers:
- `X-SafeWalk-Signature`: `sha256=<hex digest>`
- `X-SafeWalk-Timestamp`: ISO 8601 timestamp
- `X-SafeWalk-Event`: Event type (`SOS_CREATED`, `SOS_LOCATION_UPDATE`, `SOS_CANCELLED`)

To verify:
1. Concatenate `<X-SafeWalk-Timestamp>.<raw request body>` (with a dot separator)
2. Compute HMAC-SHA256 using your `webhookSecret`
3. Compare the hex digest with the value after `sha256=` in `X-SafeWalk-Signature`

Example (Node.js):
```js
const crypto = require('crypto');

function verifyWebhook(body, timestamp, signature, secret) {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return signature === `sha256=${expected}`;
}
```

#### Regenerate Webhook Secret
If your webhook secret is compromised, an admin can regenerate it by sending a `POST` request to `safewalk-platform-stack.apiendpoint/admin/platforms/{platformId}/regenerate-webhook-secret`

The new secret is returned once and will not be shown again.

#### SOS Data Model

| Field | Type | Description |
|-------|------|-------------|
| sosId | String | Unique identifier (UUID) |
| victimSafeWalkId | String | SafeWalk ID of the user in distress |
| victimPlatformId | String | Platform ID of the victim's platform |
| victimPlatformUserId | String | Platform-specific user ID of the victim |
| victimDisplayName | String | Display name of the victim |
| status | String | ACTIVE, CANCELLED, or SUPERSEDED |
| latestGeoLocation | Object | Most recent geo location `{ lat, lng, accuracy? }` |
| createdAt | String | ISO timestamp |
| updatedAt | String | ISO timestamp |
| ttl | Number | Unix epoch for GDPR auto-deletion (30 days) |
