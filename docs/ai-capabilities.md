# RedBlack AI capability layer

The capability layer in `backend/src/ai-capabilities.js` defines provider-neutral business intelligence contracts above the AI Gateway. It validates actor/workspace context before execution, bounds CRM context, treats CRM text as untrusted data, and validates every structured result.

Capabilities currently covered are classification, structured extraction, summarisation, lead qualification, lead scoring, reply generation, conversation analysis, intent detection, sentiment/context signals, next-best action, and sales assistance.

Call `CapabilityLayer.executeCapability({ capability, workspaceId, actor, subject, input, context, options })`. Inject the AI Gateway through the `executor` function. The executor receives normalized messages, an output schema, capability metadata, idempotency metadata, and a processing strategy. It must return a provider-neutral result such as `{ output, provider, model, requestId, usage }`.

The layer never sends communications or mutates CRM records. Reply generation returns drafts, scoring returns an additional bounded signal, and next-best-action returns a recommendation. CRM authorization belongs in the injected `authorizeContext` resolver, which must enforce existing RedBlack visibility rules before the executor is called.

Knowledge/RAG, memory, autonomous agents, and tool execution remain separate capabilities owned by later tasks.
