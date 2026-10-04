import { randomUUID } from 'node:crypto';
import {
  AGENT_RUN_STATUS, TERMINAL_AGENT_STATUSES, assertRunScope, fail,
  normalizeAgentDefinition, normalizePlannerDecision, normalizeToolRequest, normalizeToolResult
} from './contracts.js';

const event = (type, data = {}) => ({ id:randomUUID(), type, at:new Date().toISOString(), ...data });
const errorShape = (error, fallback = 'AGENT_EXECUTION_FAILED') => ({ code:error?.code ?? fallback, message:String(error?.message ?? error).slice(0,2000) });

export class AgentRunner {
  constructor({ store, planner, toolExecutor, authorizeTool, knowledgeRetriever = null, memoryStore = null, now = () => Date.now() } = {}) {
    if (!store?.create || !store?.get || !store?.save) fail('AGENT_STORE_REQUIRED','Agent run store is required.',500);
    if (!planner?.next) fail('AGENT_PLANNER_REQUIRED','A provider-neutral planner is required.',500);
    if (!toolExecutor?.execute) fail('AGENT_TOOL_EXECUTOR_REQUIRED','A ToolExecutor is required.',500);
    if (typeof authorizeTool !== 'function') fail('AGENT_AUTHORIZER_REQUIRED','A server-side tool authorizer is required.',500);
    this.store=store; this.planner=planner; this.toolExecutor=toolExecutor; this.authorizeTool=authorizeTool;
    this.knowledgeRetriever=knowledgeRetriever; this.memoryStore=memoryStore; this.now=now;
  }

  async start({ definition, workspaceId, actor, goal, correlationId = randomUUID(), idempotencyKey = randomUUID() }) {
    if (!workspaceId || typeof workspaceId !== 'string') fail('AGENT_INPUT_INVALID','workspaceId is required.');
    if (!actor || typeof actor !== 'object' || (!actor.userId && !actor.serviceId)) fail('AGENT_UNAUTHORIZED','An initiating actor or service is required.',401);
    if (actor.workspaceId && actor.workspaceId !== workspaceId) fail('AGENT_WORKSPACE_MISMATCH','Initiating actor is outside the workspace.',403);
    if (typeof goal !== 'string' || !goal.trim() || goal.length > 8000) fail('AGENT_INPUT_INVALID','goal must be a non-empty string up to 8000 characters.');
    const normalizedDefinition=normalizeAgentDefinition(definition);
    const createdAt=this.now();
    const run=await this.store.create({
      definition:normalizedDefinition, workspaceId, initiatingActor:structuredClone(actor), goal:goal.trim(), correlationId,
      idempotencyKey, deadlineAt:new Date(createdAt + normalizedDefinition.deadlineMs).toISOString()
    });
    if (run.status !== AGENT_RUN_STATUS.PENDING) return run;
    return this.resume(run.id,{ workspaceId, actor });
  }

  async get(runId,{ workspaceId, actor }={}) { const run=await this.#mustGet(runId); assertRunScope(run,{workspaceId,actor}); return run; }

  async cancel(runId,{ workspaceId, actor, reason='Cancelled by authorized caller.' }={}) {
    const run=await this.#mustGet(runId); assertRunScope(run,{workspaceId,actor});
    if (TERMINAL_AGENT_STATUSES.has(run.status)) return run;
    run.status=AGENT_RUN_STATUS.CANCELLED; run.finishedAt=new Date(this.now()).toISOString(); run.pauseReason=null; run.pendingTool=null;
    run.journal.push(event('cancelled',{ rationale:String(reason).slice(0,1000) })); return this.store.save(run);
  }

  async pause(runId,{ workspaceId, actor, reason='Paused by authorized caller.' }={}) {
    const run=await this.#mustGet(runId); assertRunScope(run,{workspaceId,actor});
    if (TERMINAL_AGENT_STATUSES.has(run.status)) return run;
    run.status=AGENT_RUN_STATUS.PAUSED; run.pauseReason=String(reason).slice(0,1000); run.journal.push(event('paused',{ rationale:run.pauseReason }));
    return this.store.save(run);
  }

  async approve(runId,{ workspaceId, actor, approved, reason='' }={}) {
    const run=await this.#mustGet(runId); assertRunScope(run,{workspaceId,actor});
    if (run.status !== AGENT_RUN_STATUS.APPROVAL_REQUIRED || !run.pendingTool) fail('AGENT_APPROVAL_NOT_PENDING','Agent run is not awaiting approval.',409);
    run.approval={ approved:approved === true, actor:structuredClone(actor ?? {}), reason:String(reason).slice(0,1000), decidedAt:new Date(this.now()).toISOString() };
    run.journal.push(event(approved === true ? 'approval_granted' : 'approval_denied',{ requestId:run.pendingTool.id, rationale:run.approval.reason }));
    if (approved !== true) {
      run.status=AGENT_RUN_STATUS.FAILED; run.error={ code:'AGENT_APPROVAL_DENIED', message:'Required tool action was denied.' }; run.finishedAt=new Date(this.now()).toISOString(); run.pendingTool=null;
      return this.store.save(run);
    }
    run.status=AGENT_RUN_STATUS.PAUSED;
    await this.store.save(run);
    return this.resume(run.id,{ workspaceId, actor });
  }

  async resume(runId,{ workspaceId, actor }={}) {
    let run=await this.#mustGet(runId); assertRunScope(run,{workspaceId,actor});
    if (TERMINAL_AGENT_STATUSES.has(run.status) || run.status === AGENT_RUN_STATUS.ESCALATED) return run;
    if (run.status === AGENT_RUN_STATUS.APPROVAL_REQUIRED) return run;
    if (this.#expired(run)) return this.#terminate(run,AGENT_RUN_STATUS.TIMED_OUT,'AGENT_DEADLINE_EXCEEDED','Agent execution deadline exceeded.');
    if (!run.startedAt) run.startedAt=new Date(this.now()).toISOString();
    run.status=AGENT_RUN_STATUS.RUNNING; run.pauseReason=null; run.journal.push(event('resumed'));
    run=await this.store.save(run);

    try {
      if (run.pendingTool && run.approval?.approved) {
        run=await this.#executeTool(run,run.pendingTool,{ approved:true, approval:run.approval });
        if (run.status !== AGENT_RUN_STATUS.RUNNING) return run;
      }
      while (run.status === AGENT_RUN_STATUS.RUNNING) {
        if (this.#expired(run)) return this.#terminate(run,AGENT_RUN_STATUS.TIMED_OUT,'AGENT_DEADLINE_EXCEEDED','Agent execution deadline exceeded.');
        if (run.stepCount >= run.definition.maxSteps) return this.#terminate(run,AGENT_RUN_STATUS.MAX_STEPS,'AGENT_MAX_STEPS','Agent reached its maximum step count.');
        const context=await this.#optionalContext(run);
        let decision;
        try { decision=normalizePlannerDecision(await this.#withDeadline(run,()=>this.planner.next(this.#plannerView(run,context)))); }
        catch(error) { return this.#terminate(run, this.#expired(run) || error?.code === 'AGENT_DEADLINE_EXCEEDED' ? AGENT_RUN_STATUS.TIMED_OUT : AGENT_RUN_STATUS.FAILED, error?.code ?? 'AGENT_PLANNER_FAILED', error?.message ?? 'Planner failed.'); }
        run.stepCount += 1;
        run.journal.push(event('planner_decision',{ step:run.stepCount, decision:decision.type, rationale:decision.rationale }));
        run=await this.store.save(run);
        if (decision.type === 'finish') { run.result=structuredClone(decision.result); return this.#terminate(run,AGENT_RUN_STATUS.COMPLETED,null,null); }
        if (decision.type === 'pause') { run.status=AGENT_RUN_STATUS.PAUSED; run.pauseReason=decision.reason || decision.rationale || 'Planner requested pause.'; run.journal.push(event('paused',{rationale:run.pauseReason})); return this.store.save(run); }
        if (decision.type === 'escalate') { run.status=AGENT_RUN_STATUS.ESCALATED; run.pauseReason=decision.reason || decision.rationale || 'Human escalation required.'; run.journal.push(event('escalated',{rationale:run.pauseReason})); return this.store.save(run); }
        const request=normalizeToolRequest(decision.request,run);
        if (!run.definition.allowedTools.includes(request.tool)) return this.#terminate(run,AGENT_RUN_STATUS.FAILED,'AGENT_UNKNOWN_TOOL',`Planner requested unregistered tool: ${request.tool}.`);
        if (run.journal.some(entry => entry.type === 'tool_result' && entry.fingerprint === request.fingerprint && entry.ok)) return this.#terminate(run,AGENT_RUN_STATUS.FAILED,'AGENT_REPEATED_TOOL_CALL','Planner repeated an already completed tool call.');
        let authorization;
        try { authorization=await this.authorizeTool({ run:this.#authorizationView(run), request:structuredClone(request), actor:structuredClone(run.initiatingActor), approval:null }); }
        catch(error) { return this.#terminate(run,AGENT_RUN_STATUS.FAILED,'AGENT_AUTHORIZATION_FAILED',error?.message ?? 'Tool authorization failed.'); }
        if (!authorization?.allowed && !authorization?.approvalRequired) return this.#terminate(run,AGENT_RUN_STATUS.FAILED,'AGENT_TOOL_UNAUTHORIZED','Server authorization denied the requested tool.');
        const policyApproval=run.definition.requireApprovalFor.includes(request.tool) || ['external','destructive','administrative'].includes(request.impact);
        if (authorization?.approvalRequired || policyApproval) {
          run.status=AGENT_RUN_STATUS.APPROVAL_REQUIRED; run.pendingTool=request; run.approval=null;
          run.journal.push(event('approval_required',{ requestId:request.id, tool:request.tool, impact:request.impact, rationale:request.rationale }));
          return this.store.save(run);
        }
        run=await this.#executeTool(run,request,{ approved:false, authorization });
        if (run.status !== AGENT_RUN_STATUS.RUNNING) return run;
      }
      return run;
    } catch(error) {
      return this.#terminate(run,AGENT_RUN_STATUS.FAILED,error?.code ?? 'AGENT_EXECUTION_FAILED',error?.message ?? 'Agent execution failed.');
    }
  }

  async #executeTool(run,request,{ approved=false, approval=null, authorization:initialAuthorization=null }={}) {
    run.pendingTool=request;
    run.journal.push(event('tool_requested',{ requestId:request.id, tool:request.tool, fingerprint:request.fingerprint, impact:request.impact, rationale:request.rationale }));
    run=await this.store.save(run);
    let authorization=initialAuthorization;
    if (approved) {
      authorization=await this.authorizeTool({ run:this.#authorizationView(run), request:structuredClone(request), actor:structuredClone(run.initiatingActor), approval:structuredClone(approval) });
      if (!authorization?.allowed || authorization?.approvalRequired) return this.#terminate(run,AGENT_RUN_STATUS.FAILED,'AGENT_TOOL_UNAUTHORIZED','Tool was not authorized after approval.');
    }
    let lastError;
    for (let attempt=0; attempt <= run.definition.maxRetries; attempt += 1) {
      if (this.#expired(run)) return this.#terminate(run,AGENT_RUN_STATUS.TIMED_OUT,'AGENT_DEADLINE_EXCEEDED','Agent execution deadline exceeded.');
      try {
        const raw=await this.#withDeadline(run,()=>this.toolExecutor.execute({ request:structuredClone(request), authorization:structuredClone(authorization), actor:structuredClone(run.initiatingActor) }));
        const result=normalizeToolResult(raw,request);
        if (!result.ok) throw Object.assign(new Error(result.error || 'Tool failed.'),{ code:'AGENT_TOOL_FAILED' });
        run.journal.push(event('tool_result',{ requestId:request.id, tool:request.tool, fingerprint:request.fingerprint, ok:true, observation:result.output, metadata:result.metadata }));
        run.pendingTool=null; run.approval=null; return this.store.save(run);
      } catch(error) {
        lastError=error;
        run.journal.push(event('tool_attempt_failed',{ requestId:request.id, tool:request.tool, attempt:attempt+1, error:errorShape(error,'AGENT_TOOL_FAILED') }));
        run=await this.store.save(run);
        if (error?.code === 'AGENT_DEADLINE_EXCEEDED') return this.#terminate(run,AGENT_RUN_STATUS.TIMED_OUT,error.code,error.message);
      }
    }
    return this.#terminate(run,AGENT_RUN_STATUS.FAILED,lastError?.code ?? 'AGENT_TOOL_FAILED',lastError?.message ?? 'Tool execution failed.');
  }

  async #optionalContext(run) {
    const context={ knowledge:null, memory:null };
    if (this.knowledgeRetriever?.retrieve) context.knowledge=await this.knowledgeRetriever.retrieve({ workspaceId:run.workspaceId, actor:structuredClone(run.initiatingActor), goal:run.goal, runId:run.id });
    if (this.memoryStore?.getContext) context.memory=await this.memoryStore.getContext({ workspaceId:run.workspaceId, actor:structuredClone(run.initiatingActor), goal:run.goal, runId:run.id });
    return context;
  }
  #plannerView(run,context) { return { runId:run.id, workspaceId:run.workspaceId, goal:run.goal, status:run.status, stepCount:run.stepCount, maxSteps:run.definition.maxSteps, allowedTools:[...run.definition.allowedTools], observations:run.journal.filter(x=>x.type==='tool_result').map(x=>({tool:x.tool,observation:x.observation})), context }; }
  #authorizationView(run) { return { id:run.id, workspaceId:run.workspaceId, initiatingActor:structuredClone(run.initiatingActor), goal:run.goal, correlationId:run.correlationId, status:run.status }; }
  #expired(run) { return this.now() >= Date.parse(run.deadlineAt); }
  async #withDeadline(run,fn) {
    const remaining=Date.parse(run.deadlineAt)-this.now();
    if (remaining <= 0) fail('AGENT_DEADLINE_EXCEEDED','Agent execution deadline exceeded.',408);
    let timer;
    try { return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{ timer=setTimeout(()=>reject(Object.assign(new Error('Agent execution deadline exceeded.'),{code:'AGENT_DEADLINE_EXCEEDED'})),remaining); })]); }
    finally { clearTimeout(timer); }
  }
  async #terminate(run,status,code,message) { run.status=status; run.finishedAt=new Date(this.now()).toISOString(); run.pauseReason=null; run.pendingTool=null; if (code) run.error={code,message}; run.journal.push(event('terminated',{status,error:run.error})); return this.store.save(run); }
  async #mustGet(id) { const run=await this.store.get(id); if (!run) fail('AGENT_RUN_NOT_FOUND','Agent run not found.',404); return run; }
}
