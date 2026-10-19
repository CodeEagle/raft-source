#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, rmSync, lstatSync } from 'node:fs';
import { resolve, join, relative, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
export const VERSION = 1;
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export function parse(args) {
  const command = args.shift(), o = { command };
  if (!['build','deploy','check-deps'].includes(command)) throw Error('Expected build, deploy or check-deps');
  while (args.length) {
    const k = args.shift();
    if (k === '--allow-dirty') { o.allowDirty = true; continue; }
    if (!['--target','--env','--ref','--artifact'].includes(k) || !args.length || args[0].startsWith('--')) throw Error(`Invalid option ${k}`);
    const key = k.slice(2); if (key in o) throw Error(`Duplicate ${k}`); o[key] = args.shift();
  }
  if (command === 'check-deps') { if (Object.keys(o).length !== 1) throw Error('check-deps takes no options'); return o; }
  if (command === 'build') { o.target ??= 'standard'; o.env ??= o.target === 'standard' ? 'local' : 'release'; if (!o.ref || o.artifact || !['local','dev','release'].includes(o.env) || (o.env !== (o.target === 'standard' ? 'local' : 'release') && o.env !== 'dev')) throw Error('build requires --ref; only --env dev may override default'); }
  else if (!o.target || !o.env || !o.artifact || o.ref || o.allowDirty) throw Error('deploy requires explicit --target, --env and --artifact');
  if (!['standard','lazycat'].includes(o.target) || !['local','dev','release'].includes(o.env) || (o.target === 'lazycat' && o.env === 'local')) throw Error('Invalid target/environment');
  return o;
}
export function run(cmd, args, cwd = root, phase = cmd) {
  const r = spawnSync(cmd, args, { cwd, encoding:'utf8', timeout: 30 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0 || r.error) throw Error(`${phase} incomplete: ${cmd} ${args.join(' ')}; exit=${r.status}; ${r.error?.code || ''}\n${((r.stderr || '') + (r.stdout || '')).slice(-4000)}`);
  return r.stdout.trim();
}
export function resolveLzcCli(exec = run, env = process.env) {
  const candidates = env.RAFT_LZC_CLI
    ? [env.RAFT_LZC_CLI]
    : [...new Set((env.PATH ?? '').split(delimiter).map(dir => resolve(root, dir, 'lzc-cli')))];
  const minimum = [2, 0, 9];
  for (const path of candidates) {
    let output;
    try { output = exec(path, ['--version']); } catch { continue; }
    const match = /^lzc-cli\s+(\d+)\.(\d+)\.(\d+)\s*$/.exec(output.trim());
    if (!match) continue;
    const parts = match.slice(1).map(Number);
    const difference = parts.findIndex((part, i) => part !== minimum[i]);
    if (parts.every(Number.isSafeInteger) && (difference === -1 || parts[difference] > minimum[difference])) {
      return { path, version: match.slice(1).join('.') };
    }
  }
  throw Error('Install lzc-cli >= 2.0.9 and make it available on PATH, or set RAFT_LZC_CLI to a compatible executable.');
}
export function source(ref, allowDirty, exec = run) {
  const sha = exec('git',['rev-parse','--verify',`${ref}^{commit}`]);
  if (!/^[a-f0-9]{40}$/.test(sha)) throw Error('Ref did not resolve to a full commit');
  const head = exec('git',['rev-parse','HEAD']);
  if (sha !== head) throw Error('Checkout the requested commit before building (working tree HEAD differs)');
  const status = exec('git',['status','--porcelain','--untracked-files=normal']);
  if (status && !allowDirty) throw Error('Dirty working tree; commit changes or use --allow-dirty');
  return { commit:sha, dirty:!!status, patchSummary:status ? exec('git',['diff','HEAD','--stat']) + '\n' + status : '' };
}
export function copyInputs(text) {
  return [...new Set(text.split('\n').filter(l=>/^COPY /i.test(l) && !l.includes('--from=')).flatMap(l=>l.trim().split(/\s+/).slice(1,-1)).filter(p=>p === 'package.json' || p === 'pnpm-workspace.yaml' || p === 'pnpm-lock.yaml' || p.startsWith('packages/')))].sort();
}
export function checkDeps(dir = root) {
  for (const kind of ['server','web']) {
    const a = copyInputs(readFileSync(join(dir,`packages/${kind}/Dockerfile`),'utf8'));
    const b = copyInputs(readFileSync(join(dir,`lazycat/Dockerfile.${kind}`),'utf8'));
    if (JSON.stringify(a) !== JSON.stringify(b)) throw Error(`Dependency closure drift: ${kind}\nstandard: ${a}\nlazycat: ${b}`);
  }
}
const hash = p => createHash('sha256').update(readFileSync(p)).digest('hex');
export function validateArtifact(a, o) {
  if (a.scriptVersion !== VERSION || a.target !== o.target || a.env !== o.env || !/^[a-f0-9]{40}$/.test(a.commit) || !Number.isFinite(Date.parse(a.buildTime))) throw Error('Artifact identity/target/environment mismatch');
  if (o.target === 'standard') {
    for (const kind of ['server','web']) if (!a.images?.[kind]?.ref?.startsWith(`raft-standard-${kind}:`) || !/^sha256:[a-f0-9]{64}$/.test(a.images[kind].digest)) throw Error('Invalid standard image identity/digest');
  } else if (!a.lpk?.path || !/^[a-f0-9]{64}$/.test(a.lpk.sha256) || !a.lpk.version) throw Error('Invalid LPK identity/digest');
}
export function excluded(path) {
  return path.split('/').some(p=>['.git','.pi','node_modules','.lzc-cli-cache','dist','secrets','.aws','.ssh','.codex','.agents'].includes(p) || /^\.env(?:\.|$)/.test(p) || /\.(pem|key|p12|pfx|lpk)$/i.test(p));
}
export function main(args) {
  const o = parse(args);
  if (o.command === 'check-deps') { checkDeps(); console.log('Dependency closures match'); return; }
  if (o.command === 'deploy') {
    const a = JSON.parse(readFileSync(resolve(o.artifact),'utf8')); validateArtifact(a,o);
    if (o.target === 'lazycat') {
      if (hash(a.lpk.path) !== a.lpk.sha256) throw Error('LPK digest mismatch');
      const lzcCli = resolveLzcCli();
      console.log(`lzc-cli: ${lzcCli.path} (${lzcCli.version})`);
      run(lzcCli.path,['lpk','install',a.lpk.path],root,'install reviewed LPK');
    } else {
      for (const i of Object.values(a.images)) if (run('docker',['image','inspect','--format','{{.Id}}',i.ref]) !== i.digest) throw Error('Image digest mismatch');
      // Compose uses immutable local image IDs after both images have been verified.
      const temp = mkdtempSync(join(tmpdir(),'raft-deploy-'));
      try {
        const config = readFileSync(join(root,'deploy/standard/compose.yml'),'utf8').replace('${RAFT_SERVER_IMAGE:?required}',a.images.server.digest).replace('${RAFT_WEB_IMAGE:?required}',a.images.web.digest);
        writeFileSync(join(temp,'compose.yml'),config.replace('./nginx.conf',join(root,'deploy/standard/nginx.conf')));
        run('docker',['compose','--project-name',`raft-standard-${o.env}`,'--env-file',join(root,'deploy/standard/.env'),'-f',join(temp,'compose.yml'),'up','-d','--no-build'],root,'standard deployment');
      } finally { rmSync(temp,{recursive:true,force:true}); }
    }
    return;
  }
  checkDeps();
  const identity = source(o.ref,o.allowDirty), buildTime = new Date().toISOString();
  const out = join(root,'deploy-artifacts',`${o.target}-${o.env}-${identity.commit.slice(0,12)}-${Date.now()}`); mkdirSync(out,{recursive:true});
  const a = { scriptVersion:VERSION, ...identity, target:o.target, env:o.env, buildTime };
  const metadata = { RAFT_RELEASE_SHA:identity.commit, RAFT_BUILD_AT:buildTime, RAFT_RELEASE_BRANCH:o.ref, RAFT_IMAGE_SOURCE:'https://github.com/CodeEagle/raft-source', SLOCK_RELEASE_SHA:identity.commit, SLOCK_BUILD_AT:buildTime, SLOCK_RELEASE_BRANCH:o.ref };
  const web = { VITE_API_URL:'', VITE_COMMIT_SHA:identity.commit, VITE_BUILD_AT:buildTime, VITE_RELEASE_BRANCH:o.ref, VITE_FRONTEND_RELEASE_ID:identity.commit };
  if (o.target === 'standard') {
    a.images = {};
    for (const kind of ['server','web']) {
      const ref = `raft-standard-${kind}:${identity.commit}-${Date.now()}`;
      const params = kind === 'server' ? metadata : web;
      run('docker',['build','-f',`packages/${kind}/Dockerfile`,'-t',ref,...Object.entries(params).flatMap(([k,v])=>['--build-arg',`${k}=${v}`]),'.'],root,`build standard ${kind}`);
      a.images[kind] = { ref, digest:run('docker',['image','inspect','--format','{{.Id}}',ref]) };
    }
  } else {
    const appUrl = process.env.RAFT_APP_URL;
    if (!appUrl || !/^https:\/\/[^\s"'\\]+$/.test(appUrl)) throw Error('lazycat build requires RAFT_APP_URL=https://<deployment-domain> (LPK embeds deployment config)');
    a.lzcCli = resolveLzcCli();
    console.log(`lzc-cli: ${a.lzcCli.path} (${a.lzcCli.version})`);
    const temp = mkdtempSync(join(tmpdir(),'raft-lazycat-'));
    try {
      cpSync(root,temp,{recursive:true,filter:p=>!excluded(relative(root,p)) && !relative(root,p).startsWith('deploy-artifacts') && !lstatSync(p).isSymbolicLink()});
      for (const [kind,params] of [['server',metadata],['web',web]]) {
        const p = join(temp,`lazycat/Dockerfile.${kind}`);
        let text = readFileSync(p,'utf8');
        for (const [k,v] of Object.entries(params)) text = text.replace(new RegExp(`^ARG ${k}(?:=.*)?$`,'m'),`ARG ${k}=${JSON.stringify(v)}`);
        writeFileSync(p,text);
      }
      const manifest = join(temp,'lazycat/lzc-manifest.yml');
      writeFileSync(manifest,readFileSync(manifest,'utf8').replace('__RAFT_APP_URL__',appUrl));
      let config = readFileSync(join(temp,'lazycat/lzc-build.yml'),'utf8');
      if (o.env === 'dev') config += '\n' + readFileSync(join(temp,'lazycat/lzc-build.dev.yml'),'utf8');
      writeFileSync(join(temp,'lazycat/lzc-build.resolved.yml'),config);
      const lpkOut = join(temp,'raft.lpk');
      run(a.lzcCli.path,['project','build','--file','lzc-build.resolved.yml','--output',lpkOut],join(temp,'lazycat'),'build lazycat LPK');
      const path = join(out,'raft.lpk'); cpSync(lpkOut,path);
      a.lpk = { path, sha256:hash(path), version:readFileSync(join(temp,'lazycat/package.yml'),'utf8').match(/^version:\s*(.+)$/m)[1].trim() };
    } finally { rmSync(temp,{recursive:true,force:true}); }
  }
  validateArtifact(a,o);
  const path = join(out,'artifact-manifest.json'); writeFileSync(path,JSON.stringify(a,null,2)+'\n'); console.log(path);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
