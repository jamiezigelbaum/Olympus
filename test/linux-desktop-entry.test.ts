import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { publishLinuxEngineReceipt, resolveLinuxEngineLayout } from '../src/core/linux-engine-layout.ts';
const roots:string[]=[];
afterEach(()=>{for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
const api=()=>import('../src/core/linux-desktop-entry.ts');
function fixture(){const home=mkdtempSync(join(tmpdir(),'desktop-entry-'));roots.push(home);const runtime=join(home,'run');mkdirSync(runtime,{mode:0o700});return resolveLinuxEngineLayout({HOME:home,XDG_DATA_HOME:join(home,'custom data'),XDG_RUNTIME_DIR:runtime});}
test('desktop content quotes Exec using both desktop escape layers',async()=>{
 const {renderLinuxDesktopEntry}=await api();
 const text=renderLinuxDesktopEntry('/home/a "b"/$c/`d`/back\\slash/olympus');
 expect(text).toContain(String.raw`Exec="/home/a \\"b\\"/\\$c/\\\`d\\\`/back\\\\slash/olympus" dashboard`.replaceAll('\\`','`'));
 for(const line of ['[Desktop Entry]','Type=Application','Name=Olympus','Icon=ai.olympusplugin.Olympus','Categories=Utility;','Terminal=false','X-Olympus-Managed=true'])expect(text.split('\n')).toContain(line);
});
test('desktop refuses nonabsolute, control, equals, percent and non-ASCII executable paths',async()=>{
 const {renderLinuxDesktopEntry}=await api();
 for(const path of ['relative','/a\nExec=evil','/a\0b','/a\tb','/a=b','/a%f','/a/é'])expect(()=>renderLinuxDesktopEntry(path)).toThrow();
});
test('custom XDG install refreshes caches, replaces marked edits, and preserves unmarked edits',async()=>{
 const {linuxDesktopEntryPaths,writeLinuxDesktopEntry}=await api(),l=fixture(),p=linuxDesktopEntryPaths(l),calls:string[]=[];
 const exec=(cmd:string)=>{calls.push(cmd);return {status:127,stdout:'',stderr:'missing'};};
 const packageRoot=join(import.meta.dir,'..');
 writeLinuxDesktopEntry(l,packageRoot,exec);
 expect(readFileSync(p.icon)).toEqual(readFileSync(join(packageRoot,'assets/icon.png')));
 expect(calls).toEqual(['update-desktop-database','gtk-update-icon-cache']);
 publishLinuxEngineReceipt(l,{machineArtifacts:[{path:p.icon,kind:'file',sha256:createHash('sha256').update(readFileSync(p.icon)).digest('hex')}]});
 writeFileSync(p.desktop,'[Desktop Entry]\nName=Edited\nX-Olympus-Managed=true\n');
 writeLinuxDesktopEntry(l,packageRoot,exec);expect(readFileSync(p.desktop,'utf8')).toContain('Name=Olympus');
 writeFileSync(p.desktop,'[Desktop Entry]\nName=Mine\n');
 expect(()=>writeLinuxDesktopEntry(l,packageRoot,exec)).toThrow('retained');
 expect(readFileSync(p.desktop,'utf8')).toBe('[Desktop Entry]\nName=Mine\n');
});
test('desktop refuses symlinks and unowned icon collisions before writing',async()=>{
 const {linuxDesktopEntryPaths,writeLinuxDesktopEntry}=await api(),l=fixture(),p=linuxDesktopEntryPaths(l);
 mkdirSync(dirname(p.desktop),{recursive:true});const target=join(l.home,'target');writeFileSync(target,'untouched');symlinkSync(target,p.desktop);
 expect(()=>writeLinuxDesktopEntry(l,join(import.meta.dir,'..'))).toThrow();expect(readFileSync(target,'utf8')).toBe('untouched');rmSync(p.desktop);
 mkdirSync(dirname(p.icon),{recursive:true});writeFileSync(p.icon,'user icon');
 expect(()=>writeLinuxDesktopEntry(l,join(import.meta.dir,'..'))).toThrow('retained');expect(existsSync(p.desktop)).toBe(false);
});
