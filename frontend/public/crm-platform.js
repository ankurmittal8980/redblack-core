// Operational CRM views use the same authenticated API and vanilla SPA shell.
export function createCrmPlatformUI({api,workspacePath,setPage,pageHeading,escapeHtml:esc,appState,showToast,renderLeadDetail}) {
 const writable=()=>['owner','admin','manager','agent'].includes(appState.role);
 const cfg={
  contacts:{title:'Contacts',label:r=>[r.first_name,r.last_name].filter(Boolean).join(' '),fields:['firstName','lastName','email','phone','title','companyId','leadId','ownerUserId']},
  companies:{title:'Companies',label:r=>r.name,fields:['name','website','domain','phone','address','ownerUserId']},
  deals:{title:'Deals / Opportunities',label:r=>r.title||'Opportunity',fields:['title','value','currency','status','expectedCloseDate','pipelineId','stageId','contactId','companyId','leadId','ownerUserId']},
  tickets:{title:'Tickets',label:r=>`#${r.ticket_number} ${r.subject}`,fields:['subject','description','status','priority','contactId','companyId','leadId','assigneeUserId']}
 };
 const keys={firstName:'first_name',lastName:'last_name',companyId:'company_id',leadId:'lead_id',ownerUserId:'owner_user_id',assigneeUserId:'assignee_user_id',expectedCloseDate:'expected_close_date',pipelineId:'pipeline_id',stageId:'stage_id',contactId:'contact_id'};
 const button=(label,action,attrs='')=>`<button type="button" class="button button-secondary button-small" data-crm-action="${action}" ${attrs}>${esc(label)}</button>`;
 const panel=html=>`<section class="panel"><div class="panel-body">${html}</div></section>`;
 const empty=label=>`<div class="empty-state">${esc(label)}</div>`;
 const title=key=>key.replace(/([A-Z])/g,' $1').replace(/^./,x=>x.toUpperCase());
 const error=err=>showToast(err.message,'error');
 let currentEntity=null,currentId=null,lastFilters={};
 function handlers(click,submit,change) {
  const root=document.querySelector('#viewRoot');
  root.onclick=event=>{const target=event.target.closest('[data-crm-action]');if(target)Promise.resolve(click?.(target)).catch(error);};
  root.onsubmit=event=>{if(!event.target.matches('[data-crm-form]'))return;event.preventDefault();Promise.resolve(submit?.(event.target)).catch(error);};
  root.onchange=event=>Promise.resolve(change?.(event.target)).catch(error);
 }
 function payload(form) {return Object.fromEntries(new FormData(form).entries());}
 async function choices() {
  const paths=['companies','contacts','leads?limit=100','pipelines','members/choices'];
  const rows=await Promise.all(paths.map(path=>api(workspacePath(path))));
  return {companies:rows[0].data,contacts:rows[1].data,leads:rows[2].data,pipelines:rows[3].data,members:rows[4].data};
 }
 function select(name,value,rows,label,idKey='id',required=false) {
  return `<label>${esc(title(name))}<select name="${name}" ${required?'required':''}><option value="">Select…</option>${rows.map(row=>`<option value="${esc(row[idKey])}" ${String(row[idKey])===String(value)?'selected':''}>${esc(label(row))}</option>`).join('')}</select></label>`;
 }
 function field(entity,key,row,c) {
  const value=row[keys[key]??key]??(key==='currency'?appState.workspace.currency:'');
  if(['ownerUserId','assigneeUserId'].includes(key))return select(key,value,c.members.filter(m=>appState.role!=='agent'||m.user_id===appState.user.id),r=>r.display_name,'user_id');
  if(key==='companyId')return select(key,value,c.companies,r=>r.name);
  if(key==='contactId')return select(key,row.primary_contact_id??value,c.contacts,cfg.contacts.label);
  if(key==='leadId')return select(key,value,c.leads,r=>[r.first_name,r.last_name].filter(Boolean).join(' '));
  if(key==='pipelineId')return select(key,value,c.pipelines.filter(p=>p.active),r=>r.name);
  if(key==='stageId')return select(key,value,c.pipelines.find(p=>p.id===row.pipeline_id)?.stages??[],r=>r.name);
  if(key==='status')return select(key,value||(entity==='deals'?'open':'open'),(entity==='deals'?['open','won','lost']:['open','in_progress','waiting','resolved','closed']).map(id=>({id})),r=>r.id);
  if(key==='priority')return select(key,value||'normal',['low','normal','high','urgent'].map(id=>({id})),r=>r.id);
  if(['description','address'].includes(key))return `<label class="span-2">${esc(title(key))}<textarea name="${key}" maxlength="10000">${esc(value)}</textarea></label>`;
  return `<label>${esc(title(key))}<input name="${key}" type="${key==='email'?'email':key==='expectedCloseDate'?'date':key==='value'?'number':'text'}" ${key==='value'?'min="0" step="0.01"':''} value="${esc(key==='expectedCloseDate'?String(value).slice(0,10):value)}" maxlength="${key==='currency'?3:500}" ${['name','subject'].includes(key)||(key==='title'&&entity==='deals')?'required':''}></label>`;
 }
 async function list(entity,filters={}) {
  currentEntity=entity;currentId=null;lastFilters=filters;
  const query=new URLSearchParams({...filters,limit:100});const [result,c]=await Promise.all([api(`${workspacePath(entity)}?${query}`),choices()]);
  const rows=result.data??[];const attrs=r=>`data-id="${esc(r.id)}"`;
  const table=rows.length?`<div class="table-wrap"><table><thead><tr><th>Name</th><th>Status / details</th><th>Updated</th><th>Actions</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(cfg[entity].label(r))}</td><td>${esc(r.status??r.email??r.domain??'—')}${entity==='deals'?` · ${esc(r.value??'0')} ${esc(r.currency??'')}`:''}</td><td>${esc(new Date(r.updated_at).toLocaleString())}</td><td>${button('Open','open',attrs(r))}${writable()?button(filters.trash==='true'?'Restore':'Archive',filters.trash==='true'?'restore':'archive',attrs(r)):''}</td></tr>`).join('')}</tbody></table></div>`:empty('No matching records.');
  const board=entity==='deals'&&filters.trash!=='true'?panel(`<h2>Deal pipeline</h2><select id="crmBoardPipeline"><option value="">Select pipeline…</option>${c.pipelines.filter(p=>p.active).map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select><div id="crmDealBoard" class="pipeline-board">${empty('Choose a pipeline to see deals by stage.')}</div>`):'';
  setPage(`${pageHeading('CRM',cfg[entity].title,'Workspace records, relationships and history.')}${panel(`<form data-crm-form="filter" class="inline-form"><label>Search<input name="q" value="${esc(filters.q??'')}"></label>${['deals','tickets'].includes(entity)?`<label>Status<select name="status"><option value="">All</option>${(entity==='deals'?['open','won','lost']:['open','in_progress','waiting','resolved','closed']).map(s=>`<option ${filters.status===s?'selected':''}>${s}</option>`).join('')}</select></label>`:''}<label>View<select name="trash"><option value="false">Active</option><option value="true" ${filters.trash==='true'?'selected':''}>Archived</option></select></label><button class="button button-primary">Filter</button>${writable()?button('Create','create'):''}</form>`)}${board}${panel(table)}${result.nextOffset!==null?panel(button('Next 100','next')):''}`);
  handlers(async target=>{
   const action=target.dataset.crmAction,id=target.dataset.id;
   if(action==='open')await detail(entity,id);
   else if(action==='create')await edit(entity,null,c);
   else if(action==='next')await list(entity,{...filters,offset:result.nextOffset});
   else if(['archive','restore'].includes(action)){if(action==='archive'&&!confirm('Archive this record? It can be restored.'))return;await api(workspacePath(`${entity}/${id}${action==='restore'?'/restore':''}`),{method:action==='restore'?'POST':'DELETE',body:action==='restore'?{}:undefined});showToast('Record updated.');await list(entity,filters);}
  },form=>list(entity,payload(form)),async target=>{
   if(target.id==='crmBoardPipeline') {
    const p=c.pipelines.find(p=>p.id===target.value); const stageList=p?.stages??[];
    document.querySelector('#crmDealBoard').innerHTML=stageList.map(s=>`<div class="pipeline-column"><h3>${esc(s.name)}</h3>${rows.filter(r=>r.pipeline_id===p.id&&r.stage_id===s.id).map(r=>`<article class="pipeline-card">${button(cfg.deals.label(r),'open',attrs(r))}${writable()?`<select data-crm-move="${esc(r.id)}"><option value="">Move to…</option>${stageList.map(next=>`<option value="${esc(next.id)}">${esc(next.name)}</option>`).join('')}</select>`:''}</article>`).join('')||empty('No deals.')}</div>`).join('');
   }
   if(target.dataset.crmMove&&target.value){await api(workspacePath(`deals/${target.dataset.crmMove}`),{method:'PATCH',body:{pipelineId:document.querySelector('#crmBoardPipeline').value,stageId:target.value}});showToast('Deal moved.');await list(entity,filters);}
  });
 }
 async function detail(entity,id) {
  currentEntity=entity;currentId=id;const row=await api(workspacePath(`${entity}/${id}`));
  setPage(`${pageHeading('CRM',cfg[entity].label(row),'Record details and activity history.')}${panel(`${button('Back','back')}${writable()&&!row.deleted_at?button('Edit','edit'):''}${row.deleted_at?'<p>This record is archived.</p>':''}<dl class="key-value">${cfg[entity].fields.map(key=>`<dt>${esc(title(key))}</dt><dd>${esc(row[keys[key]??key]??(key==='contactId'?row.primary_contact_id:'')??'—')}</dd>`).join('')}</dl>`)}${panel(`<h2>Activity / history</h2>${(row.history??[]).map(h=>`<article class="task-row"><div><strong>${esc(h.action)}</strong><p>${esc(h.body??'')}</p><small>${esc(h.actor_name??'System')} · ${esc(new Date(h.created_at).toLocaleString())}</small>${h.details?.after?`<dl class="key-value">${Object.entries(h.details.after).map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v??'—')}</dd>`).join('')}</dl>`:''}</div></article>`).join('')||empty('No recorded history yet.')}${writable()&&!row.deleted_at?'<form data-crm-form="note"><label>Add note<textarea name="body" required maxlength="10000"></textarea></label><button class="button button-primary">Add note</button></form>':''}`)}`);
  handlers(async target=>{if(target.dataset.crmAction==='back')await list(entity,lastFilters);if(target.dataset.crmAction==='edit')await edit(entity,row);},async form=>{await api(workspacePath(`${entity}/${id}/notes`),{method:'POST',body:payload(form)});await detail(entity,id);});
 }
 async function edit(entity,row,cached=null) {
  const c=cached??await choices();row??={};
  setPage(`${pageHeading('CRM',`${row.id?'Edit':'Create'} ${cfg[entity].title}`,'Changes are validated and recorded in workspace history.')}${panel(`<form data-crm-form="entity"><div class="field-grid">${cfg[entity].fields.map(key=>field(entity,key,row,c)).join('')}</div><p>Related-record choices show the first 100 accessible records.</p><button class="button button-primary">Save</button> ${button('Cancel','cancel')}</form>`)}`);
  handlers(()=>row.id?detail(entity,row.id):list(entity,lastFilters),async form=>{
   const data=payload(form);for(const key of Object.keys(data)){if(key.endsWith('Id')&&data[key]==='')data[key]=null;}
   const saved=await api(workspacePath(`${entity}${row.id?`/${row.id}`:''}`),{method:row.id?'PATCH':'POST',body:data});showToast('Record saved.');await detail(entity,saved.id);
  },target=>{if(target.name==='pipelineId'){const stages=c.pipelines.find(p=>p.id===target.value)?.stages??[]; const selectEl=document.querySelector('[name="stageId"]');selectEl.innerHTML=`<option value="">Select…</option>${stages.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}`;}});
 }
 async function conversion(leadId) {
  if(!writable())return;
  const existing=await api(workspacePath(`leads/${leadId}/convert`));
  const root=document.querySelector('#viewRoot');
  const node=document.createElement('section');node.className='panel';
  if(existing){node.innerHTML=`<div class="panel-body"><h2>Converted lead</h2><p>Original lead history is retained.</p>${button('Open contact','converted-contact')}${button('Open deal','converted-deal')}</div>`;root.append(node);node.onclick=event=>{const t=event.target.closest('[data-crm-action]');if(t)detail(t.dataset.crmAction==='converted-contact'?'contacts':'deals',t.dataset.crmAction==='converted-contact'?existing.contact_id:existing.opportunity_id).catch(error);};return;}
  const c=await choices();
  node.innerHTML=`<div class="panel-body"><h2>Convert lead to contact / company / deal</h2><p>Conversion is atomic and safe to retry. Lead history stays available.</p><form data-crm-convert><div class="field-grid"><label>Deal title<input name="title" required maxlength="300"></label><label>New company name (optional)<input name="companyName" maxlength="300"></label>${select('companyId','',c.companies,r=>r.name)}${select('contactId','',c.contacts,cfg.contacts.label)}${select('pipelineId','',c.pipelines.filter(p=>p.active),r=>r.name)}${select('stageId','',[],r=>r.name)}<label>Deal value<input name="value" type="number" min="0" step="0.01"></label></div><button class="button button-primary">Convert lead</button></form></div>`;root.append(node);
  node.onchange=event=>{if(event.target.name==='pipelineId'){const stages=c.pipelines.find(p=>p.id===event.target.value)?.stages??[];node.querySelector('[name="stageId"]').innerHTML=`<option value="">Select…</option>${stages.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}`;}};
  node.onsubmit=async event=>{event.preventDefault();event.stopPropagation();const form=event.target;const b=form.querySelector('button');b.disabled=true;try{const data=payload(form);const result=await api(workspacePath(`leads/${leadId}/convert`),{method:'POST',body:data});showToast('Lead converted.');await detail('deals',result.opportunity_id);}catch(err){error(err);b.disabled=false;}};
 }
 async function search(query='') {
  const result=query?await api(`${workspacePath('search')}?q=${encodeURIComponent(query)}`):{data:[]};
  setPage(`${pageHeading('CRM','Global Search','Search only records available to your workspace role.')}${panel(`<form data-crm-form="search" class="inline-form"><label>Search<input name="q" value="${esc(query)}" required maxlength="120"></label><button class="button button-primary">Search</button></form>${result.data.map(r=>`<div class="task-row"><span>${esc(r.entity_type)}</span>${button(r.label||'Unnamed record','result',`data-type="${esc(r.entity_type)}" data-id="${esc(r.id)}"`)}<span>${esc(r.detail??'')}</span></div>`).join('')||empty(query?'No accessible matches.':'Enter a name, email or phone.')}`)}`);
  handlers(target=>target.dataset.type==='lead'?renderLeadDetail(target.dataset.id):detail({contact:'contacts',company:'companies',deal:'deals',ticket:'tickets'}[target.dataset.type],target.dataset.id),form=>search(payload(form).q));
 }
 async function notifications() {
  const result=await api(workspacePath('notifications'));
  setPage(`${pageHeading('WORKSPACE','Notifications','Internal assignment and CRM updates for you.')}${panel(result.data.map(n=>`<article class="task-row"><div><strong>${esc(n.title)}</strong><p>${esc(n.body??'')}</p><small>${esc(new Date(n.created_at).toLocaleString())} · ${n.read_at?'Read':'Unread'}</small></div>${!n.read_at?button('Mark read','read',`data-id="${esc(n.id)}"`):''}</article>`).join('')||empty('No notifications yet.'))}`);
  handlers(async t=>{await api(workspacePath(`notifications/${t.dataset.id}/read`),{method:'POST',body:{}});await notifications();});
 }
 async function reports(from='',to='') {
  const query=new URLSearchParams();if(from)query.set('from',`${from}T00:00:00Z`);if(to)query.set('to',`${to}T23:59:59.999Z`);
  const r=await api(`${workspacePath('reports/crm')}?${query}`);
  const table=(rows,columns)=>rows.length?`<div class="table-wrap"><table><thead><tr>${columns.map(k=>`<th>${esc(title(k))}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${columns.map(k=>`<td>${esc(row[k]??'—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`:empty('No records in this date range.');
  const node=document.createElement('section');node.className='panel';node.id='crmOperationalReports';
  node.innerHTML=`<div class="panel-body"><h2>Operational CRM reports</h2><form data-crm-report class="inline-form"><label>From<input type="date" name="from" value="${esc(r.from.slice(0,10))}" required></label><label>To<input type="date" name="to" value="${esc(r.to.slice(0,10))}" required></label><button class="button button-primary">Apply dates</button></form><p>${r.conversions.converted} conversions during this period; ${r.conversions.leads} leads created during this period.</p><h3>Deal funnel (amounts kept separate by currency)</h3>${table(r.deals,['pipeline','stage','status','currency','count','value'])}<h3>Ticket metrics</h3>${table(r.tickets,['status','priority','count'])}<h3>Tasks / follow-ups</h3>${table(r.tasks,['status','count'])}<h3>Activities</h3>${table(r.activities,['type','count'])}</div>`;
  document.querySelector('#crmOperationalReports')?.remove();document.querySelector('#viewRoot').append(node);
  node.onsubmit=event=>{event.preventDefault();event.stopPropagation();const data=payload(event.target);reports(data.from,data.to).catch(error);};
 }
 async function inbox(leadId=null,channel=null) {
  const threads=await api(workspacePath('inbox'));let messages=[];
  if(leadId){messages=(await api(workspacePath(`inbox/${leadId}/${channel}`))).data;await api(workspacePath(`inbox/${leadId}/${channel}/read`),{method:'POST',body:{}});}
  const leads=writable()?(await api(workspacePath('leads?limit=100'))).data:[];
  setPage(`${pageHeading('COMMUNICATIONS','Unified Inbox','Conversations grouped by lead and channel. Read state is internal to Core.')}${panel(`<h2>Threads</h2>${threads.data.map(t=>`<div class="task-row">${button(`${t.lead_name||'Unnamed lead'} · ${t.channel}`,'thread',`data-lead="${esc(t.lead_id)}" data-channel="${esc(t.channel)}"`)}<span>${t.messages} messages · ${t.unread} unread</span></div>`).join('')||empty('No linked conversations yet.')}`)}${leadId?panel(`<h2>Conversation</h2>${button('Open lead context','lead',`data-id="${esc(leadId)}"`)}${messages.map(m=>`<article class="task-row"><div><strong>${esc(m.direction)} · ${esc(m.channel)} · ${esc(m.status)}</strong><p>${esc(m.subject??'')}</p><p style="white-space:pre-wrap">${esc(m.body??'')}</p><small>${esc(new Date(m.created_at).toLocaleString())}</small></div></article>`).join('')||empty('No messages.')}`):''}${writable()?panel(`<h2>Create message draft</h2><p>Drafts remain internal until sent using a configured, supported provider.</p><form data-crm-form="draft"><div class="field-grid">${select('leadId',leadId,leads,r=>[r.first_name,r.last_name].filter(Boolean).join(' '),'id',true)}${select('channel',channel??'email',['email','whatsapp','sms','rcs'].map(id=>({id})),r=>r.id)}<label>Subject<input name="subject" maxlength="300"></label><label class="span-2">Message<textarea name="body" required maxlength="10000"></textarea></label></div><button class="button button-primary">Save draft</button></form>`):''}`);
  handlers(t=>t.dataset.crmAction==='lead'?renderLeadDetail(t.dataset.id):inbox(t.dataset.lead,t.dataset.channel),async form=>{const data=payload(form);await api(workspacePath('messages'),{method:'POST',body:{...data,status:'draft'}});showToast('Draft saved.');await inbox(data.leadId,data.channel);});
 }
 return {list,detail,conversion,search,notifications,reports,inbox};
}
