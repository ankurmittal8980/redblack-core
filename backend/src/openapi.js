const workspace = '/api/v1/workspaces/{workspaceId}';

const protectedGet = summary => ({ get: { summary, security: [{ cookieSession: [] }], parameters: [{ $ref: '#/components/parameters/workspaceId' }], responses: { '200': { description: 'Workspace-scoped result' }, '401': { $ref: '#/components/responses/Unauthorized' }, '403': { $ref: '#/components/responses/Forbidden' } } } });
const protectedWrite = (summary, method = 'post') => ({ [method]: { summary, security: [{ cookieSession: [] }, { csrfToken: [] }], parameters: [{ $ref: '#/components/parameters/workspaceId' }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } }, responses: { '200': { description: 'Saved' }, '201': { description: 'Created' }, '400': { description: 'Invalid input' }, '401': { $ref: '#/components/responses/Unauthorized' }, '403': { $ref: '#/components/responses/Forbidden' } } } });

export const OPENAPI_SPEC = Object.freeze({
  openapi: '3.1.0',
  info: { title: 'RedBlack Core API', version: '1.0.0', description: 'Workspace-scoped CRM, operations, communications and usage endpoints.' },
  servers: [{ url: '/' }],
  tags: [
    { name: 'Authentication' }, { name: 'Workspace' }, { name: 'CRM' }, { name: 'Operations' },
    { name: 'Communications' }, { name: 'Automation' }, { name: 'Usage and reporting' }
  ],
  paths: {
    '/health/live': { get: { summary: 'Process liveness', responses: { '200': { description: 'Process is running' } } } },
    '/health/ready': { get: { summary: 'Database readiness', responses: { '200': { description: 'Database is reachable' }, '500': { description: 'Database unavailable' } } } },
    '/api/v1/openapi.json': { get: { summary: 'OpenAPI contract', responses: { '200': { description: 'OpenAPI 3.1 document' } } } },
    '/api/v1/auth/bootstrap': { post: { tags: ['Authentication'], summary: 'Create the first owner and workspace', parameters: [{ name: 'X-Bootstrap-Token', in: 'header', required: true, schema: { type: 'string' } }], responses: { '201': { description: 'Owner created and signed in' }, '409': { description: 'Already initialized' } } } },
    '/api/v1/auth/login': { post: { tags: ['Authentication'], summary: 'Sign in with email and password', responses: { '200': { description: 'Session created' }, '401': { description: 'Invalid credentials' }, '409': { description: 'Select a workspace' } } } },
    '/api/v1/auth/me': { get: { tags: ['Authentication'], summary: 'Current identity and workspace', security: [{ cookieSession: [] }], responses: { '200': { description: 'Current identity' } } } },
    '/api/v1/workspaces': { get: { tags: ['Workspace'], summary: 'List accessible workspaces', security: [{ cookieSession: [] }], responses: { '200': { description: 'Workspace memberships' } } }, post: protectedWrite('Create a workspace') },
    [`${workspace}/leads`]: { ...protectedGet('List workspace leads'), ...protectedWrite('Create a lead') },
    [`${workspace}/leads/import`]: protectedWrite('Import leads from CSV text'),
    [`${workspace}/leads/export`]: protectedGet('Export visible leads as CSV'),
    [`${workspace}/leads/trash`]: protectedGet('List trashed leads'),
    [`${workspace}/leads/bulk`]: protectedWrite('Bulk trash, restore, status or owner update'),
    [`${workspace}/leads/{leadId}/restore`]: protectedWrite('Restore a trashed lead'),
    [`${workspace}/leads/{leadId}/permanent`]: protectedWrite('Permanently delete a trashed lead', 'delete'),
    [`${workspace}/leads/{leadId}`]: { get: { summary: 'Read a lead and timeline', security: [{ cookieSession: [] }], parameters: [{ $ref: '#/components/parameters/workspaceId' }, { name: 'leadId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Lead record' }, '404': { description: 'Not found in this workspace' } } }, patch: protectedWrite('Update a lead', 'patch') },
    [`${workspace}/pipelines`]: { ...protectedGet('List pipelines and stages'), ...protectedWrite('Create a pipeline') },
    [`${workspace}/pipelines/{pipelineId}`]: { patch: protectedWrite('Update a pipeline', 'patch') },
    [`${workspace}/pipelines/{pipelineId}/stages`]: protectedWrite('Create a pipeline stage'),
    [`${workspace}/pipelines/{pipelineId}/stages/{stageId}`]: { patch: protectedWrite('Update a pipeline stage', 'patch') },
    [`${workspace}/leads/{leadId}/stage`]: protectedWrite('Move a lead to a pipeline stage'),
    [`${workspace}/lead-sources`]: { ...protectedGet('List lead sources'), ...protectedWrite('Create a lead source') },
    [`${workspace}/task-types`]: { ...protectedGet('List task types'), ...protectedWrite('Create a task type') },
    [`${workspace}/assignment-rules`]: { ...protectedGet('List assignment rules'), ...protectedWrite('Create an assignment rule') },
    [`${workspace}/scoring-rules`]: { ...protectedGet('List scoring rules'), ...protectedWrite('Create a scoring rule') },
    [`${workspace}/saved-views`]: { ...protectedGet('List saved CRM views'), ...protectedWrite('Create a saved CRM view') },
    [`${workspace}/layouts`]: { ...protectedGet('List CRM layouts'), ...protectedWrite('Create a CRM layout') },
    [`${workspace}/custom-fields`]: { ...protectedGet('List custom field definitions'), ...protectedWrite('Create a custom field') },
    [`${workspace}/custom-fields/{fieldId}`]: { patch: protectedWrite('Update custom field settings', 'patch') },
    [`${workspace}/tags`]: { ...protectedGet('List tags'), ...protectedWrite('Create a tag') },
    [`${workspace}/tags/{tagId}`]: { patch: protectedWrite('Rename a tag', 'patch') },
    [`${workspace}/tasks`]: { ...protectedGet('List tasks'), ...protectedWrite('Create a task') },
    [`${workspace}/tasks/{taskId}`]: { patch: protectedWrite('Update or complete a task', 'patch') },
    [`${workspace}/activities`]: { ...protectedGet('List activities'), ...protectedWrite('Create an activity') },
    [`${workspace}/meetings`]: { ...protectedGet('List meetings'), ...protectedWrite('Create a meeting') },
    [`${workspace}/meetings/{meetingId}`]: { patch: protectedWrite('Update meeting status or schedule', 'patch') },
    [`${workspace}/communications/providers`]: { ...protectedGet('List provider adapters'), ...protectedWrite('Configure an adapter') },
    [`${workspace}/communications/messages`]: { ...protectedGet('List messages'), ...protectedWrite('Create or send a message') },
    [`${workspace}/communications/consent`]: { ...protectedGet('Read consent preferences'), ...protectedWrite('Update consent preferences', 'patch') },
    [`${workspace}/calls`]: { ...protectedGet('List calls'), ...protectedWrite('Create a call record') },
    [`${workspace}/automations`]: { ...protectedGet('List automations'), ...protectedWrite('Create a versioned automation') },
    [`${workspace}/automations/{automationId}`]: { ...protectedGet('Read automation definition'), patch: protectedWrite('Publish a new automation version', 'patch'), post: protectedWrite('Queue an automation run') },
    [`${workspace}/automations/{automationId}/runs`]: protectedGet('List automation runs'),
    [`${workspace}/automations/{automationId}/runs/{runId}`]: protectedGet('Read automation run and step history'),
    [`${workspace}/automations/{automationId}/test`]: protectedWrite('Queue an automation test run'),
    [`${workspace}/usage`]: protectedGet('List metered usage'),
    [`${workspace}/usage/estimate`]: protectedWrite('Estimate PAYG provider cost'),
    [`${workspace}/usage/rates`]: { ...protectedGet('List rate versions'), ...protectedWrite('Publish a rate version') },
    [`${workspace}/reports/dashboard`]: protectedGet('Dashboard summary'),
    [`${workspace}/reports/sales`]: protectedGet('Sales report'),
    [`${workspace}/reports/agents`]: protectedGet('Agent activity report'),
    [`${workspace}/reports/sources`]: protectedGet('Lead source report'),
    [`${workspace}/audit`]: protectedGet('Audit events'),
    '/api/v1/webhooks/{provider}/calls': { post: { tags: ['Communications'], summary: 'Receive a signed call status event', parameters: [{ name: 'X-RedBlack-Timestamp', in: 'header', required: true, schema: { type: 'string' } }, { name: 'X-RedBlack-Signature', in: 'header', required: true, schema: { type: 'string' } }], responses: { '202': { description: 'Event accepted or replay recognized' }, '401': { description: 'Signature invalid or expired' } } } },
    '/api/v1/webhooks/{provider}/messages': { post: { tags: ['Communications'], summary: 'Receive a signed message status event', responses: { '202': { description: 'Event accepted or replay recognized' }, '401': { description: 'Signature invalid or expired' } } } }
  },
  components: {
    securitySchemes: {
      cookieSession: { type: 'apiKey', in: 'cookie', name: 'rb_session' },
      csrfToken: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token' }
    },
    parameters: { workspaceId: { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } } },
    responses: {
      Unauthorized: { description: 'Sign in required' },
      Forbidden: { description: 'Workspace role does not grant this action' }
    }
  }
});

