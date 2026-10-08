import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

test('browser acceptance: operational CRM screens, conversion, editing, read-only controls and mobile navigation', {skip:!process.env.CRM_BROWSER_MODULE || !process.env.TEST_DATABASE_URL,timeout:120000}, async()=>{
 process.env.APP_ENV='test';process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
 const [{chromium},{Pool},{createRedBlackServer},{createSession}]=await Promise.all([import(pathToFileURL(process.env.CRM_BROWSER_MODULE).href),import('pg'),import('../backend/src/server.js'),import('../backend/src/auth.js')]);
 const db=new Pool({connectionString:process.env.TEST_DATABASE_URL});const key=randomUUID();
 const workspaceId=(await db.query("INSERT INTO workspaces(name,slug,currency) VALUES('Browser CRM',$1,'USD') RETURNING id",[`browser-${key}`])).rows[0].id;
 const users={};for(const role of ['owner','admin','manager','agent','reporting','service']) {
  users[role]=(await db.query('INSERT INTO users(email,display_name) VALUES($1,$2) RETURNING id',[`${role}-browser-${key}@example.com`,role])).rows[0].id;
  await db.query('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspaceId,users[role],role]);
 }
 const lead=(await db.query("INSERT INTO leads(workspace_id,first_name,last_name,email) VALUES($1,'Browser','Customer','browser@example.com') RETURNING id",[workspaceId])).rows[0].id;
 await db.query('INSERT INTO lead_assignments(workspace_id,lead_id,user_id) VALUES($1,$2,$3)',[workspaceId,lead,users.agent]);
 await db.query("INSERT INTO leads(workspace_id,first_name,last_name) VALUES($1,'Unassigned','Lead')",[workspaceId]);
 const company=(await db.query("INSERT INTO companies(workspace_id,name,owner_user_id) VALUES($1,'Browser Company',$2) RETURNING id",[workspaceId,users.owner])).rows[0].id;
 const contact=(await db.query("INSERT INTO contacts(workspace_id,company_id,lead_id,owner_user_id,first_name,last_name) VALUES($1,$2,$3,$4,'Browser','Contact') RETURNING id",[workspaceId,company,lead,users.owner])).rows[0].id;
 const pipeline=(await db.query("INSERT INTO pipelines(workspace_id,name,slug) VALUES($1,'Browser Pipeline',$2) RETURNING id",[workspaceId,`browser-pipeline-${key}`])).rows[0].id;
 const stage=(await db.query("INSERT INTO pipeline_stages(pipeline_id,name,slug,position) VALUES($1,'New','new',0) RETURNING id",[pipeline])).rows[0].id;
 const deal=(await db.query("INSERT INTO opportunities(workspace_id,lead_id,title,company_id,primary_contact_id,owner_user_id,pipeline_id,stage_id,currency,value) VALUES($1,$2,'Browser Deal',$3,$4,$5,$6,$7,'USD',100.25) RETURNING id",[workspaceId,lead,company,contact,users.owner,pipeline,stage])).rows[0].id;
 const ticket=(await db.query("INSERT INTO tickets(workspace_id,subject,company_id,contact_id,lead_id,assignee_user_id,created_by) VALUES($1,'Browser Ticket',$2,$3,$4,$5,$5) RETURNING id",[workspaceId,company,contact,lead,users.owner])).rows[0].id;
 const server=createRedBlackServer({db});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;const browser=await chromium.launch({headless:true});const errors=[];
 async function sessionPage(role,mobile=false) {
  const session=await createSession(db,{workspaceId,userId:users[role]});const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1000}});
  await context.addCookies([{name:'rb_session',value:session.token,url:origin,httpOnly:true},{name:'rb_csrf',value:session.csrf,url:origin}]);
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(`${origin}/app/`);await page.locator('#appView').waitFor({state:'visible'});return {page,context};
 }
 async function navigate(page,view) {await page.locator(`#mainNav [data-view="${view}"]`).click();await page.locator('#viewRoot h1').waitFor();await page.waitForLoadState('networkidle');const content=await page.locator('#viewRoot').innerText();assert.ok(!content.includes('We could not load'),`${view} failed: ${content}`);}
 async function assertLeadDirectory(role,page) {
  await navigate(page,'leads');
  const leadRow=page.locator('tr').filter({hasText:'Browser Customer'});
  assert.equal(await leadRow.count(),1);
  if(role==='agent') assert.equal(await page.getByText('Unassigned Lead',{exact:false}).count(),0);
  if(['reporting','service'].includes(role)) {
   for(const selector of ['#savedViewForm','[data-action="select-all-leads"]','[data-action="select-lead"]','[data-action="bulk-trash"]','#bulkStatus','#bulkStage','#bulkTag','#bulkOwner']) assert.equal(await page.locator(selector).count(),0,`${role} should not see ${selector}`);
   assert.equal(await page.getByRole('button',{name:/New lead/}).count(),0);
   assert.equal(await page.getByRole('button',{name:'Import CSV',exact:true}).count(),0);
   assert.equal(await page.getByRole('link',{name:'Export CSV',exact:true}).count(),1);
   assert.equal(await page.locator('#leadSearch').count(),1);
   assert.equal(await page.locator('#leadStatus').count(),1);
   await leadRow.getByRole('button',{name:'Open',exact:true}).click();
   await page.getByRole('heading',{name:'Browser Customer',exact:true}).waitFor();
   assert.equal(await page.getByRole('button',{name:'Edit',exact:true}).count(),0);
   assert.equal(await page.getByRole('button',{name:'Save changes',exact:true}).count(),0);
  }
 }
 try {
  for(const role of ['admin','manager','agent','reporting','service']) {
   const {page:p,context:c}=await sessionPage(role,role==='agent');
   await assertLeadDirectory(role,p);
   await c.close();
  }
  const {page,context}=await sessionPage('owner');
  await assertLeadDirectory('owner',page);
  await navigate(page,'companies');assert.ok((await page.getByRole('button',{name:'Browser Company',exact:true}).count())>0);await page.getByRole('button',{name:'Browser Company',exact:true}).click();await page.getByText('Activity / history',{exact:true}).waitFor();
  await navigate(page,'contacts');assert.ok((await page.getByRole('button',{name:'Browser Contact',exact:true}).count())>0);
  await navigate(page,'deals');assert.ok((await page.getByRole('button',{name:'Browser Deal',exact:true}).count())>0);await page.getByRole('button',{name:'Browser Deal',exact:true}).click();await page.getByText('Activity / history',{exact:true}).waitFor();
  await navigate(page,'tickets');assert.ok((await page.getByRole('button',{name:/Browser Ticket/}).count())>0);await page.getByRole('button',{name:/Browser Ticket/}).click();await page.getByText('Activity / history',{exact:true}).waitFor();
  await navigate(page,'search');await page.getByLabel('Search',{exact:true}).fill('Browser Customer');await page.locator('[data-crm-form="search"] button').click();await page.getByRole('button',{name:'Browser Customer',exact:true}).click();await page.getByRole('heading',{name:'Convert lead to contact / company / deal'}).waitFor();
  await page.getByLabel('Deal title',{exact:true}).fill('Converted Browser Deal');await page.getByRole('button',{name:'Convert lead',exact:true}).click();await page.getByRole('heading',{name:'Converted Browser Deal',exact:true}).waitFor();
  assert.equal((await db.query('SELECT count(*)::int n FROM lead_conversions WHERE workspace_id=$1 AND lead_id=$2',[workspaceId,lead])).rows[0].n,1);
  await navigate(page,'notifications');assert.ok(await page.getByRole('button',{name:'Mark read',exact:true}).count()>0);await page.getByRole('button',{name:'Mark read',exact:true}).first().click();await page.waitForLoadState('networkidle');
  await navigate(page,'reports');await page.getByRole('heading',{name:'Operational CRM reports',exact:true}).waitFor();
  await navigate(page,'communications');await page.getByRole('heading',{name:'Unified Inbox',exact:true}).waitFor();await context.close();
  for(const role of ['admin','manager','agent','reporting','service']) {
   const {page:p,context:c}=await sessionPage(role,role==='agent');
   for(const view of ['contacts','companies','deals','tickets','search','notifications','communications']) {
    await navigate(p,view);
    if(['reporting','service'].includes(role)) {assert.equal(await p.getByRole('button',{name:'Create',exact:true}).count(),0);assert.equal(await p.getByRole('button',{name:'Save draft',exact:true}).count(),0);}
   }
   await c.close();
  }
  assert.deepEqual(errors,[]);
 } finally {await browser.close();await new Promise(resolve=>server.close(resolve));await db.end();}
});

