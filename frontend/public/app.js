const $ = selector => document.querySelector(selector);
const appState = { user: null, workspace: null, workspaces: [], role: null, view: 'dashboard', cursor: null, leadSearch: '', leadStatus: '', selectedLeads: new Set(), toastTimer: null };
const apiRoot = '/api/v1';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
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

function renderLeadRows(rows) {
  if (!rows.length) return '<tr><td colspan="6" class="empty-state">No leads found for this view.</td></tr>';
  return rows.map(lead => `<tr>
    <td><input type="checkbox" data-action="select-lead" data-id="${escapeHtml(lead.id)}" ${appState.selectedLeads.has(lead.id) ? 'checked' : ''} aria-label="Select lead"><div class="lead-name">${escapeHtml([lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Unnamed lead')}</div><div class="lead-sub">${escapeHtml(lead.company_name || lead.email || lead.phone || '')}</div></td>
    <td>${escapeHtml(lead.brand_project || lead.opportunity_type || '—')}</td>
    <td>${badge(lead.temperature ?? lead.status)}</td>
    <td>${lead.budget === null ? '—' : fmtMoney(lead.budget)}</td>
    <td>${fmtDate(lead.next_action_at, { time: true })}</td>
    <td><button class="quiet-button" data-action="lead-details" data-id="${escapeHtml(lead.id)}">Open</button></td>
  </tr>`).join('');
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
  const rows = (result.data ?? []).map(lead => `<tr><td><div class="lead-name">${escapeHtml([lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Unnamed lead')}</div><div class="lead-sub">${escapeHtml(lead.email || lead.phone || lead.company_name || '')}</div></td><td>${badge(lead.status)}</td><td>${fmtDate(lead.deleted_at, { time: true })}</td><td>${canRestore ? `<button class="quiet-button" data-action="restore-lead" data-id="${escapeHtml(lead.id)}">Restore</button>` : '—'}</td></tr>`).join('') || '<tr><td colspan="4" class="empty-state">Trash is empty.</td></tr>';
  setPage(`${pageHeading('DATA SAFETY', 'Lead trash', 'Archived leads remain recoverable and auditable.', '<button class="button button-secondary" data-view="leads">Back to leads</button>')}
    <section class="panel"><div class="panel-body"><div class="table-wrap"><table><thead><tr><th>Lead</th><th>Status</th><th>Deleted</th><th></th></tr></thead><tbody>${rows}</tbody></table></div><div class="pagination"><button class="button button-secondary button-small" data-action="next-trash" ${result.nextCursor ? '' : 'disabled'} data-cursor="${escapeHtml(result.nextCursor ?? '')}">Load more</button></div></div></section>`);
}

async function renderLeads() {
  const params = new URLSearchParams({ limit: '50' });
  if (appState.cursor) params.set('cursor', appState.cursor);
  if (appState.leadSearch) params.set('q', appState.leadSearch);
  if (appState.leadStatus) params.set('status', appState.leadStatus);
  const result = await api(`${workspacePath('leads')}?${params}`);
  const createAllowed = ['owner','admin','manager','agent'].includes(appState.role);
  const action = createAllowed ? '<button class="button button-primary" data-action="toggle-new-lead">+ New lead</button>' : '';
  setPage(`${pageHeading('CRM', 'Leads', 'Find, qualify and follow up with every opportunity.', action)}
    <section id="newLeadPanel" class="panel hidden"><div class="panel-header"><div><h2 class="panel-title">Add a lead</h2><p class="panel-subtitle">Contact details and project context</p></div><button class="text-button" data-action="toggle-new-lead">Close</button></div><form id="newLeadForm" class="panel-body"><div class="field-grid">
      <label>First name<input name="firstName" required maxlength="120"></label><label>Last name<input name="lastName" maxlength="120"></label>
      <label>Email<input name="email" type="email" maxlength="320"></label><label>Phone<input name="phone" type="tel" maxlength="80"></label>
      <label>Company<input name="companyName" maxlength="240"></label><label>Project / brand<input name="brandProject" maxlength="240"></label>
      <label>Opportunity type<input name="opportunityType" maxlength="160"></label><label>Budget (INR)<input name="budget" type="number" min="0" step="0.01"></label>
      <label>Status<input name="status" value="New Lead" maxlength="80"></label><label>Next follow-up<input name="nextActionAt" type="datetime-local"></label>
      <label class="span-2">Requirement<textarea name="requirement" maxlength="5000"></textarea></label>
    </div><div class="heading-actions"><button class="button button-primary" type="submit">Save lead</button><button class="button button-secondary" type="reset">Clear</button></div></form></section>
    <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Lead directory</h2><p class="panel-subtitle">${fmtNumber(result.data?.length ?? 0)} records on this page</p></div><span class="badge">${escapeHtml(appState.role)}</span></div>
      <div class="panel-body"><div class="toolbar"><label><input type="checkbox" data-action="select-all-leads" aria-label="Select all visible leads"> Select all</label><button class="button button-secondary button-small" data-action="bulk-trash" ${appState.selectedLeads.size ? '' : 'disabled'}>Trash selected</button><select id="bulkStatus" aria-label="Bulk status"><option value="">Bulk status…</option><option>New Lead</option><option>Connected</option><option>Qualified</option><option>Won</option><option>Lost</option></select><input id="leadSearch" type="search" placeholder="Search name, email, phone or company" value="${escapeHtml(appState.leadSearch)}"><select id="leadStatus"><option value="">All statuses</option>${['New Lead','Contact Attempted','Connected','Qualified','Meeting / Presentation','Proposal','Negotiation','Won','Lost','HOT','WARM','COLD','NO RESPONSE'].map(item => `<option ${appState.leadStatus === item ? 'selected' : ''}>${escapeHtml(item)}</option>`).join('')}</select><button class="button button-secondary button-small" data-action="clear-lead-filters">Clear</button></div>
      <div class="table-wrap"><table><thead><tr><th>Lead</th><th>Project / opportunity</th><th>Temperature / status</th><th>Budget</th><th>Next action</th><th></th></tr></thead><tbody>${renderLeadRows(result.data ?? [])}</tbody></table></div>
      <div class="pagination"><button class="button button-secondary button-small" data-action="next-leads" ${result.nextCursor ? '' : 'disabled'} data-cursor="${escapeHtml(result.nextCursor ?? '')}">Load more</button></div></div></section>`);
}

function customFieldControl(field) {
  const name = `cf:${field.id}`; const value = field.value ?? '';
  const required = field.required ? 'required' : '';
  if (field.field_type === 'boolean') return `<label class="checkbox-row"><input type="checkbox" name="${escapeHtml(name)}" ${value === true ? 'checked' : ''}> ${escapeHtml(field.label)}</label>`;
  if (field.field_type === 'textarea') return `<label class="span-2">${escapeHtml(field.label)}<textarea name="${escapeHtml(name)}" ${required}>${escapeHtml(value)}</textarea></label>`;
  if (['select','multiselect'].includes(field.field_type)) {
    const options = Array.isArray(field.config?.options) ? field.config.options : [];
    return `<label>${escapeHtml(field.label)}<select name="${escapeHtml(name)}" ${field.field_type === 'multiselect' ? 'multiple' : ''} ${required}>${options.map(option => `<option value="${escapeHtml(option)}" ${Array.isArray(value) ? (value.includes(option) ? 'selected' : '') : (String(value) === String(option) ? 'selected' : '')}>${escapeHtml(option)}</option>`).join('')}</select></label>`;
  }
  const type = ({number:'number',currency:'number',date:'date',datetime:'datetime-local',email:'email',phone:'tel',url:'url'})[field.field_type] || 'text';
  return `<label>${escapeHtml(field.label)}<input type="${type}" name="${escapeHtml(name)}" value="${escapeHtml(value)}" ${required}></label>`;
}

async function renderLeadDetail(leadId) {
  const [lead, timeline, tagCatalog] = await Promise.all([api(`${workspacePath(`leads/${encodeURIComponent(leadId)}`)}`), api(`${workspacePath(`leads/${encodeURIComponent(leadId)}/timeline`)}`), api(workspacePath('tags'))]);
  const selectedTags = new Set((lead.tags ?? []).map(tag => tag.id));
  const customControls = (lead.customFields ?? []).map(customFieldControl).join('');
  const tagControls = (tagCatalog.data ?? []).map(tag => `<label class="checkbox-row"><input type="checkbox" data-lead-tag value="${escapeHtml(tag.id)}" ${selectedTags.has(tag.id) ? 'checked' : ''}> ${escapeHtml(tag.name)}</label>`).join('') || '<span class="muted">No workspace tags configured.</span>';
  setPage(`${pageHeading('LEAD RECORD', [lead.first_name,lead.last_name].filter(Boolean).join(' ') || 'Lead details', lead.company_name || lead.email || lead.phone || '')}
    <section class="panel"><div class="panel-header"><h2 class="panel-title">Contact and qualification</h2><div><button class="button button-secondary button-small" data-action="toggle-lead-edit">Edit</button> <button class="button button-secondary button-small" data-view="leads">Back to leads</button></div></div><div id="leadEditPanel" class="panel-body hidden"><form id="leadEditForm" data-lead-id="${escapeHtml(lead.id)}"><div class="field-grid"><label>First name<input name="firstName" value="${escapeHtml(lead.first_name || '')}"></label><label>Last name<input name="lastName" value="${escapeHtml(lead.last_name || '')}"></label><label>Email<input name="email" type="email" value="${escapeHtml(lead.email || '')}"></label><label>Phone<input name="phone" value="${escapeHtml(lead.phone || '')}"></label><label>Status<input name="status" value="${escapeHtml(lead.status || '')}"></label><label>Score<input name="score" type="number" value="${escapeHtml(lead.score ?? 0)}"></label><label>Temperature<select name="temperature"><option value="">—</option>${['hot','warm','cold'].map(v => `<option value="${v}" ${lead.temperature === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label><label>Budget<input name="budget" type="number" value="${escapeHtml(lead.budget ?? '')}"></label><label>Next action<input name="nextAction" value="${escapeHtml(lead.next_action || '')}"></label><label>Next follow-up<input name="nextActionAt" type="datetime-local" value="${lead.next_action_at ? escapeHtml(new Date(lead.next_action_at).toISOString().slice(0,16)) : ''}"></label><label class="span-2">Notes<textarea name="notes">${escapeHtml(lead.notes || '')}</textarea></label>${customControls}</div><div class="panel-body"><strong>Tags</strong><div class="heading-actions">${tagControls}</div></div><button class="button button-primary" type="submit">Save changes</button></form></div><div class="panel-body"><dl class="key-value"><dt>Email</dt><dd>${escapeHtml(lead.email || '—')}</dd><dt>Phone</dt><dd>${escapeHtml(lead.phone || '—')}</dd><dt>Project</dt><dd>${escapeHtml(lead.brand_project || '—')}</dd><dt>Opportunity type</dt><dd>${escapeHtml(lead.opportunity_type || '—')}</dd><dt>Budget</dt><dd>${lead.budget === null ? '—' : fmtMoney(lead.budget)}</dd><dt>Status</dt><dd>${badge(lead.status)}</dd><dt>Temperature</dt><dd>${badge(lead.temperature)}</dd><dt>Next action</dt><dd>${escapeHtml(lead.next_action || '—')} · ${fmtDate(lead.next_action_at, { time: true })}</dd><dt>Tags</dt><dd>${(lead.tags ?? []).map(tag => badge(tag.name)).join(' ') || '—'}</dd><dt>Notes</dt><dd>${escapeHtml(lead.notes || '—')}</dd></dl></div></section>
    <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Timeline</h2><p class="panel-subtitle">Recent calls, tasks, messages and notes</p></div></div><div class="panel-body">${(timeline.data ?? []).map(item => `<div class="task-row"><span class="badge">${escapeHtml(item.item_type)}</span><div><div class="task-title">${escapeHtml(item.title)}</div><div class="task-meta">${escapeHtml(item.body || item.kind || '')}</div></div><div class="task-due">${fmtDate(item.happened_at, { time: true })}</div></div>`).join('') || '<div class="empty-state">No timeline events yet.</div>'}</div></section>`);
}

async function renderPipelines() {
  const [pipelines, leads] = await Promise.all([api(workspacePath('pipelines')), api(`${workspacePath('leads')}?limit=100`)]);
  const first = pipelines.data?.[0];
  const cards = (leads.data ?? []).map(lead => ({ lead, current: null }));
  if (first) {
    const board = first.stages.map(stage => {
      const matching = cards.filter(({ lead }) => (lead.status || '').toLowerCase() === stage.name.toLowerCase() || (stage.slug === 'new-lead' && (lead.status || '').toLowerCase() === 'new lead'));
      return `<div class="pipeline-column" data-drop-stage="${escapeHtml(stage.id)}" data-drop-pipeline="${escapeHtml(first.id)}"><div class="pipeline-column-header"><span>${escapeHtml(stage.name)}</span><span class="badge">${matching.length}</span></div>${matching.map(({ lead }) => `<article class="pipeline-card" draggable="true" data-drag-lead="${escapeHtml(lead.id)}"><span class="lead-name">${escapeHtml([lead.first_name,lead.last_name].filter(Boolean).join(' ') || 'Unnamed lead')}</span><div class="lead-sub">${escapeHtml(lead.brand_project || lead.email || '')}</div><select data-action="move-stage" data-lead="${escapeHtml(lead.id)}" data-pipeline="${escapeHtml(first.id)}"><option value="">Move to stage…</option>${first.stages.map(next => `<option value="${escapeHtml(next.id)}">${escapeHtml(next.name)}</option>`).join('')}</select></article>`).join('') || '<div class="lead-sub">No leads in this stage</div>'}</div>`;
    }).join('');
    setPage(`${pageHeading('OPPORTUNITY FLOW', 'Pipelines', 'Move every opportunity forward with a clear next step.')}
      <section class="panel"><div class="panel-header"><div><h2 class="panel-title">${escapeHtml(first.name)}</h2><p class="panel-subtitle">Showing up to 100 active leads. Stage changes are recorded in history.</p></div><select id="pipelineChoice">${pipelines.data.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === first.id ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select></div><div class="panel-body"><div class="pipeline-board">${board}</div></div></section>`);
    $('#pipelineChoice').addEventListener('change', () => renderPipelineChoice(pipelines.data, $('#pipelineChoice').value));
    bindPipelineDnD();
  } else setPage(`${pageHeading('OPPORTUNITY FLOW', 'Pipelines', 'No pipelines are available yet.')}<section class="panel"><div class="empty-state">Ask a workspace admin to create a pipeline.</div></section>`);
}

async function renderPipelineChoice(all, pipelineId) {
  const pipeline = all.find(item => item.id === pipelineId);
  if (!pipeline) return;
  const leads = await api(`${workspacePath('leads')}?pipelineId=${encodeURIComponent(pipelineId)}&limit=100`);
  const board = pipeline.stages.map(stage => {
    const matching = (leads.data ?? []).filter(lead => (lead.status || '').toLowerCase() === stage.name.toLowerCase() || (stage.slug === 'new-lead' && (lead.status || '').toLowerCase() === 'new lead'));
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
  const result = await api(`${workspacePath('tasks')}?limit=100`);
  appState.taskCache = result.data ?? [];
  const rows = appState.taskCache.map(task => {
    const terminal = ['completed','cancelled'].includes(task.status);
    const actions = terminal
      ? `<button class="quiet-button" data-action="task-status" data-status="pending" data-id="${escapeHtml(task.id)}">Reopen</button>`
      : `<button class="quiet-button" data-action="complete-task" data-id="${escapeHtml(task.id)}">Complete</button> <button class="quiet-button" data-action="task-status" data-status="cancelled" data-id="${escapeHtml(task.id)}">Cancel</button>`;
    return `<tr><td><div class="lead-name">${escapeHtml(task.title)}</div><div class="lead-sub">${escapeHtml(task.task_type || task.source || 'Follow-up')}</div></td><td>${fmtDate(task.due_at, { time: true })}</td><td>${badge(task.status)}</td><td>${escapeHtml(task.priority)}</td><td><button class="quiet-button" data-action="edit-task" data-id="${escapeHtml(task.id)}">Edit</button> ${actions}</td></tr>`;
  }).join('') || '<tr><td colspan="5" class="empty-state">No tasks found.</td></tr>';
  const canWrite = ['owner','admin','manager','agent'].includes(appState.role);
  setPage(`${pageHeading('FOLLOW-UP WORK', 'Tasks & activities', 'Create, edit, complete, cancel and reopen follow-ups.', canWrite ? '<button class="button button-primary" data-action="toggle-task-form">+ New task</button>' : '')}
    <section id="taskFormPanel" class="panel hidden"><div class="panel-header"><h2 class="panel-title">Create a follow-up</h2><button class="text-button" data-action="toggle-task-form">Close</button></div><form id="taskForm" class="panel-body"><div class="field-grid"><label>Lead ID (optional)<input name="leadId" maxlength="36"></label><label>Task type<select name="taskType"><option>CALL</option><option>WHATSAPP</option><option>MEETING</option><option>EMAIL</option><option>OTHER</option></select></label><label class="span-2">Title<input name="title" required maxlength="240"></label><label>Due date<input name="dueAt" type="datetime-local"></label><label>Priority<input name="priority" type="number" value="0" min="0" max="10"></label><label class="span-2">Notes<textarea name="description" maxlength="5000"></textarea></label></div><button class="button button-primary">Save task</button></form></section>
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
  const rows = (meetings.data ?? []).map(item => `<tr><td>${fmtDate(item.starts_at, { time: true })}</td><td>${escapeHtml(item.meeting_type || 'Meeting')}</td><td>${badge(item.status)}</td><td>${escapeHtml(item.notes || '—')}</td><td>${canWrite ? `<button class="quiet-button" data-action="meeting-status" data-status="completed" data-id="${escapeHtml(item.id)}">Complete</button> <button class="quiet-button" data-action="meeting-status" data-status="missed" data-id="${escapeHtml(item.id)}">Missed</button> <button class="quiet-button" data-action="meeting-status" data-status="cancelled" data-id="${escapeHtml(item.id)}">Cancel</button>` : '—'}</td></tr>`).join('') || '<tr><td colspan="5" class="empty-state">No meetings scheduled.</td></tr>';
  setPage(`${pageHeading('APPOINTMENTS', 'Meetings & calendar', 'Schedule appointments and record completed, missed or cancelled outcomes.')}
    ${canWrite ? `<section class="panel"><div class="panel-header"><h2 class="panel-title">Schedule meeting</h2></div><form id="meetingForm" class="panel-body"><div class="field-grid"><label>Lead<select name="leadId"><option value="">No linked lead</option>${(leads.data ?? []).map(lead => `<option value="${escapeHtml(lead.id)}">${escapeHtml([lead.first_name,lead.last_name].filter(Boolean).join(' ') || lead.email || lead.phone || lead.id)}</option>`).join('')}</select></label><label>Type<input name="meetingType" value="Consultation" maxlength="120"></label><label>Starts<input name="startsAt" type="datetime-local" required></label><label>Ends<input name="endsAt" type="datetime-local"></label><label class="span-2">Notes<textarea name="notes" maxlength="5000"></textarea></label></div><button class="button button-primary">Schedule meeting</button></form></section>` : ''}
    <section class="panel"><div class="panel-header"><h2 class="panel-title">Calendar queue</h2><span class="badge">${fmtNumber(meetings.data?.length ?? 0)}</span></div><div class="table-wrap"><table><thead><tr><th>When</th><th>Type</th><th>Status</th><th>Notes</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div></section>`);
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

async function renderAutomations() {
  const result = await api(`${workspacePath('automations')}`);
  const canManage = ['owner','admin','manager'].includes(appState.role);
  const rows = (result.data ?? []).map(item => `<tr><td><div class="lead-name">${escapeHtml(item.name)}</div><div class="lead-sub">v${escapeHtml(item.current_version_id?.slice(0,8) || '—')} · ${escapeHtml(item.description || '')}</div></td><td>${badge(item.trigger_type)}</td><td>${badge(item.active ? 'active' : 'inactive')}</td><td><button class="quiet-button" data-action="run-automation" data-id="${escapeHtml(item.id)}">Queue run</button></td></tr>`).join('') || '<tr><td colspan="4" class="empty-state">Add a workflow to automate a task, stage change or message draft.</td></tr>';
  setPage(`${pageHeading('WORKFLOW ENGINE', 'Automations', 'Versioned workflows run in the background with retries and an audit trail.', canManage ? '<button class="button button-primary" data-action="toggle-automation-form">+ New automation</button>' : '')}
    <div class="notice">Allowed actions create a task, add an activity, change a pipeline stage or prepare a message draft. External sends stay behind consent checks and a configured provider adapter.</div>
    <section id="automationFormPanel" class="panel hidden"><div class="panel-header"><h2 class="panel-title">Create automation</h2><button class="text-button" data-action="toggle-automation-form">Close</button></div><form id="automationForm" class="panel-body"><div class="field-grid"><label>Name<input name="name" required maxlength="160"></label><label>Trigger<select name="triggerType"><option>manual</option><option>lead.created</option><option>lead.updated</option><option>form.submitted</option><option>lead.stage_changed</option><option>message.incoming</option><option>email.incoming</option><option>appointment.created</option><option>appointment.missed</option><option>task.completed</option><option>meeting.created</option><option>meeting.missed</option><option>call.completed</option><option>call.ended</option><option>lead.no_response</option><option>lead.score_changed</option><option>scheduled.time</option><option>webhook.received</option><option>ai.decision</option></select></label><label>Description<input name="description" maxlength="500"></label><label>Action<select name="actionType"><option value="create_task">Create a task</option><option value="create_activity">Add an activity</option><option value="create_message_draft">Create a message draft</option></select></label><label class="span-2">Action title / message<textarea name="actionText" required maxlength="10000"></textarea></label><label class="span-2">Conditions JSON (optional)<textarea name="conditions"></textarea></label><label>Wait minutes<input name="waitMinutes" type="number" min="0" value="0"></label></div><label class="checkbox-row"><input name="active" type="checkbox" class="checkbox-input"> Activate after saving</label><button class="button button-primary">Save version 1</button></form></section>
    <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Workflows</h2><p class="panel-subtitle">${fmtNumber(result.data?.length ?? 0)} workflows</p></div></div><div class="table-wrap"><table><thead><tr><th>Automation</th><th>Trigger</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>`);
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

async function renderWorkspace() {
  const [workspace, members, fields, tags] = await Promise.all([
    api(workspacePath()), api(workspacePath('members')), api(`${workspacePath('custom-fields')}?entityType=lead`), api(workspacePath('tags'))
  ]);
  const canManage = ['owner','admin'].includes(appState.role);
  const fieldRows = (fields.data ?? []).map(field => `<tr><td>${escapeHtml(field.label)}</td><td><code>${escapeHtml(field.field_key)}</code></td><td>${badge(field.field_type)}</td><td>${field.required ? 'Required' : 'Optional'}</td><td>${canManage ? `<button class="quiet-button" data-action="field-required" data-required="${field.required ? 'false' : 'true'}" data-id="${escapeHtml(field.id)}">${field.required ? 'Make optional' : 'Make required'}</button>` : '—'}</td></tr>`).join('') || '<tr><td colspan="5" class="empty-state">No custom lead fields configured.</td></tr>';
  const tagRows = (tags.data ?? []).map(tag => `<span class="badge">${escapeHtml(tag.name)}</span>`).join(' ') || '<span class="muted">No tags configured.</span>';
  setPage(`${pageHeading('CRM BUILDER', 'Workspace', 'Configure the team boundary, CRM fields, tags and operating defaults without rebuilding the application.')}
    <section class="panel"><div class="panel-header"><h2 class="panel-title">Workspace profile</h2><span class="badge">${escapeHtml(appState.role)}</span></div><div class="panel-body"><dl class="key-value"><dt>Name</dt><dd>${escapeHtml(workspace.name)}</dd><dt>Workspace slug</dt><dd>${escapeHtml(workspace.slug)}</dd><dt>Timezone</dt><dd>${escapeHtml(workspace.timezone)}</dd><dt>Currency</dt><dd>${escapeHtml(workspace.currency)}</dd></dl></div></section>
    ${canManage ? `<section class="panel"><div class="panel-header"><h2 class="panel-title">Update workspace</h2></div><form id="workspaceForm" class="panel-body"><div class="inline-form"><label>Workspace name<input name="name" value="${escapeHtml(workspace.name)}" required maxlength="120"></label><label>Timezone<input name="timezone" value="${escapeHtml(workspace.timezone)}" required maxlength="80"></label><label>Currency<input name="currency" value="${escapeHtml(workspace.currency)}" minlength="3" maxlength="3" required></label><button class="button button-primary">Save settings</button></div></form></section>` : ''}
    <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Lead fields</h2><p class="panel-subtitle">Workspace-scoped custom field definitions</p></div></div><div class="table-wrap"><table><thead><tr><th>Label</th><th>Key</th><th>Type</th><th>Requirement</th><th></th></tr></thead><tbody>${fieldRows}</tbody></table></div>
      ${canManage ? `<form id="customFieldForm" class="panel-body"><div class="inline-form"><label>Label<input name="label" required maxlength="160"></label><label>Key<input name="fieldKey" required maxlength="80" pattern="[A-Za-z0-9_]+"></label><label>Type<select name="fieldType"><option>text</option><option>textarea</option><option>number</option><option>currency</option><option>date</option><option>datetime</option><option>boolean</option><option>select</option><option>multiselect</option><option>email</option><option>phone</option><option>url</option></select></label><label class="checkbox-row"><input name="required" type="checkbox" class="checkbox-input"> Required</label><button class="button button-primary">Add field</button></div></form>` : ''}</section>
    <section class="panel"><div class="panel-header"><h2 class="panel-title">Tags</h2></div><div class="panel-body"><div class="heading-actions">${tagRows}</div>${canManage ? `<form id="tagForm" class="inline-form"><label>New tag<input name="name" required maxlength="80"></label><button class="button button-primary">Add tag</button></form>` : ''}</div></section>
    <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Members</h2><p class="panel-subtitle">${fmtNumber(members.data?.length ?? 0)} active and invited users</p></div></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead><tbody>${(members.data ?? []).map(member => `<tr><td>${escapeHtml(member.display_name)}</td><td>${escapeHtml(member.email)}</td><td>${badge(member.role)}</td><td>${badge(member.active ? 'active' : 'inactive')}</td></tr>`).join('')}</tbody></table></div></section>
    ${canManage ? `<section class="panel"><div class="panel-header"><h2 class="panel-title">Add a team member</h2></div><form id="memberForm" class="panel-body"><div class="field-grid"><label>Name<input name="displayName" required maxlength="120"></label><label>Email<input name="email" type="email" required maxlength="320"></label><label>Initial password<input name="initialPassword" type="password" required minlength="12" maxlength="1024"></label><label>Role<select name="role"><option>agent</option><option>manager</option><option>reporting</option><option>admin</option><option>service</option></select></label></div><p class="muted small">Share the initial password with the member through your normal secure process. Email delivery is not enabled.</p><button class="button button-primary">Create member</button></form></section>` : ''}`);
}

async function renderView(view) {
  appState.view = view;
  document.querySelectorAll('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  try {
    if (view === 'dashboard') await renderDashboard();
    else if (view === 'leads') await renderLeads();
    else if (view === 'trash') await renderTrash();
    else if (view === 'pipelines') await renderPipelines();
    else if (view === 'tasks') await renderTasks();
    else if (view === 'meetings') await renderMeetings();
    else if (view === 'communications') await renderCommunications();
    else if (view === 'calling') await renderCalling();
    else if (view === 'automations') await renderAutomations();
    else if (view === 'usage') await renderUsage();
    else if (view === 'reports') await renderReports();
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
    else if (action === 'toggle-lead-edit') $('#leadEditPanel')?.classList.toggle('hidden');
    else if (action === 'new-lead') { renderView('leads'); setTimeout(() => $('#newLeadPanel')?.classList.remove('hidden'), 0); }
    else if (action === 'lead-details') await renderLeadDetail(id);
    else if (action === 'restore-lead') { await api(`${workspacePath(`leads/${encodeURIComponent(id)}/restore`)}`, { method: 'POST', body: {} }); showToast('Lead restored.'); await renderTrash(); }
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
    else if (action === 'field-required') { await api(`${workspacePath(`custom-fields/${encodeURIComponent(id)}`)}`, { method: 'PATCH', body: { required: button.dataset.required === 'true' } }); showToast('Field settings updated.'); await renderWorkspace(); }
    else if (action === 'toggle-automation-form') $('#automationFormPanel').classList.toggle('hidden');
    else if (action === 'reload-view') await renderView(appState.view);
    else if (action === 'run-automation') {
      const key = `manual-${crypto.randomUUID()}`;
      await api(`${workspacePath(`automations/${encodeURIComponent(id)}`)}`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: {} });
      showToast('Automation run queued.'); await renderAutomations();
    }
  } catch (error) { showToast(error.message, 'error'); }
});

$('#viewRoot').addEventListener('change', async event => {
  if (event.target.id === 'leadStatus') { appState.leadStatus = event.target.value; appState.cursor = null; await renderLeads(); }
  if (event.target.id === 'bulkStatus' && event.target.value) {
    if (!appState.selectedLeads.size) { showToast('Select at least one lead.', 'error'); event.target.value = ''; return; }
    try {
      await api(workspacePath('leads/bulk'), { method: 'POST', body: { leadIds: [...appState.selectedLeads], operation: 'status', status: event.target.value } });
      appState.selectedLeads.clear(); showToast('Selected lead statuses updated.'); await renderLeads();
    } catch (error) { showToast(error.message, 'error'); }
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
  if (event.target.id === 'leadSearch') {
    clearTimeout(appState.searchTimer);
    appState.searchTimer = setTimeout(async () => { appState.leadSearch = event.target.value; appState.cursor = null; await renderLeads(); }, 250);
  }
});

$('#viewRoot').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.target; const input = formObject(form);
  try {
    if (form.id === 'leadEditForm') {
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
      const lead = { ...input, budget: input.budget ? Number(input.budget) : null, nextActionAt: input.nextActionAt ? localDateTime(input.nextActionAt) : null };
      Object.keys(lead).forEach(key => { if (lead[key] === '') lead[key] = null; });
      await api(workspacePath('leads'), { method: 'POST', body: lead }); showToast('Lead created.'); appState.cursor = null; await renderLeads();
    } else if (form.id === 'taskForm') {
      const task = { ...input, leadId: input.leadId || null, dueAt: input.dueAt ? localDateTime(input.dueAt) : null, priority: Number(input.priority ?? 0) };
      await api(workspacePath('tasks'), { method: 'POST', body: task }); showToast('Follow-up created.'); await renderTasks();
    } else if (form.id === 'taskEditForm') {
      const taskId = form.dataset.taskId;
      await api(`${workspacePath(`tasks/${encodeURIComponent(taskId)}`)}`, { method: 'PATCH', body: { title: input.title, description: input.description || null, dueAt: input.dueAt ? localDateTime(input.dueAt) : null, priority: Number(input.priority || 0), status: input.status } });
      showToast('Task updated.'); await renderTasks();
    } else if (form.id === 'meetingForm') {
      await api(workspacePath('meetings'), { method: 'POST', body: { leadId: input.leadId || null, meetingType: input.meetingType || null, startsAt: localDateTime(input.startsAt), endsAt: input.endsAt ? localDateTime(input.endsAt) : null, status: 'scheduled', notes: input.notes || null } });
      showToast('Meeting scheduled.'); await renderMeetings();
    } else if (form.id === 'messageDraftForm') {
      await api(workspacePath('messages'), { method: 'POST', body: input }); showToast('Message draft saved.'); await renderCommunications();
    } else if (form.id === 'callForm') {
      const notes = input.metadataNotes; const metadata = notes ? { notes } : {};
      const call = { ...input, leadId: input.leadId || null, durationSeconds: Number(input.durationSeconds || 0), startedAt: input.startedAt ? localDateTime(input.startedAt) : null, answeredAt: input.answeredAt ? localDateTime(input.answeredAt) : null, endedAt: input.endedAt ? localDateTime(input.endedAt) : null, metadata };
      delete call.metadataNotes;
      await api(workspacePath('calls'), { method: 'POST', body: call }); showToast('Call record saved.'); await renderCalling();
    } else if (form.id === 'automationForm') {
      const actionType = input.actionType;
      const actionConfig = actionType === 'create_task' ? { title: input.actionText } : actionType === 'create_activity' ? { title: input.actionText } : { channel: 'whatsapp', body: input.actionText };
      let conditionConfig = {}; if (input.conditions) { try { conditionConfig = JSON.parse(input.conditions); } catch { throw new Error('Conditions must be valid JSON.'); } }
      const actions = []; if (Number(input.waitMinutes || 0) > 0) actions.push({ type: 'wait', config: { minutes: Number(input.waitMinutes) } }); actions.push({ type: actionType, config: actionConfig });
      const result = await api(workspacePath('automations'), { method: 'POST', body: { name: input.name, description: input.description || null, triggerType: input.triggerType, triggerConfig: conditionConfig, actions, active: form.elements.active.checked } });
      showToast(`Automation saved as version 1${result.active ? ' and activated' : ''}.`); await renderAutomations();
    } else if (form.id === 'estimateForm') {
      const estimate = await api(workspacePath('usage/estimate'), { method: 'POST', body: { ...input, quantity: Number(input.quantity) } });
      $('#estimateResult').innerHTML = `<div class="notice notice-green">Estimated provider cost: <strong>${fmtMoney(estimate.providerCost, estimate.currency)}</strong> · Customer charge: <strong>${fmtMoney(estimate.customerCharge, estimate.currency)}</strong> · Rate ${escapeHtml(estimate.rateId.slice(0, 8))}</div>`;
    } else if (form.id === 'rateForm') {
      const rate = { ...input, provider: input.provider || null, providerCostPerUnit: Number(input.providerCostPerUnit), customerChargePerUnit: Number(input.customerChargePerUnit), validFrom: input.validFrom ? localDateTime(input.validFrom) : null };
      await api(workspacePath('usage/rates'), { method: 'POST', body: rate }); showToast('Rate version published.'); await renderUsage();
    } else if (form.id === 'workspaceForm') {
      await api(workspacePath(), { method: 'PATCH', body: input }); showToast('Workspace updated.'); await renderWorkspace();
    } else if (form.id === 'customFieldForm') {
      await api(workspacePath('custom-fields'), { method: 'POST', body: { entityType: 'lead', fieldKey: input.fieldKey, label: input.label, fieldType: input.fieldType, required: form.elements.required.checked, config: {} } });
      showToast('Custom field added.'); await renderWorkspace();
    } else if (form.id === 'tagForm') {
      await api(workspacePath('tags'), { method: 'POST', body: { name: input.name } }); showToast('Tag added.'); await renderWorkspace();
    } else if (form.id === 'memberForm') {
      await api(workspacePath('members'), { method: 'POST', body: input }); showToast('Member created.'); await renderWorkspace();
    }
  } catch (error) { showToast(error.message, 'error'); }
});

boot();

