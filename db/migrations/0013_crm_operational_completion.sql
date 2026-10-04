-- Forward-only upgrade of 0012. Retain opportunities/proposals and all lead history.
ALTER TABLE companies ADD CONSTRAINT companies_workspace_id_key UNIQUE(workspace_id,id);
ALTER TABLE contacts ADD CONSTRAINT contacts_workspace_id_key UNIQUE(workspace_id,id);
ALTER TABLE tickets ADD CONSTRAINT tickets_workspace_id_key UNIQUE(workspace_id,id);
ALTER TABLE companies ADD CONSTRAINT companies_owner_workspace_fk FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_members(workspace_id,user_id);
ALTER TABLE contacts ADD CONSTRAINT contacts_owner_workspace_fk FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_members(workspace_id,user_id);
ALTER TABLE contacts ADD CONSTRAINT contacts_company_workspace_fk FOREIGN KEY(workspace_id,company_id) REFERENCES companies(workspace_id,id);
ALTER TABLE contacts ADD CONSTRAINT contacts_lead_workspace_fk FOREIGN KEY(workspace_id,lead_id) REFERENCES leads(workspace_id,id);
ALTER TABLE opportunities ADD COLUMN stage_id uuid;
ALTER TABLE opportunities ADD CONSTRAINT opportunities_stage_pipeline_fk FOREIGN KEY(pipeline_id,stage_id) REFERENCES pipeline_stages(pipeline_id,id);
ALTER TABLE opportunities ADD CONSTRAINT opportunities_stage_requires_pipeline CHECK(stage_id IS NULL OR pipeline_id IS NOT NULL);
ALTER TABLE opportunities ADD CONSTRAINT opportunities_company_workspace_fk FOREIGN KEY(workspace_id,company_id) REFERENCES companies(workspace_id,id);
ALTER TABLE opportunities ADD CONSTRAINT opportunities_contact_workspace_fk FOREIGN KEY(workspace_id,primary_contact_id) REFERENCES contacts(workspace_id,id);
ALTER TABLE tickets ADD CONSTRAINT tickets_contact_workspace_fk FOREIGN KEY(workspace_id,contact_id) REFERENCES contacts(workspace_id,id);
ALTER TABLE tickets ADD CONSTRAINT tickets_company_workspace_fk FOREIGN KEY(workspace_id,company_id) REFERENCES companies(workspace_id,id);
ALTER TABLE tickets ADD CONSTRAINT tickets_lead_workspace_fk FOREIGN KEY(workspace_id,lead_id) REFERENCES leads(workspace_id,id);
ALTER TABLE tickets ADD CONSTRAINT tickets_assignee_workspace_fk FOREIGN KEY(workspace_id,assignee_user_id) REFERENCES workspace_members(workspace_id,user_id);

CREATE TABLE crm_record_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id),
 entity_type text NOT NULL, entity_id uuid NOT NULL, actor_user_id uuid,
 action text NOT NULL, body text, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,actor_user_id) REFERENCES workspace_members(workspace_id,user_id)
);
CREATE INDEX crm_record_history_entity_idx ON crm_record_history(workspace_id,entity_type,entity_id,created_at);
CREATE TRIGGER crm_record_history_append_only BEFORE UPDATE OR DELETE ON crm_record_history FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TABLE lead_conversions (
 workspace_id uuid NOT NULL, lead_id uuid NOT NULL, contact_id uuid NOT NULL, company_id uuid, opportunity_id uuid NOT NULL,
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,lead_id),
 FOREIGN KEY(workspace_id,lead_id) REFERENCES leads(workspace_id,id),
 FOREIGN KEY(workspace_id,contact_id) REFERENCES contacts(workspace_id,id),
 FOREIGN KEY(workspace_id,company_id) REFERENCES companies(workspace_id,id),
 FOREIGN KEY(workspace_id,opportunity_id) REFERENCES opportunities(workspace_id,id),
 FOREIGN KEY(workspace_id,created_by) REFERENCES workspace_members(workspace_id,user_id)
);
ALTER TABLE messages ADD CONSTRAINT messages_workspace_id_key UNIQUE(workspace_id,id);
CREATE TABLE message_read_states (
 workspace_id uuid NOT NULL, message_id uuid NOT NULL, user_id uuid NOT NULL, read_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,message_id,user_id),
 FOREIGN KEY(workspace_id,message_id) REFERENCES messages(workspace_id,id),
 FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_members(workspace_id,user_id)
);
ALTER TABLE notifications ADD COLUMN event_key text;
CREATE UNIQUE INDEX notifications_event_key ON notifications(workspace_id,user_id,event_key) WHERE event_key IS NOT NULL;
ALTER TABLE notifications ADD CONSTRAINT notifications_member_workspace_fk FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_members(workspace_id,user_id);

-- Database hooks cover API and automation worker writes in the same transaction.
CREATE FUNCTION crm_notify_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recipient uuid; label text; kind text; record_id uuid;
BEGIN
 IF TG_TABLE_NAME='tasks' THEN
   recipient:=NEW.assigned_to; label:='Task: '||NEW.title; kind:='task'; record_id:=NEW.id;
   IF TG_OP='UPDATE' AND NEW.assigned_to IS NOT DISTINCT FROM OLD.assigned_to AND NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.due_at IS NOT DISTINCT FROM OLD.due_at THEN RETURN NEW; END IF;
 ELSIF TG_TABLE_NAME='lead_assignments' THEN
   recipient:=NEW.user_id; label:='Lead assigned to you'; kind:='lead'; record_id:=NEW.lead_id;
   IF NEW.unassigned_at IS NOT NULL THEN RETURN NEW; END IF;
 ELSIF TG_TABLE_NAME='opportunities' THEN
   recipient:=NEW.owner_user_id; label:='Deal: '||COALESCE(NEW.title,'Opportunity'); kind:='deal'; record_id:=NEW.id;
   IF TG_OP='UPDATE' AND NEW.owner_user_id IS NOT DISTINCT FROM OLD.owner_user_id AND NEW.stage_id IS NOT DISTINCT FROM OLD.stage_id AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
 ELSIF TG_TABLE_NAME='tickets' THEN
   recipient:=NEW.assignee_user_id; label:='Ticket: '||NEW.subject; kind:='ticket'; record_id:=NEW.id;
   IF TG_OP='UPDATE' AND NEW.assignee_user_id IS NOT DISTINCT FROM OLD.assignee_user_id AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
 END IF;
 INSERT INTO notifications(workspace_id,user_id,type,title,entity_type,entity_id,event_key)
 SELECT NEW.workspace_id,recipient,'crm.'||kind,label,kind,record_id,TG_TABLE_NAME||':'||NEW.id||':'||txid_current()
 WHERE recipient IS NOT NULL AND EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=NEW.workspace_id AND user_id=recipient AND active)
 ON CONFLICT(workspace_id,user_id,event_key) WHERE event_key IS NOT NULL DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER tasks_notify AFTER INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION crm_notify_event();
CREATE TRIGGER assignments_notify AFTER INSERT ON lead_assignments FOR EACH ROW EXECUTE FUNCTION crm_notify_event();
CREATE TRIGGER opportunities_notify AFTER INSERT OR UPDATE ON opportunities FOR EACH ROW EXECUTE FUNCTION crm_notify_event();
CREATE TRIGGER tickets_notify AFTER INSERT OR UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION crm_notify_event();

