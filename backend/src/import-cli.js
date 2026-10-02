import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, transaction, closeDatabase } from './db.js';
import { parseCsv } from './csv.js';
import { mapLegacyLead, normalizeLegacyStatus, parseLegacyDate } from './legacy-map.js';
import { uuid } from './validation.js';

const BATCH_SIZE = 300;
const LEAD_SOURCE = 'google-sheet:LEADS';
const TASK_SOURCE = 'google-sheet:TASKS';

function field(record, names) {
  const entries = Object.keys(record.values);
  for (const name of names) {
    const key = entries.find(item => item.trim().toLowerCase() === name.toLowerCase());
    if (key !== undefined) return record.values[key];
  }
  return '';
}

function csvInput(file, requiredHeaders = []) {
  return readFile(file, 'utf8').then(text => {
    const parsed = parseCsv(text);
    const headers = new Set(parsed.headers.map(value => value.trim().toLowerCase()));
    const missing = requiredHeaders.filter(value => !headers.has(value.toLowerCase()));
    if (missing.length) throw new Error(`${path.basename(file)} is missing required headers: ${missing.join(', ')}.`);
    return { ...parsed, bytes: Buffer.from(text, 'utf8') };
  });
}

function sourceId(value, rowNumber) {
  const result = String(value ?? '').trim();
  return result || `row:${rowNumber}`;
}

function pipelineSlugFor(lead) {
  const text = `${lead.sourceName ?? ''} ${lead.migrationPayload['Brand / Project Name'] ?? ''} ${lead.migrationPayload['Opportunity Type'] ?? ''}`.toLowerCase();
  if (/realty|goa|dubai|dholera|property/.test(text)) return 'realty';
  if (/redblack tech|digital|marketing|website|automation|software/.test(text)) return 'redblack-tech';
  return 'franchise';
}

function normalizeTaskStatus(value) {
  const status = String(value ?? '').trim().toLowerCase();
  if (['completed', 'complete', 'done', 'closed'].includes(status)) return 'completed';
  if (['cancelled', 'canceled', 'dropped'].includes(status)) return 'cancelled';
  if (['in progress', 'in_progress', 'started'].includes(status)) return 'in_progress';
  return 'pending';
}

function legacyMeetingStatus(value) {
  const status = String(value ?? '').trim();
  if (!status) return 'scheduled';
  if (status.length > 80) return status.slice(0, 80);
  return status;
}

function meetingKey(leadSourceId, eventId, startsAt, sheetRow = '') {
  if (eventId) return `calendar-event:${eventId}`;
  if (leadSourceId && startsAt) return `lead:${leadSourceId}:meeting:${startsAt}`;
  return `calendar-row:${sheetRow}`;
}

async function bulk(client, sql, workspaceId, rows) {
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const part = rows.slice(offset, offset + BATCH_SIZE);
    await client.query(sql, [workspaceId, JSON.stringify(part)]);
  }
}

async function insertErrors(client, batchId, errors) {
  const values = errors.map(item => ({ sheet: item.sheet, row: item.rowNumber, source_id: item.sourceId ?? null, code: item.code, detail: { message: item.message } }));
  for (let offset = 0; offset < values.length; offset += BATCH_SIZE) {
    await client.query(
      `INSERT INTO import_row_errors(import_batch_id,source_sheet,source_row,source_id,error_code,detail)
       SELECT $1,x.sheet,x.row,x.source_id,x.code,x.detail FROM jsonb_to_recordset($2::jsonb) AS x(sheet text,row integer,source_id text,code text,detail jsonb)
       ON CONFLICT(import_batch_id,source_sheet,source_row) DO UPDATE SET source_id=EXCLUDED.source_id,error_code=EXCLUDED.error_code,detail=EXCLUDED.detail`,
      [batchId, JSON.stringify(values.slice(offset, offset + BATCH_SIZE))]
    );
  }
}

async function upsertExternalMappings(client, workspaceId, batchId, records) {
  const rows = records.map(item => ({ source_system: 'google-sheet', entity_type: item.entityType, source_id: item.sourceId, target_id: item.targetId }));
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    await client.query(
      `INSERT INTO external_id_mappings(workspace_id,import_batch_id,source_system,entity_type,source_id,target_id)
       SELECT $1,$2,x.source_system,x.entity_type,x.source_id,x.target_id FROM jsonb_to_recordset($3::jsonb) AS x(source_system text,entity_type text,source_id text,target_id uuid)
       ON CONFLICT(workspace_id,source_system,entity_type,source_id) DO UPDATE SET import_batch_id=EXCLUDED.import_batch_id,target_id=EXCLUDED.target_id`,
      [workspaceId, batchId, JSON.stringify(rows.slice(offset, offset + BATCH_SIZE))]
    );
  }
}

async function resolvePipelineIds(client, workspaceId) {
  const result = await client.query(
    `SELECT p.id AS pipeline_id,p.slug,s.id AS stage_id,s.slug AS stage_slug
       FROM pipelines p JOIN pipeline_stages s ON s.pipeline_id=p.id
      WHERE p.workspace_id=$1 AND p.slug IN ('franchise','realty','redblack-tech')`, [workspaceId]
  );
  const pipelines = new Map();
  for (const row of result.rows) {
    if (!pipelines.has(row.slug)) pipelines.set(row.slug, { id: row.pipeline_id, stages: new Map() });
    pipelines.get(row.slug).stages.set(row.stage_slug, row.stage_id);
  }
  for (const slug of ['franchise','realty','redblack-tech']) if (!pipelines.has(slug)) throw new Error(`The workspace is missing the ${slug} pipeline. Create the default workspace pipelines before importing.`);
  return pipelines;
}

async function importRows({ db, workspaceId, batchId, leadRows, taskRows, calendarRows, errors }) {
  const counts = { leads: 0, tasks: 0, meetings: 0, activities: 0, possibleDuplicates: 0 };
  const leadSeen = new Set(); const normalizedSeen = new Map();
  const validatedLeads = [];
  for (const record of leadRows.records) {
    const row = leadRows.headers.map(header => record.values[header] ?? '');
    try {
      const lead = mapLegacyLead(row, leadRows.headers);
      lead.sourceId = sourceId(lead.sourceId, record.rowNumber);
      if (leadSeen.has(lead.sourceId)) throw new Error('DUPLICATE_SOURCE_ID: Lead ID is repeated in the source sheet.');
      leadSeen.add(lead.sourceId);
      const contactKey = lead.phoneNormalized ? `phone:${lead.phoneNormalized}` : lead.emailNormalized ? `email:${lead.emailNormalized}` : null;
      if (contactKey && normalizedSeen.has(contactKey)) {
        counts.possibleDuplicates += 1;
        errors.push({ sheet: 'LEADS', rowNumber: record.rowNumber, sourceId: lead.sourceId, code: 'POSSIBLE_DUPLICATE', message: 'Normalized phone/email matches an earlier source row; both records are preserved for review.' });
      }
      if (contactKey) normalizedSeen.set(contactKey, lead.sourceId);
      const brandText = `${lead.migrationPayload['Brand / Project Name'] ?? ''} ${lead.migrationPayload['Opportunity Type'] ?? ''}`.trim();
      validatedLeads.push({ lead, rowNumber: record.rowNumber, pipelineSlug: pipelineSlugFor(lead), brandText });
    } catch (error) {
      errors.push({ sheet: 'LEADS', rowNumber: record.rowNumber, sourceId: sourceId(field(record, ['Lead ID']), record.rowNumber), code: String(error.message).startsWith('DUPLICATE_SOURCE_ID') ? 'DUPLICATE_SOURCE_ID' : 'INVALID_LEAD', message: String(error.message).slice(0, 300) });
    }
  }

  const taskPrepared = []; const taskSeen = new Set(); const pendingCounts = new Map();
  for (const record of taskRows.records) {
    const id = sourceId(field(record, ['Task ID']), record.rowNumber);
    if (taskSeen.has(id)) { errors.push({ sheet: 'TASKS', rowNumber: record.rowNumber, sourceId: id, code: 'DUPLICATE_SOURCE_ID', message: 'Task ID is repeated in the source sheet.' }); continue; }
    taskSeen.add(id);
    const leadSourceId = String(field(record, ['Lead ID']) ?? '').trim();
    const status = normalizeTaskStatus(field(record, ['Status']));
    if (status === 'pending' && leadSourceId) pendingCounts.set(leadSourceId, (pendingCounts.get(leadSourceId) ?? 0) + 1);
    taskPrepared.push({
      sourceId: id, leadSourceId: leadSourceId || null,
      dueAt: parseLegacyDate(field(record, ['Due Date'])), completedAt: parseLegacyDate(field(record, ['Completed At'])),
      taskType: String(field(record, ['Task Type']) ?? '').trim().slice(0, 80) || 'OTHER',
      touchNumber: Number.parseInt(field(record, ['Touch #']), 10), status,
      notes: String(field(record, ['Notes']) ?? '').slice(0, 5000) || null,
      priority: Number.parseInt(field(record, ['Priority']), 10),
      raw: record.values, rowNumber: record.rowNumber
    });
  }
  const pendingSeen = new Set();
  for (const task of taskPrepared) {
    if (task.status !== 'pending' || !task.leadSourceId) { task.importSource = 'legacy'; continue; }
    const leadPendingKey = task.leadSourceId;
    if (pendingCounts.get(leadPendingKey) > 1) {
      if (!pendingSeen.has(leadPendingKey)) { task.importSource = 'legacy'; pendingSeen.add(leadPendingKey); }
      else { task.importSource = 'legacy-overflow'; counts.possibleDuplicates += 1; }
    } else task.importSource = 'legacy';
  }

  const pipelineMaps = await resolvePipelineIds(db, workspaceId);
  const sourceNames = [...new Set(validatedLeads.map(item => item.lead.sourceName).filter(Boolean))];
  const sourceIds = new Map();
  for (const name of sourceNames) {
    const result = await db.query(
      `INSERT INTO lead_sources(workspace_id,name) VALUES($1,$2) ON CONFLICT(workspace_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [workspaceId, name]
    );
    sourceIds.set(name, result.rows[0].id);
  }

  const preparedLeads = validatedLeads.map(({ lead, pipelineSlug }) => ({
    source_id: lead.sourceId,
    first_name: lead.firstName,
    last_name: lead.lastName,
    company_name: null,
    email: lead.email,
    email_normalized: lead.emailNormalized,
    phone: lead.phone,
    phone_normalized: lead.phoneNormalized,
    source_id_ref: sourceIds.get(lead.sourceName) ?? null,
    brand_project: String(lead.migrationPayload['Brand / Project Name'] ?? '').trim() || null,
    opportunity_type: String(lead.migrationPayload['Opportunity Type'] ?? '').trim() || null,
    budget: lead.budget,
    location: null,
    requirement: lead.requirement,
    status: lead.status,
    temperature: lead.temperature,
    score: lead.score,
    notes: lead.notes,
    next_action: String(lead.migrationPayload['Next Action'] ?? '').trim() || null,
    next_action_at: lead.nextActionAt,
    last_contacted_at: parseLegacyDate(lead.migrationPayload['Last Contacted']),
    last_followup_at: lead.nextActionAt,
    meeting_at: lead.meetingAt,
    do_not_contact: lead.doNotContact,
    migration_payload: lead.migrationPayload,
    added_at: lead.addedAt,
    pipeline_id: pipelineMaps.get(pipelineSlug).id,
    stage_id: pipelineMaps.get(pipelineSlug).stages.get(lead.stageSlug) ?? pipelineMaps.get(pipelineSlug).stages.get('new-lead')
  }));

  const leadSql = `WITH incoming AS (
    SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(
      source_id text,first_name text,last_name text,company_name text,email text,email_normalized text,phone text,phone_normalized text,
      source_id_ref uuid,brand_project text,opportunity_type text,budget numeric,location text,requirement text,status text,temperature text,score integer,
      notes text,next_action text,next_action_at timestamptz,last_contacted_at timestamptz,last_followup_at timestamptz,meeting_at timestamptz,
      do_not_contact boolean,migration_payload jsonb,added_at timestamptz,pipeline_id uuid,stage_id uuid)
  )
  INSERT INTO leads(workspace_id,migration_source,migration_source_id,first_name,last_name,company_name,email,email_normalized,phone,phone_normalized,source_id,
    brand_project,opportunity_type,budget,location,requirement,status,temperature,score,notes,next_action,next_action_at,last_contacted_at,last_followup_at,meeting_at,
    do_not_contact,migration_payload,created_at)
  SELECT $1,'google-sheet:LEADS',x.source_id,x.first_name,x.last_name,x.company_name,x.email,x.email_normalized,x.phone,x.phone_normalized,x.source_id_ref,
    x.brand_project,x.opportunity_type,x.budget,x.location,x.requirement,x.status,NULLIF(x.temperature,'')::lead_temperature,x.score,x.notes,x.next_action,
    x.next_action_at,x.last_contacted_at,x.last_followup_at,x.meeting_at,x.do_not_contact,x.migration_payload,COALESCE(x.added_at,now()) FROM incoming x
  ON CONFLICT(workspace_id,migration_source,migration_source_id) DO UPDATE SET first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,
    email=EXCLUDED.email,email_normalized=EXCLUDED.email_normalized,phone=EXCLUDED.phone,phone_normalized=EXCLUDED.phone_normalized,source_id=EXCLUDED.source_id,
    brand_project=EXCLUDED.brand_project,opportunity_type=EXCLUDED.opportunity_type,budget=EXCLUDED.budget,location=EXCLUDED.location,requirement=EXCLUDED.requirement,
    status=EXCLUDED.status,temperature=EXCLUDED.temperature,score=EXCLUDED.score,notes=EXCLUDED.notes,next_action=EXCLUDED.next_action,next_action_at=EXCLUDED.next_action_at,
    last_contacted_at=EXCLUDED.last_contacted_at,last_followup_at=EXCLUDED.last_followup_at,meeting_at=EXCLUDED.meeting_at,do_not_contact=EXCLUDED.do_not_contact,
    migration_payload=EXCLUDED.migration_payload,updated_at=now()`;
  await bulk(db, leadSql, workspaceId, preparedLeads);
  counts.leads = preparedLeads.length;

  const sourceToLead = new Map();
  const sourceIdList = preparedLeads.map(item => item.source_id);
  for (let offset = 0; offset < sourceIdList.length; offset += 1000) {
    const result = await db.query('SELECT migration_source_id,id FROM leads WHERE workspace_id=$1 AND migration_source=$2 AND migration_source_id=ANY($3::text[])', [workspaceId, LEAD_SOURCE, sourceIdList.slice(offset, offset + 1000)]);
    for (const row of result.rows) sourceToLead.set(row.migration_source_id, row.id);
  }

  const pipelineEntries = preparedLeads.map(item => ({ lead_id: sourceToLead.get(item.source_id), pipeline_id: item.pipeline_id, stage_id: item.stage_id }));
  const pipelineSql = `WITH incoming AS (
    SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(lead_id uuid,pipeline_id uuid,stage_id uuid)
  ), existing AS (
    SELECT i.lead_id,i.pipeline_id,i.stage_id,e.current_stage_id AS old_stage_id
      FROM incoming i LEFT JOIN lead_pipeline_entries e ON e.workspace_id=$1 AND e.lead_id=i.lead_id AND e.pipeline_id=i.pipeline_id AND e.is_current
  ), updated AS (
    UPDATE lead_pipeline_entries e SET current_stage_id=x.stage_id,entered_at=now(),exited_at=NULL,is_current=true
      FROM existing x WHERE e.workspace_id=$1 AND e.lead_id=x.lead_id AND e.pipeline_id=x.pipeline_id AND e.is_current AND x.old_stage_id IS DISTINCT FROM x.stage_id
      RETURNING e.lead_id,e.pipeline_id,x.old_stage_id,x.stage_id
  ), inserted AS (
    INSERT INTO lead_pipeline_entries(workspace_id,lead_id,pipeline_id,current_stage_id)
      SELECT $1,x.lead_id,x.pipeline_id,x.stage_id FROM existing x WHERE x.old_stage_id IS NULL
      ON CONFLICT(lead_id,pipeline_id) WHERE is_current DO NOTHING
      RETURNING lead_id,pipeline_id,current_stage_id
  )
  INSERT INTO lead_stage_history(workspace_id,lead_id,pipeline_id,from_stage_id,to_stage_id,metadata)
    SELECT $1,lead_id,pipeline_id,old_stage_id,stage_id,'{"migration":"google-sheet"}'::jsonb FROM updated
    UNION ALL
    SELECT $1,lead_id,pipeline_id,NULL,current_stage_id,'{"migration":"google-sheet"}'::jsonb FROM inserted`;
  await bulk(db, pipelineSql, workspaceId, pipelineEntries);

  const meetingRows = [];
  const activityRows = [];
  for (const { lead, rowNumber } of validatedLeads) {
    const leadId = sourceToLead.get(lead.sourceId);
    const eventId = String(lead.migrationPayload['Calendar Event ID'] ?? '').trim();
    if (lead.meetingAt) meetingRows.push({ lead_id: leadId, source_id: meetingKey(lead.sourceId, eventId, lead.meetingAt), starts_at: lead.meetingAt,
      status: legacyMeetingStatus(lead.migrationPayload['Meeting Status']), event_id: eventId || null,
      payload: { sheet: 'LEADS', rowNumber, calendarEventId: eventId || null, meetingStatus: lead.migrationPayload['Meeting Status'] ?? '' } });
    const lastContact = parseLegacyDate(lead.migrationPayload['Last Contacted']);
    const lastMessage = parseLegacyDate(lead.migrationPayload['Last Message Sent']);
    if (lastContact) activityRows.push({ lead_id: leadId, source_id: `lead:${lead.sourceId}:last-contacted`, type: 'system', title: 'Last contacted (imported)', body: String(lead.migrationPayload['Last Outcome'] ?? ''), occurred_at: lastContact });
    if (lead.notes) activityRows.push({ lead_id: leadId, source_id: `lead:${lead.sourceId}:notes`, type: 'note', title: 'Legacy note (imported)', body: lead.notes, occurred_at: lead.addedAt ?? new Date().toISOString() });
    if (lastMessage) activityRows.push({ lead_id: leadId, source_id: `lead:${lead.sourceId}:last-message`, type: 'whatsapp', title: 'Last message sent (imported)', body: String(lead.migrationPayload['WhatsApp Status'] ?? ''), occurred_at: lastMessage });
  }

  for (const record of calendarRows?.records ?? []) {
    const leadSourceId = String(field(record, ['Lead ID']) ?? '').trim();
    const leadId = sourceToLead.get(leadSourceId);
    const startsAt = parseLegacyDate(field(record, ['Meeting Date','Start Date','Start Time','Date','Starts At']));
    const eventId = String(field(record, ['Calendar Event ID','Event ID','Google Calendar Event ID']) ?? '').trim();
    if (!startsAt) { errors.push({ sheet: 'CALENDAR', rowNumber: record.rowNumber, sourceId: eventId || null, code: 'INVALID_MEETING_DATE', message: 'Calendar row did not have a parseable meeting date.' }); continue; }
    if (!leadId) { errors.push({ sheet: 'CALENDAR', rowNumber: record.rowNumber, sourceId: eventId || null, code: 'UNMATCHED_MEETING_LEAD', message: 'Calendar row could not be matched to an imported Lead ID.' }); continue; }
    meetingRows.push({ lead_id: leadId, source_id: meetingKey(leadSourceId, eventId, startsAt, record.rowNumber), starts_at: startsAt,
      status: legacyMeetingStatus(field(record, ['Meeting Status','Status'])), event_id: eventId || null,
      payload: { sheet: 'CALENDAR', rowNumber: record.rowNumber, source: record.values } });
  }

  await bulk(db,
    `WITH incoming AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(lead_id uuid,source_id text,starts_at timestamptz,status text,event_id text,payload jsonb))
     INSERT INTO meetings(workspace_id,lead_id,starts_at,status,external_provider,external_event_id,migration_source,migration_source_id,migration_payload)
     SELECT $1,lead_id,starts_at,status,CASE WHEN event_id IS NULL THEN NULL ELSE 'google_calendar' END,event_id,'google-sheet',source_id,payload FROM incoming
     ON CONFLICT(workspace_id,migration_source,migration_source_id) DO UPDATE SET lead_id=EXCLUDED.lead_id,starts_at=EXCLUDED.starts_at,status=EXCLUDED.status,
       external_provider=EXCLUDED.external_provider,external_event_id=EXCLUDED.external_event_id,migration_payload=EXCLUDED.migration_payload`, workspaceId, meetingRows);
  counts.meetings = meetingRows.length;

  await bulk(db,
    `WITH incoming AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(lead_id uuid,source_id text,type text,title text,body text,occurred_at timestamptz))
     INSERT INTO activities(workspace_id,lead_id,type,title,body,occurred_at,migration_source,migration_source_id,metadata)
     SELECT $1,lead_id,type,title,body,occurred_at,'google-sheet',source_id,'{"migration":"google-sheet"}'::jsonb FROM incoming
     ON CONFLICT(workspace_id,migration_source,migration_source_id) DO UPDATE SET type=EXCLUDED.type,title=EXCLUDED.title,body=EXCLUDED.body,occurred_at=EXCLUDED.occurred_at`, workspaceId, activityRows);
  counts.activities = activityRows.length;

  const preparedTasks = [];
  for (const task of taskPrepared) {
    if (task.leadSourceId && !sourceToLead.has(task.leadSourceId)) {
      errors.push({ sheet: 'TASKS', rowNumber: task.rowNumber, sourceId: task.sourceId, code: 'UNMATCHED_TASK_LEAD', message: 'Task lead ID did not match an imported lead; task is retained without a lead link.' });
    }
    preparedTasks.push({
      source_id: task.sourceId,
      lead_source_id: task.leadSourceId,
      task_type: task.taskType,
      title: `${task.taskType} follow-up`.slice(0, 240),
      due_at: task.dueAt,
      completed_at: task.completedAt,
      status: task.status,
      priority: Number.isFinite(task.priority) ? Math.max(0, Math.min(task.priority, 10)) : 0,
      touch_number: Number.isFinite(task.touchNumber) ? Math.max(0, task.touchNumber) : null,
      notes: task.notes,
      source: task.importSource,
      migration_payload: task.raw
    });
  }
  await bulk(db,
    `WITH incoming AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(source_id text,lead_source_id text,task_type text,title text,due_at timestamptz,completed_at timestamptz,status text,priority integer,touch_number integer,notes text,source text,migration_payload jsonb))
     INSERT INTO tasks(workspace_id,lead_id,created_by,title,description,due_at,status,completed_at,priority,source,task_type,touch_number,migration_source,migration_source_id,migration_payload)
     SELECT $1,l.id,NULL,x.title,x.notes,x.due_at,x.status::task_status,x.completed_at,x.priority,x.source,x.task_type,x.touch_number,'google-sheet:TASKS',x.source_id,x.migration_payload
       FROM incoming x LEFT JOIN leads l ON l.workspace_id=$1 AND l.migration_source='google-sheet:LEADS' AND l.migration_source_id=x.lead_source_id
     ON CONFLICT(workspace_id,migration_source,migration_source_id) WHERE migration_source IS NOT NULL AND migration_source_id IS NOT NULL
     DO UPDATE SET lead_id=EXCLUDED.lead_id,title=EXCLUDED.title,description=EXCLUDED.description,due_at=EXCLUDED.due_at,status=EXCLUDED.status,
       completed_at=EXCLUDED.completed_at,priority=EXCLUDED.priority,source=EXCLUDED.source,task_type=EXCLUDED.task_type,touch_number=EXCLUDED.touch_number,migration_payload=EXCLUDED.migration_payload,updated_at=now()`, workspaceId, preparedTasks);
  counts.tasks = preparedTasks.length;

  const mappingRows = [];
  for (const [id, targetId] of sourceToLead) mappingRows.push({ entityType: 'lead', sourceId: id, targetId });
  const taskMap = await db.query('SELECT migration_source_id,id FROM tasks WHERE workspace_id=$1 AND migration_source=$2 AND migration_source_id=ANY($3::text[])', [workspaceId, TASK_SOURCE, preparedTasks.map(item => item.source_id)]);
  for (const row of taskMap.rows) mappingRows.push({ entityType: 'task', sourceId: row.migration_source_id, targetId: row.id });
  const meetingMap = await db.query("SELECT migration_source_id,id FROM meetings WHERE workspace_id=$1 AND migration_source='google-sheet' AND migration_source_id=ANY($2::text[])", [workspaceId, meetingRows.map(item => item.source_id)]);
  for (const row of meetingMap.rows) mappingRows.push({ entityType: 'meeting', sourceId: row.migration_source_id, targetId: row.id });
  const activityMap = await db.query("SELECT migration_source_id,id FROM activities WHERE workspace_id=$1 AND migration_source='google-sheet' AND migration_source_id=ANY($2::text[])", [workspaceId, activityRows.map(item => item.source_id)]);
  for (const row of activityMap.rows) mappingRows.push({ entityType: 'activity', sourceId: row.migration_source_id, targetId: row.id });
  await upsertExternalMappings(db, workspaceId, batchId, mappingRows);
  await insertErrors(db, batchId, errors);
  return counts;
}

function validateLeadHeaders(parsed) {
  const required = ['Lead ID','Name','Phone','Investor Email','Lead Source','Status'];
  const headers = new Set(parsed.headers.map(value => value.trim().toLowerCase()));
  const missing = required.filter(value => !headers.has(value.toLowerCase()));
  if (missing.length) throw new Error(`LEADS.csv is missing required headers: ${missing.join(', ')}.`);
}

async function main() {
  const inputDir = process.argv[2];
  if (!inputDir) throw new Error('Usage: pnpm import:sheet -- <csv-folder> [--apply]');
  const apply = process.argv.includes('--apply');
  if (process.env.APP_ENV === 'production' && !process.argv.includes('--confirm-production-cutover')) {
    throw new Error('Production imports require --confirm-production-cutover after a reconciled staging rehearsal and explicit cutover approval.');
  }
  const workspaceId = uuid(process.env.REDBLACK_WORKSPACE_ID, 'REDBLACK_WORKSPACE_ID');
  const root = path.resolve(inputDir);
  const leadSheet = await csvInput(path.join(root, 'LEADS.csv'));
  validateLeadHeaders(leadSheet);
  const taskSheet = await csvInput(path.join(root, 'TASKS.csv'), ['Task ID','Lead ID','Due Date','Task Type','Status']);
  let calendarSheet = null;
  try { calendarSheet = await csvInput(path.join(root, 'CALENDAR.csv')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const fingerprint = createHash('sha256').update(leadSheet.bytes).update(taskSheet.bytes).update(calendarSheet?.bytes ?? '').digest('hex');
  const counts = { LEADS: leadSheet.records.length, TASKS: taskSheet.records.length, CALENDAR: calendarSheet?.records.length ?? 0 };
  const errors = [];
  const mapped = new Set(); const contacts = new Set(); let validLeads = 0;
  for (const record of leadSheet.records) {
    try {
      const model = mapLegacyLead(leadSheet.headers.map(header => record.values[header] ?? ''), leadSheet.headers);
      const id = sourceId(model.sourceId, record.rowNumber);
      if (mapped.has(id)) throw new Error('Lead ID is repeated in the source sheet.');
      mapped.add(id); validLeads += 1;
      const contact = model.phoneNormalized ? `phone:${model.phoneNormalized}` : model.emailNormalized ? `email:${model.emailNormalized}` : null;
      if (contact && contacts.has(contact)) errors.push({ sheet: 'LEADS', rowNumber: record.rowNumber, sourceId: id, code: 'POSSIBLE_DUPLICATE', message: 'Normalized phone/email matches an earlier source row; both records will be preserved.' });
      if (contact) contacts.add(contact);
    } catch (error) {
      errors.push({ sheet: 'LEADS', rowNumber: record.rowNumber, sourceId: sourceId(field(record, ['Lead ID']), record.rowNumber), code: 'INVALID_LEAD', message: String(error.message).slice(0, 300) });
    }
  }
  const statusCounts = {};
  for (const row of leadSheet.records) { const status = String(field(row, ['Status']) || 'New Lead').trim().toUpperCase(); statusCounts[status] = (statusCounts[status] ?? 0) + 1; }
  const preview = {
    mode: apply ? 'apply' : 'preview', workspaceId, sourceFingerprint: fingerprint,
    sourceCounts: counts, validLeads, rejectedRows: errors.filter(item => item.code !== 'POSSIBLE_DUPLICATE').length,
    potentialDuplicates: errors.filter(item => item.code === 'POSSIBLE_DUPLICATE').length,
    legacyStatusCounts: statusCounts,
    pipelineRule: 'Realty/property keywords → Realty; RedBlack Tech/digital/web/automation keywords → RedBlack Tech; all other legacy records → Franchise. Original brand, opportunity type and legacy status are retained in migration_payload/status.',
    applyRequiresStagingReconciliation: true
  };
  if (!apply) { process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`); return; }

  const batch = await db.query(
    `INSERT INTO import_batches(workspace_id,source_system,status,source_fingerprint,source_counts,created_by,started_at)
     VALUES($1,'google-sheet','running',$2,$3::jsonb,NULL,now())
     ON CONFLICT(workspace_id,source_system,source_fingerprint) DO UPDATE SET status='running',started_at=now(),completed_at=NULL,source_counts=EXCLUDED.source_counts
     RETURNING id`, [workspaceId, fingerprint, JSON.stringify(counts)]
  );
  const batchId = batch.rows[0].id;
  const actualErrors = [...errors];
  try {
    const imported = await importRows({ db, workspaceId, batchId, leadRows: leadSheet, taskRows: taskSheet, calendarRows: calendarSheet, errors: actualErrors });
    const rejected = actualErrors.filter(item => item.code !== 'POSSIBLE_DUPLICATE').length;
    await db.query(
      `UPDATE import_batches SET status=$2,imported_counts=$3::jsonb,rejected_counts=$4::jsonb,completed_at=now() WHERE workspace_id=$1 AND id=$5`,
      [workspaceId, rejected ? 'completed_with_errors' : 'completed', JSON.stringify(imported), JSON.stringify({ rows: rejected, potentialDuplicates: actualErrors.filter(item => item.code === 'POSSIBLE_DUPLICATE').length }), batchId]
    );
    process.stdout.write(`${JSON.stringify({ ...preview, batchId, imported, rejectedRows: rejected, potentialDuplicates: actualErrors.filter(item => item.code === 'POSSIBLE_DUPLICATE').length }, null, 2)}\n`);
  } catch (error) {
    await db.query("UPDATE import_batches SET status='failed',completed_at=now(),rejected_counts=$3::jsonb WHERE workspace_id=$1 AND id=$2", [workspaceId, batchId, JSON.stringify({ fatal: String(error.message).slice(0, 300) })]);
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  finally { await closeDatabase(); }
}

