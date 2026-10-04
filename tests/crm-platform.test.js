import test from 'node:test';
import assert from 'node:assert/strict';
import { crmInput,CRM_ENTITIES } from '../backend/src/crm-platform.js';
test('CRM input has a fixed field allowlist, normalized identity and decimal validation',()=>{
 assert.deepEqual(crmInput('contacts',{firstName:' Test ',email:'TEST@EXAMPLE.COM',workspaceId:'attack',deletedAt:'attack'}),{first_name:'Test',email:'test@example.com',email_normalized:'test@example.com'});
 assert.deepEqual(crmInput('deals',{title:'Deal',value:'123.40',currency:'INR'}),{title:'Deal',value:'123.4',currency:'INR'});
 assert.throws(()=>crmInput('deals',{value:'1.001'}));assert.throws(()=>crmInput('deals',{currency:'invalid'}));
 assert.throws(()=>crmInput('tickets',{status:'invalid'}));assert.throws(()=>crmInput('contacts',{email:'bad'}));
 assert.equal(CRM_ENTITIES.deals.table,'opportunities');
});
