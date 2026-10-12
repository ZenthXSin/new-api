import { CloudEnvironments } from './cloud-environments.mjs';
import { workspaceGitAction } from './git-actions.mjs';
import { GitHubPullRequests } from './pull-requests.mjs';
import { apiError } from './store.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function installWorkbenchExtensions(manager) {
  manager.policies = new Map();
  manager.cloudJobs = new Map();
  manager.cloud = new CloudEnvironments({dataDir: manager.config.dataDir, store: manager.store, files: manager.files, runtime: manager.runtime, config: manager.config, githubEnvironment: owner => manager.githubEnvironment(owner)});
  const local = manager.runtime.local || manager.runtime;
  local.setWorkspaceEnvironmentResolver?.(id => manager.cloud.workspaceEnvironment(manager.runtime.owner(id), id));
  local.userPolicies = manager.policies;
  manager.policy = owner => manager.policies.get(owner) || {enabled:true,allowDocker:true,allowSSH:true};
  manager.acceptPolicy = (owner, header) => {
    if (!header) return;
    let policy;
    try { policy = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')); } catch { throw apiError(403, 'invalid_user_policy', 'Invalid user policy'); }
    if (policy.userId !== owner || policy.enabled !== true || typeof policy.allowDocker !== 'boolean' || typeof policy.allowSSH !== 'boolean') throw apiError(403, 'codex_access_denied', 'Online Codex access is disabled');
    for (const [field, max] of Object.entries({cpuPercent:100,memoryMB:1048576,diskMB:10485760,maxProjects:1000,idleSeconds:86400})) {
      if (!Number.isFinite(policy[field]) || policy[field] < 0 || policy[field] > max) throw apiError(403, 'invalid_user_policy', 'Invalid user resource limits');
    }
    if (JSON.stringify(policy) !== JSON.stringify(manager.policies.get(owner))) local.invalidate?.(owner);
    manager.policies.set(owner, policy);
  };
  manager.requireExecution = (owner, remote, host = false) => {
    const policy = manager.policy(owner);
    if (host) {
      if (!policy.enabled || policy.allowHost !== true || !manager.runtime.host) throw apiError(403, 'host_admin_required', 'Host execution is available only to administrators');
      return;
    }
    if (!policy.enabled || (remote ? !policy.allowSSH : !policy.allowDocker)) throw apiError(403, 'execution_disabled', 'This execution location is disabled by your administrator');
  };
  manager.cloudDetail = (owner, id) => {
    const result = manager.cloud.get(owner, id);
    const job = manager.cloudJobs.get(`${owner}:${id}`);
    if (job) { result.operation = job; result.environment.operation = job; if (job.status === 'running') result.environment.status = job.type === 'setup' ? 'preparing' : 'publishing'; }
    return result;
  };
  manager.cloudCreate = async (owner, body) => {
    manager.requireExecution(owner, false);
    return manager.lock(`cloud-create:${owner}`, async () => {
      const created = await manager.create(owner, {name: body.name || 'Cloud environment setup'});
      try { return {...await manager.cloud.create(owner, body, created.workspace), workspace:created.workspace}; }
      catch (error) { await manager.delete(owner, created.workspace.id).catch(() => {}); throw error; }
    });
  };
  manager.cloudOperation = async (owner, id, type) => {
    manager.requireExecution(owner, false);
    manager.cloud.get(owner, id);
    if ([...manager.cloudJobs.entries()].some(([key, job]) => key.startsWith(`${owner}:`) && job.status === 'running')) throw apiError(409, 'environment_busy', 'Wait for environment preparation to finish');
    manager.requireOwnerIdle(owner);
    const operation = {type, status:'running', startedAt:Date.now()};
    manager.cloudJobs.set(`${owner}:${id}`, operation);
    const task = manager.lock(`owner:${owner}`, async () => {
      manager.requireOwnerIdle(owner);
      await manager.closeOwnerSessions(owner);
      if (type === 'setup') await manager.ensureEnvironment(owner, 'code');
      await manager.cloud[type](owner, id);
      operation.status = 'completed'; operation.finishedAt = Date.now();
    }).catch(error => {
      operation.status = 'failed'; operation.finishedAt = Date.now(); operation.error = {code:error.code || 'environment_failed',message:manager.sanitize(error.message)};
    });
    operation.promise = task;
    // The Promise is internal only; expose the serializable job fields.
    Object.defineProperty(operation, 'promise', {value:task, enumerable:false});
    return {...manager.cloudDetail(owner,id), workspace:manager.store.publicWorkspace(manager.store.get(owner, manager.cloud.get(owner,id).environment.setupWorkspaceId))};
  };
  manager.cloudTask = async (owner, id, body, authorization) => {
    manager.requireExecution(owner, false);
    if (!UUID.test(body.requestId || '')) throw apiError(400, 'invalid_request_id', 'A task request ID is required');
    const result = await manager.lock(`cloud-create:${owner}`, async () => {
      manager.cloud.get(owner,id);
      const prior = [...manager.store.states.values()].find(state => state.workspace.ownerId === owner && state.workspace.cloudRequestId === body.requestId);
      if (prior) {
        if (prior.workspace.cloudEnvironmentId !== id) throw apiError(409,'idempotency_conflict','This request ID belongs to another environment');
        return {workspace:manager.store.publicWorkspace(prior)};
      }
      const created = await manager.create(owner,{name:body.name || 'New task'});
      try {
        await manager.lock(`owner:${owner}`, async () => {
          // Restore only this new project; sibling sessions remain active.
          const snapshot = await manager.cloud.materialize(owner,id,created.workspace.id);
          const state = manager.store.get(owner,created.workspace.id);
          Object.assign(state.workspace,{cloudEnvironmentId:id,cloudEnvironmentVersion:snapshot.environment.version,cloudRequestId:body.requestId});
          await manager.store.persist(state);
        });
        return {workspace:manager.store.publicWorkspace(manager.store.get(owner,created.workspace.id))};
      } catch (error) { await manager.cloud.removeWorkspaceBinding(owner,created.workspace.id).catch(()=>{}); await manager.delete(owner,created.workspace.id).catch(()=>{}); throw error; }
    });
    if (body.prompt?.trim()) await manager.turn(owner,result.workspace.id,body,authorization);
    return result;
  };
  manager.gitAction = async (owner,id,operation,body) => manager.lock(`owner:${owner}`,async()=>{
    const state=manager.store.get(owner,id);
    manager.requireExecution(owner,Boolean(state.workspace.remote),Boolean(state.workspace.host));
    manager.requireOwnerIdle(owner);
    if(operation!=='status' && (state.workspace.archived || manager.ownerWorkspaces(owner).some(entry=>entry.queuedTurns?.length))) throw apiError(409,'workspace_busy','Restore the workspace and clear queued tasks before changing Git history');
    await manager.closeOwnerSessions(owner);
    if(!state.workspace.remote && !state.workspace.host) await manager.ensureEnvironment(owner,'code');
    const result=await workspaceGitAction(manager.runtime,id,operation,body,{env:manager.githubEnvironment(owner)});
    manager.touchOwner(owner);
    if(operation!=='status'){manager.store.record(state,'workbench/files/updated',{});await manager.store.persist(state);}
    return result;
  });
  manager.pullRequestTask = async (owner,target,body,authorization) => {
    manager.requireExecution(owner,false);
    if(!UUID.test(body.requestId||'') || !['ask','review'].includes(body.mode)) throw apiError(400,'invalid_request','Choose a review mode and request ID');
    const result=await manager.lock(`cloud-create:${owner}`,async()=>{
      const prior=[...manager.store.states.values()].find(state=>state.workspace.ownerId===owner && state.workspace.pullRequestRequestId===body.requestId);
      if(prior) {
        if(prior.workspace.pullRequestTarget!==target.join('/') || prior.workspace.pullRequestHead!==body.expectedHead)throw apiError(409,'idempotency_conflict','Request ID was used for another pull request');
        return {state:prior,prompt:prior.pullRequestPrompt};
      }
      const provider=new GitHubPullRequests({token:manager.githubEnvironment(owner).GH_TOKEN});
      const context=await provider.context(...target,{instruction:body.instruction});
      if(context.headSha!==body.expectedHead)throw apiError(409,'pull_request_changed','The pull request changed. Refresh before starting a review.');
      const created=await manager.create(owner,{name:`${context.repository} #${context.number}`,repositoryUrl:context.headRepositoryUrl||context.repositoryUrl,branch:context.headRef});
      try {
        const backend=manager.runtime.backend?.(created.workspace.id)||manager.runtime;
        const checked=await backend.exec(created.workspace.id,['git','-c','core.fsmonitor=false','rev-parse','HEAD']);
        if(checked.code || checked.stdout.trim()!==context.headSha)throw apiError(409,'pull_request_changed','The pull request changed during checkout. Refresh and try again.');
        const state=manager.store.get(owner,created.workspace.id);
        Object.assign(state.workspace,{pullRequestRequestId:body.requestId,pullRequestTarget:target.join('/'),pullRequestHead:context.headSha});
        state.pullRequestPrompt=context.prompt;
        await manager.store.persist(state);
        return {state,prompt:context.prompt};
      }catch(error){await manager.delete(owner,created.workspace.id).catch(()=>{});throw error;}
    });
    const turn=await manager.turn(owner,result.state.workspace.id,{...body,prompt:result.prompt,mode:'ask',effort:body.effort||manager.config.defaultEffort},authorization);
    return {workspaceId:result.state.workspace.id,conversationId:result.state.conversation.id,turnId:turn.turnId};
  };
}
