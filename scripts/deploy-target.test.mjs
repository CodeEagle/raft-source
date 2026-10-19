import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, source, validateArtifact, checkDeps, excluded, VERSION, copyInputs, resolveLzcCli } from './deploy-target.mjs';
const sha = 'a'.repeat(40), digest = 'sha256:'+'b'.repeat(64);
const artifact = () => ({ scriptVersion:VERSION, commit:sha, dirty:false, patchSummary:'', target:'standard', env:'local', buildTime:new Date().toISOString(), images:Object.fromEntries(['server','web'].map(k=>[k,{ref:`raft-standard-${k}:${sha}`,digest}])) });
test('arguments fail closed',()=>{
  assert.equal(parse(['build','--ref','HEAD']).target,'standard');
  for(const args of [ ['build'], ['build','--ref','HEAD','--target','standrad'], ['deploy','--artifact','x'], ['deploy','--target','lazycat','--env','local','--artifact','x'], ['build','--ref','HEAD','--env','prod'], ['deploy','--target','standard','--env','local','--artifact','x','--wat'] ]) assert.throws(()=>parse(args));
});
test('artifact shape and mismatches rejected before commands',()=>{
  const a=artifact(); validateArtifact(a,{target:'standard',env:'local'});
  assert.throws(()=>validateArtifact(a,{target:'lazycat',env:'dev'}));
  assert.throws(()=>validateArtifact(a,{target:'standard',env:'release'}));
  a.images.web.digest='bad'; assert.throws(()=>validateArtifact(a,{target:'standard',env:'local'}));
});
test('full ref resolution and dirty provenance',()=>{
  const calls=[]; const exec=(_,args)=>{ calls.push(args); return args[0]==='rev-parse'?sha:args[0]==='status'?' M file':' file | 1 +'; };
  assert.throws(()=>source('v1',false,exec),/Dirty/);
  const s=source('v1',true,exec); assert.equal(s.commit,sha); assert.equal(s.dirty,true); assert.match(s.patchSummary,/file/); assert.ok(calls.some(a=>a.includes('v1^{commit}')));
  assert.throws(()=>source('other',true,(_,a)=>a.includes('HEAD')?'c'.repeat(40):sha),/Checkout/);
});
test('manifest carries no environment secrets',()=>{
  process.env.JWT_SECRET='sentinel-never-persist';
  assert.ok(!JSON.stringify(artifact()).includes(process.env.JWT_SECRET)); delete process.env.JWT_SECRET;
  for(const p of ['.pi/x','lazycat/dist/x','lazycat/.lzc-cli-cache/x','packages/server/.env.local','keys/private.pem','node_modules/x']) assert.ok(excluded(p),p);
});
test('dependency closure matches and includes lockfiles',()=>{ checkDeps(); assert.deepEqual(copyInputs('COPY package.json pnpm-lock.yaml ./'),['package.json','pnpm-lock.yaml']); });
test('lzc-cli selects the first compatible PATH candidate and records only path/version',()=>{
  const calls = [];
  const cli = resolveLzcCli((path,args)=>{
    calls.push(path); assert.deepEqual(args,['--version']);
    return path === '/old/lzc-cli' ? 'lzc-cli 2.0.5' : 'lzc-cli 2.0.9\n';
  },{PATH:'/old:/new:/later',JWT_SECRET:'sentinel-never-persist'});
  assert.deepEqual(cli,{path:'/new/lzc-cli',version:'2.0.9'});
  assert.deepEqual(calls,['/old/lzc-cli','/new/lzc-cli']);
});
test('lzc-cli compares versions numerically and rejects old or invalid versions',()=>{
  for (const version of ['2.0.9','2.0.10','2.1.0','3.0.0','10.0.0']) {
    assert.equal(resolveLzcCli(()=>`lzc-cli ${version}`,{PATH:'/cli'}).version,version);
  }
  for (const version of ['2.0.5','2.0.8','1.99.99','invalid','2.0.9-beta']) {
    assert.throws(()=>resolveLzcCli(()=>`lzc-cli ${version}`,{PATH:'/cli'}),/Install lzc-cli >= 2\.0\.9/);
  }
  assert.throws(()=>resolveLzcCli(()=>{ throw Error('missing'); },{PATH:'/missing'}),/Install lzc-cli >= 2\.0\.9/);
});
test('lzc-cli skips unavailable PATH entries and honors override without fallback',()=>{
  assert.equal(resolveLzcCli(path=>{
    if (path === '/missing/lzc-cli') throw Error('ENOENT');
    return 'lzc-cli 2.0.9';
  },{PATH:'/missing:/new'}).path,'/new/lzc-cli');
  const env = {PATH:'/new',RAFT_LZC_CLI:'/override/lzc-cli'};
  const exec = path=>{ assert.equal(path,env.RAFT_LZC_CLI); return 'lzc-cli 2.0.10'; };
  assert.deepEqual(resolveLzcCli(exec,env),{path:env.RAFT_LZC_CLI,version:'2.0.10'});
  assert.throws(()=>resolveLzcCli(()=> 'lzc-cli 2.0.5',env),/Install lzc-cli >= 2\.0\.9/);
});
