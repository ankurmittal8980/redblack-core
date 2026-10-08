import { createCrmPlatformUI } from './crm-platform.js';
const $ = selector => document.querySelector(selector);
const appState = { user: null, workspace: null, workspaces: [], role: null, view: 'dashboard', cursor: null, leadSearch: '', leadStatus: '', selectedLeads: new Set(), toastTimer: null, csvImportText: null, csvImportFields: [], csvImportErrors: [] };
const apiRoot = '/api/v1';
const crmUI = createCrmPlatformUI({ api, workspacePath, setPage, pageHeading, escapeHtml, appState, showToast, renderLeadDetail });
const VIEW_ROLES = Object.freeze({
  automations: ['owner','admin','manager'],
  usage: ['owner','admin','manager','reporting'],
  reports: ['owner','admin','manager','reporting'],
  workspace: ['owner','admin']
});

function viewAllowed(view, role) { return !VIEW_ROLES[view] || VIEW_ROLES[view].includes(role); }

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function downloadCsv(filename, headers, rows) {
  const cell = value => {
    let text = value == null ? '' : String(value);
    if (/^[\s\uFEFF]*[=+\-@]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const content = `\uFEFF${[headers.map(cell).join(','), ...rows.map(row => row.map(cell).join(','))].join('\r\n')}\r\n`;
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function csrfToken() {
  const part = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith('rb_csrf='));
  return part ? decodeURIComponent(part.slice('rb_csrf='.length)) : '';
}

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const options = { method, credentials: 'same-origin', headers: { Accept: 'application/json', ...headers } };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  if (['POST','PATCH','PUT','DELETE'].includes(method)) options.headers['X-CSRF-Token'] = csrfToken();
  const response = await fetch(`${apiRoot}${path}`, options);
  let payload = {};
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok) {
    const error = new Error(payload.error?.message ?? `Request failed (${response.status}).`);
    error.status = response.status;
    error.code = payload.error?.code ?? payload.code;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function showToast(message, kind = 'success') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast show ${kind === 'error' ? 'error' : 'success'}`;
  clearTimeout(appState.toastTimer);
  appState.toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3200);
}

function fmtDate(value, { time = false } = {}) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return new Intl.DateTimeFormat('en-IN', time ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }).format(date);
}

function fmtNumber(value) { return new Intl.NumberFormat('en-IN').format(Number(value ?? 0)); }
function fmtMoney(value, currency = 'INR') {
  const amount = Number(value ?? 0);
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number.isFinite(amount) ? amount : 0);
}
function badge(value) {
  const clean = String(value ?? 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const color = ['hot','warm','cold','won','lost','completed','failed','cancelled'].includes(clean) ? ` badge-${clean}` : '';
  return `<span class="badge${color}">${escapeHtml(value ?? '—')}</span>`;
}
function pageHeading(label, title, text, action = '') {
  return `<div class="page-heading"><div><p class="eyebrow">${escapeHtml(label)}</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></div><div class="heading-actions">${action}</div></div>`;
}
function metric(label, value, meta, accent = false) {
  return `<article class="metric-card">${accent ? '<span class="metric-accent"></span>' : ''}<div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">${escapeHtml(value)}</div><div class="metric-meta">${escapeHtml(meta)}</div></article>`;
}
function setPage(html) { $('#viewRoot').innerHTML = html; $('#viewRoot').focus({ preventScroll: true }); }
function workspacePath(suffix = '') { return `/workspaces/${encodeURIComponent(appState.workspace.id)}${suffix ? `/${suffix}` : ''}`; }

function switchToApp(session) {
  appState.user = session.user;
  appState.workspace = session.workspace;
  appState.role = session.role;
  document.querySelectorAll('#mainNav [data-view]').forEach(button => button.classList.toggle('hidden', !viewAllowed(button.dataset.view, appState.role)));
  if (!viewAllowed(appState.view, appState.role)) appState.view = 'dashboard';
  $('#authView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  $('#userLabel').textContent = session.user.displayName ?? session.user.email;
  $('#userBadge').textContent = (session.user.displayName ?? session.user.email).split(/[\s@]/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase();
  $('#topWorkspaceName').textContent = session.workspace?.name ?? 'Choose workspace';
  loadWorkspaces().then(() => session.workspace ? renderView(appState.view) : chooseWorkspaceView());
}

async function loadWorkspaces() {
  const result = await api('/workspaces');
  appState.workspaces = result.data ?? [];
  const picker = $('#workspacePicker');
  picker.innerHTML = appState.workspaces.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === appState.workspace?.id ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('');
}

function chooseWorkspaceView() {
  setPage(`${pageHeading('ACCOUNT', 'Choose a workspace', 'Select the team space you want to open.')}
    <section class="panel"><div class="panel-body"><div class="empty-state"><div><strong>Workspace selection required</strong>Choose an active workspace from the selector in the sidebar.</div></div></div></section>`);
}

async function boot() {
  try {
    const session = await api('/auth/me');
    switchToApp(session);
  } catch (error) {
    if (error.status !== 401) showToast(error.message, 'error');
    $('#appView').classList.add('hidden');
    $('#authView').classList.remove('hidden');
  }
}

function renderLeadRows(rows, columns = ['project','status','budget','nextAction']) {
  if (!rows.length) return `<tr><td colspan="${columns.length + 2}" class="empty-state">No leads found for this view.</td></tr>`;
  const cell = (lead, column) => {
    if (column === 'project') return escapeHtml(lead.brand_project || lead.opportunity_type || '—');
    if (column === 'status') return badge(lead.temperature ?? lead.status);
    if (column === 'budget') return lead.budget === null ? '—' : fmtMoney(lead.budget);
    if (column === 'nextAction') return fmtDate(lead.next_action_at, { time: true });
    if (column === 'owner') return escapeHtml(lead.owner_user_id || '—');
    if (column === 'score') return escapeHtml(lead.score ?? 0);
    if (column === 'location') return escapeHtml(lead.location || '—');
    return '—';
  };
  return rows.map(lead => `<tr><td><input type="checkbox" data-action="select-lead" data-id="${escapeHtml(lead.id)}" ${appState.selectedLeads.has(lead.id) ? 'checked' : ''} aria-label="Select lead"><div class="lead-name">${escapeHtml([lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Unnamed lead')}</div><div class="lead-sub">${escapeHtml(lead.company_name || lead.email || lead.phone || '')}</div></td>${columns.map(column => `<td>${cell(lead,column)}</td>`).join('')}<td><button class="quiet-button" data-action="lead-details" data-id="${escapeHtml(lead.id)}">Open</button></td></tr>`).join('');
}

async function renderToday() {
  const [tasks, leads] = await Promise.all([api(`${workspacePath('tasks')}?limit=100`), api(`${workspacePath('leads')}?limit=100`)]);
  const now = new Date(); const day = new Date(now); day.setHours(23,59,59,999);
  const taskRows = (tasks.data ?? []).filter(t => t.status !== 'completed' && t.status !== 'cancelled').map(t => `<tr><td>${escapeHtml(t.title)}</td><td>${fmtDate(t.due_at, { time: true })}</td><td>${badge(t.status)}</td><td><button class="quiet-button" data-action="complete-task" data-id="${escapeHtml(t.id)}">Complete</button></td></tr>`).join('') || '<tr><td colspan="4" class="empty-state">No open follow-ups.</td></tr>';
  const hot = (leads.data ?? []).filter(l => ['hot','warm'].includes(String(l.temperature).toLowerCase()) || Number(l.score) >= 70).slice(0,20);
  setPage(`${pageHeading('DAILY SALES DESK', 'Today', 'Prioritize overdue work, follow-ups and high-intent leads.', '<button class="button button-secondary" data-view="tasks">Open tasks</button>')}
    <section class="metrics"><article class="metric-card"><span class="metric-label">Open follow-ups</span><strong>${fmtNumber((tasks.data ?? []).filter(t => !['completed','cancelled'].includes(t.status)).length)}</strong></article><article class="metric-card"><span class="metric-label">Hot / high score</span><strong>${fmtNumber(hot.length)}</strong></article></section>
    <section class="panel"><div class="panel-header"><h2 class="panel-title">Follow-up queue</h2></div><div class="panel-body"><div class="table-wrap"><table><thead><tr><th>Task</th><th>Due</th><th>Status</th><th></th></tr></thead><tbody>${taskRows}</tbody></table></div></div></section>
    <section class="panel"><div class="panel-header"><h2 class="panel-title">Hot and high-score leads</h2></div><div class="panel-body"><div class="task-list">${hot.map(l => `<button class="task-row" data-action="lead-details" data-id="${escapeHtml(l.id)}"><span class="badge">${escapeHtml(l.temperature || l.score)}</span><span class="task-title">${escapeHtml([l.first_name,l.last_name].filter(Boolean).join(' ') || l.email || 'Lead')}</span><span class="task-due">${escapeHtml(l.status || '')}</span></button>`).join('') || '<div class="empty-state">No hot leads.</div>'}</div></div></section>`);
}

async function renderDashboard() {
  const [report, leads, tasks, pipelines] = await Promise.all([
    api(`${workspacePath('reports/dashboard')}?from=${encodeURIComponent(new Date(Date.now() - 30 * 86400000).toISOString())}&to=${encodeURIComponent(new Date().toISOString())}`),
    api(`${workspacePath('leads')}?limit=6`), api(`${workspacePath('tasks')}?status=pending&limit=6`), api(workspacePath('pipelines'))
  ]);
  const summary = report.summary ?? {};
  const action = ['owner','admin','manager','agent'].includes(appState.role) ? '<button class="button button-primary" data-action="new-lead">+ New lead</button>' : '';
  const leadHtml = (leads.data ?? []).map(lead => `<tr><td><div class="lead-name">${escapeHtml([lead.first_name,lead.last_name].filter(Boolean).join(' ') || 'Unnamed lead')}</div><div class="lead-sub">${escapeHtml(lead.company_name || lead.email || lead.phone || '')}</div></td><td>${escapeHtml(lead.brand_project || '—')}</td><td>${badge(lead.temperature ?? lead.status)}</td><td>${fmtDate(lead.created_at)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty-state">Your lead list is ready when you add your first record.</td></tr>';
  const taskHtml = (tasks.data ?? []).map(task => `<div class="task-row"><input class="task-check" type="checkbox" data-action="complete-task" data-id="${escapeHtml(task.id)}" aria-label="Complete ${escapeHtml(task.title)}"><div><div class="task-title">${escapeHtml(task.title)}</div><div class="task-meta">${escapeHtml(task.task_type || 'Follow-up')}</div></div><div class="task-due">${fmtDate(task.due_at)}</div></div>`).join('') || '<div class="empty-state"><div><strong>No pending tasks</strong>New follow-ups will appear here.</div></div>';
  setPage(`${pageHeading('YOUR WORKSPACE', `Good to see you, ${(appState.user.displayName || '').split(' ')[0] || 'there'}`, 'Here is what is moving across your team.', action)}
    <section class="metrics">
      ${metric('Total leads', fmtNumber(summary.total_leads), 'Active records', true)}
      ${metric('Hot leads', fmtNumber(summary.hot), 'Ready for a follow-up')}
      ${metric('Meetings', fmtNumber(summary.meetings), 'In the selected period')}
      ${metric('Win rate', `${Number(summary.win_rate ?? 0).toFixed(1)}%`, `${fmtNumber(summary.won)} won · ${fmtNumber(summary.lost)} lost`)}
    </section>
    <section class="dashboard-grid">
      <article class="panel"><div class="panel-header"><div><h2 class="panel-title">Recently added leads</h2><p class="panel-subtitle">The latest activity in your pipeline</p></div><button class="text-button" data-view="leads">View all</button></div><div class="table-wrap"><table><thead><tr><th>Lead</th><th>Project</th><th>Temperature</th><th>Added</th></tr></thead><tbody>${leadHtml}</tbody></table></div></article>
      <article class="panel"><div class="panel-header"><div><h2 class="panel-title">Follow-up queue</h2><p class="panel-subtitle">Your next actions</p></div><button class="text-button" data-view="tasks">All tasks</button></div><div class="panel-body"><div class="task-list">${taskHtml}</div></div></article>
    </section>
    <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Pipeline health</h2><p class="panel-subtitle">Open a pipeline to review stages and movement</p></div><button class="button button-secondary button-small" data-view="pipelines">Explore pipelines</button></div><div class="panel-body"><div class="metrics">${(pipelines.data ?? []).map(p => metric(p.name, (p.stages ?? []).length, 'Configured stages')).join('')}</div></div></section>`);
}

async function renderTrash() {
  const params = new URLSearchParams({ limit: '50' });
  if (appState.trashCursor) params.set('cursor', appState.trashCursor);
  const result = await api(`${workspacePath('leads/trash')}?${params}`);
  const canRestore = ['owner','admin','manager','agent'].includes(appState.role);
  const canPurge = ['owner','admin'].includes(appState.role);
  const rows = (result.data ?? []).map(lead => `<tr><td><div class="lead-name">${escapeHtml([lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Unnamed lead')}</div><div class="lead-sub">${escapeHtml(lead.email || lead.phone || lead.company_name || '')}</div></td><td>${badge(lead.status)}</td><td>${fmtDate(lead.deleted_at, { time: true })}</td><td>${canRestore ? `<button class="quiet-button" data-action="restore-lead" data-id="${escapeHtml(lead.id)}">Restore</button>` : '—'} ${canPurge ? `<button class="quiet-button" data-action="purge-lead" data-id="${escapeHtml(lead.id)}">Delete permanently</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="empty-state">Trash is empty.</td></tr>';
  setPage(`${pageHeading('DATA SAFETY', 'Lead trash', 'Archived leads remain recoverable and auditable.', '<button class="button button-secondary" data-view="leads">Back to leads</button>')}
    <section class="panel"><div class="panel-body"><div class="table-wrap"><table><thead><tr><th>Lead</th><th>Status</th><th>Deleted</th><th></th></tr></thead><tbody>${rows}</tbody></table></div><div class="pagination"><button class="button button-secondary button-small" data-action="next-trash" ${result.nextCursor ? '' : 'disabled'} data-cursor="${escapeHtml(result.nextCursor ?? '')}">Load more</button></div></div></section>`);
}

async function renderLeads() {
  const params = new URLSearchParams({ limit: '50' });
  if (appState.cursor) params.set('cursor', appState.cursor);
  if (appState.leadSearch) params.set('q', appState.leadSearch);
  if (appState.leadStatus) params.set('status', appState.leadStatus);
  const exportParams = new URLSearchParams();
  if (appState.leadSearch) exportParams.set('q', appState.leadSearch);
  if (appState.leadStatus) exportParams.set('status', appState.leadStatus);
  const exportQuery = exportParams.toString();
  const exportHref = `${apiRoot}${workspacePath('leads/export')}${exportQuery ? `?${exportQuery}` : ''}`;
  const memberPromise = ['owner','admin','manager'].includes(appState.role) ? api(workspacePath('members')) : Promise.resolve({data:[]});
  const [result, fieldDefs, tagCatalog, sources, savedViews, pipelines, members, layouts] = await Promise.all([api(`${workspacePath('leads')}?${params}`), api(`${workspacePath('custom-fields')}?entityType=lead`), api(workspacePath('tags')), api(workspacePath('lead-sources')), api(`${workspacePath('saved-views')}?entityType=lead`), api(workspacePath('pipelines')), memberPromise, api(`${workspacePath('layouts')}?entityType=lead`)]);
  const leadColumns = layouts.data?.find(layout => layout.active)?.config?.columns ?? ['project','status','budget','nextAction'];
  const leadColumnLabels = {project:'Project / opportunity',status:'Temperature / status',budget:'Budget',nextAction:'Next action',owner:'Owner',score:'Score',location:'Location'};
  const createAllowed = ['owner','admin','manager','agent'].includes(appState.role);
  const action = createAllowed ? `<div class="heading-actions"><button class="button button-secondary" data-action="toggle-import-leads">Import CSV</button><a class="button button-secondary" href="${escapeHtml(exportHref)}">Export CSV</a><button class="button button-primary" data-action="toggle-new-lead">+ New lead</button></div>` : `<a class="button button-secondary" href="${escapeHtml(exportHref)}">Export CSV</a>`;
  setPage(`${pageHeading('CRM', 'Leads', 'Find, qualify and follow up with every opportunity.', action)}
    <section id="leadImportPanel" class="panel hidden"><div class="panel-header"><div><h2 class="panel-title">Import leads</h2><p class="panel-subtitle">Preview your file, map its columns and review row errors. Matching email addresses or phone numbers are skipped.</p></div><button class="text-button" data-action="toggle-import-leads">Close</button></div><form id="csvImportForm" class="panel-body"><label>CSV file<input id="csvImportFile" name="file" type="file" accept=".csv,text/csv" required></label><div class="heading-actions"><button class="button button-secondary" type="button" data-action="preview-csv-import">Preview columns</button><button id="csvImportSubmit" class="button button-primary hidden" type="submit">Import leads</button></div><div id="csvImportPreview" class="hidden"></div><div id="csvImportResult"></div></form></section>
    <section id="newLeadPanel" class="panel hidden"><div class="panel-header"><div><h2 class="panel-title">Add a lead</h2><p class="panel-subtitle">Contact details and project context</p></div><button class="text-button" data-action="toggle-new-lead">Close</button></div><form id="newLeadForm" class="panel-body"><div class="field-grid">
      <label>First name<input name="firstName" required maxlength="120"></label><label>Last name<input name="lastName" maxlength="120"></label>
      <label>Email<input name="email" type="email" maxlength="320"></label><label>Phone<input name="phone" type="tel" maxlength="80"></label>
      <label>Company<input name="companyName" maxlength="240"></label><label>Project / brand<input name="brandProject" maxlength="240"></label>
      <label>Opportunity type<input name="opportunityType" maxlength="160"></label><label>Budget (INR)<input name="budget" type="number" min="0" step="0.01"></label>
      <label>Status<input name="status" value="New Lead" maxlength="80"></label><label>Next follow-up<input name="nextActionAt" type="datetime-local"></label>
      <label>Lead source<select name="sourceId"><option value="">—</option>${(sources.data??[]).map(source=>`<option value="${escapeHtml(source.id)}">${escapeHtml(source.name)}</option>`).join('')}</select></label><label>Temperature<select name="temperature"><option value="">—</option><option>hot</option><option>warm</option><option>cold</option></select></label>
      <label class="span-2">Requirement<textarea name="requirement" maxlength="5000"></textarea></label>
      ${(fieldDefs.data??[]).filter(field=>field.config?.visible!==false).sort((a,b)=>(a.config?.order??0)-(b.config?.order??0)).map(field=>customFieldControl({...field,value:null})).join('')}
    </div><div class="panel-body"><strong>Tags</strong><div class="heading-actions">${(tagCatalog.data??[]).map(tag=>`<label class="checkbox-row"><input type="checkbox" data-new-lead-tag value="${escapeHtml(tag.id)}"> ${escapeHtml(tag.name)}</label>`).join('')||'<span class="muted">No tags configured.</span>'}</div></div><div class="heading-actions"><button class="button button-primary" type="submit">Save lead</button><button class="button button-secondary" type="reset">Clear</button></div></form></section>
    <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Lead directory</h2><p class="panel-subtitle">${fmtNumber(result.data?.length ?? 0)} records on this page</p></div><span class="badge">${escapeHtml(appState.role)}</span></div>
      <div class="panel-body"><div class="toolbar"><label>Saved view<select id="savedLeadView"><option value="">Current view</option>${(savedViews.data??[]).map(view=>`<option value="${escapeHtml(view.id)}" data-config="${escapeHtml(JSON.stringify(view.config||{}))}">${escapeHtml(view.name)}</option>`).join('')}</select></label><form id="savedViewForm" class="inline-form"><input name="name" placeholder="Save current view as…" required maxlength="160"><button class="button button-secondary button-small">Save view</button></form><label><input type="checkbox" data-action="select-all-leads" aria-label="Select all visible leads"> Select all</label><button class="button button-secondary button-small" data-action="bulk-trash" ${appState.selectedLeads.size ? '' : 'disabled'}>Trash selected</button><select id="bulkStatus" aria-label="Bulk status"><option value="">Bulk status…</option><option>New Lead</option><option>Connected</option><option>Qualified</option><option>Won</option><option>Lost</option></select><select id="bulkStage" aria-label="Bulk stage"><option value="">Bulk stage…</option>${(pipelines.data??[]).flatMap(p=>p.stages.map(s=>`<option value="${escapeHtml(p.id)}|${escapeHtml(s.id)}">${escapeHtml(p.name)} · ${escapeHtml(s.name)}</option>`)).join('')}</select><select id="bulkTag" aria-label="Bulk tag"><option value="">Set tag…</option>${(tagCatalog.data??[]).map(tag=>`<option value="${escapeHtml(tag.id)}">${escapeHtml(tag.name)}</option>`).join('')}</select>${members.data?.length?`<select id="bulkOwner" aria-label="Bulk owner"><option value="">Assign owner…</option>${members.data.filter(m=>m.active).map(m=>`<option value="${escapeHtml(m.id||m.user_id)}">${escapeHtml(m.display_name)}</option>`).join('')}</select>`:''}<input id="leadSearch" type="search" placeholder="Search name, email, phone or company" value="${escapeHtml(appState.leadSearch)}"><select id="leadStatus"><option value="">All statuses</option>${['New Lead','Contact Attempted','Connected','Qualified','Meeting / Presentation','Proposal','Negotiation','Won','Lost','HOT','WARM','COLD','NO RESPONSE'].map(item => `<option ${appState.leadStatus === item ? 'selected' : ''}>${escapeHtml(item)}</option>`).join('')}</select><button class="button button-secondary button-small" data-action="clear-lead-filters">Clear</button></div>
      <div class="table-wrap"><table><thead><tr><th>Lead</th>${leadColumns.map(column=>`<th>${escapeHtml(leadColumnLabels[column]||column)}</th>`).join('')}<th></th></tr></thead><tbody>${renderLeadRows(result.data ?? [], leadColumns)}</tbody></table></div>
      <div class="pagination"><button class="button button-secondary button-small" data-action="next-leads" ${result.nextCursor ? '' : 'disabled'} data-cursor="${escapeHtml(result.nextCursor ?? '')}">Load more</button></div></div></section>`);
  if (!createAllowed) {
    document.querySelectorAll('#savedViewForm,[data-action="select-all-leads"],[data-action="bulk-trash"],[data-action="select-lead"],#bulkStatus,#bulkStage,#bulkTag,#bulkOwner').forEach(control => {
      if (control.matches('[data-action="select-all-leads"]')) control.closest('label')?.remove();
      else control.remove();
    });
  }
}

function customFieldControl(field) {
  const name = `cf:${field.id}`; const value = field.value ?? '';
  const required = field.required ? 'required' : ''; const disabled = field.config?.readOnly ? 'disabled' : '';
  if (field.field_type === 'boolean') return `<label class="checkbox-row"><input type="checkbox" name="${escapeHtml(name)}" ${value === true ? 'checked' : ''} ${disabled}> ${escapeHtml(field.label)}</label>`;
  if (field.field_type === 'textarea') return `<label class="span-2">${escapeHtml(field.label)}<textarea name="${escapeHtml(name)}" ${required} ${disabled}>${escapeHtml(value)}</textarea></label>`;
  if (['select','multiselect'].includes(field.field_type)) {
    const options = Array.isArray(field.config?.options) ? field.config.options : [];
    return `<label>${escapeHtml(field.label)}<select name="${escapeHtml(name)}" ${field.field_type === 'multiselect' ? 'multiple' : ''} ${required} ${disabled}>${options.map(option => `<option value="${escapeHtml(option)}" ${Array.isArray(value) ? (value.includes(option) ? 'selected' : '') : (String(value) === String(option) ? 'selected' : '')}>${escapeHtml(option)}</option>`).join('')}</select></label>`;
  }
  const type = ({number:'number',currency:'number',date:'date',datetime:'datetime-local',email:'email',phone:'tel',url:'url'})[field.field_type] || 'text';
  return `<label>${escapeHtml(field.label)}<input type="${type}" name="${escapeHtml(name)}" value="${escapeHtml(value)}" ${required} ${disabled}></label>`;
}

async function renderLeadDetail(leadId) {
  $('#viewRoot').onclick = null; $('#viewRoot').onsubmit = null; $('#viewRoot').onchange = null;
  const [lead, timeline, tagCatalog] = await Promise.all([api(`${workspacePath(`leads/${encodeURIComponent(leadId)}`)}`), api(`${workspacePath(`leads/${encodeURIComponent(leadId)}/timeline`)}`), api(workspacePath('tags'))]);
  const selectedTags = new Set((lead.tags ?? []).map(tag => tag.id));
  const customControls = (lead.customFields ?? []).filter(field => field.config?.visible !== false).sort((a,b)=>(a.config?.order??0)-(b.config?.order??0)).map(customFieldControl).join('');
  const tagControls = (tagCatalog.data ?? []).map(tag => `<label class="checkbox-row"><input type="checkbox" data-lead-tag value="${escapeHtml(tag.id)}" ${selectedTags.has(tag.id) ? 'checked' : ''}> ${escapeHtml(tag.name)}</label>`).join('') || '<span class="muted">No workspace tags configured.</span>';
  setPage(`${pageHeading('LEAD RECORD', [lead.first_name,lead.last_name].filter(Boolean).join(' ') || 'Lead details', lead.company_name || lead.email || lead.phone || '')}
    <section class="panel"><div class="panel-header"><h2 class="panel-title">Contact and qualification</h2><div><button class="button button-secondary button-small" data-action="toggle-lead-edit">Edit</button> <button class="button button-secondary button-small" data-view="leads">Back to leads</button></div></div><div id="leadEditPanel" class="panel-body hidden"><form id="leadEditForm" data-lead-id="${escapeHtml(lead.id)}"><div class="field-grid"><label>First name<input name="firstName" value="${escapeHtml(lead.first_name || '')}"></label><label>Last name<input name="lastName" value="${escapeHtml(lead.last_name || '')}"></label><label>Email<input name="email" type="email" value="${escapeHtml(lead.email || '')}"></label><label>Phone<input name="phone" value="${escapeHtml(lead.phone || '')}"></label><label>Status<input name="status" value="${escapeHtml(lead.status || '')}"></label><label>Score<input name="score" type="number" value="${escapeHtml(lead.score ?? 0)}"></label><label>Temperature<select name="temperature"><option value="">—</option>${['hot','warm','cold'].map(v => `<option value="${v}" ${lead.temperature === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label><label>Budget<input name="budget" type="number" value="${escapeHtml(lead.budget ?? '')}"></label><label>Next action<input name="nextAction" value="${escapeHtml(lead.next_action || '')}"></label><label>Next follow-up<input name="nextActionAt" type="datetime-local" value="${lead.next_action_at ? escapeHtml(new Date(lead.next_action_at).toISOString().slice(0,16)) : ''}"></label><label class="span-2">Notes<textarea name="notes">${escapeHtml(lead.notes || '')}</textarea></label>${customControls}</div><div class="panel-body"><strong>Tags</strong><div class="heading-actions">${tagControls}</div></div><button class="button button-primary" type="submit">Save changes</button></form></div><div class="panel-body"><dl class="key-value"><dt>Email</dt><dd>${escapeHtml(lead.email || '—')}</dd><dt>Phone</dt><dd>${escapeHtml(lead.phone || '—')}</dd><dt>Project</dt><dd>${escapeHtml(lead.brand_project || '—')}</dd><dt>Opportunity type</dt><dd>${escapeHtml(lead.opportunity_type || '—')}</dd><dt>Budget</dt><dd>${lead.budget === null ? '—' : fmtMoney(lead.budget)}</dd><dt>Status</dt><dd>${badge(lead.status)}</dd><dt>Temperature</dt><dd>${badge(lead.temperature)}</dd><dt>Next action</dt><dd>${escapeHtml(lead.next_action || '—')} · ${fmtDate(lead.next_action_at, { time: true })}</dd><dt>Tags</dt><dd>${(lead.tags ?? []).map(tag => badge(tag.name)).join(' ') || '—'}</dd><dt>Notes</dt><dd>${escapeHtml(lead.notes || '—')}</dd></dl></div></section>
    <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Timeline</h2><p class="panel-subtitle">Recent calls, tasks, messages and notes</p></div></div><div class="panel-body">${(timeline.data ?? []).map(item => `<div class="task-row"><span class="badge">${escapeHtml(item.item_type)}</span><div><div class="task-title">${escapeHtml(item.title)}</div><div class="task-meta">${escapeHtml(item.body || item.kind || '')}</div></div><div class="task-due">${fmtDate(item.happened_at, { time: true })}</div></div>`).join('') || '<div class="empty-state">No timeline events yet.</div>'}</div></section>`);
  if (!['owner','admin','manager','agent'].includes(appState.role)) { $('#leadEditPanel').remove(); $('[data-action="toggle-lead-edit"]').remove(); }
  await crmUI.conversion(leadId);
}

async function renderPipelines(selectedPipelineId = null) {
  const [pipelines, leads] = await Promise.all([api(workspacePath('pipelines')), api(`${workspacePath('leads')}?limit=100`)]);
  const first = pipelines.data?.find(item => item.id === selectedPipelineId) ?? pipelines.data?.[0];
  const canManage = ['owner','admin'].includes(appState.role);
  const cards = (leads.data ?? []).map(lead => ({ lead, current: null }));
  if (first) {
    const board = first.stages.map(stage => {
      const matching = cards.filter(({ lead }) => lead.current_stage_id ? lead.current_stage_id === stage.id : ((lead.status || '').toLowerCase() === stage.name.toLowerCase() || (stage.slug === 'new-lead' && (lead.status || '').toLowerCase() === 'new lead')));
      return `<div class="pipeline-column" data-drop-stage="${escapeHtml(stage.id)}" data-drop-pipeline="${escapeHtml(first.id)}"><div class="pipeline-column-header"><span>${escapeHtml(stage.name)}</span><span class="badge">${matching.length}</span></div>${matching.map(({ lead }) => `<article class="pipeline-card" draggable="true" data-drag-lead="${escapeHtml(lead.id)}"><span class="lead-name">${escapeHtml([lead.first_name,lead.last_name].filter(Boolean).join(' ') || 'Unnamed lead')}</span><div class="lead-sub">${escapeHtml(lead.brand_project || lead.email || '')}</div><select data-action="move-stage" data-lead="${escapeHtml(lead.id)}" data-pipeline="${escapeHtml(first.id)}"><option value="">Move to stage…</option>${first.stages.map(next => `<option value="${escapeHtml(next.id)}">${escapeHtml(next.name)}</option>`).join('')}</select></article>`).join('') || '<div class="lead-sub">No leads in this stage</div>'}</div>`;
    }).join('');
    setPage(`${pageHeading('OPPORTUNITY FLOW', 'Pipelines', 'Move every opportunity forward with a clear next step.')}
      <section class="panel"><div class="panel-header"><div><h2 class="panel-title">${escapeHtml(first.name)}</h2><p class="panel-subtitle">Showing up to 100 active leads. Drag lead cards between stages; movement is recorded in history.</p></div><select id="pipelineChoice">${pipelines.data.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === first.id ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select></div><div class="panel-body"><div class="pipeline-board">${board}</div></div></section>${canManage ? `<section class="panel"><div class="panel-header"><div><h2 class="panel-title">Pipeline builder</h2><p class="panel-subtitle">Edit the selected pipeline and its stage definitions.</p></div></div><div class="panel-body">
        <form id="pipelineEditForm" data-pipeline-id="${escapeHtml(first.id)}" class="inline-form"><label>Name<input name="name" value="${escapeHtml(first.name)}" required maxlength="120"></label><label>Slug<input name="slug" value="${escapeHtml(first.slug)}" required maxlength="120"></label><label class="checkbox-row"><input name="active" type="checkbox" ${first.active?'checked':''}> Active</label><button class="button button-primary">Save pipeline</button></form>
        <div class="table-wrap"><table><thead><tr><th>Stage</th><th>Settings</th></tr></thead><tbody>${first.stages.map(stage=>`<tr><td><strong>${escapeHtml(stage.name)}</strong><div class="lead-sub">Position ${escapeHtml(stage.position)}</div></td><td><form data-stage-edit-form data-pipeline-id="${escapeHtml(first.id)}" data-stage-id="${escapeHtml(stage.id)}" class="inline-form"><label>Name<input name="name" value="${escapeHtml(stage.name)}" required maxlength="120"></label><label>Slug<input name="slug" value="${escapeHtml(stage.slug)}" required maxlength="120"></label><label>Position<input name="position" type="number" min="0" value="${escapeHtml(stage.position)}" required></label><label class="checkbox-row"><input name="isWon" type="checkbox" ${stage.isWon?'checked':''}> Won</label><label class="checkbox-row"><input name="isLost" type="checkbox" ${stage.isLost?'checked':''}> Lost</label><button class="button button-secondary button-small">Save stage</button></form></td></tr>`).join('')}</tbody></table></div>
        <hr><form id="pipelineForm" class="inline-form"><label>New pipeline name<input name="name" required maxlength="120"></label><label>Slug<input name="slug" required maxlength="120"></label><button class="button button-secondary">Create pipeline</button></form>
        <form id="stageForm" class="inline-form"><input type="hidden" name="pipelineId" value="${escapeHtml(first.id)}"><label>New stage name<input name="name" required maxlength="120"></label><label>Slug<input name="slug" required maxlength="120"></label><label>Position<input name="position" type="number" min="0" value="${first.stages.length}"></label><label class="checkbox-row"><input name="isWon" type="checkbox"> Won</label><label class="checkbox-row"><input name="isLost" type="checkbox"> Lost</label><button class="button button-secondary">Add stage</button></form>
      </div></section>` : ''}`);
    $('#pipelineChoice').addEventListener('change', () => renderPipelines($('#pipelineChoice').value));
    bindPipelineDnD();
  } else setPage(`${pageHeading('OPPORTUNITY FLOW', 'Pipelines', 'No pipelines are available yet.')}<section class="panel"><div class="empty-state">Ask a workspace admin to create a pipeline.</div></section>`);
}

async function renderPipelineChoice(all, pipelineId) {
  const pipeline = all.find(item => item.id === pipelineId);
  if (!pipeline) return;
  const leads = await api(`${workspacePath('leads')}?pipelineId=${encodeURIComponent(pipelineId)}&limit=100`);
  const board = pipeline.stages.map(stage => {
    const matching = (leads.data ?? []).filter(lead => lead.current_stage_id ? lead.current_stage_id === stage.id : ((lead.status || '').toLowerCase() === stage.name.toLowerCase() || (stage.slug === 'new-lead' && (lead.status || '').toLowerCase() === 'new lead')));
    return `<div class="pipeline-column" data-drop-stage="${escapeHtml(stage.id)}" data-drop-pipeline="${escapeHtml(pipeline.id)}"><div class="pipeline-column-header"><span>${escapeHtml(stage.name)}</span><span class="badge">${matching.length}</span></div>${matching.map(lead => `<article class="pipeline-card" draggable="true" data-drag-lead="${escapeHtml(lead.id)}"><span class="lead-name">${escapeHtml([lead.first_name,lead.last_name].filter(Boolean).join(' ') || 'Unnamed lead')}</span><div class="lead-sub">${escapeHtml(lead.brand_project || lead.email || '')}</div><select data-action="move-stage" data-lead="${escapeHtml(lead.id)}" data-pipeline="${escapeHtml(pipeline.id)}"><option value="">Move to stage…</option>${pipeline.stages.map(next => `<option value="${escapeHtml(next.id)}">${escapeHtml(next.name)}</option>`).join('')}</select></article>`).join('') || '<div class="lead-sub">No leads in this stage</div>'}</div>`;
  }).join('');
  $('.pipeline-board').innerHTML = board;
  bindPipelineDnD();
}

function bindPipelineDnD() {
  document.querySelectorAll('[data-drag-lead]').forEach(card => card.addEventListener('dragstart', event => {
    event.dataTransfer.setData('text/plain', card.dataset.dragLead);
    event.dataTransfer.effectAllowed = 'move';
  }));
  document.querySelectorAll('[data-drop-stage]').forEach(column => {
    column.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; });
    column.addEventListener('drop', async event => {
      event.preventDefault(); const leadId = event.dataTransfer.getData('text/plain');
      if (!leadId) return;
      try {
        await api(`${workspacePath(`leads/${encodeURIComponent(leadId)}/stage`)}`, { method: 'POST', body: { pipelineId: column.dataset.dropPipeline, stageId: column.dataset.dropStage } });
        showToast('Lead moved.'); await renderPipelines();
      } catch (error) { showToast(error.message, 'error'); }
    });
  });
}

async function renderTasks() {
  const [result, taskTypes] = await Promise.all([api(`${workspacePath('tasks')}?limit=100`), api(workspacePath('task-types'))]);
  appState.taskCache = result.data ?? [];
  const canWrite = ['owner','admin','manager','agent'].includes(appState.role);
  const rows = appState.taskCache.map(task => {
    const terminal = ['completed','cancelled'].includes(task.status);
    const actions = !canWrite ? '—' : (terminal
      ? `<button class="quiet-button" data-action="task-status" data-status="pending" data-id="${escapeHtml(task.id)}">Reopen</button>`
      : `<button class="quiet-button" data-action="complete-task" data-id="${escapeHtml(task.id)}">Complete</button> <button class="quiet-button" data-action="task-status" data-status="cancelled" data-id="${escapeHtml(task.id)}">Cancel</button>`);
    return `<tr><td><div class="lead-name">${escapeHtml(task.title)}</div><div class="lead-sub">${escapeHtml(task.task_type || task.source || 'Follow-up')}</div></td><td>${fmtDate(task.due_at, { time: true })}</td><td>${badge(task.status)}</td><td>${escapeHtml(task.priority)}</td><td>${canWrite ? `<button class="quiet-button" data-action="edit-task" data-id="${escapeHtml(task.id)}">Edit</button>` : ''} ${actions}</td></tr>`;
  }).join('') || '<tr><td colspan="5" class="empty-state">No tasks found.</td></tr>';
  setPage(`${pageHeading('FOLLOW-UP WORK', 'Tasks & activities', 'Create, edit, complete, cancel and reopen follow-ups.', canWrite ? '<button class="button button-primary" data-action="toggle-task-form">+ New task</button>' : '')}
    <section id="taskFormPanel" class="panel hidden"><div class="panel-header"><h2 class="panel-title">Create a follow-up</h2><button class="text-button" data-action="toggle-task-form">Close</button></div><form id="taskForm" class="panel-body"><div class="field-grid"><label>Lead ID (optional)<input name="leadId" maxlength="36"></label><label>Task type<select name="taskType">${['CALL','WHATSAPP','MEETING','EMAIL','OTHER',...(taskTypes.data??[]).map(item=>item.name)].filter((value,index,array)=>array.indexOf(value)===index).map(value=>`<option>${escapeHtml(value)}</option>`).join('')}</select></label><label class="span-2">Title<input name="title" required maxlength="240"></label><label>Due date<input name="dueAt" type="datetime-local"></label><label>Priority<input name="priority" type="number" value="0" min="0" max="10"></label><label class="span-2">Notes<textarea name="description" maxlength="5000"></textarea></label></div><button class="button button-primary">Save task</button></form></section>
    <section id="taskEditPanel" class="panel hidden"></section>
    <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Task queue</h2><p class="panel-subtitle">${fmtNumber(appState.taskCache.length)} records</p></div></div><div class="table-wrap"><table><thead><tr><th>Task</th><th>Due</th><th>Status</th><th>Priority</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div></section>`);
}

function openTaskEditor(taskId) {
  const task = (appState.taskCache ?? []).find(item => item.id === taskId);
  if (!task) return;
  const panel = $('#taskEditPanel');
  const due = task.due_at ? new Date(task.due_at).toISOString().slice(0,16) : '';
  panel.innerHTML = `<div class="panel-header"><h2 class="panel-title">Edit task</h2><button class="text-button" data-action="close-task-edit">Close</button></div><form id="taskEditForm" data-task-id="${escapeHtml(task.id)}" class="panel-body"><div class="field-grid"><label class="span-2">Title<input name="title" value="${escapeHtml(task.title)}" required maxlength="240"></label><label>Due date<input name="dueAt" type="datetime-local" value="${escapeHtml(due)}"></label><label>Priority<input name="priority" type="number" min="0" max="10" value="${escapeHtml(task.priority ?? 0)}"></label><label>Status<select name="status">${['pending','in_progress','completed','cancelled'].map(value => `<option value="${value}" ${task.status === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label class="span-2">Notes<textarea name="description" maxlength="5000">${escapeHtml(task.description || '')}</textarea></label></div><button class="button button-primary">Save task</button></form>`;
  panel.classList.remove('hidden');
}

async function renderMeetings() {
  const [meetings, leads] = await Promise.all([api(`${workspacePath('meetings')}?limit=100`), api(`${workspacePath('leads')}?limit=100`)]);
  const canWrite = ['owner','admin','manager','agent'].includes(appState.role);
  appState.meetingCache = meetings.data ?? [];
  const rows = appState.meetingCache.map(item => `<tr><td>${fmtDate(item.starts_at, { time: true })}</td><td>${escapeHtml(item.meeting_type || 'Meeting')}</td><td>${badge(item.status)}</td><td>${escapeHtml(item.notes || '—')}</td><td>${canWrite ? `<button class="quiet-button" data-action="edit-meeting" data-id="${escapeHtml(item.id)}">Edit</button> <button class="quiet-button" data-action="meeting-status" data-status="completed" data-id="${escapeHtml(item.id)}">Complete</button> <button class="quiet-button" data-action="meeting-status" data-status="missed" data-id="${escapeHtml(item.id)}">Missed</button> <button class="quiet-button" data-action="meeting-status" data-status="cancelled" data-id="${escapeHtml(item.id)}">Cancel</button>` : '—'}</td></tr>`).join('') || '<tr><td colspan="5" class="empty-state">No meetings scheduled.</td></tr>';
  setPage(`${pageHeading('APPOINTMENTS', 'Meetings & calendar', 'Schedule appointments and record completed, missed or cancelled outcomes.')}
    ${canWrite ? `<section class="panel"><div class="panel-header"><h2 class="panel-title">Schedule meeting</h2></div><form id="meetingForm" class="panel-body"><div class="field-grid"><label>Lead<select name="leadId"><option value="">No linked lead</option>${(leads.data ?? []).map(lead => `<option value="${escapeHtml(lead.id)}">${escapeHtml([lead.first_name,lead.last_name].filter(Boolean).join(' ') || lead.email || lead.phone || lead.id)}</option>`).join('')}</select></label><label>Type<input name="meetingType" value="Consultation" maxlength="120"></label><label>Starts<input name="startsAt" type="datetime-local" required></label><label>Ends<input name="endsAt" type="datetime-local"></label><label class="span-2">Notes<textarea name="notes" maxlength="5000"></textarea></label></div><button class="button button-primary">Schedule meeting</button></form></section>` : ''}
    <section id="meetingEditPanel" class="panel hidden"></section>
    <section class="panel"><div class="panel-header"><h2 class="panel-title">Calendar queue</h2><span class="badge">${fmtNumber(meetings.data?.length ?? 0)}</span></div><div class="table-wrap"><table><thead><tr><th>When</th><th>Type</th><th>Status</th><th>Notes</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div></section>`);
}

function openMeetingEditor(meetingId) {
  const item=(appState.meetingCache??[]).find(meeting=>meeting.id===meetingId); if(!item)return;
  const panel=$('#meetingEditPanel'); const start=item.starts_at?new Date(item.starts_at).toISOString().slice(0,16):''; const end=item.ends_at?new Date(item.ends_at).toISOString().slice(0,16):'';
  panel.innerHTML=`<div class="panel-header"><h2 class="panel-title">Edit meeting</h2><button class="text-button" data-action="close-meeting-edit">Close</button></div><form id="meetingEditForm" data-meeting-id="${escapeHtml(item.id)}" class="panel-body"><div class="field-grid"><label>Type<input name="meetingType" value="${escapeHtml(item.meeting_type||'')}"></label><label>Status<select name="status">${['scheduled','completed','missed','cancelled'].map(v=>`<option ${item.status===v?'selected':''}>${v}</option>`).join('')}</select></label><label>Starts<input name="startsAt" type="datetime-local" value="${escapeHtml(start)}" required></label><label>Ends<input name="endsAt" type="datetime-local" value="${escapeHtml(end)}"></label><label class="span-2">Notes<textarea name="notes">${escapeHtml(item.notes||'')}</textarea></label></div><button class="button button-primary">Save meeting</button></form>`; panel.classList.remove('hidden');
}

async function renderCommunications() {
  const [messages, leads, providers] = await Promise.all([
    api(`${workspacePath('messages')}?limit=50`), api(`${workspacePath('leads')}?limit=100`), api(workspacePath('communications/providers'))
  ]);
  const messageRows = (messages.data ?? []).map(message => `<tr><td>${escapeHtml(message.channel)}</td><td>${escapeHtml(message.direction)}</td><td>${escapeHtml(message.subject || (message.body || '').slice(0, 70) || '—')}</td><td>${badge(message.status)}</td><td>${fmtDate(message.created_at, { time: true })}</td></tr>`).join('') || '<tr><td colspan="5" class="empty-state">Drafts and delivery events will appear here.</td></tr>';
  setPage(`${pageHeading('RED BLACK ADAPTERS', 'Communications', 'Prepare clear messages and keep channel history in one place.')}
    <div class="notice">WhatsApp remains manual by default. This page creates a draft only; no message is sent until a provider adapter is configured, consent is recorded and an authorized user takes the send action.</div>
    <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Create a message draft</h2><p class="panel-subtitle">Provider-neutral draft; the current workbook’s manual-send behavior is preserved.</p></div></div><form id="messageDraftForm" class="panel-body"><div class="field-grid"><label>Lead<select name="leadId" required><option value="">Choose a lead</option>${(leads.data ?? []).map(lead => `<option value="${escapeHtml(lead.id)}">${escapeHtml([lead.first_name,lead.last_name].filter(Boolean).join(' ') || lead.email || lead.phone || lead.id)}</option>`).join('')}</select></label><label>Channel<select name="channel"><option>whatsapp</option><option>email</option><option>rcs</option></select></label><label class="span-2">Subject<input name="subject" maxlength="500"></label><label class="span-2">Message<textarea name="body" required maxlength="10000"></textarea></label></div><button class="button button-primary">Save draft</button></form></section>
    <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Provider adapters</h2><p class="panel-subtitle">No provider account or paid subscription is assumed.</p></div></div><div class="panel-body"><div class="notice">${(providers.configuredAdapters ?? []).length ? `Runtime adapters: ${escapeHtml(providers.configuredAdapters.join(', '))}` : 'No runtime send adapters are installed. Email, WhatsApp, RCS and Voice remain available as RedBlack-owned adapter boundaries.'}</div></div></section>
    <section class="panel"><div class="panel-header"><h2 class="panel-title">Message history</h2></div><div class="table-wrap"><table><thead><tr><th>Channel</th><th>Direction</th><th>Content</th><th>Status</th><th>Created</th></tr></thead><tbody>${messageRows}</tbody></table></div></section>`);
}

async function renderCalling() {
  const [calls, leads] = await Promise.all([api(`${workspacePath('calls')}?limit=50`), api(`${workspacePath('leads')}?limit=100`)]);
  const rows = (calls.data ?? []).map(call => `<tr><td>${escapeHtml(call.direction)}</td><td>${escapeHtml(call.provider || 'Manual log')}</td><td>${badge(call.status)}</td><td>${fmtDate(call.started_at, { time: true })}</td><td>${fmtNumber(call.duration_seconds)} sec</td><td>${escapeHtml(call.disposition || '—')}</td></tr>`).join('') || '<tr><td colspan="6" class="empty-state">No calls are logged yet.</td></tr>';
  setPage(`${pageHeading('RED BLACK VOICE ADAPTER', 'Calling', 'Record call outcomes and keep the history with each lead.')}
    <div class="notice">Calling is provider-neutral. With no call adapter configured, Core supports manual call records and verified event ingestion; it will not start paid calls.</div>
    <section class="panel"><div class="panel-header"><h2 class="panel-title">Log a call</h2></div><form id="callForm" class="panel-body"><div class="field-grid"><label>Lead<select name="leadId"><option value="">No linked lead</option>${(leads.data ?? []).map(lead => `<option value="${escapeHtml(lead.id)}">${escapeHtml([lead.first_name,lead.last_name].filter(Boolean).join(' ') || lead.email || lead.phone || lead.id)}</option>`).join('')}</select></label><label>Direction<select name="direction"><option>outbound</option><option>inbound</option></select></label><label>Status<select name="status"><option>answered</option><option>missed</option><option>busy</option><option>failed</option></select></label><label>Duration in seconds<input name="durationSeconds" type="number" min="0" value="0"></label><label>Started at<input name="startedAt" type="datetime-local"></label><label>Answered at<input name="answeredAt" type="datetime-local"></label><label>Ended at<input name="endedAt" type="datetime-local"></label><label>Disposition<input name="disposition" maxlength="160"></label><label class="span-2">Call notes<textarea name="metadataNotes" maxlength="2000"></textarea></label></div><button class="button button-primary">Save call record</button></form></section>
    <section class="panel"><div class="panel-header"><h2 class="panel-title">Call history</h2></div><div class="table-wrap"><table><thead><tr><th>Direction</th><th>Provider</th><th>Status</th><th>Started</th><th>Duration</th><th>Disposition</th></tr></thead><tbody>${rows}</tbody></table></div></section>`);
}



const automationActionTypes = ['create_task','create_activity','change_stage','create_message_draft','update_lead','assign_owner','create_note','invoke_ai','schedule_follow_up','send_communication','start_call'];
const automationFields = ['lead.score','lead.status','lead.temperature','lead.budget','lead.location','lead.email','lead.phone','lead.owner_user_id','event.pipelineId','event.fromStageId','event.stageId','event.status','event.channel','event.provider','event.subject','event.direction','event.durationSeconds','event.messageId','event.callId','event.objectType','event.waitResult.timedOut'];
const automationOperators = ['=','!=','>','>=','<','<=','contains','does not contain','is empty','is not empty','in','not in'];

function automationDefaultConfig(type) {
  if (type === 'create_task') return { title: 'Follow up', dueInMinutes: 60, assignTo: 'owner' };
  if (type === 'create_activity' || type === 'create_note') return { title: 'Automation activity', body: '' };
  if (type === 'wait') return { minutes: 60 };
  if (type === 'schedule_follow_up') return { title: 'Follow up', dueInMinutes: 60 };
  if (type === 'create_message_draft') return { channel: 'whatsapp', body: '' };
  if (type === 'send_communication') return { channel: 'whatsapp', provider: '', to: '', body: '' };
  if (type === 'invoke_ai') return { prompt: '', processing: 'standard' };
  if (type === 'start_call') return { provider: '', direction: 'outbound', to: '' };
  if (type === 'update_lead') return { status: 'Qualified' };
  if (type === 'change_stage') return { pipelineId: '', stageId: '' };
  if (type === 'assign_owner') return { userId: '' };
  return {};
}

const automationWaitEvents = [
  ['message.incoming','Incoming message'],['email.incoming','Incoming email'],
  ['meeting.created','Appointment created'],['appointment.created','Appointment booked'],
  ['meeting.missed','Appointment missed'],['appointment.missed','Appointment missed'],
  ['call.completed','Call completed'],['lead.updated','Lead updated'],
  ['lead.stage_changed','Stage changed'],['lead.score_changed','Score changed']
];
function renderWaitConfig(node) {
  const mode=node.mode??'duration';
  if(mode==='condition'&&!node.condition)node.condition={all:[{field:'lead.status',operator:'=',value:'Connected'}]};
  const modeOptions=[['duration','For a duration'],['event','Until an event'],['condition','Until a condition']];
  let settings='';
  if(mode==='duration')settings=`<label>Wait minutes<input type="number" min="1" max="525600" data-wait-key="minutes" data-node-id="${escapeHtml(node.id)}" value="${escapeHtml(node.minutes??60)}"></label>`;
  else if(mode==='event')settings=`<label>Resume when<select data-wait-key="eventType" data-node-id="${escapeHtml(node.id)}">${automationWaitEvents.map(([value,label])=>`<option value="${value}" ${node.eventType===value?'selected':''}>${label}</option>`).join('')}</select></label><label>Timeout minutes (optional)<input type="number" min="1" max="525600" data-wait-key="timeoutMinutes" data-node-id="${escapeHtml(node.id)}" value="${escapeHtml(node.timeoutMinutes??'')}"></label>`;
  else if(mode==='condition')settings=`${renderConditionTree(node.id,node.condition)}<label>Timeout minutes (optional)<input type="number" min="1" max="525600" data-wait-key="timeoutMinutes" data-node-id="${escapeHtml(node.id)}" value="${escapeHtml(node.timeoutMinutes??'')}"></label>`;
  return `<label>Wait type<select data-wait-key="mode" data-node-id="${escapeHtml(node.id)}">${modeOptions.map(([value,label])=>`<option value="${value}" ${mode===value?'selected':''}>${label}</option>`).join('')}</select></label>${settings}`;
}

function newAutomationGraph() {
  const action = { id: 'action_start', label: 'Create follow-up task', type: 'action', action: { type: 'create_task', config: automationDefaultConfig('create_task') } };
  return { version: 1, startNodeId: action.id, nodes: [action, { id: 'end', label: 'Complete', type: 'end' }], edges: [{ from: action.id, to: 'end', label: 'next' }] };
}
function ensureAutomationGraph() { if (!appState.automationGraph) appState.automationGraph = newAutomationGraph(); return appState.automationGraph; }
function graphNode(id) { return ensureAutomationGraph().nodes.find(node => node.id === id); }
function graphPathExists(from, target, ignoredFrom, ignoredLabel) {
  const edges = ensureAutomationGraph().edges.filter(edge => !(edge.from === ignoredFrom && edge.label === ignoredLabel));
  const seen = new Set(); const visit = id => { if (id === target) return true; if (seen.has(id)) return false; seen.add(id); return edges.some(edge => edge.from === id && visit(edge.to)); };
  return visit(from);
}
function graphTargetSelect(node, label) {
  const graph = ensureAutomationGraph(); const current = graph.edges.find(edge => edge.from === node.id && edge.label === label);
  const choices = graph.nodes.filter(item => item.id !== node.id && (!graphPathExists(item.id, node.id, node.id, label) || item.id === current?.to));
  return `<label class="workflow-connection">${label === 'yes' ? 'YES →' : label === 'no' ? 'NO →' : 'Next →'}<select data-graph-connection data-node-id="${escapeHtml(node.id)}" data-label="${label}" aria-label="${label} connection">${choices.map(item => `<option value="${escapeHtml(item.id)}" ${current?.to === item.id ? 'selected' : ''}>${escapeHtml(item.label || (item.type === 'end' ? 'End' : item.id))}</option>`).join('')}</select></label>`;
}
function renderConditionTree(nodeId, condition, path = 'condition') {
  if (condition?.all || condition?.any) {
    const groupKey = condition.all ? 'all' : 'any'; const children = condition[groupKey] ?? [];
    return `<div class="workflow-condition-group"><div class="inline-form"><label>Match<select data-condition-group data-node-id="${escapeHtml(nodeId)}" data-condition-path="${path}"><option value="all" ${groupKey==='all'?'selected':''}>ALL conditions (AND)</option><option value="any" ${groupKey==='any'?'selected':''}>ANY condition (OR)</option></select></label><button type="button" class="quiet-button" data-action="add-condition-rule" data-node-id="${escapeHtml(nodeId)}" data-condition-path="${path}">+ Rule</button><button type="button" class="quiet-button" data-action="add-condition-group" data-node-id="${escapeHtml(nodeId)}" data-condition-path="${path}">+ Group</button>${path==='condition'?'':`<button type="button" class="quiet-button" data-action="remove-condition-group" data-node-id="${escapeHtml(nodeId)}" data-condition-path="${path}">Remove group</button>`}</div>${children.map((child,index)=>renderConditionTree(nodeId,child,`${path}.${groupKey}.${index}`)).join('')}</div>`;
  }
  const field=condition?.field??'lead.score', operator=condition?.operator??'>=';
  const value=Array.isArray(condition?.value)?condition.value.join(', '):(condition?.value??'');
  return `<div class="workflow-condition-rule"><select data-condition-key="field" data-node-id="${escapeHtml(nodeId)}" data-condition-path="${path}">${automationFields.concat((appState.automationCustomFields??[]).map(field=>`lead.custom.${field.field_key}`)).map(item=>`<option ${item===field?'selected':''}>${item}</option>`).join('')}</select><select data-condition-key="operator" data-node-id="${escapeHtml(nodeId)}" data-condition-path="${path}">${automationOperators.map(item=>`<option ${item===operator?'selected':''}>${item}</option>`).join('')}</select><input data-condition-key="value" data-node-id="${escapeHtml(nodeId)}" data-condition-path="${path}" value="${escapeHtml(value)}" aria-label="Comparison value" placeholder="Comma-separated for in / not in"><button type="button" class="quiet-button" data-action="remove-condition" data-node-id="${escapeHtml(nodeId)}" data-condition-path="${path}" aria-label="Remove condition">Remove</button></div>`;
}
function automationConfigField(node,key,label,kind='text') {
  const config=node.action.config??{}; const value=config[key]??'';
  if (kind==='owner') return `<label>${label}<select data-automation-config data-node-id="${escapeHtml(node.id)}" data-key="${key}"><option value="">Use lead owner / default</option>${(appState.automationMembers??[]).map(member=>`<option value="${escapeHtml(member.user_id)}" ${value===member.user_id?'selected':''}>${escapeHtml(member.display_name||member.email)}</option>`).join('')}</select></label>`;
  if (kind==='pipeline') return `<label>${label}<select data-automation-config data-node-id="${escapeHtml(node.id)}" data-key="pipelineId"><option value="">Choose pipeline</option>${(appState.automationPipelines??[]).map(p=>`<option value="${escapeHtml(p.id)}" ${config.pipelineId===p.id?'selected':''}>${escapeHtml(p.name)}</option>`).join('')}</select></label><label>Stage<select data-automation-config data-node-id="${escapeHtml(node.id)}" data-key="stageId"><option value="">Choose stage</option>${(appState.automationPipelines??[]).flatMap(p=>(p.stages??[]).map(s=>`<option value="${escapeHtml(s.id)}" ${config.stageId===s.id?'selected':''}>${escapeHtml(p.name)} · ${escapeHtml(s.name)}</option>`)).join('')}</select></label>`;
  if (kind==='select') {
    const options=key==='channel'?['email','whatsapp','rcs']:key==='assignTo'?['owner','current']:key==='direction'?['inbound','outbound']:key==='temperature'?['hot','warm','cold']:key==='processing'?['standard']:[];
    return `<label>${label}<select data-automation-config data-node-id="${escapeHtml(node.id)}" data-key="${key}">${options.map(item=>`<option value="${item}" ${value===item?'selected':''}>${item}</option>`).join('')}</select></label>`;
  }
  const tag=kind==='textarea'?'textarea':'input'; const attrs=kind==='number'?'type="number" min="0" step="1"':'type="text"';
  return kind==='textarea' ? `<label class="span-2">${label}<textarea data-automation-config data-node-id="${escapeHtml(node.id)}" data-key="${key}" maxlength="10000">${escapeHtml(value)}</textarea></label>` : `<label>${label}<${tag} ${attrs} data-automation-config data-node-id="${escapeHtml(node.id)}" data-key="${key}" value="${escapeHtml(value)}"></label>`;
}
function renderAutomationActionConfig(node) {
  const type=node.action.type; const fields={
    create_task:[['title','Task title'],['description','Task notes','textarea'],['dueInMinutes','Due in minutes','number'],['assignTo','Assign to','select']],
    create_activity:[['title','Activity title'],['body','Activity details','textarea']],
    create_note:[['title','Note title'],['body','Note','textarea']],
    schedule_follow_up:[['title','Follow-up title'],['dueInMinutes','Due in minutes','number']],
    create_message_draft:[['channel','Channel','select'],['subject','Subject'],['body','Message','textarea']],
    send_communication:[['channel','Channel','select'],['provider','Configured provider name'],['to','Destination'],['subject','Subject'],['body','Message','textarea']],
    invoke_ai:[['prompt','AI instruction','textarea'],['model','Model override (optional)'],['processing','Processing mode','select']],
    start_call:[['provider','Configured calling provider'],['direction','Direction','select'],['to','Phone number']],
    change_stage:[['pipelineId','Pipeline','pipeline']],
    assign_owner:[['userId','Owner','owner']],
    update_lead:[['status','Set status'],['temperature','Set temperature','select'],['score','Set score','number'],['nextAction','Next action'],['notes','Add/replace notes','textarea']]
  }[type]??[];
  return `<div class="field-grid">${fields.map(([key,label,kind='text'])=>automationConfigField(node,key,label,kind)).join('')}</div>`;
}
function renderAutomationGraph() {
  const root=$('#automationSteps'); if(!root)return; const graph=ensureAutomationGraph();
  root.innerHTML=`<div class="workflow-canvas" aria-label="Automation workflow graph">${graph.nodes.map((node,index)=>`<article class="pipeline-card workflow-node" draggable="true" data-automation-node="${escapeHtml(node.id)}"><div class="panel-header"><div><span class="badge">${node.type==='end'?'END':node.type==='condition'?'BRANCH':node.type==='wait'?'WAIT':'ACTION'}</span> <strong>${escapeHtml(node.label||node.id)}</strong></div>${node.type==='end'?'':`<button type="button" class="text-button" data-action="remove-automation-node" data-node-id="${escapeHtml(node.id)}">Remove</button>`}</div>${node.type==='end'?'':`<label>Step name<input data-node-label data-node-id="${escapeHtml(node.id)}" value="${escapeHtml(node.label||'')}" maxlength="80"></label>`}${node.type==='condition'?renderConditionTree(node.id,node.condition):node.type==='action'?`<label>Action<select data-automation-action-type data-node-id="${escapeHtml(node.id)}">${automationActionTypes.map(type=>`<option value="${type}" ${node.action.type===type?'selected':''}>${escapeHtml(type.replaceAll('_',' '))}</option>`).join('')}</select></label>${renderAutomationActionConfig(node)}`:node.type==='wait'?renderWaitConfig(node):''}${node.type==='condition'?graphTargetSelect(node,'yes')+graphTargetSelect(node,'no'):node.type==='end'?'':graphTargetSelect(node,'next')}</article>`).join('<div class="workflow-edge" aria-hidden="true">↓</div>')}</div>`;
  root.ondragstart=event=>{const card=event.target.closest('[data-automation-node]');if(card)event.dataTransfer.setData('text/plain',card.dataset.automationNode);};
  root.ondragover=event=>event.preventDefault();
  root.ondrop=event=>{ event.preventDefault(); const from=event.dataTransfer.getData('text/plain'); const target=event.target.closest('[data-automation-node]'); if(!from||!target||from===target.dataset.automationNode)return; const nodes=graph.nodes.filter(node=>node.type!=='end'); const moving=nodes.findIndex(node=>node.id===from),to=nodes.findIndex(node=>node.id===target.dataset.automationNode); if(moving<0||to<0)return; const [node]=nodes.splice(moving,1); nodes.splice(to,0,node); graph.nodes=[...nodes,graph.nodes.find(node=>node.type==='end')]; renderAutomationGraph(); };
}
function addAutomationNode(type) {
  const graph=ensureAutomationGraph();
  if (graph.nodes.length >= 50) { showToast('This workflow already has the 50-node maximum.', 'error'); return; }
  if (type !== 'condition' && graph.nodes.filter(node=>node.type==='action'||node.type==='wait').length >= 25) { showToast('This workflow already has the 25-action maximum.', 'error'); return; }
  const end=graph.nodes.find(node=>node.type==='end'); const id=`${type}_${crypto.randomUUID().slice(0,8)}`;
  const node=type==='condition'?{id,label:'Condition',type,condition:{all:[{field:'lead.score',operator:'>=',value:70}]}}:type==='wait'?{id,label:'Wait',type,minutes:60}:{id,label:type.replaceAll('_',' '),type:'action',action:{type,config:automationDefaultConfig(type)}};
  graph.edges.forEach(edge=>{if(edge.to===end.id)edge.to=id;});
  graph.nodes.splice(graph.nodes.indexOf(end),0,node);
  if(type==='condition') graph.edges.push({from:id,to:end.id,label:'yes'},{from:id,to:end.id,label:'no'});
  else graph.edges.push({from:id,to:end.id,label:'next'});
  renderAutomationGraph();
}
function removeAutomationNode(id) {
  const graph=ensureAutomationGraph(),node=graph.nodes.find(item=>item.id===id); if(!node||node.type==='end'||graph.nodes.length<=2)return;
  const out=graph.edges.filter(edge=>edge.from===id); const target=node.type==='condition'?out.find(edge=>edge.label==='yes')?.to:out.find(edge=>edge.label==='next')?.to;
  if(!target)return;
  if(graph.startNodeId===id)graph.startNodeId=target;
  graph.edges=graph.edges.flatMap(edge=>edge.to===id?[{...edge,to:target}]:edge.from===id?[]:[edge]);
  graph.nodes=graph.nodes.filter(item=>item.id!==id);
  const reachable=new Set(); const visit=current=>{if(reachable.has(current))return;reachable.add(current);graph.edges.filter(edge=>edge.from===current).forEach(edge=>visit(edge.to));};visit(graph.startNodeId);
  graph.nodes=graph.nodes.filter(item=>reachable.has(item.id)); graph.edges=graph.edges.filter(edge=>reachable.has(edge.from)&&reachable.has(edge.to));
  renderAutomationGraph();
}
function updateGraphConnection(select) {
  const graph=ensureAutomationGraph(),{nodeId,label}=select.dataset;
  graph.edges=graph.edges.filter(edge=>!(edge.from===nodeId&&edge.label===label));
  graph.edges.push({from:nodeId,to:select.value,label});
}
function conditionPathParts(path) { const parts=String(path||'').split('.').filter(Boolean); if(parts[0]==='condition')parts.shift(); return parts; }
function getConditionAt(node,path) { return conditionPathParts(path).reduce((value,key)=>/^\d+$/.test(key)?value?.[Number(key)]:value?.[key],node.condition); }
function setConditionAt(node,path,value) { const parts=conditionPathParts(path); const last=parts.pop(); const parent=parts.reduce((item,key)=>/^\d+$/.test(key)?item[Number(key)]:item[key],node.condition); if(/^\d+$/.test(last))parent[Number(last)]=value;else parent[last]=value; }
function handleConditionControl(control) {
  const node=graphNode(control.dataset.nodeId); if(!node)return; const {conditionPath,key}=control.dataset;
  if(control.matches('[data-condition-group]')) { const group=getConditionAt(node,conditionPath); const children=group.all??group.any??[]; delete group.all;delete group.any;group[control.value]=children;renderAutomationGraph();return; }
  const rule=getConditionAt(node,conditionPath);
  if(key==='value') { if(control.value==='')delete rule.value; else if(['in','not in'].includes(rule.operator))rule.value=control.value.split(',').map(value=>value.trim()).filter(Boolean);else if(control.value==='true'||control.value==='false')rule.value=control.value==='true';else if(control.value.trim()!==''&&Number.isFinite(Number(control.value)))rule.value=Number(control.value);else rule.value=control.value; }
  else rule[key]=key==='operator'?control.value.toLowerCase():control.value;
}
function addConditionChild(nodeId,path,nested) { const node=graphNode(nodeId),group=getConditionAt(node,path); const key=group.all?'all':'any'; group[key].push(nested?{any:[{field:'lead.status',operator:'=','value':'Connected'}]}:{field:'lead.status',operator:'=','value':'Connected'});renderAutomationGraph(); }
function removeConditionChild(nodeId,path) { const node=graphNode(nodeId),parts=conditionPathParts(path),index=Number(parts.pop()),groupKey=parts.pop(),group=getConditionAt(node,parts.join('.')); if(group?.[groupKey]?.length>1){group[groupKey].splice(index,1);renderAutomationGraph();} }
function removeConditionGroup(nodeId,path) { const node=graphNode(nodeId),parts=conditionPathParts(path),index=Number(parts.pop()),groupKey=parts.pop(),parent=getConditionAt(node,parts.join('.')); if(parent?.[groupKey]?.length>1){parent[groupKey].splice(index,1);renderAutomationGraph();} }

async function loadAutomationEditor(automationId, clone = false) {
  const item=await api(`${workspacePath(`automations/${encodeURIComponent(automationId)}`)}`); const definition=item.definition??{};
  appState.automationEditingId=clone?null:automationId;
  appState.automationTriggerConfig=definition.triggerConfig??item.trigger_config??{};
  if (definition.graph) appState.automationGraph=JSON.parse(JSON.stringify(definition.graph));
  else {
    const nodes=(definition.actions??[]).map((step,index)=>({id:`step_${index}`,type:step.type==='wait'?'wait':'action',...(step.type==='wait'?{minutes:step.config?.minutes??1}:{action:{type:step.type,config:step.config??{}}})}));
    if(!nodes.length)nodes.push({id:'action_start',type:'action',action:{type:'create_task',config:automationDefaultConfig('create_task')}});
    const end={id:'end',label:'Complete',type:'end'}; const edges=[];
    nodes.forEach((node,index)=>{const target=nodes[index+1]?.id??end.id;edges.push({from:node.id,to:target,label:node.type==='condition'?'yes':'next'});if(node.type==='condition')edges.push({from:node.id,to:target,label:'no'});});
    appState.automationGraph={version:1,startNodeId:nodes[0].id,nodes:[...nodes,end],edges};
  }
  $('#automationFormPanel')?.classList.remove('hidden'); const form=$('#automationForm'); if(!form)return;
  form.elements.name.value=clone?`${definition.name||item.name} copy`:(definition.name||item.name||'');
  form.elements.description.value=definition.description||item.description||''; form.elements.triggerType.value=definition.triggerType||item.trigger_type||'manual';
  form.elements.active.checked=clone?false:Boolean(item.active); renderAutomationGraph();
}

async function renderAutomations() {
  const [result,pipelines,members,customFields] = await Promise.all([api(`${workspacePath('automations')}`),api(workspacePath('pipelines')),api(workspacePath('members/choices')),api(`${workspacePath('custom-fields')}?entityType=lead`)]);
  appState.automationPipelines=pipelines.data??[]; appState.automationMembers=members.data??[]; appState.automationCustomFields=customFields.data??[];
  const canManage = ['owner','admin','manager'].includes(appState.role);
  if (!appState.automationGraph) appState.automationGraph = newAutomationGraph();
  const rows = (result.data ?? []).map(item => `<tr><td><div class="lead-name">${escapeHtml(item.name)}</div><div class="lead-sub">v${escapeHtml(item.current_version_id?.slice(0,8) || '—')} · ${escapeHtml(item.description || '')}</div></td><td>${badge(item.trigger_type)}</td><td>${badge(item.active ? 'active' : 'inactive')}</td><td>${canManage ? `<button class="quiet-button" data-action="edit-automation" data-id="${escapeHtml(item.id)}">Edit</button> <button class="quiet-button" data-action="clone-automation" data-id="${escapeHtml(item.id)}">Clone</button> <button class="quiet-button" data-action="test-automation" data-id="${escapeHtml(item.id)}">Test</button> <button class="quiet-button" data-action="run-automation" data-id="${escapeHtml(item.id)}">Queue run</button> <button class="quiet-button" data-action="automation-runs" data-id="${escapeHtml(item.id)}">Run history</button>` : '—'}</td></tr>`).join('') || '<tr><td colspan="4" class="empty-state">Add a workflow to automate sales work.</td></tr>';
  setPage(`${pageHeading('WORKFLOW ENGINE', 'Automations', 'Build versioned workflows with connected condition branches, actions and waits.', canManage ? '<button class="button button-primary" data-action="toggle-automation-form">+ New automation</button>' : '')}
    <div class="notice">Published workflow definitions are versioned. Provider-backed actions remain behind consent, configuration and idempotency controls.</div>
    <section id="automationFormPanel" class="panel hidden"><div class="panel-header"><h2 class="panel-title">Visual automation builder</h2><button class="text-button" data-action="toggle-automation-form">Close</button></div><form id="automationForm" class="panel-body"><div class="field-grid"><label>Name<input name="name" required maxlength="160"></label><label>Trigger<select name="triggerType"><option>manual</option><option>lead.created</option><option>lead.updated</option><option>lead.stage_changed</option><option>message.incoming</option><option>email.incoming</option><option>appointment.created</option><option>appointment.missed</option><option>task.completed</option><option>meeting.created</option><option>meeting.missed</option><option>call.completed</option><option>call.ended</option><option>lead.no_response</option><option>lead.score_changed</option><option>webhook.received</option></select></label><label class="span-2">Description<input name="description" maxlength="500"></label><p class="span-2 muted">Add condition nodes to configure ALL/ANY rules and YES/NO paths. Connections are saved with this workflow version.</p></div>
      <div class="panel-header"><div><h3 class="panel-title">Action palette</h3><p class="panel-subtitle">Add actions, conditions and waits, then connect each path.</p></div></div><div class="heading-actions">${automationActionTypes.map(type => `<button type="button" class="button button-secondary button-small" data-action="add-automation-step" data-type="${type}">+${escapeHtml(type.replaceAll('_',' '))}</button>`).join('')}<button type="button" class="button button-secondary button-small" data-action="add-automation-node" data-type="condition">+ Condition / branch</button><button type="button" class="button button-secondary button-small" data-action="add-automation-node" data-type="wait">+ Wait</button></div>
      <div id="automationSteps" class="panel-body"></div>
      <label class="checkbox-row"><input name="active" type="checkbox" class="checkbox-input"> Activate after saving</label><button class="button button-primary">Save workflow version</button></form></section>
    <section id="automationRunPanel" class="panel hidden"></section>
    <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Workflows</h2><p class="panel-subtitle">${fmtNumber(result.data?.length ?? 0)} workflows</p></div></div><div class="table-wrap"><table><thead><tr><th>Automation</th><th>Trigger</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div></section>`);
  renderAutomationGraph();
}

async function renderUsage() {
  const [usage, rates] = await Promise.all([api(`${workspacePath('usage')}?limit=50`), api(workspacePath('usage/rates'))]);
  const rateRows = (rates.data ?? []).map(rate => `<tr><td>${escapeHtml(rate.provider || 'Default')}</td><td>${escapeHtml(rate.service)} · ${escapeHtml(rate.usage_type)}</td><td>${escapeHtml(rate.unit)}</td><td>${fmtMoney(rate.provider_cost_per_unit, rate.currency)}</td><td>${fmtMoney(rate.customer_charge_per_unit, rate.currency)}</td><td>${fmtDate(rate.valid_from)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty-state">No active rate card exists. Estimates will return “rate not configured” until an admin adds one.</td></tr>';
  const usageRows = (usage.data ?? []).map(event => `<tr><td>${escapeHtml(event.service)} · ${escapeHtml(event.usage_type)}</td><td>${escapeHtml(event.quantity)} ${escapeHtml(event.unit)}</td><td>${event.provider_cost === null ? '—' : fmtMoney(event.provider_cost, event.currency)}</td><td>${event.internal_charge === null ? '—' : fmtMoney(event.internal_charge, event.currency)}</td><td>${fmtDate(event.occurred_at, { time: true })}</td></tr>`).join('') || '<tr><td colspan="5" class="empty-state">PAYG events appear when adapters or usage sources report activity.</td></tr>';
  const canManage = ['owner','admin'].includes(appState.role);
  setPage(`${pageHeading('PAYG METERING', 'Usage & cost', 'Estimate before execution and reconcile against actual provider cost.')}
    <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Cost calculator</h2><p class="panel-subtitle">Rates are versioned RedBlack Core data; no subscription pricing is assumed.</p></div></div><form id="estimateForm" class="panel-body"><div class="inline-form"><label>Service<select name="service"><option>voice</option><option>whatsapp</option><option>email</option><option>rcs</option><option>ai</option><option>automation</option></select></label><label>Usage type<input name="usageType" value="call_duration" required maxlength="80"></label><label>Quantity<input name="quantity" type="number" min="0" step="0.000001" value="60" required></label><label>Unit<input name="unit" value="second" required maxlength="60"></label><label>Provider<input name="provider" maxlength="120"></label><button class="button button-dark">Estimate cost</button></div><div id="estimateResult"></div></form></section>
    ${canManage ? `<section class="panel"><div class="panel-header"><div><h2 class="panel-title">Add a rate version</h2><p class="panel-subtitle">New rates take effect from the selected date; old versions remain auditable.</p></div></div><form id="rateForm" class="panel-body"><div class="field-grid"><label>Provider (optional)<input name="provider" maxlength="120"></label><label>Service<input name="service" required maxlength="80"></label><label>Usage type<input name="usageType" required maxlength="80"></label><label>Unit<input name="unit" required maxlength="60"></label><label>Provider cost per unit<input name="providerCostPerUnit" type="number" min="0" step="0.00000001" required></label><label>Customer charge per unit<input name="customerChargePerUnit" type="number" min="0" step="0.00000001" required></label><label>Currency<input name="currency" value="INR" minlength="3" maxlength="3" required></label><label>Valid from<input name="validFrom" type="datetime-local"></label></div><button class="button button-primary">Publish rate version</button></form></section>` : ''}
    <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Rate versions</h2><p class="panel-subtitle">${fmtNumber(rates.data?.length ?? 0)} available rates</p></div></div><div class="table-wrap"><table><thead><tr><th>Provider</th><th>Service</th><th>Unit</th><th>Provider cost</th><th>Customer charge</th><th>Effective</th></tr></thead><tbody>${rateRows}</tbody></table></div></section>
    <section class="panel"><div class="panel-header"><h2 class="panel-title">Usage ledger</h2></div><div class="table-wrap"><table><thead><tr><th>Service</th><th>Quantity</th><th>Provider cost</th><th>Internal charge</th><th>Occurred</th></tr></thead><tbody>${usageRows}</tbody></table></div></section>`);
}

async function renderReports() {
  const [sales, agents, sources] = await Promise.all(['sales','agents','sources'].map(name => api(`${workspacePath(`reports/${name}`)}`)));
  const s = sales.summary ?? {};
  setPage(`${pageHeading('PERFORMANCE', 'Reports', 'Review the lead funnel, team activity and source quality.')}
    <section class="metrics">${metric('New leads', fmtNumber(s.new_leads), 'Last 30 days')}${metric('Qualified', fmtNumber(s.qualified), 'Hot or warm status')}${metric('Connected calls', fmtNumber(s.connected_calls), `${fmtNumber(s.talk_time_seconds)} talk seconds`)}${metric('Revenue', fmtMoney(s.revenue), `${fmtNumber(s.meetings)} meetings`)}</section>
    <section class="dashboard-grid"><article class="panel"><div class="panel-header"><h2 class="panel-title">Agent activity</h2></div><div class="table-wrap"><table><thead><tr><th>Agent</th><th>Assigned</th><th>Tasks done</th><th>Connected calls</th><th>Meetings</th></tr></thead><tbody>${(agents.data ?? []).map(row => `<tr><td>${escapeHtml(row.display_name)}</td><td>${fmtNumber(row.assigned_leads)}</td><td>${fmtNumber(row.completed_tasks)}</td><td>${fmtNumber(row.connected_calls)}</td><td>${fmtNumber(row.meetings)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty-state">No agent activity for this period.</td></tr>'}</tbody></table></div></article>
      <article class="panel"><div class="panel-header"><h2 class="panel-title">Lead sources</h2></div><div class="table-wrap"><table><thead><tr><th>Source</th><th>Leads</th><th>Won</th><th>Qualified</th></tr></thead><tbody>${(sources.data ?? []).map(row => `<tr><td>${escapeHtml(row.source)}</td><td>${fmtNumber(row.leads)}</td><td>${fmtNumber(row.won)}</td><td>${fmtNumber(row.qualified)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty-state">No source data yet.</td></tr>'}</tbody></table></div></article></section>`);
}

function openCustomFieldEditor(fieldId) {
  const field=(appState.customFieldCache??[]).find(item=>item.id===fieldId); if(!field)return;
  const config=field.config??{}; const panel=$('#customFieldEditPanel'); if(!panel)return;
  panel.innerHTML=`<div class="panel-header"><div><h2 class="panel-title">Edit custom field</h2><p class="panel-subtitle"><code>${escapeHtml(field.field_key)}</code> · ${escapeHtml(field.field_type)}</p></div><button class="text-button" data-action="close-custom-field-edit">Close</button></div>
    <form id="customFieldEditForm" data-field-id="${escapeHtml(field.id)}" class="panel-body"><div class="field-grid">
      <label>Label<input name="label" value="${escapeHtml(field.label)}" required maxlength="160"></label>
      <label>Section<input name="section" value="${escapeHtml(config.section??'Details')}" maxlength="120"></label>
      <label>Order<input name="order" type="number" min="0" value="${escapeHtml(config.order??0)}"></label>
      <label class="span-2">Options (comma-separated)<input name="options" value="${escapeHtml((config.options??[]).join(', '))}" maxlength="1000"></label>
      <label class="checkbox-row"><input name="required" type="checkbox" class="checkbox-input" ${field.required?'checked':''}> Required</label>
      <label class="checkbox-row"><input name="visible" type="checkbox" class="checkbox-input" ${config.visible===false?'':'checked'}> Visible</label>
      <label class="checkbox-row"><input name="readOnly" type="checkbox" class="checkbox-input" ${config.readOnly?'checked':''}> Read only</label>
    </div><button class="button button-primary">Save field settings</button></form>`;
  panel.classList.remove('hidden');
}

async function renderWorkspace() {
  const [workspace, members, fields, tags, sources, taskTypes, assignmentRules, scoringRules, layouts] = await Promise.all([
    api(workspacePath()), api(workspacePath('members')), api(`${workspacePath('custom-fields')}?entityType=lead`), api(workspacePath('tags')),
    api(workspacePath('lead-sources')), api(workspacePath('task-types')), api(workspacePath('assignment-rules')), api(workspacePath('scoring-rules')), api(`${workspacePath('layouts')}?entityType=lead`)
  ]);
  const canManage = ['owner','admin'].includes(appState.role);
  appState.customFieldCache = fields.data ?? [];
  const fieldRows = (fields.data ?? []).map(field => `<tr><td>${escapeHtml(field.label)}</td><td><code>${escapeHtml(field.field_key)}</code></td><td>${badge(field.field_type)}</td><td>${field.required ? 'Required' : 'Optional'}</td><td>${canManage ? `<button class="quiet-button" data-action="edit-custom-field" data-id="${escapeHtml(field.id)}">Edit</button> <button class="quiet-button" data-action="field-required" data-required="${field.required ? 'false' : 'true'}" data-id="${escapeHtml(field.id)}">${field.required ? 'Make optional' : 'Make required'}</button>` : '—'}</td></tr>`).join('') || '<tr><td colspan="5" class="empty-state">No custom lead fields configured.</td></tr>';
  const tagRows = (tags.data ?? []).map(tag => `<span class="badge">${escapeHtml(tag.name)}</span>`).join(' ') || '<span class="muted">No tags configured.</span>';
  setPage(`${pageHeading('CRM BUILDER', 'Workspace', 'Configure the team boundary, CRM fields, tags and operating defaults without rebuilding the application.')}
    <section class="panel"><div class="panel-header"><h2 class="panel-title">Workspace profile</h2><span class="badge">${escapeHtml(appState.role)}</span></div><div class="panel-body"><dl class="key-value"><dt>Name</dt><dd>${escapeHtml(workspace.name)}</dd><dt>Workspace slug</dt><dd>${escapeHtml(workspace.slug)}</dd><dt>Timezone</dt><dd>${escapeHtml(workspace.timezone)}</dd><dt>Currency</dt><dd>${escapeHtml(workspace.currency)}</dd></dl></div></section>
    ${canManage ? `<section class="panel"><div class="panel-header"><h2 class="panel-title">Update workspace</h2></div><form id="workspaceForm" class="panel-body"><div class="inline-form"><label>Workspace name<input name="name" value="${escapeHtml(workspace.name)}" required maxlength="120"></label><label>Timezone<input name="timezone" value="${escapeHtml(workspace.timezone)}" required maxlength="80"></label><label>Currency<input name="currency" value="${escapeHtml(workspace.currency)}" minlength="3" maxlength="3" required></label><button class="button button-primary">Save settings</button></div></form></section>` : ''}
    <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Lead fields</h2><p class="panel-subtitle">Workspace-scoped custom field definitions</p></div></div><div class="table-wrap"><table><thead><tr><th>Label</th><th>Key</th><th>Type</th><th>Requirement</th><th></th></tr></thead><tbody>${fieldRows}</tbody></table></div>
      ${canManage ? `<form id="customFieldForm" class="panel-body"><div class="inline-form"><label>Label<input name="label" required maxlength="160"></label><label>Key<input name="fieldKey" required maxlength="80" pattern="[A-Za-z0-9_]+"></label><label>Type<select name="fieldType"><option>text</option><option>textarea</option><option>number</option><option>currency</option><option>date</option><option>datetime</option><option>boolean</option><option>select</option><option>multiselect</option><option>email</option><option>phone</option><option>url</option></select></label><label>Section<input name="section" value="Details" maxlength="120"></label><label>Order<input name="order" type="number" min="0" value="0"></label><label>Options (comma-separated)<input name="options" maxlength="1000"></label><label class="checkbox-row"><input name="required" type="checkbox" class="checkbox-input"> Required</label><label class="checkbox-row"><input name="readOnly" type="checkbox" class="checkbox-input"> Read only</label><button class="button button-primary">Add field</button></div></form>` : ''}</section>
    <section id="customFieldEditPanel" class="panel hidden"></section>
    <section class="panel"><div class="panel-header"><h2 class="panel-title">Tags</h2></div><div class="panel-body"><div class="heading-actions">${tagRows}</div>${canManage ? `<form id="tagForm" class="inline-form"><label>New tag<input name="name" required maxlength="80"></label><button class="button button-primary">Add tag</button></form>` : ''}</div></section>
    <section class="panel"><div class="panel-header"><h2 class="panel-title">Lead sources & task types</h2></div><div class="panel-body"><div class="heading-actions">${(sources.data??[]).map(item=>badge(item.name)).join(' ')||'<span class="muted">No lead sources.</span>'}</div><div class="heading-actions">${(taskTypes.data??[]).map(item=>badge(item.name)).join(' ')||'<span class="muted">No custom task types.</span>'}</div>${canManage?`<div class="field-grid"><form id="leadSourceForm" class="inline-form"><label>Lead source<input name="name" required maxlength="120"></label><button class="button button-secondary">Add source</button></form><form id="taskTypeForm" class="inline-form"><label>Task type<input name="name" required maxlength="120"></label><button class="button button-secondary">Add task type</button></form></div>`:''}</div></section>
    <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Assignment rules</h2><p class="panel-subtitle">First matching active rule assigns new unowned leads.</p></div></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Strategy</th><th>Priority</th><th>Status</th><th></th></tr></thead><tbody>${(assignmentRules.data??[]).map(rule=>`<tr><td>${escapeHtml(rule.name)}</td><td>${badge(rule.strategy)}</td><td>${escapeHtml(rule.priority)}</td><td>${badge(rule.active?'active':'inactive')}</td><td>${canManage?`<button class="quiet-button" data-action="toggle-assignment-rule" data-id="${escapeHtml(rule.id)}" data-active="${rule.active?'false':'true'}">${rule.active?'Disable':'Enable'}</button>`:'—'}</td></tr>`).join('')||'<tr><td colspan="5" class="empty-state">No assignment rules.</td></tr>'}</tbody></table></div>${canManage?`<form id="assignmentRuleForm" class="panel-body"><div class="field-grid"><label>Name<input name="name" required maxlength="160"></label><label>Priority<input name="priority" type="number" value="100" min="0"></label><label>Strategy<select name="strategy"><option value="round_robin">Round robin</option><option value="fixed_owner">Fixed owner</option><option value="unassigned">Leave unassigned</option></select></label><label>Fixed owner<select name="userId"><option value="">—</option>${(members.data??[]).filter(m=>m.active).map(m=>`<option value="${escapeHtml(m.id||m.user_id)}">${escapeHtml(m.display_name)}</option>`).join('')}</select></label><label class="span-2">Conditions JSON<textarea name="conditions" placeholder='{"all":[{"field":"location","operator":"contains","value":"Goa"}]}'></textarea></label></div><button class="button button-primary">Add assignment rule</button></form>`:''}</section>
    <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Lead scoring rules</h2><p class="panel-subtitle">Matching rules combine into a deterministic lead score.</p></div></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Score</th><th>Priority</th><th>Status</th><th></th></tr></thead><tbody>${(scoringRules.data??[]).map(rule=>`<tr><td>${escapeHtml(rule.name)}</td><td>${escapeHtml(rule.score_delta)}</td><td>${escapeHtml(rule.priority)}</td><td>${badge(rule.active?'active':'inactive')}</td><td>${canManage?`<button class="quiet-button" data-action="toggle-scoring-rule" data-id="${escapeHtml(rule.id)}" data-active="${rule.active?'false':'true'}">${rule.active?'Disable':'Enable'}</button>`:'—'}</td></tr>`).join('')||'<tr><td colspan="5" class="empty-state">No scoring rules.</td></tr>'}</tbody></table></div>${canManage?`<form id="scoringRuleForm" class="panel-body"><div class="field-grid"><label>Name<input name="name" required maxlength="160"></label><label>Score delta<input name="scoreDelta" type="number" required value="10"></label><label>Priority<input name="priority" type="number" value="100" min="0"></label><label class="span-2">Conditions JSON<textarea name="conditions" required placeholder='{"all":[{"field":"budget","operator":">=","value":10000000}]}'></textarea></label></div><button class="button button-primary">Add scoring rule</button></form>`:''}</section>
    <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Lead list layouts</h2><p class="panel-subtitle">Choose which standard columns appear in the lead directory.</p></div></div><div class="panel-body"><div class="heading-actions">${(layouts.data??[]).map(layout=>badge(layout.name)).join(' ')||'<span class="muted">Default layout is active.</span>'}${canManage?`<form id="layoutForm"><div class="inline-form"><label>Name<input name="name" value="Sales layout" required maxlength="160"></label>${['project','status','budget','nextAction','owner','score','location'].map(column=>`<label class="checkbox-row"><input type="checkbox" name="layoutColumn" value="${column}" ${['project','status','budget','nextAction'].includes(column)?'checked':''}> ${column}</label>`).join('')}<button class="button button-secondary">Save layout</button></div></form>`:''}</div></div></section>
    <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Members</h2><p class="panel-subtitle">${fmtNumber(members.data?.length ?? 0)} active and invited users</p></div></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead><tbody>${(members.data ?? []).map(member => `<tr><td>${escapeHtml(member.display_name)}</td><td>${escapeHtml(member.email)}</td><td>${badge(member.role)}</td><td>${badge(member.active ? 'active' : 'inactive')}</td></tr>`).join('')}</tbody></table></div></section>
    ${canManage ? `<section class="panel"><div class="panel-header"><h2 class="panel-title">Add a team member</h2></div><form id="memberForm" class="panel-body"><div class="field-grid"><label>Name<input name="displayName" required maxlength="120"></label><label>Email<input name="email" type="email" required maxlength="320"></label><label>Initial password<input name="initialPassword" type="password" required minlength="12" maxlength="1024"></label><label>Role<select name="role"><option>agent</option><option>manager</option><option>reporting</option><option>admin</option><option>service</option></select></label></div><p class="muted small">Share the initial password with the member through your normal secure process. Email delivery is not enabled.</p><button class="button button-primary">Create member</button></form></section>` : ''}`);
}

async function renderView(view) {
  if (!viewAllowed(view, appState.role)) view = 'dashboard';
  appState.view = view;
  document.querySelectorAll('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  try {
    $('#viewRoot').onclick = null; $('#viewRoot').onsubmit = null; $('#viewRoot').onchange = null;
    if (['contacts','companies','deals','tickets'].includes(view)) await crmUI.list(view);
    else if (view === 'search') await crmUI.search();
    else if (view === 'notifications') await crmUI.notifications();
    else if (view === 'dashboard') await renderDashboard();
    else if (view === 'leads') await renderLeads();
    else if (view === 'trash') await renderTrash();
    else if (view === 'pipelines') await renderPipelines();
    else if (view === 'tasks') await renderTasks();
    else if (view === 'meetings') await renderMeetings();
    else if (view === 'communications') await crmUI.inbox();
    else if (view === 'calling') await renderCalling();
    else if (view === 'automations') await renderAutomations();
    else if (view === 'usage') await renderUsage();
    else if (view === 'reports') { await renderReports(); await crmUI.reports(); }
    else if (view === 'workspace') await renderWorkspace();
    else await renderDashboard();
  } catch (error) {
    setPage(`${pageHeading('REDBLACK CORE', 'We could not load this view', error.message)}<section class="panel"><div class="panel-body"><button class="button button-secondary" data-action="reload-view">Try again</button></div></section>`);
  }
}

function formObject(form) { return Object.fromEntries(new FormData(form).entries()); }
function localDateTime(value) { return value ? new Date(value).toISOString() : null; }

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const input = formObject(event.currentTarget);
  try {
    const session = await api('/auth/login', { method: 'POST', body: { email: input.email, password: input.password } });
    switchToApp(session);
  } catch (error) {
    if (error.status === 409 && error.payload?.workspaces?.length) {
      const select = $('#workspaceChoice');
      select.innerHTML = error.payload.workspaces.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(item.role)}</option>`).join('');
      $('#workspaceChoiceWrap').classList.remove('hidden');
      $('#loginButton').classList.add('hidden');
      showToast('Choose which workspace to open.', 'success');
    } else showToast(error.message, 'error');
  }
});

$('#selectWorkspaceButton').addEventListener('click', async () => {
  try {
    await api('/auth/select-workspace', { method: 'POST', body: { workspaceId: $('#workspaceChoice').value } });
    await boot();
  } catch (error) { showToast(error.message, 'error'); }
});

$('#showSetupButton').addEventListener('click', () => $('#setupForm').classList.toggle('hidden'));
$('#setupForm').addEventListener('submit', async event => {
  event.preventDefault(); const input = formObject(event.currentTarget);
  try {
    const session = await api('/auth/bootstrap', { method: 'POST', headers: { 'X-Bootstrap-Token': input.bootstrapToken }, body: { displayName: input.displayName, email: input.email, password: input.password, workspaceName: input.workspaceName, workspaceSlug: input.workspaceSlug } });
    showToast('Workspace created. Welcome to RedBlack Core.'); switchToApp(session);
  } catch (error) { showToast(error.message, 'error'); }
});

$('#logoutButton').addEventListener('click', async () => {
  try { await api('/auth/logout', { method: 'POST', body: {} }); } catch (error) { showToast(error.message, 'error'); }
  appState.user = null; appState.workspace = null; $('#appView').classList.add('hidden'); $('#authView').classList.remove('hidden');
});

$('#workspacePicker').addEventListener('change', async event => {
  try {
    await api('/auth/select-workspace', { method: 'POST', body: { workspaceId: event.target.value } });
    await boot();
  } catch (error) { showToast(error.message, 'error'); }
});

$('#mainNav').addEventListener('click', event => {
  const button = event.target.closest('[data-view]');
  if (button) renderView(button.dataset.view);
});

$('#viewRoot').addEventListener('click', async event => {
  const viewButton = event.target.closest('[data-view]');
  if (viewButton) { renderView(viewButton.dataset.view); return; }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id } = button.dataset;
  try {
    if (action === 'complete-task') { await api(`${workspacePath(`tasks/${encodeURIComponent(id)}`)}`, { method: 'PATCH', body: { status: 'completed' } }); showToast('Task completed.'); await renderView(appState.view); return; }
    if (action === 'toggle-new-lead') $('#newLeadPanel').classList.toggle('hidden');
    else if (action === 'toggle-import-leads') $('#leadImportPanel')?.classList.toggle('hidden');
    else if (action === 'preview-csv-import') {
      const file = $('#csvImportFile')?.files?.[0]; if (!file) throw new Error('Choose a CSV file.');
      const csv = await file.text();
      const preview = await api(workspacePath('leads/import/preview'), { method: 'POST', body: { csv } });
      appState.csvImportText = csv; appState.csvImportFields = preview.fields ?? []; appState.csvImportErrors = [];
      const headers = preview.headers ?? [];
      const mappingControls = appState.csvImportFields.map(field => `<label>${escapeHtml(field.label)}${field.required ? ' *' : ''}<select data-csv-map="${escapeHtml(field.key)}"><option value="">Do not import</option>${headers.map(header => `<option value="${escapeHtml(header)}" ${preview.suggestedMapping?.[field.key] === header ? 'selected' : ''}>${escapeHtml(header)}</option>`).join('')}</select></label>`).join('');
      const sampleHeaders = headers.slice(0, 10);
      const sampleRows = (preview.sampleRows ?? []).map(row => `<tr>${sampleHeaders.map((_, index) => `<td>${escapeHtml(row[index])}</td>`).join('')}</tr>`).join('');
      $('#csvImportPreview').innerHTML = `<p class="panel-subtitle">${fmtNumber(preview.rowCount)} data rows found. Map each CRM field to a file column; fields with * must be mapped.</p><div class="field-grid">${mappingControls}</div><h3 class="panel-title">First ${Math.min(5, preview.sampleRows?.length ?? 0)} rows${headers.length > 10 ? ` · showing 10 of ${headers.length} columns` : ''}</h3><div class="table-wrap"><table><thead><tr>${sampleHeaders.map(header => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${sampleRows || `<tr><td colspan="${Math.max(1, sampleHeaders.length)}" class="empty-state">No data rows found.</td></tr>`}</tbody></table></div>`;
      $('#csvImportPreview').classList.remove('hidden');
      const submit = $('#csvImportSubmit'); submit.textContent = `Import ${fmtNumber(preview.rowCount)} rows`; submit.disabled = preview.rowCount === 0; submit.classList.remove('hidden');
      $('#csvImportResult').replaceChildren();
    }
    else if (action === 'download-import-errors') downloadCsv('redblack-import-errors.csv', ['CSV row','Error'], appState.csvImportErrors.map(item => [item.row, item.message]));
    else if (action === 'toggle-lead-edit') $('#leadEditPanel')?.classList.toggle('hidden');
    else if (action === 'new-lead') { renderView('leads'); setTimeout(() => $('#newLeadPanel')?.classList.remove('hidden'), 0); }
    else if (action === 'lead-details') await renderLeadDetail(id);
    else if (action === 'restore-lead') { await api(`${workspacePath(`leads/${encodeURIComponent(id)}/restore`)}`, { method: 'POST', body: {} }); showToast('Lead restored.'); await renderTrash(); }
    else if (action === 'purge-lead') { if (!confirm('Permanently delete this trashed lead and its dependent CRM records? This cannot be undone.')) return; await api(`${workspacePath(`leads/${encodeURIComponent(id)}/permanent`)}`, { method: 'DELETE', body: {} }); showToast('Lead permanently deleted.'); await renderTrash(); }
    else if (action === 'select-lead') { if (button.checked) appState.selectedLeads.add(id); else appState.selectedLeads.delete(id); await renderLeads(); }
    else if (action === 'select-all-leads') { document.querySelectorAll('[data-action="select-lead"]').forEach(input => { input.checked = button.checked; if (button.checked) appState.selectedLeads.add(input.dataset.id); else appState.selectedLeads.delete(input.dataset.id); }); await renderLeads(); }
    else if (action === 'bulk-trash') { if (!confirm('Move selected leads to Trash?')) return; await api(workspacePath('leads/bulk'), { method: 'POST', body: { leadIds: [...appState.selectedLeads], operation: 'trash' } }); appState.selectedLeads.clear(); showToast('Selected leads moved to Trash.'); await renderLeads(); }
    else if (action === 'next-leads') { appState.cursor = button.dataset.cursor; await renderLeads(); }
    else if (action === 'next-trash') { appState.trashCursor = button.dataset.cursor; await renderTrash(); }
    else if (action === 'clear-lead-filters') { appState.cursor = null; appState.leadSearch = ''; appState.leadStatus = ''; appState.selectedLeads.clear(); await renderLeads(); }
    else if (action === 'toggle-task-form') $('#taskFormPanel').classList.toggle('hidden');
    else if (action === 'edit-task') openTaskEditor(id);
    else if (action === 'close-task-edit') $('#taskEditPanel')?.classList.add('hidden');
    else if (action === 'task-status') { await api(`${workspacePath(`tasks/${encodeURIComponent(id)}`)}`, { method: 'PATCH', body: { status: button.dataset.status } }); showToast('Task status updated.'); await renderTasks(); }
    else if (action === 'meeting-status') { await api(`${workspacePath(`meetings/${encodeURIComponent(id)}`)}`, { method: 'PATCH', body: { status: button.dataset.status } }); showToast('Meeting updated.'); await renderMeetings(); }
    else if (action === 'edit-meeting') openMeetingEditor(id);
    else if (action === 'close-meeting-edit') $('#meetingEditPanel')?.classList.add('hidden');
    else if (action === 'edit-custom-field') openCustomFieldEditor(id);
    else if (action === 'close-custom-field-edit') $('#customFieldEditPanel')?.classList.add('hidden');
    else if (action === 'field-required') { await api(`${workspacePath(`custom-fields/${encodeURIComponent(id)}`)}`, { method: 'PATCH', body: { required: button.dataset.required === 'true' } }); showToast('Field settings updated.'); await renderWorkspace(); }
    else if (action === 'toggle-assignment-rule') { await api(`${workspacePath(`assignment-rules/${encodeURIComponent(id)}`)}`, { method:'PATCH', body:{ active:button.dataset.active==='true' } }); showToast('Assignment rule updated.'); await renderWorkspace(); }
    else if (action === 'toggle-scoring-rule') { await api(`${workspacePath(`scoring-rules/${encodeURIComponent(id)}`)}`, { method:'PATCH', body:{ active:button.dataset.active==='true' } }); showToast('Scoring rule updated.'); await renderWorkspace(); }
    else if (action === 'toggle-automation-form') { appState.automationEditingId=null; appState.automationTriggerConfig={}; appState.automationGraph=newAutomationGraph(); const form=$('#automationForm'); if(form){form.reset();form.elements.active.checked=false;} renderAutomationGraph(); $('#automationFormPanel').classList.toggle('hidden'); }
    else if (action === 'edit-automation') await loadAutomationEditor(id, false);
    else if (action === 'clone-automation') await loadAutomationEditor(id, true);
    else if (action === 'test-automation') { const leadId=prompt('Lead ID for this safe dry run:'); if(!leadId)return; await api(`${workspacePath(`automations/${encodeURIComponent(id)}/test`)}`,{method:'POST',headers:{'Idempotency-Key':`test-${crypto.randomUUID()}`},body:{leadId}});showToast('Safe automation test queued. No actions will be applied.'); }
    else if (action === 'add-automation-step') addAutomationNode(button.dataset.type)
    else if (action === 'add-automation-node') addAutomationNode(button.dataset.type)
    else if (action === 'remove-automation-node') removeAutomationNode(button.dataset.nodeId)
    else if (action === 'add-condition-rule') addConditionChild(button.dataset.nodeId,button.dataset.conditionPath,false)
    else if (action === 'add-condition-group') addConditionChild(button.dataset.nodeId,button.dataset.conditionPath,true)
    else if (action === 'remove-condition') removeConditionChild(button.dataset.nodeId,button.dataset.conditionPath)
    else if (action === 'remove-condition-group') removeConditionGroup(button.dataset.nodeId,button.dataset.conditionPath)
    else if (action === 'automation-runs') { const runs = await api(`${workspacePath(`automations/${encodeURIComponent(id)}/runs`)}?limit=50`); const panel=$('#automationRunPanel'); panel.innerHTML=`<div class="panel-header"><h2 class="panel-title">Run history</h2></div><div class="table-wrap"><table><thead><tr><th>Status</th><th>Attempts</th><th>Started</th><th>Completed</th><th>Error</th><th></th></tr></thead><tbody>${(runs.data??[]).map(run=>`<tr><td>${badge(run.status)}</td><td>${escapeHtml(run.attempt_count)}</td><td>${fmtDate(run.started_at,{time:true})}</td><td>${fmtDate(run.completed_at,{time:true})}</td><td>${escapeHtml(run.error_message||'—')}</td><td><button class="quiet-button" data-action="automation-run-detail" data-id="${escapeHtml(id)}" data-run-id="${escapeHtml(run.id)}">Details</button></td></tr>`).join('')||'<tr><td colspan="6" class="empty-state">No runs yet.</td></tr>'}</tbody></table></div>`; panel.classList.remove('hidden'); }
    else if (action === 'retry-automation-run') { await api(`${workspacePath(`automations/${encodeURIComponent(id)}/runs/${encodeURIComponent(button.dataset.runId)}/retry`)}`,{method:'POST'}); showToast('Failed workflow run queued for a safe retry.'); await renderAutomations(); }
    else if (action === 'automation-run-detail') {
      const detail=await api(`${workspacePath(`automations/${encodeURIComponent(id)}/runs/${encodeURIComponent(button.dataset.runId)}`)}`);
      const actions=detail.run?.definition?.actions??[]; const graphNodes=detail.run?.definition?.graph?.nodes??[]; const canRetry=['owner','admin','manager'].includes(appState.role); const retryButton=detail.run?.status==='failed'&&canRetry?`<button class="button button-secondary" data-action="retry-automation-run" data-id="${escapeHtml(id)}" data-run-id="${escapeHtml(button.dataset.runId)}">Retry failed run</button>`:''; const panel=$('#automationRunPanel');
      panel.innerHTML=`<div class="panel-header"><div><h2 class="panel-title">Run details</h2><p class="panel-subtitle">Version ${escapeHtml(detail.run?.version_number??'—')} · ${badge(detail.run?.status??'unknown')}</p></div><div>${retryButton} <button class="quiet-button" data-action="automation-runs" data-id="${escapeHtml(id)}">Back to runs</button></div></div>
        <div class="table-wrap"><table><thead><tr><th>Step</th><th>Action</th><th>Status</th><th>Input</th><th>Output</th><th>Error</th><th>Completed</th></tr></thead><tbody>${(detail.steps??[]).map(step=>{const actionDef=actions[step.position]??{};const graphNode=graphNodes[step.position];const details=step.result??{};const input=details.input??{};const output=details.output??details;const error=details.error??'';return `<tr><td>${escapeHtml(Number(step.position)+1)}</td><td>${escapeHtml(graphNode?`${graphNode.label||graphNode.id} · ${graphNode.type}`:(actionDef.type||actionDef.actionType||'action'))}</td><td>${badge(step.status)}</td><td><code>${escapeHtml(JSON.stringify(input))}</code></td><td><code>${escapeHtml(JSON.stringify(output))}</code></td><td>${error?escapeHtml(typeof error==='string'?error:JSON.stringify(error)):'—'}</td><td>${fmtDate(step.completed_at,{time:true})}</td></tr>`;}).join('')||'<tr><td colspan="7" class="empty-state">No step records were written for this run.</td></tr>'}</tbody></table></div>`;
      panel.classList.remove('hidden');
    }
    else if (action === 'reload-view') await renderView(appState.view);
    else if (action === 'run-automation') {
      const leadId=prompt('Lead ID to run this workflow for:'); if(!leadId)return;
      const key = `manual-${crypto.randomUUID()}`;
      await api(`${workspacePath(`automations/${encodeURIComponent(id)}`)}`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: { leadId } });
      showToast('Automation run queued.'); await renderAutomations();
    }
  } catch (error) { showToast(error.message, 'error'); }
});

$('#viewRoot').addEventListener('change', async event => {
  if (event.target.matches('[data-wait-key]')) {
    const node=graphNode(event.target.dataset.nodeId),key=event.target.dataset.waitKey;
    if(!node)return;
    if(key==='mode') { node.mode=event.target.value; if(node.mode==='event'&&!node.eventType)node.eventType='message.incoming'; if(node.mode==='condition'&&!node.condition)node.condition={all:[{field:'lead.status',operator:'=',value:'Connected'}]}; if(node.mode==='duration'&&!node.minutes)node.minutes=60; renderAutomationGraph(); return; }
    node[key]=event.target.value===''?null:(['minutes','timeoutMinutes'].includes(key)?Number(event.target.value):event.target.value);
    return;
  }
  if (event.target.matches('[data-graph-connection]')) { updateGraphConnection(event.target); return; }
  if (event.target.matches('[data-node-label]')) { const node=graphNode(event.target.dataset.nodeId); if(node)node.label=event.target.value; return; }
  if (event.target.matches('[data-automation-action-type]')) { const node=graphNode(event.target.dataset.nodeId); if(node){ node.action={type:event.target.value,config:automationDefaultConfig(event.target.value)}; renderAutomationGraph(); } return; }
  if (event.target.matches('[data-automation-config]')) { const node=graphNode(event.target.dataset.nodeId); if(node){ node.action??={type:'wait',config:{}}; node.action.config??={}; const key=event.target.dataset.key; if(node.type==='wait')node.minutes=Number(event.target.value); else if(event.target.value==='')delete node.action.config[key]; else node.action.config[key]=event.target.type==='number'?Number(event.target.value):event.target.value; if(key==='pipelineId')node.action.config.stageId=''; } return; }
  if (event.target.matches('[data-condition-key], [data-condition-group]')) { handleConditionControl(event.target); return; }
  if (event.target.id === 'csvImportFile') {
    appState.csvImportText = null; appState.csvImportFields = []; appState.csvImportErrors = [];
    $('#csvImportPreview')?.classList.add('hidden'); $('#csvImportPreview')?.replaceChildren();
    $('#csvImportResult')?.replaceChildren(); $('#csvImportSubmit')?.classList.add('hidden');
  }
  if (event.target.id === 'leadStatus') { appState.leadStatus = event.target.value; appState.cursor = null; await renderLeads(); }
  if (event.target.id === 'savedLeadView' && event.target.value) {
    const option=event.target.selectedOptions[0]; let config={}; try{config=JSON.parse(option.dataset.config||'{}');}catch{}
    appState.leadSearch=config.q||''; appState.leadStatus=config.status||''; appState.cursor=null; await renderLeads();
  }
  if (event.target.id === 'bulkStatus' && event.target.value) {
    if (!appState.selectedLeads.size) { showToast('Select at least one lead.', 'error'); event.target.value = ''; return; }
    try {
      await api(workspacePath('leads/bulk'), { method: 'POST', body: { leadIds: [...appState.selectedLeads], operation: 'status', status: event.target.value } });
      appState.selectedLeads.clear(); showToast('Selected lead statuses updated.'); await renderLeads();
    } catch (error) { showToast(error.message, 'error'); }
  }
  if (event.target.id === 'bulkStage' && event.target.value) {
    if (!appState.selectedLeads.size) { showToast('Select at least one lead.','error'); event.target.value=''; return; }
    const [pipelineId,stageId]=event.target.value.split('|'); try{await api(workspacePath('leads/bulk'),{method:'POST',body:{leadIds:[...appState.selectedLeads],operation:'stage',pipelineId,stageId}});appState.selectedLeads.clear();showToast('Selected leads moved.');await renderLeads();}catch(error){showToast(error.message,'error');}
  }
  if (event.target.id === 'bulkTag' && event.target.value) {
    if (!appState.selectedLeads.size) { showToast('Select at least one lead.','error'); event.target.value=''; return; }
    try{await api(workspacePath('leads/bulk'),{method:'POST',body:{leadIds:[...appState.selectedLeads],operation:'tags',tagIds:[event.target.value]}});appState.selectedLeads.clear();showToast('Selected leads tagged.');await renderLeads();}catch(error){showToast(error.message,'error');}
  }
  if (event.target.id === 'bulkOwner' && event.target.value) {
    if (!appState.selectedLeads.size) { showToast('Select at least one lead.','error'); event.target.value=''; return; }
    try{await api(workspacePath('leads/bulk'),{method:'POST',body:{leadIds:[...appState.selectedLeads],operation:'owner',ownerId:event.target.value}});appState.selectedLeads.clear();showToast('Selected leads assigned.');await renderLeads();}catch(error){showToast(error.message,'error');}
  }
  if (event.target.id === 'pipelineChoice') return;
  if (event.target.matches('[data-action="move-stage"]') && event.target.value) {
    const select = event.target; const stageId = select.value;
    try {
      await api(`${workspacePath(`leads/${encodeURIComponent(select.dataset.lead)}/stage`)}`, { method: 'POST', body: { pipelineId: select.dataset.pipeline, stageId } });
      showToast('Lead moved to the new stage.'); await renderPipelines();
    } catch (error) { showToast(error.message, 'error'); }
  }
  if (event.target.matches('[data-action="complete-task"]')) {
    const checkbox = event.target.matches('input[type="checkbox"]');
    if (!checkbox || event.target.checked) {
      try { await api(`${workspacePath(`tasks/${encodeURIComponent(event.target.dataset.id)}`)}`, { method: 'PATCH', body: { status: 'completed' } }); showToast('Task completed.'); await renderView(appState.view); }
      catch (error) { if (checkbox) event.target.checked = false; showToast(error.message, 'error'); }
    }
  }
});

$('#viewRoot').addEventListener('input', event => {
  if (event.target.matches('[data-automation-config]')) { const node=graphNode(event.target.dataset.nodeId); if(node){ const key=event.target.dataset.key; node.action??={type:'wait',config:{}}; node.action.config??={}; if(event.target.value==='')delete node.action.config[key];else node.action.config[key]=event.target.type==='number'?Number(event.target.value):event.target.value; } return; }
  if (event.target.matches('[data-condition-key]')) { handleConditionControl(event.target); return; }
  if (event.target.id === 'leadSearch') {
    clearTimeout(appState.searchTimer);
    appState.searchTimer = setTimeout(async () => { appState.leadSearch = event.target.value; appState.cursor = null; await renderLeads(); }, 250);
  }
});

$('#viewRoot').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.target; const input = formObject(form);
  try {
    if (form.matches('[data-stage-edit-form]')) {
      await api(`${workspacePath(`pipelines/${encodeURIComponent(form.dataset.pipelineId)}/stages/${encodeURIComponent(form.dataset.stageId)}`)}`, { method:'PATCH', body:{ name:input.name, slug:input.slug, position:Number(input.position), isWon:form.elements.isWon.checked, isLost:form.elements.isLost.checked } });
      showToast('Pipeline stage updated.'); await renderPipelines(form.dataset.pipelineId);
    } else if (form.id === 'pipelineEditForm') {
      await api(`${workspacePath(`pipelines/${encodeURIComponent(form.dataset.pipelineId)}`)}`, { method:'PATCH', body:{ name:input.name, slug:input.slug, active:form.elements.active.checked } });
      showToast('Pipeline settings saved.'); await renderPipelines(form.dataset.pipelineId);
    } else if (form.id === 'leadEditForm') {
      const leadId = form.dataset.leadId; const customFields = {};
      form.querySelectorAll('[name^="cf:"]').forEach(control => {
        const fieldId = control.name.slice(3);
        if (control.type === 'checkbox') customFields[fieldId] = control.checked;
        else if (control.multiple) customFields[fieldId] = [...control.selectedOptions].map(option => option.value);
        else customFields[fieldId] = control.value || null;
      });
      const tagIds = [...form.querySelectorAll('[data-lead-tag]:checked')].map(control => control.value);
      const payload = { ...input, score: input.score ? Number(input.score) : 0, budget: input.budget ? Number(input.budget) : null, nextActionAt: input.nextActionAt ? localDateTime(input.nextActionAt) : null, temperature: input.temperature || null, customFields, tagIds };
      Object.keys(payload).filter(key => key.startsWith('cf:')).forEach(key => delete payload[key]);
      await api(`${workspacePath(`leads/${encodeURIComponent(leadId)}`)}`, { method: 'PATCH', body: payload }); showToast('Lead updated.'); await renderLeadDetail(leadId);
    } else if (form.id === 'newLeadForm') {
      const customFields = {}; form.querySelectorAll('[name^="cf:"]').forEach(control => { const fieldId=control.name.slice(3); customFields[fieldId]=control.type==='checkbox'?control.checked:(control.multiple?[...control.selectedOptions].map(o=>o.value):(control.value||null)); });
      const tagIds=[...form.querySelectorAll('[data-new-lead-tag]:checked')].map(control=>control.value);
      const lead = { ...input, budget: input.budget ? Number(input.budget) : null, nextActionAt: input.nextActionAt ? localDateTime(input.nextActionAt) : null, temperature: input.temperature || null };
      Object.keys(lead).filter(key=>key.startsWith('cf:')).forEach(key=>delete lead[key]); Object.keys(lead).forEach(key => { if (lead[key] === '') lead[key] = null; });
      await api(workspacePath('leads'), { method: 'POST', body: { ...lead, customFields, tagIds } });
      showToast('Lead created.'); appState.cursor = null; await renderLeads();
    } else if (form.id === 'savedViewForm') {
      await api(workspacePath('saved-views'), { method:'POST', body:{ entityType:'lead', name:input.name, config:{ q:appState.leadSearch||'', status:appState.leadStatus||'' } } });
      showToast('Lead view saved.'); await renderLeads();
    } else if (form.id === 'csvImportForm') {
      if (!appState.csvImportText) throw new Error('Preview the selected CSV file before importing.');
      const mapping = Object.fromEntries([...form.querySelectorAll('[data-csv-map]')].map(select => [select.dataset.csvMap, select.value]).filter(([, header]) => header));
      if (!['firstName','email','phone'].some(key => mapping[key])) throw new Error('Map First Name, Email or Phone before importing.');
      const missingRequired = appState.csvImportFields.find(field => field.required && !mapping[field.key]);
      if (missingRequired) throw new Error(`Map the required custom field “${missingRequired.label.replace(/^Custom: /, '')}” before importing.`);
      const mappedHeaders = Object.values(mapping);
      if (new Set(mappedHeaders).size !== mappedHeaders.length) throw new Error('Each CSV column can be mapped to only one CRM field.');
      const result = await api(workspacePath('leads/import'), { method: 'POST', body: { csv: appState.csvImportText, mapping } });
      appState.csvImportErrors = result.errors ?? [];
      const errorRows = appState.csvImportErrors.slice(0, 20).map(item => `<tr><td>${escapeHtml(item.row)}</td><td>${escapeHtml(item.message)}</td></tr>`).join('');
      const errorDetails = appState.csvImportErrors.length ? `<div class="panel-body"><button class="button button-secondary button-small" type="button" data-action="download-import-errors">Download ${fmtNumber(appState.csvImportErrors.length)} row errors</button><details><summary>Show first ${Math.min(20, appState.csvImportErrors.length)} errors</summary><div class="table-wrap"><table><thead><tr><th>CSV row</th><th>Error</th></tr></thead><tbody>${errorRows}</tbody></table></div></details></div>` : '';
      $('#csvImportResult').innerHTML = `<div class="notice ${appState.csvImportErrors.length ? 'notice-red' : 'notice-green'}">Processed ${fmtNumber(result.processed)} rows · created ${fmtNumber(result.created)} · skipped duplicates ${fmtNumber(result.skipped)} · errors ${fmtNumber(appState.csvImportErrors.length)}</div>${errorDetails}`;
      const submit = $('#csvImportSubmit'); submit.disabled = true; submit.textContent = 'Import complete';
      appState.cursor = null;
    } else if (form.id === 'taskForm') {
      const task = { ...input, leadId: input.leadId || null, dueAt: input.dueAt ? localDateTime(input.dueAt) : null, priority: Number(input.priority ?? 0) };
      await api(workspacePath('tasks'), { method: 'POST', body: task }); showToast('Follow-up created.'); await renderTasks();
    } else if (form.id === 'pipelineForm') {
      await api(workspacePath('pipelines'),{method:'POST',body:{name:input.name,slug:input.slug}});showToast('Pipeline created.');await renderPipelines();
    } else if (form.id === 'stageForm') {
      await api(`${workspacePath(`pipelines/${encodeURIComponent(input.pipelineId)}/stages`)}`,{method:'POST',body:{name:input.name,slug:input.slug,position:Number(input.position||0),isWon:form.elements.isWon.checked,isLost:form.elements.isLost.checked}});showToast('Stage added.');await renderPipelines();
    } else if (form.id === 'taskEditForm') {
      const taskId = form.dataset.taskId;
      await api(`${workspacePath(`tasks/${encodeURIComponent(taskId)}`)}`, { method: 'PATCH', body: { title: input.title, description: input.description || null, dueAt: input.dueAt ? localDateTime(input.dueAt) : null, priority: Number(input.priority || 0), status: input.status } });
      showToast('Task updated.'); await renderTasks();
    } else if (form.id === 'meetingForm') {
      await api(workspacePath('meetings'), { method: 'POST', body: { leadId: input.leadId || null, meetingType: input.meetingType || null, startsAt: localDateTime(input.startsAt), endsAt: input.endsAt ? localDateTime(input.endsAt) : null, status: 'scheduled', notes: input.notes || null } });
      showToast('Meeting scheduled.'); await renderMeetings();
    } else if (form.id === 'meetingEditForm') {
      const meetingId=form.dataset.meetingId; await api(`${workspacePath(`meetings/${encodeURIComponent(meetingId)}`)}`,{method:'PATCH',body:{meetingType:input.meetingType||null,status:input.status,startsAt:localDateTime(input.startsAt),endsAt:input.endsAt?localDateTime(input.endsAt):null,notes:input.notes||null}}); showToast('Meeting saved.'); await renderMeetings();
    } else if (form.id === 'messageDraftForm') {
      await api(workspacePath('messages'), { method: 'POST', body: input }); showToast('Message draft saved.'); await renderCommunications();
    } else if (form.id === 'callForm') {
      const notes = input.metadataNotes; const metadata = notes ? { notes } : {};
      const call = { ...input, leadId: input.leadId || null, durationSeconds: Number(input.durationSeconds || 0), startedAt: input.startedAt ? localDateTime(input.startedAt) : null, answeredAt: input.answeredAt ? localDateTime(input.answeredAt) : null, endedAt: input.endedAt ? localDateTime(input.endedAt) : null, metadata };
      delete call.metadataNotes;
      await api(workspacePath('calls'), { method: 'POST', body: call }); showToast('Call record saved.'); await renderCalling();
    } else if (form.id === 'automationForm') {
      const graph=ensureAutomationGraph();
      const actions=graph.nodes.filter(node=>node.type==='action'||node.type==='wait').map(node=>node.type==='wait'?{type:'wait',config:{minutes:node.minutes}}:node.action);
      if (!actions.length) throw new Error('Add at least one action node.');
      const payload={ name:input.name,description:input.description||null,triggerType:input.triggerType,triggerConfig:appState.automationTriggerConfig??{},actions,graph,active:form.elements.active.checked };
      const result=appState.automationEditingId?await api(`${workspacePath(`automations/${encodeURIComponent(appState.automationEditingId)}`)}`,{method:'PATCH',body:payload}):await api(workspacePath('automations'),{method:'POST',body:payload});
      appState.automationEditingId=null;appState.automationTriggerConfig={};appState.automationGraph=newAutomationGraph();
      showToast(`Automation saved${result.active?' and activated':''}.`);await renderAutomations();
    } else if (form.id === 'estimateForm') {
      const estimate = await api(workspacePath('usage/estimate'), { method: 'POST', body: { ...input, quantity: Number(input.quantity) } });
      $('#estimateResult').innerHTML = `<div class="notice notice-green">Estimated provider cost: <strong>${fmtMoney(estimate.providerCost, estimate.currency)}</strong> · Customer charge: <strong>${fmtMoney(estimate.customerCharge, estimate.currency)}</strong> · Rate ${escapeHtml(estimate.rateId.slice(0, 8))}</div>`;
    } else if (form.id === 'rateForm') {
      const rate = { ...input, provider: input.provider || null, providerCostPerUnit: Number(input.providerCostPerUnit), customerChargePerUnit: Number(input.customerChargePerUnit), validFrom: input.validFrom ? localDateTime(input.validFrom) : null };
      await api(workspacePath('usage/rates'), { method: 'POST', body: rate }); showToast('Rate version published.'); await renderUsage();
    } else if (form.id === 'workspaceForm') {
      await api(workspacePath(), { method: 'PATCH', body: input }); showToast('Workspace updated.'); await renderWorkspace();
    } else if (form.id === 'customFieldEditForm') {
      const fieldId=form.dataset.fieldId; const existing=(appState.customFieldCache??[]).find(item=>item.id===fieldId); const prior=existing?.config??{};
      await api(`${workspacePath(`custom-fields/${encodeURIComponent(fieldId)}`)}`, { method:'PATCH', body:{ label:input.label, required:form.elements.required.checked, config:{ ...prior, section:input.section||'Details', order:Number(input.order||0), options:input.options?input.options.split(',').map(v=>v.trim()).filter(Boolean):[], visible:form.elements.visible.checked, readOnly:form.elements.readOnly.checked } } });
      showToast('Custom field settings saved.'); await renderWorkspace();
    } else if (form.id === 'customFieldForm') {
      await api(workspacePath('custom-fields'), { method: 'POST', body: { entityType: 'lead', fieldKey: input.fieldKey, label: input.label, fieldType: input.fieldType, required: form.elements.required.checked, config: { section: input.section || 'Details', order: Number(input.order || 0), options: input.options ? input.options.split(',').map(v => v.trim()).filter(Boolean) : [], visible: true, readOnly: form.elements.readOnly.checked } } });
      showToast('Custom field added.'); await renderWorkspace();
    } else if (form.id === 'tagForm') {
      await api(workspacePath('tags'), { method: 'POST', body: { name: input.name } }); showToast('Tag added.'); await renderWorkspace();
    } else if (form.id === 'layoutForm') {
      const columns=[...form.querySelectorAll('[name="layoutColumn"]:checked')].map(control=>control.value); if(!columns.length)throw new Error('Choose at least one lead column.');
      await api(workspacePath('layouts'),{method:'POST',body:{entityType:'lead',name:input.name,config:{columns},active:true}});showToast('Lead layout saved.');await renderWorkspace();
    } else if (form.id === 'leadSourceForm') {
      await api(workspacePath('lead-sources'), { method:'POST', body:{ name:input.name } }); showToast('Lead source added.'); await renderWorkspace();
    } else if (form.id === 'taskTypeForm') {
      await api(workspacePath('task-types'), { method:'POST', body:{ name:input.name } }); showToast('Task type added.'); await renderWorkspace();
    } else if (form.id === 'assignmentRuleForm') {
      let conditions={}; if(input.conditions){ try{conditions=JSON.parse(input.conditions);}catch{throw new Error('Assignment conditions must be valid JSON.');} }
      await api(workspacePath('assignment-rules'), { method:'POST', body:{ name:input.name, priority:Number(input.priority||100), strategy:input.strategy, conditions, config:input.userId?{userId:input.userId}:{}, active:true } }); showToast('Assignment rule added.'); await renderWorkspace();
    } else if (form.id === 'scoringRuleForm') {
      let conditions={}; try{conditions=JSON.parse(input.conditions||'{}');}catch{throw new Error('Scoring conditions must be valid JSON.');}
      await api(workspacePath('scoring-rules'), { method:'POST', body:{ name:input.name, priority:Number(input.priority||100), scoreDelta:Number(input.scoreDelta), conditions, active:true } }); showToast('Scoring rule added.'); await renderWorkspace();
    } else if (form.id === 'memberForm') {
      await api(workspacePath('members'), { method: 'POST', body: input }); showToast('Member created.'); await renderWorkspace();
    }
  } catch (error) { showToast(error.message, 'error'); }
});

boot();


