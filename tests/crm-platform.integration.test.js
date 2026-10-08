import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

test('operational CRM API: atomic conversion, relationships, roles, history, search, reports and inbox', {skip:!process.env.TEST_DATABASE_URL}, async t=>{
 process.env.APP_ENV='test';process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
 const [{Pool},{applyMigrations},{createRedBlackServer},{createSession}]=await Promise.all([import('pg'),import('../backend/src/migrate.js'),import('../backend/src/server.js'),import('../backend/src/auth.js')]);
 const db=new Pool({connectionString:process.env.TEST_DATABASE_URL});await applyMigrations(db);
 const key=randomUUID();
 const ws=async name=>(await db.query('INSERT INTO workspaces(name,slug) VALUES($1,$2) RETURNING id',[name,`${name}-${key}`])).rows[0].id;
 const a=await ws('operational-a'),b=await ws('operational-b');
 const users={};const sessions={};
 for(const role of ['owner','admin','manager','agent','reporting','service']) {
  const id=(await db.query('INSERT INTO users(email,display_name) VALUES($1,$2) RETURNING id',[`${role}-${key}@example.com`,role])).rows[0].id;
  users[role]=id;await db.query('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3)',[a,id,role]);sessions[role]=await createSession(db,{workspaceId:a,userId:id});
 }
 const server=createRedBlackServer({db});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const root=`http://127.0.0.1:${server.address().port}/api/v1/workspaces/${a}`;
 async function call(path,{role='owner',method='GET',data}={}) {
  const session=sessions[role];const response=await fetch(`${root}/${path}`,{method,headers:{'content-type':'application/json',cookie:`rb_session=${session.token}; rb_csrf=${session.csrf}`,'x-csrf-token':session.csrf},body:data===undefined?undefined:JSON.stringify(data)});
  return {status:response.status,body:await response.json()};
 }
 const lead=(await db.query("INSERT INTO leads(workspace_id,first_name,last_name,company_name,email,email_normalized) VALUES($1,'Operational','Customer','Operational Company','customer@example.com','customer@example.com') RETURNING id",[a])).rows[0].id;
 const foreignCompany=(await db.query("INSERT INTO companies(workspace_id,name) VALUES($1,'Foreign Company') RETURNING id",[b])).rows[0].id;
 const pipeline=(await db.query("INSERT INTO pipelines(workspace_id,name,slug) VALUES($1,'Operational','operational') RETURNING id",[a])).rows[0].id;
 const otherPipeline=(await db.query("INSERT INTO pipelines(workspace_id,name,slug) VALUES($1,'Other','other') RETURNING id",[a])).rows[0].id;
 const stage=(await db.query("INSERT INTO pipeline_stages(pipeline_id,name,slug,position) VALUES($1,'New','new',0) RETURNING id",[pipeline])).rows[0].id;
 const won=(await db.query("INSERT INTO pipeline_stages(pipeline_id,name,slug,position,is_won) VALUES($1,'Won','won',1,true) RETURNING id",[pipeline])).rows[0].id;
 let converted,ticket;
 try {
  await t.test('failed conversion rolls back company, contact, opportunity, history and audit',async()=>{
   const counts=async()=>(await db.query('SELECT (SELECT count(*) FROM companies WHERE workspace_id=$1)::int companies,(SELECT count(*) FROM contacts WHERE workspace_id=$1)::int contacts,(SELECT count(*) FROM opportunities WHERE workspace_id=$1)::int deals,(SELECT count(*) FROM audit_logs WHERE workspace_id=$1)::int audits,(SELECT count(*) FROM notifications WHERE workspace_id=$1)::int notifications',[a])).rows[0];
   const before=await counts();const result=await call(`leads/${lead}/convert`,{method:'POST',data:{title:'Rollback deal',pipelineId:otherPipeline,stageId:stage}});assert.equal(result.status,400);assert.deepEqual(await counts(),before);
   assert.equal((await call(`leads/${lead}/convert`)).body,null);
   assert.equal((await call(`leads/${lead}/convert`,{method:'POST',data:{title:'Foreign link',companyId:foreignCompany}})).status,404);
  });
  await t.test('concurrent conversion retries produce exactly one contact, company and deal and retain lead history',async()=>{
   const results=await Promise.all([1,2,3].map(()=>call(`leads/${lead}/convert`,{method:'POST',data:{title:'Operational deal',pipelineId:pipeline,stageId:stage,value:'125.50'}})));
   assert.deepEqual(results.map(r=>r.status).sort(),[200,200,201]);converted=results[0].body;
   for(const r of results)assert.equal(r.body.opportunity_id,converted.opportunity_id);
   const counts=(await db.query('SELECT (SELECT count(*)::int FROM contacts WHERE workspace_id=$1 AND lead_id=$2) contacts,(SELECT count(*)::int FROM opportunities WHERE workspace_id=$1 AND lead_id=$2) deals,(SELECT count(*)::int FROM activities WHERE workspace_id=$1 AND lead_id=$2 AND title=\'Lead converted\') history',[a,lead])).rows[0];assert.deepEqual(counts,{contacts:1,deals:1,history:1});
   assert.equal((await call(`leads/${lead}`)).status,200);
  });
  await t.test('deal stage and relationship validation, history, proposals, archive and restore',async()=>{
   assert.equal((await call(`deals/${converted.opportunity_id}`,{method:'PATCH',data:{pipelineId:otherPipeline,stageId:stage}})).status,400);
   assert.equal((await call(`deals/${converted.opportunity_id}`,{method:'PATCH',data:{companyId:foreignCompany}})).status,404);
   const moved=await call(`deals/${converted.opportunity_id}`,{method:'PATCH',data:{stageId:won}});assert.equal(moved.status,200);assert.equal(moved.body.status,'won');
   await db.query("INSERT INTO proposals(workspace_id,lead_id,opportunity_id,status) VALUES($1,$2,$3,'draft')",[a,lead,converted.opportunity_id]);
   assert.equal((await call(`deals/${converted.opportunity_id}`,{method:'DELETE'})).status,200);
   assert.equal((await call('deals')).body.data.length,0);assert.equal((await call('deals?trash=true')).body.data.length,1);
   assert.equal((await call(`deals/${converted.opportunity_id}/restore`,{method:'POST',data:{}})).status,200);
   assert.equal((await db.query('SELECT count(*)::int n FROM proposals WHERE workspace_id=$1 AND opportunity_id=$2',[a,converted.opportunity_id])).rows[0].n,1);
   assert.ok((await call(`deals/${converted.opportunity_id}`)).body.history.length>=4);
   await assert.rejects(db.query('UPDATE opportunities SET company_id=$3 WHERE workspace_id=$1 AND id=$2',[a,converted.opportunity_id,foreignCompany]),{code:'23503'});
  });
  await t.test('contacts and companies expose editable CRUD and safe archive/restore',async()=>{
   assert.equal((await call(`contacts/${converted.contact_id}`,{method:'PATCH',data:{email:'changed@example.com',title:'Buyer'}})).status,200);
   assert.equal((await db.query('SELECT email_normalized FROM contacts WHERE id=$1',[converted.contact_id])).rows[0].email_normalized,'changed@example.com');
   assert.equal((await call(`companies/${converted.company_id}`,{method:'PATCH',data:{name:'Operational Updated'}})).status,200);
   assert.equal((await call(`contacts/${converted.contact_id}`,{method:'DELETE'})).status,200);
   assert.equal((await call(`contacts/${converted.contact_id}/restore`,{method:'POST',data:{}})).status,200);
  });
  await t.test('ticket ownership, status, notes, timeline and reference integrity',async()=>{
   const result=await call('tickets',{method:'POST',data:{subject:'Operational ticket',contactId:converted.contact_id,companyId:converted.company_id,leadId:lead,assigneeUserId:users.agent}});assert.equal(result.status,201);ticket=result.body;
   assert.equal((await call(`tickets/${ticket.id}`,{role:'agent'})).status,200);
   assert.equal((await call(`tickets/${ticket.id}`,{role:'agent',method:'PATCH',data:{status:'resolved'}})).status,200);
   assert.equal((await call(`tickets/${ticket.id}/notes`,{role:'agent',method:'POST',data:{body:'Resolved by agent'}})).status,200);
   const detail=await call(`tickets/${ticket.id}`,{role:'agent'});assert.deepEqual(detail.body.history.map(h=>h.action).sort(),['created','note','updated']);
   assert.equal((await call('tickets?status=resolved')).body.data.length,1);
   assert.equal((await call('tickets',{method:'POST',data:{subject:'Bad',companyId:foreignCompany}})).status,404);
   assert.equal((await call(`tickets/${ticket.id}`,{method:'PATCH',data:{status:'invalid'}})).status,400);
   await assert.rejects(db.query('UPDATE tickets SET company_id=$3 WHERE workspace_id=$1 AND id=$2',[a,ticket.id,foreignCompany]),{code:'23503'});
  });
  await t.test('reporting/service mutations denied; all writes and guessed IDs share agent visibility',async()=>{
   for(const role of ['reporting','service'])for(const entity of ['companies','contacts','deals','tickets'])assert.equal((await call(entity,{role,method:'POST',data:{name:'Rejected',firstName:'Rejected',title:'Rejected',subject:'Rejected'}})).status,403);
   for(const [entity,id] of [['companies',converted.company_id],['contacts',converted.contact_id],['deals',converted.opportunity_id]]) {
    assert.equal((await call(`${entity}/${id}`,{role:'agent'})).status,404);
    assert.equal((await call(`${entity}/${id}`,{role:'agent',method:'DELETE'})).status,404);
    assert.equal((await call(`${entity}/${id}`,{role:'agent',method:'PATCH',data:{title:'Attack',name:'Attack',firstName:'Attack'}})).status,404);
   }
   assert.equal((await call(`companies/${foreignCompany}`)).status,404);
   assert.equal((await call('companies',{role:'agent',method:'POST',data:{name:'Assigned elsewhere',ownerUserId:users.owner}})).status,403);
   assert.equal((await call('search?q=Operational',{role:'agent'})).body.data.filter(r=>r.entity_type!=='ticket').length,0);
   const search=await call('search?q=Operational');assert.ok(search.body.data.some(r=>r.entity_type==='deal'));assert.ok(!search.body.data.some(r=>r.id===foreignCompany));
   for(const role of ['admin','manager'])assert.equal((await call('deals',{role})).status,200);
  });
  await t.test('notification generation/ownership, task worker writes and reporting security',async()=>{
   await db.query("INSERT INTO tasks(workspace_id,lead_id,assigned_to,title,status,source) VALUES($1,$2,$3,'Operational follow-up','pending','manual')",[a,lead,users.owner]);
   const notices=(await call('notifications')).body.data;assert.ok(notices.some(n=>n.entity_type==='task'));
   const agentNotices=(await call('notifications',{role:'agent'})).body.data;assert.ok(agentNotices.some(n=>n.entity_id===ticket.id));assert.ok(!agentNotices.some(n=>n.user_id!==users.agent));
   assert.equal((await call(`notifications/${notices[0].id}/read`,{role:'agent',method:'POST',data:{}})).status,404);
   assert.equal((await call(`notifications/${notices[0].id}/read`,{method:'POST',data:{}})).status,200);
   const report=await call('reports/crm',{role:'reporting'});assert.equal(report.status,200);assert.equal(report.body.conversions.converted,1);assert.equal(report.body.deals[0].value,'125.50');assert.ok(report.body.tickets.some(r=>r.status==='resolved'));
   for(const role of ['agent','service'])assert.equal((await call('reports/crm',{role})).status,403);
   assert.equal((await call('reports/crm?from=2030-01-01&to=2020-01-01')).status,400);
   assert.equal((await call('reports/crm?from=2020-01-01&to=2020-01-02')).body.deals.length,0);
  });
  await t.test('inbox history and internal read state cannot leak guessed lead/thread IDs',async()=>{
   await db.query("INSERT INTO messages(workspace_id,lead_id,channel,direction,status,body) VALUES($1,$2,'email','inbound','received','Operational message')",[a,lead]);
   const inbox=await call('inbox');assert.equal(inbox.body.data[0].unread,1);
   assert.equal((await call(`inbox/${lead}/email`,{role:'agent'})).status,404);
   assert.equal((await call(`inbox/${lead}/email/read`,{role:'agent',method:'POST',data:{}})).status,404);
   assert.equal((await call(`inbox/${lead}/email/read`,{method:'POST',data:{}})).status,200);
   assert.equal((await call('inbox')).body.data[0].unread,0);
   await db.query('INSERT INTO lead_assignments(workspace_id,lead_id,user_id) VALUES($1,$2,$3)',[a,lead,users.agent]);
   assert.equal((await call(`inbox/${lead}/email`,{role:'agent'})).body.data.length,1);
   assert.equal((await call('inbox',{role:'agent'})).body.data[0].unread,1);
   await db.query('UPDATE lead_assignments SET unassigned_at=now() WHERE workspace_id=$1 AND lead_id=$2',[a,lead]);
   assert.equal((await call(`inbox/${lead}/email`,{role:'agent'})).status,404);
  });
 } finally {await new Promise(resolve=>server.close(resolve));await db.end();}
});
