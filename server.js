import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, 'public');
// Serverless hosts (Vercel) have a read-only filesystem except /tmp.
const workspaceDir = process.env.VERCEL ? path.join(os.tmpdir(), 'atlas-workspace') : path.resolve(__dirname, process.env.WORKSPACE_DIR || 'workspace');
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cors({ origin(origin, cb) { if (!origin || !allowedOrigins.length || allowedOrigins.includes(origin)) return cb(null, true); const err = new Error('Origin not allowed by CORS policy'); err.status = 403; return cb(err); }}));
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','strict-origin-when-cross-origin'); res.setHeader('X-Frame-Options','DENY'); next(); });

const schema = new mongoose.Schema({
  id: { type: String, unique: true, required: true }, title: { type: String, required: true }, prompt: { type: String, required: true },
  status: { type: String, enum: ['queued','planning','running','approval','completed','failed','rejected'], default: 'queued' },
  plan: { type: [mongoose.Schema.Types.Mixed], default: [] }, trace: { type: [mongoose.Schema.Types.Mixed], default: [] },
  evidence: { type: [mongoose.Schema.Types.Mixed], default: [] }, result: { type: mongoose.Schema.Types.Mixed, default: null },
  requiresApproval: { type: Boolean, default: false }, error: { type: String, default: null }, planner: { type: String, default: null }, plannerWarning: { type: String, default: null }, approval: { type: mongoose.Schema.Types.Mixed, default: null },
  createdAt: { type: Date, default: Date.now }, updatedAt: { type: Date, default: Date.now }
}, { versionKey: false });
const Task = mongoose.models.AtlasTask || mongoose.model('AtlasTask', schema);
const memory = new Map();
let dbReady = null;
function connectDb() {
  if (!process.env.MONGODB_URI) return Promise.resolve();
  if (!dbReady) {
    dbReady = mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 })
      .then(() => { databaseMode = 'mongodb'; console.log('MongoDB connected.'); })
      .catch(e => { dbReady = null; console.error('MongoDB unavailable; using in-memory storage:', e.message); });
  }
  return dbReady;
}
let databaseMode = 'memory';
const now = () => new Date().toISOString();
const clone = value => JSON.parse(JSON.stringify(value));
const sensitivePattern = /\b(send|email|message|pay|payment|delete|remove|publish|invite|transfer|refund|purchase|submit|approve|provision|terminate)\b/i;
const safeTitle = s => s.trim().replace(/\s+/g, ' ').slice(0, 180);

async function getTask(id) { return databaseMode === 'mongodb' ? Task.findOne({ id }).lean() : (memory.has(id) ? clone(memory.get(id)) : null); }
async function saveTask(task) {
  task.updatedAt = now();
  if (databaseMode === 'mongodb') {
    const { _id, ...fields } = task;
    return Task.findOneAndUpdate({ id: task.id }, { $set: fields }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
  }
  memory.set(task.id, clone(task)); return clone(task);
}
async function listTasks() {
  if (databaseMode === 'mongodb') return Task.find().sort({ createdAt: -1 }).limit(100).lean();
  return [...memory.values()].sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0,100).map(clone);
}
function deterministicPlan(prompt) {
  const plan = [{ tool: 'company_context.search', action: 'Search the approved local company knowledge base', verify: 'Record matching source identifiers and snippets.' }];
  if (/summari[sz]|brief|report|compile|prepare|analy[sz]|research|organize|draft/i.test(prompt)) plan.push({ tool: 'workspace.create_artifact', action: 'Create a structured work artifact from the retrieved context', verify: 'Confirm the artifact exists and is non-empty.' });
  plan.push({ tool: 'verification.check_result', action: 'Check task output against the requested outcome', verify: 'Confirm required evidence exists; do not claim completion if a check fails.' });
  return plan;
}
async function makePlan(prompt) {
  if (!process.env.OPENAI_API_KEY) return { plan: deterministicPlan(prompt), planner: 'deterministic-local' };
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4.1-mini', temperature: 0.1, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You plan enterprise work. Return JSON with key plan: an array of 2-5 objects each with tool, action, verify. Allowed tools ONLY: company_context.search, workspace.create_artifact, verification.check_result. Never plan external actions, email sending, payments, deletion, or access changes; those require approval and are not executed by this prototype. Prefer evidence and verification.' },
        { role: 'user', content: `User goal: ${prompt}` }
      ] })
  });
  if (!response.ok) throw new Error(`Planner provider returned HTTP ${response.status}`);
  const data = await response.json();
  const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
  const allowed = new Set(['company_context.search','workspace.create_artifact','verification.check_result']);
  const plan = Array.isArray(parsed.plan) ? parsed.plan.filter(s => allowed.has(s.tool)).slice(0,5).map(s => ({ tool:s.tool, action:String(s.action || s.tool).slice(0,300), verify:String(s.verify || 'Verify the resulting evidence.').slice(0,300) })) : [];
  if (!plan.length) throw new Error('Planner did not return a valid safe plan');
  if (!plan.some(s=>s.tool==='verification.check_result')) plan.push({tool:'verification.check_result',action:'Verify requested outcome',verify:'Check output and evidence.'});
  return { plan, planner: process.env.OPENAI_MODEL || 'openai' };
}
const knowledge = [
  { id:'POL-001', title:'External communication policy', text:'Messages to customers, vendors, or other external recipients must be reviewed and explicitly approved before sending.' },
  { id:'POL-002', title:'Finance approval policy', text:'Payments and financial commitments require an authorized human approval. This prototype never initiates payments.' },
  { id:'OPS-001', title:'Task completion standard', text:'A task is complete only when the requested artifact exists, verification checks pass, and evidence is attached to the run.' },
  { id:'SEC-001', title:'Least privilege and sensitive actions', text:'Use only the minimum required access. Deletion, publication, access changes, and external actions must stop for review.' },
  { id:'OPS-002', title:'Weekly operations brief template', text:'Include executive summary, completed work, blockers, owners, due dates, risks, and source references.' }
];
function searchKnowledge(query) {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3);
  const ranked = knowledge.map(doc => ({ ...doc, score: words.reduce((n,w)=>n + ((doc.title+' '+doc.text).toLowerCase().includes(w) ? 1 : 0),0) })).sort((a,b)=>b.score-a.score);
  return ranked.filter(d=>d.score>0).slice(0,4).map(({id,title,text,score})=>({sourceId:id,title,snippet:text,matchScore:score}));
}
function needsApproval(prompt) { return sensitivePattern.test(prompt); }
function addTrace(task, title, detail, status='ok') { task.trace.push({ at: now(), title, detail, status }); }
async function executeTask(task) {
  task.status = 'running'; task.trace ||= []; task.evidence ||= [];
  addTrace(task, 'Execution started', 'Running approved local tools. No external company system is connected.');
  try {
    const results = [];
    for (const step of task.plan) {
      if (step.tool === 'company_context.search') {
        const matches = searchKnowledge(task.prompt);
        results.push({ tool: step.tool, output: matches });
        task.evidence.push({ type:'knowledge_sources', label:'Company policy and context matches', items:matches });
        addTrace(task, 'Search company context', `Found ${matches.length} relevant local knowledge source(s).`, 'ok');
      } else if (step.tool === 'workspace.create_artifact') {
        await fs.mkdir(workspaceDir, { recursive: true });
        const matches = results.find(r=>r.tool==='company_context.search')?.output || searchKnowledge(task.prompt);
        const fileName = `${task.id.toLowerCase()}-${Date.now()}.md`;
        const filePath = path.join(workspaceDir, fileName);
        const body = `# ${task.title}\n\n## Requested outcome\n${task.prompt}\n\n## Execution notes\n- Generated by Atlas local workspace tool.\n- No external action was performed.\n\n## Relevant company context\n${matches.length ? matches.map(m=>`- **${m.sourceId} — ${m.title}:** ${m.snippet}`).join('\n') : '- No matching source was found in the local demo knowledge base.'}\n\n## Verification\nThe artifact is checked for existence and non-empty content after writing.\n`;
        await fs.writeFile(filePath, body, { flag:'wx', mode:0o600 });
        results.push({ tool:step.tool, output:{ fileName, relativePath:`workspace/${fileName}` } });
        addTrace(task, 'Create workspace artifact', `Wrote ${fileName} using the local workspace tool.`, 'ok');
      } else if (step.tool === 'verification.check_result') {
        const artifacts = results.filter(r=>r.tool==='workspace.create_artifact');
        const checks = [];
        for (const artifact of artifacts) {
          const fullPath = path.join(workspaceDir, path.basename(artifact.output.fileName));
          const stat = await fs.stat(fullPath);
          const content = await fs.readFile(fullPath, 'utf8');
          checks.push({ check:'artifact_exists_and_nonempty', passed:stat.isFile() && stat.size>0 && content.includes(task.prompt), bytes:stat.size, path:artifact.output.relativePath });
        }
        if (!artifacts.length) checks.push({ check:'plan_and_source_review', passed:task.plan.length>0 && task.evidence.length>0, detail:'Plan and retrieved context were recorded.' });
        const passed = checks.every(c=>c.passed);
        results.push({ tool:step.tool, output:{ passed, checks } });
        task.evidence.push({ type:'verification', label:'Independent result checks', checks, passed });
        addTrace(task, 'Verify outcome', passed ? `All ${checks.length} verification check(s) passed.` : 'One or more verification checks failed.', passed?'ok':'error');
        if (!passed) throw new Error('Verification failed');
      }
    }
    task.result = { summary: `Executed ${task.plan.length} planned step(s) using local tools.`, toolResults: results, completedAt: now() };
    task.status = 'completed';
    addTrace(task, 'Task completed', 'Outcome and evidence were recorded after verification passed.');
  } catch (error) {
    task.status = 'failed'; task.error = error.message; addTrace(task, 'Execution failed', error.message, 'error');
  }
  return saveTask(task);
}

app.use('/api', async (_req, _res, next) => { await connectDb(); next(); });
app.get('/api/health', (_req,res)=>res.json({ ok:true, service:'atlas-operator-api', database:databaseMode, planner:process.env.OPENAI_API_KEY?'openai':'deterministic-local', tools:['company_context.search','workspace.create_artifact','verification.check_result'], timestamp:now() }));
app.get('/api/tasks', async (_req,res,next)=>{ try { res.json({ tasks:await listTasks() }); } catch(e){next(e);} });
app.post('/api/tasks', async (req,res,next)=>{
  try {
    const prompt = typeof req.body?.prompt==='string' ? req.body.prompt.trim() : '';
    if (prompt.length < 8) return res.status(400).json({ error:'Prompt must contain at least 8 characters.' });
    if (prompt.length > 2000) return res.status(400).json({ error:'Prompt must be 2000 characters or fewer.' });
    const sensitive = needsApproval(prompt);
    const id = `AT-${randomUUID().slice(0,8).toUpperCase()}`;
    let planning;
    try { planning = await makePlan(prompt); } catch (e) { planning = { plan:deterministicPlan(prompt), planner:'deterministic-fallback', warning:`LLM planner unavailable: ${e.message}` }; }
    const task = { id, title:safeTitle(prompt), prompt, status:sensitive?'approval':'queued', plan:planning.plan, trace:[], evidence:[], result:null, requiresApproval:sensitive,
      approval:sensitive?{ status:'pending', reason:'This request may send communications, change data, or trigger a sensitive action. Review is required before execution.', requestedAt:now() }:null,
      planner:planning.planner, plannerWarning:planning.warning || null, createdAt:now(), updatedAt:now() };
    addTrace(task,'Understand request','Captured the requested outcome and generated a constrained tool plan.');
    addTrace(task,'Policy evaluation',sensitive?'Sensitive action detected. Execution paused for human approval.':'No sensitive-action trigger detected; local tools may execute.',sensitive?'approval':'ok');
    await saveTask(task);
    res.status(201).json({ task });
  } catch(e){next(e);}
});
app.get('/api/tasks/:id', async (req,res,next)=>{ try { const task=await getTask(req.params.id); if(!task)return res.status(404).json({error:'Task not found.'}); res.json({task}); }catch(e){next(e);} });
app.post('/api/tasks/:id/run', async (req,res,next)=>{
  try { const task=await getTask(req.params.id); if(!task)return res.status(404).json({error:'Task not found.'});
    if (task.status==='approval' || task.requiresApproval && task.approval?.status!=='approved') return res.status(409).json({error:'Approval is required before this task can run.',task});
    if (task.status==='completed') return res.json({task,message:'Task is already completed.'});
    const updated=await executeTask(task); res.json({task:updated});
  }catch(e){next(e);}
});
app.post('/api/tasks/:id/approval', async (req,res,next)=>{
  try { const task=await getTask(req.params.id); if(!task)return res.status(404).json({error:'Task not found.'});
    const decision=req.body?.decision; if(!['approve','reject'].includes(decision))return res.status(400).json({error:'decision must be approve or reject.'});
    if(task.status!=='approval' || task.approval?.status!=='pending')return res.status(409).json({error:'Task has no pending approval.'});
    task.approval={...task.approval,status:decision==='approve'?'approved':'rejected',decidedAt:now()};
    if(decision==='reject'){task.status='rejected';addTrace(task,'Human approval rejected','No task actions were executed.','blocked');}
    else {task.status='queued';addTrace(task,'Human approval granted','Approval recorded. Run the task explicitly to continue.');}
    await saveTask(task);res.json({task});
  }catch(e){next(e);}
});
app.get('/api/knowledge/search', (req,res)=>{ const q=String(req.query.q||'').slice(0,500); res.json({results:searchKnowledge(q)}); });
app.get('/api/artifacts', async (_req,res,next)=>{try{await fs.mkdir(workspaceDir,{recursive:true});const names=(await fs.readdir(workspaceDir)).filter(n=>n.endsWith('.md'));const artifacts=await Promise.all(names.map(async name=>{const stat=await fs.stat(path.join(workspaceDir,name));return {name,size:stat.size,modifiedAt:stat.mtime.toISOString(),path:`workspace/${name}`};}));res.json({artifacts});}catch(e){next(e);}});
app.use('/api', (_req,res)=>res.status(404).json({ error:'Not found.' }));
app.use(express.static(publicDir, { extensions:['html'] }));
app.use((err,_req,res,_next)=>{console.error('[atlas-api]',err.message);if(res.headersSent)return;res.status(err.status||500).json({error:process.env.NODE_ENV==='production'?'Request failed.':err.message||'Internal server error.'});});

async function start(){
  await fs.mkdir(workspaceDir,{recursive:true});
  await connectDb();
  const server = app.listen(PORT,'0.0.0.0',()=>console.log(`Atlas Operator listening on port ${PORT} (database: ${databaseMode})`));
  const shutdown = signal => { console.log(`${signal} received, shutting down.`); server.close(async () => { try { await mongoose.disconnect(); } catch {} process.exit(0); }); setTimeout(() => process.exit(1), 10000).unref(); };
  process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
}
// Only start listening when run directly (node server.js), not when imported by tests or serverless handlers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();
export default app;
export { app, deterministicPlan, searchKnowledge, needsApproval };
