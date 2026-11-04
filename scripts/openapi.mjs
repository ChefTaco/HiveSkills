// Route inventory from the owning API source; full request/response schemas remain pending.
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
for (const [path, method, schema] of [
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
