// Product-owned route inventory and browser request/response contracts.
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';
import { z } from 'zod';
import { browserSchemas } from '../dist/browser-contracts.js';
const source = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile(
  'app.ts',
  source,
  ts.ScriptTarget.Latest,
  true,
);
const paths = {};
function visit(node) {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.expression.getText(tree) === 'app'
  ) {
    const method = node.expression.name.text;
    const arg = node.arguments[0];
    if (
      ['get', 'post', 'patch', 'put', 'delete'].includes(method) &&
      arg &&
      ts.isStringLiteral(arg)
    ) {
      const path = arg.text.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');
      const parameters = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
        name: match[1],
        in: 'path',
        required: true,
        schema: { type: 'string' },
      }));
      paths[path] ??= {};
      paths[path][method] = {
        summary: method.toUpperCase() + ' ' + path,
        ...(parameters.length ? { parameters } : {}),
        ...(path.startsWith('/admin/')
          ? { security: [{ resourceBearer: [] }, { nativeSession: [] }] }
          : {}),
        responses: {
          200: {
            description: 'Success; see the native API reference for payloads',
          },
          401: { description: 'Authentication required' },
          403: { description: 'Permission denied' },
          ...(path.startsWith('/admin/deployments') && method !== 'get'
            ? {
                503: {
                  description:
                    'Browser execution requires the Magnus job adapter',
                },
              }
            : {}),
        },
      };
    }
  }
  ts.forEachChild(node, visit);
}
visit(tree);
for (const [path, schema] of [
  ['/admin/skills', 'Skill'],
  ['/admin/skills/{slug}/releases', 'Release'],
  ['/admin/channels', 'Channel'],
  ['/admin/targets', 'Target'],
  ['/admin/audit', 'Audit'],
  ['/admin/receipts', 'Receipt'],
  ['/admin/deployments', 'DeploymentJob'],
]) {
  paths[path].get.responses[200] = {
    description: 'Authorized product records',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: { $ref: '#/components/schemas/' + schema },
        },
      },
    },
  };
}
for(const [path,method,schema] of [['/admin/deployments/{target}','post','ManagedDeployment'],['/admin/deployments/jobs/{id}','get','ManagedDeployment'],['/admin/deployments/jobs/{id}/approve','post','ManagedDeployment'],['/admin/deployments/jobs/{id}/reconcile','post','ManagedDeployment'],['/admin/deployments/capabilities','get','DeploymentCapabilities']]){paths[path][method].responses[200]={description:'Owned deployment state',content:{'application/json':{schema:{$ref:'#/components/schemas/'+schema}}}};}
for (const [path, method, schema] of [
  ['/admin/deployments/jobs/{id}/approve','post','DeploymentApproval'],
  ['/admin/skills', 'post', 'CreateSkill'],
  ['/admin/skills/{slug}/releases', 'post', 'UploadRelease'],
  ['/admin/targets/{target}/enroll', 'post', 'EnrollTarget'],
]) {
  paths[path][method].requestBody = {
    required: true,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/' + schema },
      },
    },
  };
}
for (const [path,method,schema] of [['/admin/skills/{slug}','patch','UpdateSkill'],['/admin/targets/{target}','put','UpdateTarget'],['/admin/channels/{channel}/{slug}','put','PromoteRelease']]) {
  paths[path][method].requestBody={required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/'+schema}}}};
}
for (const [path,method,schema,status] of [['/auth/me','get','AuthMe',200],['/admin/targets/{target}/enroll','post','EnrollmentResponse',201],['/admin/targets/{target}','put','Ok',200],['/admin/channels/{channel}/{slug}','put','Ok',200],['/admin/skills','post','Skill',201],['/admin/skills/{slug}','patch','Skill',200],['/admin/skills/{slug}/releases','post','Release',201]]) {
  paths[path][method].responses[status]={description:'Product-owned browser response',content:{'application/json':{schema:{$ref:'#/components/schemas/'+schema}}}};
}
// Optional, additive list filters; omitting them returns the historical listing.
for (const [path, name, description] of [
  ['/admin/targets', 'nodeId', 'Only targets bound to exactly this Magnus node id'],
  ['/admin/receipts', 'targetId', 'Only receipts for exactly this deployment target name'],
]) {
  paths[path].get.parameters = [{ name, in: 'query', required: false, description, schema: { type: 'string' } }];
  paths[path].get.responses[400] = { description: 'Invalid filter' };
}
// HiveEvent v1 feed for the HiveXUI inbox: registry administrators only, oldest first.
paths['/v1/hive/events'].get = {
  summary: 'HiveEvent v1 feed of deployment outcomes, agent restart failures and skill release changes',
  description:
    'Events from the last 14 days, oldest first by (occurredAt, id). Pass nextCursor as after to read on; a null nextCursor means caught up.',
  security: [{ resourceBearer: [] }, { nativeSession: [] }],
  parameters: [
    { name: 'after', in: 'query', required: false, description: 'Cursor from a previous page', schema: { type: 'string' } },
    { name: 'limit', in: 'query', required: false, description: 'Page size, 1 to 200 (default 50; larger values are capped)', schema: { type: 'integer', minimum: 1 } },
  ],
  responses: {
    200: { description: 'A page of HiveEvents', content: { 'application/json': { schema: { $ref: '#/components/schemas/HiveEventPage' } } } },
    400: { description: 'Invalid cursor or limit' },
    401: { description: 'Authentication required' },
    403: { description: 'Registry administrator access required' },
  },
};
// Suite audit export (HiveAuditRecord v1) for Cindertrace: every stored audit row, oldest first by id.
paths['/v1/audit/export'].get = {
  summary: 'HiveAuditRecord v1 export of the registry audit log',
  description:
    'Every stored audit record, oldest first by id, with no retention window. nextCursor is the cursor of the last record, even on the final page; poll it again later. A null nextCursor (empty data) means caught up. Oathweave service (client-credentials) tokens need hiveskills:audit:read; registry administrators are also accepted.',
  security: [{ resourceBearer: [] }, { nativeSession: [] }],
  parameters: [
    { name: 'after', in: 'query', required: false, description: 'Opaque cursor from a previous page', schema: { type: 'string' } },
    { name: 'limit', in: 'query', required: false, description: 'Page size, 1 to 200 (default 100; larger values are capped)', schema: { type: 'integer', minimum: 1 } },
  ],
  responses: {
    200: { description: 'A page of HiveAuditRecords', content: { 'application/json': { schema: { $ref: '#/components/schemas/HiveAuditPage' } } } },
    400: { description: 'Invalid cursor or limit' },
    401: { description: 'Authentication required' },
    403: { description: 'hiveskills:audit:read or registry administrator access required' },
  },
};
// Pinned releases (capability skills.pinned-release.v1): any immutable release of an enabled skill by
// exact version. Readers are enrolled targets (?target= plus the target bearer token, limited to the
// target's skill allowlist) or registry administrators; the channel-promoted archive stays public.
const pinnedParameters = [
  { name: 'slug', in: 'path', required: true, schema: { type: 'string' } },
  { name: 'version', in: 'path', required: true, schema: { type: 'string' } },
  { name: 'target', in: 'query', required: false, description: 'Enrolled target name; send its enrollment token as the bearer token', schema: { type: 'string' } },
];
paths['/v1/skills/{slug}/releases/{version}'].get = {
  summary: 'Metadata of one immutable release by exact version, promoted or not',
  description:
    'Digest, archive size, Hermes compatibility and the channels this version is promoted on. Requires an enrolled target (assigned the skill) or a registry administrator.',
  security: [{ targetToken: [] }, { resourceBearer: [] }, { nativeSession: [] }],
  parameters: pinnedParameters,
  responses: {
    200: { description: 'The release', content: { 'application/json': { schema: { $ref: '#/components/schemas/PinnedRelease' } } } },
    401: { description: 'Target enrollment or sign-in required' },
    403: { description: 'Registry administrator access, or a target assigned this skill, required' },
    404: { description: 'No such release of an enabled skill' },
  },
};
paths['/v1/skills/{slug}/releases/{version}/archive'].get = {
  summary: 'Skill release archive with its SHA-256 digest',
  description:
    'The release promoted on the requested channel (default stable) is public. Any other immutable release of an enabled skill needs an enrolled target (assigned the skill) or a registry administrator; anonymous callers get 404 for it. The stored bytes are checked against the release digest before they are served; X-Content-SHA256 carries that digest.',
  security: [{}, { targetToken: [] }, { resourceBearer: [] }, { nativeSession: [] }],
  parameters: [...pinnedParameters, { name: 'channel', in: 'query', required: false, description: 'stable (default) or canary; selects the public promoted release', schema: { type: 'string', enum: ['stable', 'canary'] } }],
  responses: {
    200: {
      description: 'The archive bytes',
      headers: { 'X-Content-SHA256': { description: 'SHA-256 of the archive, equal to the release digest', schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } } },
      content: { 'application/gzip': { schema: { type: 'string', format: 'binary' } } },
    },
    400: { description: 'Invalid channel' },
    401: { description: 'Target enrollment or sign-in required' },
    403: { description: 'Registry administrator access, or a target assigned this skill, required' },
    404: { description: 'Not the promoted release (anonymous), or no such release or archive' },
    500: { description: 'The stored archive no longer matches the release digest' },
  },
};
// Signed revocation lists (capability skills.revocations.v1) and the transparency log
// (skills.transparency-log.v1). Readers are enrolled targets (?target= plus the target bearer token)
// or registry administrators.
const trustReader = [{ targetToken: [] }, { resourceBearer: [] }, { nativeSession: [] }];
const targetParameter = { name: 'target', in: 'query', required: false, description: 'Enrolled target name; send its enrollment token as the bearer token', schema: { type: 'string' } };
const readerErrors = { 401: { description: 'Target enrollment or sign-in required' }, 403: { description: 'Registry administrator access required' } };
paths['/v1/revocations'].get = {
  summary: 'The current signed revocation list',
  description: 'The list with the highest sequence, exactly as a pinned revocation key signed it: payload is the signed JSON string. The Hermes bridge verifies it against HIVE_SKILLS_REVOCATION_KEYS before activation.',
  security: trustReader,
  parameters: [targetParameter],
  responses: { 200: { description: 'The signed list', content: { 'application/json': { schema: { $ref: '#/components/schemas/SignedRevocationList' } } } }, ...readerErrors, 404: { description: 'No revocation list has been published (revocations_unpublished)' } },
};
paths['/admin/revocations'].put = {
  summary: 'Publish a newer signed revocation list',
  description: 'The payload must be signed by a key in HIVE_SKILLS_REVOCATION_KEYS, valid, unexpired and of a higher sequence than the current list. Revoked releases are withdrawn from their channels; revoked publisher keys can no longer sign releases. The list is appended to the transparency log.',
  security: [{ resourceBearer: [] }, { nativeSession: [] }],
  requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/PublishRevocations' } } } },
  responses: {
    201: { description: 'Published', content: { 'application/json': { schema: { $ref: '#/components/schemas/RevocationsPublished' } } } },
    400: { description: 'Invalid, unverifiable or expired list' },
    401: { description: 'Authentication required' },
    403: { description: 'Registry administrator access required' },
    409: { description: 'The sequence is not above the current list' },
    413: { description: 'Request body is too large' },
    503: { description: 'HIVE_SKILLS_REVOCATION_KEYS is not configured (revocation_keys_unconfigured)' },
  },
};
paths['/v1/transparency/head'].get = {
  summary: 'The signed head of the transparency log',
  description: 'Size, hash of the last entry (64 zeros when empty) and the log public key; signature is Ed25519 over "hiveskills-transparency-head-v1\\n<size>\\n<headHash>\\n".',
  security: trustReader,
  parameters: [targetParameter],
  responses: { 200: { description: 'The head', content: { 'application/json': { schema: { $ref: '#/components/schemas/TransparencyHead' } } } }, ...readerErrors },
};
paths['/v1/transparency/entries'].get = {
  summary: 'Transparency log entries, oldest first',
  description: 'Entries from index from on. Each entry is the exact JSON string that was hashed and signed; verify the whole log with scripts/verify-transparency-log.mjs. nextFrom is null on the last page.',
  security: trustReader,
  parameters: [targetParameter, { name: 'from', in: 'query', required: false, description: 'First index (default 0)', schema: { type: 'integer', minimum: 0 } }, { name: 'limit', in: 'query', required: false, description: 'Page size, 1 to 500 (default 100)', schema: { type: 'integer', minimum: 1, maximum: 500 } }],
  responses: { 200: { description: 'A page of entries', content: { 'application/json': { schema: { $ref: '#/components/schemas/TransparencyEntries' } } } }, 400: { description: 'Invalid page' }, ...readerErrors },
};
paths['/admin/signatures'].get.summary = 'Publisher keys, release signature status, revocations and the log head';
paths['/admin/signatures'].get.responses[200] = { description: 'The signature overview', content: { 'application/json': { schema: { $ref: '#/components/schemas/SignatureOverview' } } } };
// The standalone web UI is retired: / only points browsers to HiveXUI.
paths['/'].get = {
  summary: 'Retired web UI: HiveXUI stub page or redirect',
  description:
    'HiveXUI is the UI. Without HIVEXUI_URL this returns a static HTML page pointing to HiveXUI; with HIVEXUI_URL it redirects there.',
  responses: {
    200: { description: 'Stub page (HIVEXUI_URL unset)', content: { 'text/html': { schema: { type: 'string' } } } },
    302: { description: 'Redirect to HIVEXUI_URL', headers: { Location: { schema: { type: 'string', format: 'uri' } } } },
  },
};
const version = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
const spec = {
  openapi: '3.1.0',
  info: {
    title: 'HiveSkills API route inventory',
    version,
    description:
      'Owned route inventory. Request/response schema completeness is an open acceptance gate.',
  },
  servers: [{ url: 'https://skills.example.com' }],
  paths,
  components: {
    schemas: Object.fromEntries(
      Object.entries(browserSchemas).map(([name, schema]) => [
        name,
        z.toJSONSchema(schema),
      ]),
    ),
    securitySchemes: {
      resourceBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      nativeSession: {
        type: 'apiKey',
        in: 'cookie',
        name: 'hive_skills_session',
      },
      targetToken: { type: 'http', scheme: 'bearer', description: 'Target enrollment token, sent with ?target=<name>' },
    },
  },
};
const expected =
  JSON.stringify(
    spec,
    (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          )
        : value,
    2,
  ) + '\n';
const file = new URL('../docs/openapi.json', import.meta.url);
if (process.argv.includes('--write')) writeFileSync(file, expected);
else if (readFileSync(file, 'utf8') !== expected)
  throw new Error('OpenAPI route drift: run npm run generate:openapi');
else console.log('HiveSkills API route inventory is current');
