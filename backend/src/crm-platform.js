import { transaction } from './db.js';
import { audit } from './audit.js';
import { requirePermission } from './rbac.js';
import { ValidationError, requiredString, optionalString, uuid, enumValue, normalizeEmail, normalizePhone, decimal, isoDate, finiteNumber } from './validation.js';

// SQL identifiers are exclusively defined here, never supplied by a caller.
export const CRM_ENTITIES = Object.freeze({
 contacts: { table: 'contacts', type: 'contact', owner: 'owner_user_id', label: "concat_ws(' ',r.first_name,r.last_name)", fields: { firstName:'first_name',lastName:'last_name',email:'email',phone:'phone',title:'title',companyId:'company_id',leadId:'lead_id',ownerUserId:'owner_user_id' } },
 companies: { table:'companies',type:'company',owner:'owner_user_id',label:'r.name',fields:{name:'name',website:'website',domain:'domain',phone:'phone',address:'address',ownerUserId:'owner_user_id'} },
 deals: { table:'opportunities',type:'deal',owner:'owner_user_id',label:"COALESCE(r.title,'Opportunity')",fields:{title:'title',value:'value',currency:'currency',status:'status',expectedCloseDate:'expected_close_date',pipelineId:'pipeline_id',stageId:'stage_id',contactId:'primary_contact_id',companyId:'company_id',leadId:'lead_id',ownerUserId:'owner_user_id'} },
 tickets: { table:'tickets',type:'ticket',owner:'assignee_user_id',label:'r.subject',fields:{subject:'subject',description:'description',status:'status',priority:'priority',contactId:'contact_id',companyId:'company_id',leadId:'lead_id',assigneeUserId:'assignee_user_id'} }
});
function fail(status,code,message) { const error=new Error(message); Object.assign(error,{status,code}); throw error; }
function writePermission(context) { requirePermission(context,'crm:write'); if(context.role==='service') fail(403,'FORBIDDEN','Service accounts cannot manage these CRM records.'); }
function scope(context,entity,alias='r',userParameter=2) {
 if(context.role!=='agent') return '';
 if(entity==='leads') return ` AND EXISTS(SELECT 1 FROM lead_assignments a WHERE a.workspace_id=${alias}.workspace_id AND a.lead_id=${alias}.id AND a.user_id=$${userParameter} AND a.unassigned_at IS NULL)`;
 return ` AND ${alias}.${CRM_ENTITIES[entity].owner}=$${userParameter}`;
}
async function record(db,context,entity,id,{trash=false,lock=false}={}) {
 const table=entity==='leads'?'leads':CRM_ENTITIES[entity].table;
 const result=await db.query(`SELECT r.* FROM ${table} r WHERE r.workspace_id=$1 AND ($2::uuid IS NOT NULL) AND r.id=$3 ${trash?'':'AND r.deleted_at IS NULL'}${scope(context,entity)}${lock?' FOR UPDATE':''}`, [context.workspaceId,context.userId,uuid(id)]);
 if(!result.rows[0]) fail(404,'RECORD_NOT_FOUND','Record was not found or is unavailable to you.');
 return result.rows[0];
}
async function references(db,context,data,entity,changed=null) {
 for(const [column,kind] of Object.entries({company_id:'companies',primary_contact_id:'contacts',contact_id:'contacts',lead_id:'leads'})) {
  if(data[column]&&(!changed||changed.includes(column))) await record(db,context,kind,data[column]);
 }
 const owner=data.owner_user_id??data.assignee_user_id;
 if(owner) {
  uuid(owner,'owner');
  if(context.role==='agent' && owner!==context.userId) fail(403,'FORBIDDEN','Agents can assign these records only to themselves.');
  if(!(await db.query('SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND active',[context.workspaceId,owner])).rowCount) fail(400,'INVALID_OWNER','Select an active workspace member.');
 }
 if(entity==='deals') {
  if(data.pipeline_id && !(await db.query('SELECT 1 FROM pipelines WHERE workspace_id=$1 AND id=$2 AND active',[context.workspaceId,data.pipeline_id])).rowCount) fail(400,'INVALID_PIPELINE','Select an active workspace pipeline.');
  if(data.stage_id) {
   const stage=(await db.query('SELECT s.* FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id WHERE p.workspace_id=$1 AND p.active AND s.pipeline_id=$2 AND s.id=$3',[context.workspaceId,data.pipeline_id,data.stage_id])).rows[0];
   if(!stage) fail(400,'INVALID_STAGE','Stage must belong to the selected workspace pipeline.');
   if(stage.is_won) data.status='won'; else if(stage.is_lost) data.status='lost'; else data.status='open';
  }
 }
}
export function crmInput(entity,input) {
 const config=CRM_ENTITIES[entity]; if(!config) throw new ValidationError('Unknown CRM entity.');
 const result={};
 for(const [key,column] of Object.entries(config.fields)) {
  if(input[key]===undefined) continue;
  const value=input[key];
  if(key.endsWith('Id')) result[column]=value?uuid(value,key):null;
  else if(key==='email') {result.email=normalizeEmail(value); result.email_normalized=result.email;}
  else if(key==='phone') {result.phone=normalizePhone(value); if(entity==='contacts')result.phone_normalized=result.phone;}
  else if(key==='value') result[column]=value===''||value===null?null:decimal(value,key,{min:'0',max:'9999999999999999.99',scale:2});
  else if(key==='status') result[column]=enumValue(value,key,entity==='deals'?['open','won','lost']:['open','in_progress','waiting','resolved','closed']);
  else if(key==='priority') result[column]=enumValue(value,key,['low','normal','high','urgent']);
  else if(key==='currency') { if(!/^[A-Z]{3}$/.test(value))throw new ValidationError('Currency must be a three-letter uppercase code.'); result[column]=value; }
  else if(key==='expectedCloseDate') result[column]=isoDate(value,key,{optional:true});
  else if(['name','subject','title'].includes(key) && (entity!=='contacts'||key!=='title')) result[column]=requiredString(value,key,{max:300});
  else result[column]=optionalString(value,key,key==='description'?10000:500);
 }
 return result;
}
async function history(db,context,entity,id,action,request,details={},body=null) {
 await db.query('INSERT INTO crm_record_history(workspace_id,entity_type,entity_id,actor_user_id,action,body,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',[context.workspaceId,entity,id,context.userId,action,body,JSON.stringify(details)]);
 await audit(db,{workspaceId:context.workspaceId,actorUserId:context.userId,action:`${entity}.${action}`,entityType:entity,entityId:id,request,metadata:details});
}
async function insert(db,context,entity,data,request) {
 const cfg=CRM_ENTITIES[entity];
 data[cfg.owner]??=context.userId;
 if(entity==='contacts'&&!data.first_name&&!data.last_name) throw new ValidationError('A contact name is required.');
 if(entity==='companies') requiredString(data.name,'name');
 if(entity==='tickets') {requiredString(data.subject,'subject');data.created_by=context.userId;}
 if(entity==='deals') {requiredString(data.title,'title');data.currency??=(await db.query('SELECT currency FROM workspaces WHERE id=$1',[context.workspaceId])).rows[0].currency;}
 await references(db,context,data,entity);
 const columns=['workspace_id',...Object.keys(data)]; const values=[context.workspaceId,...Object.values(data)];
 const created=(await db.query(`INSERT INTO ${cfg.table}(${columns.join(',')}) VALUES(${values.map((_,i)=>`$${i+1}`).join(',')}) RETURNING *`,values)).rows[0];
 await history(db,context,cfg.type,created.id,'created',request,{fields:Object.keys(data)});
 return created;
}

export async function handleCrmPlatform({db,context,suffix,request,url,body,reply}) {
 const method=request.method; const workspaceId=context.workspaceId;
 const entityMatch=suffix.match(/^(contacts|companies|deals|tickets)(?:\/([^/]+))?(?:\/(restore|notes))?$/);
 if(entityMatch) {
  const [,entity,rawId,operation]=entityMatch; const cfg=CRM_ENTITIES[entity]; const id=rawId?uuid(rawId):null;
  requirePermission(context,'crm:read');
  if(method==='GET'&&!id) {
   const q=optionalString(url.searchParams.get('q'),'q',120)??''; const status=optionalString(url.searchParams.get('status'),'status',40)??'';
   const limit=finiteNumber(url.searchParams.get('limit')??100,'limit',{min:1,max:100}); const offset=finiteNumber(url.searchParams.get('offset')??0,'offset',{min:0,max:100000});
   const trash=url.searchParams.get('trash')==='true';
   const result=await db.query(`SELECT r.* FROM ${cfg.table} r WHERE r.workspace_id=$1 AND $2::uuid IS NOT NULL AND r.deleted_at IS ${trash?'NOT ':''}NULL${scope(context,entity)} AND ($3='' OR position(lower($3) in lower(${cfg.label}||' '||COALESCE(to_jsonb(r)->>'email','')))>0) ${['tickets','deals'].includes(entity)?"AND ($4='' OR r.status=$4)":"AND $4::text IS NOT NULL"} ORDER BY r.created_at DESC,r.id LIMIT $5 OFFSET $6`,[workspaceId,context.userId,q,status,limit,offset]);
   reply(200,{data:result.rows,nextOffset:result.rowCount===limit?offset+limit:null});return true;
  }
  if(method==='GET'&&id&&!operation) {
   const found=await record(db,context,entity,id,{trash:true});
   const events=await db.query('SELECT h.*,u.display_name AS actor_name FROM crm_record_history h LEFT JOIN users u ON u.id=h.actor_user_id WHERE h.workspace_id=$1 AND h.entity_type=$2 AND h.entity_id=$3 ORDER BY h.created_at DESC,h.id DESC LIMIT 100',[workspaceId,cfg.type,id]);
   reply(200,{...found,history:events.rows});return true;
  }
  writePermission(context);
  if(method==='POST'&&!id) {const input=crmInput(entity,await body());reply(201,await transaction(db,client=>insert(client,context,entity,input,request)));return true;}
  if(!id) fail(405,'METHOD_NOT_ALLOWED','Unsupported CRM operation.');
  if(method==='PATCH'||method==='DELETE'||(method==='POST'&&operation)) {
   const input=method==='PATCH'?crmInput(entity,await body()):operation==='notes'?await body():{};
   const result=await transaction(db,async client=>{
    const old=await record(client,context,entity,id,{trash:operation==='restore',lock:true});
    if(operation==='notes') {await history(client,context,cfg.type,id,'note',request,{},requiredString(input.body,'body',{max:10000}));return old;}
    let changes;
    let action='updated';
    if(method==='DELETE') {changes={deleted_at:new Date()};action='deleted';}
    else if(operation==='restore'){changes={deleted_at:null};action='restored';}
    else {changes=input; if(!Object.keys(changes).length)throw new ValidationError('Provide at least one supported field.'); const merged={...old,...changes}; if(context.role==='agent'&&!merged[cfg.owner])fail(403,'FORBIDDEN','Agents must retain ownership of these records.'); if(entity==='contacts'&&!merged.first_name&&!merged.last_name)throw new ValidationError('A contact name is required.'); await references(client,context,merged,entity,Object.keys(changes)); if(entity==='deals'&&(input.stage_id!==undefined||input.pipeline_id!==undefined)) changes.status=merged.status;}
    const columns=Object.keys(changes); const values=[workspaceId,id,...Object.values(changes)];
    const updated=(await client.query(`UPDATE ${cfg.table} SET ${columns.map((column,i)=>`${column}=$${i+3}`).join(',')},updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *`,values)).rows[0];
    await history(client,context,cfg.type,id,action,request,{fields:columns,before:Object.fromEntries(columns.map(key=>[key,old[key]])),after:changes});return updated;
   });reply(200,result);return true;
  }
  fail(405,'METHOD_NOT_ALLOWED','Unsupported CRM operation.');
 }
 const conversion=suffix.match(/^leads\/([^/]+)\/convert$/);
 if(conversion) {
  requirePermission(context,'crm:read');const id=uuid(conversion[1]);
  if(method==='GET'){await record(db,context,'leads',id);reply(200,(await db.query('SELECT * FROM lead_conversions WHERE workspace_id=$1 AND lead_id=$2',[workspaceId,id])).rows[0]??null);return true;}
  if(method!=='POST')fail(405,'METHOD_NOT_ALLOWED','Use POST to convert a lead.');
  writePermission(context);const input=await body();
  const result=await transaction(db,async client=>{
   const lead=await record(client,context,'leads',id,{lock:true});
   const existing=(await client.query('SELECT * FROM lead_conversions WHERE workspace_id=$1 AND lead_id=$2',[workspaceId,id])).rows[0];
   if(existing)return {...existing,replayed:true};
   let companyId=input.companyId?uuid(input.companyId):null;
   if(companyId)await record(client,context,'companies',companyId);
   else if(input.companyName||lead.company_name)companyId=(await insert(client,context,'companies',{name:requiredString(input.companyName??lead.company_name,'companyName'),owner_user_id:context.userId},request)).id;
   let contactId=input.contactId?uuid(input.contactId):null;
   if(contactId)await record(client,context,'contacts',contactId);
   else contactId=(await insert(client,context,'contacts',{lead_id:id,company_id:companyId,first_name:lead.first_name,last_name:lead.last_name,email:lead.email,email_normalized:lead.email_normalized,phone:lead.phone,phone_normalized:lead.phone_normalized,owner_user_id:context.userId},request)).id;
   const dealData=crmInput('deals',{title:input.title??`${[lead.first_name,lead.last_name].filter(Boolean).join(' ')} opportunity`,pipelineId:input.pipelineId,stageId:input.stageId,value:input.value,expectedCloseDate:input.expectedCloseDate});
   const deal=await insert(client,context,'deals',{...dealData,lead_id:id,primary_contact_id:contactId,company_id:companyId,owner_user_id:context.userId},request);
   const converted=(await client.query('INSERT INTO lead_conversions(workspace_id,lead_id,contact_id,company_id,opportunity_id,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[workspaceId,id,contactId,companyId,deal.id,context.userId])).rows[0];
   await client.query("INSERT INTO activities(workspace_id,lead_id,user_id,type,title,body,metadata) VALUES($1,$2,$3,'system','Lead converted','Contact and deal linked; original lead history retained.',$4::jsonb)",[workspaceId,id,context.userId,JSON.stringify(converted)]);
   await history(client,context,'lead',id,'converted',request,converted);return {...converted,replayed:false};
  });reply(result.replayed?200:201,result);return true;
 }
 if(suffix==='search'&&method==='GET') {
  requirePermission(context,'crm:read');const q=requiredString(url.searchParams.get('q')??'','q',{max:120});
  const queries=Object.entries(CRM_ENTITIES).map(([entity,cfg])=>`SELECT r.id,'${cfg.type}' AS entity_type,${cfg.label} AS label,COALESCE(to_jsonb(r)->>'status',to_jsonb(r)->>'email','') AS detail FROM ${cfg.table} r WHERE r.workspace_id=$1 AND $2::uuid IS NOT NULL AND r.deleted_at IS NULL${scope(context,entity)} AND position(lower($3) in lower(${cfg.label}||' '||COALESCE(to_jsonb(r)->>'email','')))>0`);
  queries.push(`SELECT r.id,'lead',concat_ws(' ',r.first_name,r.last_name),r.status FROM leads r WHERE r.workspace_id=$1 AND $2::uuid IS NOT NULL AND r.deleted_at IS NULL${scope(context,'leads')} AND position(lower($3) in lower(concat_ws(' ',r.first_name,r.last_name,r.email,r.phone)))>0`);
  reply(200,{data:(await db.query(`SELECT * FROM (${queries.join(' UNION ALL ')}) records ORDER BY label LIMIT 100`,[workspaceId,context.userId,q])).rows});return true;
 }
 if(suffix==='notifications'&&method==='GET') {
  requirePermission(context,'crm:read');reply(200,{data:(await db.query('SELECT * FROM notifications WHERE workspace_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 100',[workspaceId,context.userId])).rows});return true;
 }
 const notification=suffix.match(/^notifications\/([^/]+)\/read$/);
 if(notification&&method==='POST') {
  requirePermission(context,'crm:read');const row=(await db.query('UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE workspace_id=$1 AND user_id=$2 AND id=$3 RETURNING *',[workspaceId,context.userId,uuid(notification[1])])).rows[0];
  if(!row)fail(404,'NOTIFICATION_NOT_FOUND','Notification was not found.');reply(200,row);return true;
 }
 if(suffix==='reports/crm'&&method==='GET') {
  requirePermission(context,'reports:read');
  const from=isoDate(url.searchParams.get('from')??new Date(Date.now()-30*86400000).toISOString(),'from');
  const to=isoDate(url.searchParams.get('to')??new Date().toISOString(),'to');
  if(from>to)throw new ValidationError('Start date must be before end date.');
  const [deals,tickets,tasks,activities,conversions]=await Promise.all([
   db.query("SELECT o.currency,o.status,p.name AS pipeline,s.name AS stage,count(*)::int AS count,COALESCE(sum(o.value),0)::text AS value FROM opportunities o LEFT JOIN pipelines p ON p.workspace_id=o.workspace_id AND p.id=o.pipeline_id LEFT JOIN pipeline_stages s ON s.pipeline_id=o.pipeline_id AND s.id=o.stage_id WHERE o.workspace_id=$1 AND o.deleted_at IS NULL AND o.created_at BETWEEN $2 AND $3 GROUP BY o.currency,o.status,p.name,s.name ORDER BY p.name,s.name",[workspaceId,from,to]),
   db.query('SELECT status,priority,count(*)::int AS count FROM tickets WHERE workspace_id=$1 AND deleted_at IS NULL AND created_at BETWEEN $2 AND $3 GROUP BY status,priority',[workspaceId,from,to]),
   db.query('SELECT status,count(*)::int AS count FROM tasks WHERE workspace_id=$1 AND created_at BETWEEN $2 AND $3 GROUP BY status',[workspaceId,from,to]),
   db.query('SELECT type,count(*)::int AS count FROM activities WHERE workspace_id=$1 AND occurred_at BETWEEN $2 AND $3 GROUP BY type',[workspaceId,from,to]),
   db.query('SELECT count(*)::int AS converted,(SELECT count(*)::int FROM leads WHERE workspace_id=$1 AND deleted_at IS NULL AND created_at BETWEEN $2 AND $3) AS leads FROM lead_conversions WHERE workspace_id=$1 AND created_at BETWEEN $2 AND $3',[workspaceId,from,to])
  ]);reply(200,{from,to,deals:deals.rows,tickets:tickets.rows,tasks:tasks.rows,activities:activities.rows,conversions:conversions.rows[0]});return true;
 }
 if(suffix==='inbox'&&method==='GET') {
  requirePermission(context,'crm:read');
  const rows=await db.query(`SELECT m.lead_id,m.channel,concat_ws(' ',l.first_name,l.last_name) AS lead_name,count(*)::int AS messages,max(m.created_at) AS last_at,count(*) FILTER(WHERE m.direction='inbound' AND rs.message_id IS NULL)::int AS unread FROM messages m JOIN leads l ON l.workspace_id=m.workspace_id AND l.id=m.lead_id LEFT JOIN message_read_states rs ON rs.workspace_id=m.workspace_id AND rs.message_id=m.id AND rs.user_id=$2 WHERE m.workspace_id=$1 AND l.deleted_at IS NULL${scope(context,'leads','l')} GROUP BY m.lead_id,m.channel,l.first_name,l.last_name ORDER BY last_at DESC LIMIT 100`,[workspaceId,context.userId]);
  reply(200,{data:rows.rows});return true;
 }
 const thread=suffix.match(/^inbox\/([^/]+)\/([^/]+)(?:\/(read))?$/);
 if(thread) {
  requirePermission(context,'crm:read'); const leadId=uuid(thread[1]);const channel=enumValue(thread[2],'channel',['email','sms','whatsapp','rcs','voice']);await record(db,context,'leads',leadId);
  if(method==='GET'&&!thread[3]) {
   const rows=await db.query('SELECT m.*,rs.read_at AS internally_read_at FROM messages m LEFT JOIN message_read_states rs ON rs.workspace_id=m.workspace_id AND rs.message_id=m.id AND rs.user_id=$2 WHERE m.workspace_id=$1 AND m.lead_id=$3 AND m.channel=$4 ORDER BY m.created_at DESC,m.id LIMIT 100',[workspaceId,context.userId,leadId,channel]);reply(200,{data:rows.rows});return true;
  }
  if(method==='POST'&&thread[3]==='read') {
   // Internal per-user read state, never represented as a provider read receipt.
   await db.query("INSERT INTO message_read_states(workspace_id,message_id,user_id) SELECT workspace_id,id,$2 FROM messages WHERE workspace_id=$1 AND lead_id=$3 AND channel=$4 AND direction='inbound' ON CONFLICT DO NOTHING",[workspaceId,context.userId,leadId,channel]);reply(200,{read:true});return true;
  }
  fail(405,'METHOD_NOT_ALLOWED','Unsupported inbox operation.');
 }
 return false;
}
