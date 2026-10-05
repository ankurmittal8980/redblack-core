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
 const server=createRedBlackServer({db});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;const browser=await chromium.launch({headless:true});const errors=[];
 async function sessionPage(role,mobile=false) {
  const session=await createSession(db,{workspaceId,userId:users[role]});const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1000}});
  await context.addCookies([{name:'rb_session',value:session.token,url:origin,httpOnly:true},{name:'rb_csrf',value:session.csrf,url:origin}]);
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(`${origin}/app/`);await page.locator('#appView').waitFor({state:'visible'});return {page,context};
 }
 async function navigate(page,view) {await page.locator(`#mainNav [data-view="${view}"]`).click();await page.locator('#viewRoot h1').waitFor();await page.waitForLoadState('networkidle');assert.ok(!await page.locator('#viewRoot').innerText().then(text=>text.includes('We could not load')));}
 try {
  const {page,context}=await sessionPage('owner');
  await navigate(page,'companies');await page.getByRole('button',{name:'Create',exact:true}).click();await page.getByLabel('Name',{exact:true}).fill('Browser Company');await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Browser Company',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Edit',exact:true}).click();await page.getByLabel('Domain',{exact:true}).fill('example.com');await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Browser Company',{exact:true}).waitFor();
  await navigate(page,'contacts');await page.getByRole('button',{name:'Create',exact:true}).click();await page.getByLabel('First Name',{exact:true}).fill('Browser Contact');await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Browser Contact',{exact:true}).waitFor();
  await navigate(page,'deals');await page.getByRole('button',{name:'Create',exact:true}).click();assert.equal(await page.getByLabel('Currency',{exact:true}).inputValue(),'USD');await page.getByLabel('Title',{exact:true}).fill('Browser Deal');await page.getByLabel('Value',{exact:true}).fill('100.25');await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Browser Deal',{exact:true}).waitFor();
  await navigate(page,'tickets');await page.getByRole('button',{name:'Create',exact:true}).click();await page.getByLabel('Subject',{exact:true}).fill('Browser Ticket');await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText(/Browser Ticket/).waitFor();await page.getByLabel('Add note').fill('Browser timeline note');await page.getByRole('button',{name:'Add note',exact:true}).click();await page.getByText('Browser timeline note',{exact:true}).waitFor();
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

