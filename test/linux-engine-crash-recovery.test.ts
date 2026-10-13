import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveLinuxEngineLayout } from '../src/core/linux-engine-layout.ts';
import type { EngineLifecycleCheckpoint } from '../src/core/engine-service.ts';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const fixture=join(import.meta.dir,'fixtures/linux-engine-crash-child.ts');
const checkpoints:EngineLifecycleCheckpoint[]=[
 'linger_receipt_published','linger_enabled','receipt_published','journal_published','staging_identity_published','generation_identity_published','generation_renamed',
 'launcher_published','activating_published','config_published','unit_published','current_published',
 'qualified_published','receipt_finalized','backup_removed','journal_removed',
];
function run(root:string,action:'install'|'repair'|'recover'|'rollback',checkpoint?:EngineLifecycleCheckpoint,version='1.0.0'){return spawnSync(process.execPath,[fixture],{encoding:'utf8',timeout:20_000,
 env:{...process.env,CRASH_ROOT:root,CRASH_ACTION:action,CRASH_VERSION:version,...(checkpoint?{CRASH_CHECKPOINT:checkpoint}:{})}});}

for(const checkpoint of checkpoints)test.skipIf(process.platform!=='linux')(`install SIGKILL recovery is idempotent after ${checkpoint}`,()=>{
  const root=mkdtempSync(join(tmpdir(),`linux-engine-crash-${checkpoint}-`));roots.push(root);
  const crashed=run(root,'install',checkpoint);expect({checkpoint,status:crashed.status,signal:crashed.signal,stderr:crashed.stderr}).toMatchObject({checkpoint,status:null,signal:'SIGKILL'});
  for(let pass=0;pass<2;pass+=1){const repaired=run(root,'repair');expect({checkpoint,pass,status:repaired.status,stderr:repaired.stderr}).toMatchObject({checkpoint,pass,status:0,stderr:''});}
  const env={HOME:join(root,'home'),XDG_CONFIG_HOME:join(root,'config'),XDG_DATA_HOME:join(root,'data'),XDG_STATE_HOME:join(root,'state'),XDG_CACHE_HOME:join(root,'cache'),XDG_RUNTIME_DIR:join(root,'run')};
  const layout=resolveLinuxEngineLayout(env),receipt=JSON.parse(readFileSync(layout.receiptPath,'utf8'));
  expect({checkpoint,state:receipt.installationState,lingerPredated:receipt.lingerPredated,journal:existsSync(join(layout.stateDir,'install-transaction.json'))}).toEqual({checkpoint,state:'installed',lingerPredated:false,journal:false});
  const generations=readdirSync(join(layout.packageDir,'generations'));expect({checkpoint,generations:generations.length}).toEqual({checkpoint,generations:1});
  const generation=join(layout.packageDir,'generations',generations[0]!);expect(readFileSync(layout.unitPath,'utf8')).toContain(generation);expect(readFileSync(layout.launcherPath,'utf8')).toContain(generation);
  expect(readFileSync(join(layout.dataHome,'applications/ai.olympusplugin.Olympus.desktop'),'utf8')).toContain(`Exec="${layout.launcherPath}" dashboard`);
  expect(readFileSync(join(layout.dataHome,'icons/hicolor/512x512/apps/ai.olympusplugin.Olympus.png'))).toEqual(readFileSync(join(root,'source-1.0.0/assets/app-icon.png')));
  expect(readdirSync(layout.stateDir).filter(name=>name.startsWith('.install-backup-')||name.startsWith('.prepare-'))).toEqual([]);
},20_000);

const rollbackCheckpoints:EngineLifecycleCheckpoint[]=['journal_published','activating_published','unit_published','config_published','launcher_published','current_published','receipt_finalized','qualified_published','backup_removed','journal_removed'];
for(const checkpoint of rollbackCheckpoints)test.skipIf(process.platform!=='linux')(`rollback SIGKILL recovery is idempotent after ${checkpoint}`,()=>{
  const root=mkdtempSync(join(tmpdir(),`linux-engine-rollback-${checkpoint}-`));roots.push(root);
  expect(run(root,'install',undefined,'1.0.0').status).toBe(0);expect(run(root,'install',undefined,'2.0.0').status).toBe(0);
  const crashed=run(root,'rollback',checkpoint,'2.0.0');expect({checkpoint,status:crashed.status,signal:crashed.signal}).toMatchObject({checkpoint,status:null,signal:'SIGKILL'});
  for(let pass=0;pass<2;pass+=1){const recovered=run(root,'recover',undefined,'2.0.0');expect({checkpoint,pass,status:recovered.status,stderr:recovered.stderr}).toMatchObject({checkpoint,pass,status:0,stderr:''});}
  const env={HOME:join(root,'home'),XDG_CONFIG_HOME:join(root,'config'),XDG_DATA_HOME:join(root,'data'),XDG_STATE_HOME:join(root,'state'),XDG_CACHE_HOME:join(root,'cache'),XDG_RUNTIME_DIR:join(root,'run')};
  const layout=resolveLinuxEngineLayout(env),current=JSON.parse(readFileSync(join(layout.stateDir,'service-current.json'),'utf8')),unit=readFileSync(layout.unitPath,'utf8'),launcher=readFileSync(layout.launcherPath,'utf8');
  const committed=['qualified_published','backup_removed','journal_removed'].includes(checkpoint),expected=committed?'1.0.0+':'2.0.0+';
  expect(readFileSync(join(layout.dataHome,'applications/ai.olympusplugin.Olympus.desktop'),'utf8')).toContain(`Exec="${layout.launcherPath}" dashboard`);
  expect(readFileSync(join(layout.dataHome,'icons/hicolor/512x512/apps/ai.olympusplugin.Olympus.png'))).toEqual(readFileSync(join(root,`source-${committed?'1.0.0':'2.0.0'}/assets/app-icon.png`)));
  expect({checkpoint,build:current.program.build.startsWith(expected),unit:unit.includes(current.program.workingDirectory),launcher:launcher.includes(current.program.workingDirectory),journal:existsSync(join(layout.stateDir,'install-transaction.json'))}).toEqual({checkpoint,build:true,unit:true,launcher:true,journal:false});
},30_000);

for(const checkpoint of ['launcher_published','qualified_published'] as const) for(const replacement of ['desktop','icon','symlink'] as const)
test.skipIf(process.platform!=='linux')(`desktop recovery retains user ${replacement} after ${checkpoint}`,()=>{
 const root=mkdtempSync(join(tmpdir(),'linux-desktop-recovery-'));roots.push(root);
 expect(run(root,'install',checkpoint).signal).toBe('SIGKILL');
 const desktop=join(root,'data/applications/ai.olympusplugin.Olympus.desktop');
 const icon=join(root,'data/icons/hicolor/512x512/apps/ai.olympusplugin.Olympus.png');
 const target=replacement==='icon'?icon:desktop;
 if(replacement==='symlink'){rmSync(target);const other=join(root,'personal');writeFileSync(other,'personal');symlinkSync(other,target);}
 else writeFileSync(target,'personal');
 const recovered=run(root,'recover');
 expect(recovered.status).not.toBe(0);expect(readFileSync(target,'utf8')).toBe('personal');
 expect(existsSync(join(root,'state/olympus/engine/install-transaction.json'))).toBe(true);
});

test.skipIf(process.platform!=='linux')('legacy recovery leaves unrelated desktop files alone',()=>{
 const root=mkdtempSync(join(tmpdir(),'linux-legacy-desktop-'));roots.push(root);
 expect(run(root,'install','journal_published').signal).toBe('SIGKILL');
 const desktop=join(root,'data/applications/ai.olympusplugin.Olympus.desktop');
 const icon=join(root,'data/icons/hicolor/512x512/apps/ai.olympusplugin.Olympus.png');
 const journalPath=join(root,'state/olympus/engine/install-transaction.json');
 const journal=JSON.parse(readFileSync(journalPath,'utf8'));
 for(const path of [desktop,icon]){delete journal.before.files[path];mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,'personal');}
 const oldBackup=join(journal.backupDir,'file-5.backup');renameSync(journal.before.receipt.backupPath,oldBackup);journal.before.receipt.backupPath=oldBackup;
 writeFileSync(journalPath,JSON.stringify(journal));
 const recovered=run(root,'recover');expect({status:recovered.status,stderr:recovered.stderr}).toEqual({status:0,stderr:''});
 for(const path of [desktop,icon])expect(readFileSync(path,'utf8')).toBe('personal');
 const receipt=JSON.parse(readFileSync(join(root,'config/olympus/install-receipt.json'),'utf8'));
 expect(receipt.machineArtifacts.some((item:any)=>[desktop,icon].includes(item.path))).toBe(false);
});
