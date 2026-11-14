/** Provider web UI only: no provider API calls, cookies or access-token extraction. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Machine, Tunnel } from './machine.ts';
import { connectBrowser, type BrowserSession } from './web-clients.ts';
import { parseCdpEndpoint } from './fresh-dashboard.ts';
import { consentBlock, FreshInconclusive, quote } from './fresh-install.ts';
import { browserSeedPlan, ON_DEMAND_FOLDER, browserTimingSeeds, type BrowserSeedUi, type SeedFolder, type TimingSource } from './on-demand-seeds.ts';

const TEST_ACCOUNT = 'jamiez.olympus@gmail.com';
const visible = `(e) => !!e && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility !== 'hidden'`;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** One name per rendered row; repeated aria labels inside a row are not duplicate files. */
export function providerListingExpression(source: TimingSource): string {
  const titles = [ON_DEMAND_FOLDER, ...browserSeedPlan(source).map(file => file.name)];
  return `(() => {
    const titles=${JSON.stringify(titles)};
    let rows=[...document.querySelectorAll('[role=row],tr')];
    if(!rows.length)rows=[...document.querySelectorAll('[data-testid="file-name"],[data-testid="folder-name"],[data-filename]')];
    const shows=(e,name)=>[e.getAttribute('data-tooltip'),e.getAttribute('aria-label'),e.getAttribute('data-filename'),e.getAttribute('title'),e.textContent?.trim()].includes(name);
    const found=rows.flatMap(row=>{
      const elements=[row,...row.querySelectorAll('*')];
      const title=titles.find(name=>elements.some(e=>shows(e,name)));
      return title ? [title] : [];
    });
    // A listing that names items outside its rows (Dropbox's top level): an element showing exactly the name counts.
    const leaves=[...document.querySelectorAll('body *')];
    for(const name of titles) if(!found.includes(name) && leaves.some(e=>(e.children.length===0 || e.hasAttribute('title') || e.hasAttribute('aria-label')) && shows(e,name))) found.push(name);
    return found;
  })()`;
}

/** Drive's own search address for one folder name, so no keyboard submit is needed. */
export function driveFolderSearchUrl(name: string): string {
  return `https://drive.google.com/drive/u/0/search?q=${encodeURIComponent(`type:folder "${name}"`)}`;
}

/** A loading bar the user can see. Drive keeps hidden bars in the page at rest, and its storage meter is a
 * visible bar with a value, so only a visible bar without aria-valuenow (indeterminate) counts as loading. */
const BUSY = `[...document.querySelectorAll('[role=progressbar]')].some(e => !e.hasAttribute('aria-valuenow') && (${visible})(e))`;
const DRIVE_EMPTY = `/no results|no matching|matched this search|try another search|none of your files/i.test(document.body?.innerText || '')`;

/** Drive search has settled: result rows, or the empty state a first run gets before the folder exists.
 * Drive keeps a visible loading bar on screen even after results show, so the bar is not a signal here. */
export const DRIVE_SEARCH_SETTLED = `(() => location.pathname.includes('/search') && (${DRIVE_EMPTY} || !!document.querySelector('[role=grid] [role=row]')))()`;

/** What a Drive search page showed, for a failure message: no file names or page text. */
export const DRIVE_SEARCH_SNAPSHOT = `(() => ({path: location.pathname, grid: !!document.querySelector('[role=grid]'), progress: !!document.querySelector('[role=progressbar]'), busy: ${BUSY}, empty: ${DRIVE_EMPTY}, rows: document.querySelectorAll('[role=row]').length}))()`;

const PROVIDER_CONTROLS = `[...document.querySelectorAll('button,[role=button],[role=menuitem],a')].filter(${visible})`;
/** A control's names: its label, its text, and its first rendered line. Drive's menu items carry a
 * keyboard-shortcut hint after the name ("New folder" then "Alt+C then F"), so the whole text never equals it. */
const CONTROL_NAMES = `(e) => [e.getAttribute('aria-label'), e.textContent, (e.innerText || '').split('\\n')[0]].filter(Boolean).map(v => v.trim())`;

/** Find the first visible control named by one of `labels` and press it as a person would. Closure menus
 * (Drive) act on mousedown/mouseup, so send those before the click. */
/** Presses the first visible control with one of these names; one inside an open dialog wins (a dialog's Create, not the toolbar's). */
export function providerClickExpression(labels: readonly string[]): string {
  return `(() => {const names=${CONTROL_NAMES};const named=${PROVIDER_CONTROLS}.filter(e=>names(e).some(value=>${JSON.stringify(labels)}.some(label=>value===label || value.startsWith(label+' '))));const e=named.find(e=>e.closest('[role=dialog],[role=alertdialog],[aria-modal=true]'))||named[0];if(!e||e.disabled||e.getAttribute('aria-disabled')==='true')return false;for(const type of ['mousedown','mouseup'])e.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,view:window}));e.click();return true;})()`;
}

/** Whether a Dropbox listing row (not a toast or the rename box) names this folder exactly. */
function dropboxRowShows(name: string): string {
  return `[...document.querySelectorAll('[role=row],tr')].some(r=>[r,...r.querySelectorAll('*')].some(e=>(e.textContent||'').trim()===${JSON.stringify(name)}||e.getAttribute('title')===${JSON.stringify(name)}||e.getAttribute('aria-label')===${JSON.stringify(name)}))`;
}

/** Visible menu item names, for a failure message: provider UI labels only, never file names. */
const PROVIDER_CONTROL_NAMES = `[...document.querySelectorAll('[role=menuitem]')].filter(${visible}).map(e => (${CONTROL_NAMES})(e).at(-1)).slice(0, 20)`;

/** Drive lists items as rows in list view and as grid cells or options in grid view. */
const DRIVE_ITEMS = '[role=row],[role=gridcell],[role=option],tr';

/** What a Drive page showed when the seed folder was not found: counts and flags only. */
export function drivePageSnapshot(name: string): string {
  return `(() => ({path: location.pathname, items: document.querySelectorAll(${JSON.stringify(DRIVE_ITEMS)}).length, rows: document.querySelectorAll('[role=row]').length, cells: document.querySelectorAll('[role=gridcell],[role=option]').length, nameShown: (document.body?.innerText || '').includes(${JSON.stringify(name)}), untitledShown: /untitled folder/i.test(document.body?.innerText || ''), dialogs: [...document.querySelectorAll('[role=dialog]')].filter(${visible}).length}))()`;
}

/** Open the one row named `name` (by tooltip, label, or its visible text, as the listing reads names).
 * Returns 'none' while it is not listed and 'many' when the name is not unique. */
/**
 * Finds the one Drive item showing `name`. Returns its folder id when Drive
 * labels the item with one (the caller opens the folder by address, which a
 * synthetic double-click does not reliably do); otherwise double-clicks it.
 */
export function driveFolderRowExpression(name: string): string {
  return `(() => {const name=${JSON.stringify(name)};const named=[...document.querySelectorAll(${JSON.stringify(DRIVE_ITEMS)})].filter(row=>[row,...row.querySelectorAll('*')].some(e=>[e.getAttribute('data-tooltip'),e.getAttribute('aria-label'),e.getAttribute('data-filename'),e.children.length?null:e.textContent?.trim()].includes(name)));const rows=named.filter(row=>!named.some(other=>other!==row&&row.contains(other)));if(rows.length>1)return 'many';if(!rows.length)return 'none';const row=rows[0];const id=[row,...row.querySelectorAll('[data-id]')].map(e=>e.getAttribute('data-id')).find(Boolean)||row.closest('[data-id]')?.getAttribute('data-id');if(id)return 'id:'+id;row.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,view:window}));return 'opened';})()`;
}

export async function openBrowserTimingSeeds(machine: Machine, endpoint: string, sources: readonly TimingSource[] = ['dropbox', 'google_drive']) {
  const { host, port } = parseCdpEndpoint(endpoint);
  let tunnel: Tunnel | undefined;
  let browser: BrowserSession | undefined;
  const tabs = new Set<string>();
  const scratch = mkdtempSync(join(tmpdir(), 'olympus-browser-seeds-'));
  const remote = `/tmp/olympus-browser-seeds-${crypto.randomUUID()}`;
  const folders = new Map<TimingSource, { id: string; session: string; url: string }>();
  const close = async () => {
    try {
      if (browser) for (const targetId of tabs) await browser.send('Target.closeTarget', { targetId }).catch(() => {});
    } finally {
      browser?.close(); tunnel?.close();
      rmSync(scratch, { recursive: true, force: true });
      const cleaned = await machine.exec(`rm -rf -- ${quote(remote)}`, { timeoutMs: 30_000 });
      if (cleaned.code !== 0) throw new Error('browser seed scratch cleanup failed');
    }
  };
  try {
    if (host === 'localhost' || host === '127.0.0.1') {
      if (!machine.tunnel) throw new Error('driver needs a CDP tunnel');
      tunnel = await machine.tunnel(port);
    }
    const address = tunnel ? `127.0.0.1:${tunnel.port}` : endpoint;
    const version = await (await fetch(`http://${address}/json/version`, { signal: AbortSignal.timeout(10_000) })).json() as { webSocketDebuggerUrl?: string };
    if (!version.webSocketDebuggerUrl) throw new FreshInconclusive('renew Google and Dropbox sign-in in freshBrowser (CDP unavailable)');
    browser = await connectBrowser(version.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://${address}`));
    const choosers = new Map<string, number>();
    browser.on('Page.fileChooserOpened', (event, session) => { if (session && event.backendNodeId) choosers.set(session, event.backendNodeId); });
    const rawSend = browser.send.bind(browser);
    const send = async (method: string, params: Record<string, unknown> = {}, session?: string) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([rawSend(method, params, session), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`browser seed ${method} timed out`)), 30_000);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    };
    browser.send = send;
    const evaluate = async <T>(session: string, expression: string): Promise<T> => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, session);
      if (result.exceptionDetails) throw new Error('provider page evaluation failed');
      return result.result?.value as T;
    };
    const until = async (read: () => Promise<boolean>, reason: string) => {
      const deadline = Date.now() + 120_000;
      for (;;) {
        if (await read()) return;
        if (Date.now() >= deadline) throw new Error(reason);
        await delay(1000);
      }
    };
    const attach = async (id: string) => {
      const { sessionId } = await send('Target.attachToTarget', { targetId: id, flatten: true });
      await send('Runtime.enable', {}, sessionId);
      await send('Page.enable', {}, sessionId);
      return sessionId as string;
    };
    const page = async (url: string) => {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      tabs.add(targetId);
      const session = await attach(targetId);
      await send('Page.navigate', { url }, session);
      return { id: targetId as string, session, url };
    };
    const click = async (session: string, labels: string[]) => {
      try {
        await until(() => evaluate(session, providerClickExpression(labels)), `provider control unavailable: ${labels.join(' / ')}`);
      } catch (error) {
        const shown = await evaluate<string[]>(session, PROVIDER_CONTROL_NAMES).catch(() => undefined);
        throw new Error(`provider control unavailable: ${labels.join(' / ')}${shown ? ` (menu items shown: ${JSON.stringify(shown)})` : ''}`, { cause: error });
      }
    };
    const enter = async (session: string) => {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, session);
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, session);
    };
    const fill = async (session: string, selector: string, text: string) => {
      await until(() => evaluate(session, `(() => {const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(${visible});if(!e)return false;e.focus();e.select?.();return true;})()`), 'provider text field unavailable');
      await send('Input.insertText', { text }, session);
    };
    const checkAccount = async (source: TimingSource, session: string) => {
      await until(() => evaluate(session, `document.readyState==='complete' && !!document.body?.innerText`), 'provider page did not load');
      const snap = await evaluate<any>(session, `({url:location.href,text:document.body.innerText,password:[...document.querySelectorAll('input[type=password]')].some(${visible}),accounts:0,signedOut:[...document.querySelectorAll('input[type=email],input[name=login_email]')].some(${visible})})`);
      const blocked = consentBlock(snap);
      if (blocked) throw new FreshInconclusive(`renew ${source} sign-in in freshBrowser: ${blocked}`);
      if (source === 'dropbox') await click(session, ['Account', 'Account menu', 'Open account menu', 'View account menu']);
      const accountShown = source === 'google_drive'
        ? `(() => {const e=[...document.querySelectorAll('[aria-label]')].find(e=>/^Google Account:/i.test(e.getAttribute('aria-label')||'') && (${visible})(e));return e?.getAttribute('aria-label')?.toLowerCase().split(/[^a-z0-9@.+_-]+/).includes(${JSON.stringify(TEST_ACCOUNT)}) || false;})()`
        : `(() => {const menus=[...document.querySelectorAll('[role=menu],[role=dialog],[data-testid="account-menu"]')].filter(${visible});const text=menus.length?menus.map(e=>e.innerText).join(' '):document.body.innerText;return text.toLowerCase().split(/[^a-z0-9@.+_-]+/).includes(${JSON.stringify(TEST_ACCOUNT)});})()`;
      await until(() => evaluate(session, accountShown), `browser is not verified as ${TEST_ACCOUNT} on ${source}`);
      if (source === 'dropbox') {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, session);
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, session);
      }
    };
    const openDriveFolderRow = async (session: string, name: string, ms: number) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const found = await evaluate<string>(session, driveFolderRowExpression(name));
        if (found.startsWith('id:')) {
          await send('Page.navigate', { url: `https://drive.google.com/drive/u/0/folders/${encodeURIComponent(found.slice(3))}` }, session);
          return 'opened';
        }
        if (found !== 'none' || Date.now() >= deadline) return found as 'none' | 'many' | 'opened';
        await delay(1000);
      }
    };
    const driveSearch = async (session: string, name: string) => {
      await send('Page.navigate', { url: driveFolderSearchUrl(name) }, session);
      try {
        await until(() => evaluate(session, DRIVE_SEARCH_SETTLED), 'Drive folder search did not finish');
      } catch (error) {
        const shown = await evaluate<Record<string, unknown>>(session, DRIVE_SEARCH_SNAPSHOT).catch(() => undefined);
        throw new Error(`Drive folder search did not finish${shown ? ` (${JSON.stringify(shown)})` : ''}`, { cause: error });
      }
    };
    // Read only the rendered provider listing. The seed folder is small, with at most four files.
    const listing = providerListingExpression;
    const names = async (folder: SeedFolder) => {
      const tab = folders.get(folder.source)!;
      await until(() => evaluate(tab.session, `!!document.querySelector('[role=grid], [role=table], table, [data-testid="files-table"], [data-testid="empty-folder"]') && (!${BUSY} || !!document.querySelector('[role=row],tr'))`), 'provider folder listing unavailable');
      return evaluate<string[]>(tab.session, listing(folder.source));
    };
    const ui: BrowserSeedUi = {
      folder: async (source, name) => {
        const tab = await page(source === 'dropbox' ? 'https://www.dropbox.com/home' : 'https://drive.google.com/drive/u/0/my-drive');
        folders.set(source, tab);
        await checkAccount(source, tab.session);
        // Drive's search is folder scoped after opening; use global search here to avoid a partial/virtual root listing.
        if (source === 'google_drive') {
          await driveSearch(tab.session, name);
        } else {
          // Existence is read from the top level's own listing, not from how /home/<name> looks: in run 43547436148
          // the dashboard picker, which lists the account's top level live, never showed the seed folder.
          await send('Page.navigate', { url: 'https://www.dropbox.com/home' }, tab.session);
          await until(() => evaluate(tab.session, `document.readyState==='complete' && !!document.querySelector('[role=grid],[role=table],table,[data-testid="files-table"],[data-testid="empty-folder"]') && (!${BUSY} || !!document.querySelector('[role=row],tr'))`), 'Dropbox top level did not load');
          if (await evaluate<boolean>(tab.session, dropboxRowShows(name))) {
            await send('Page.navigate', { url: `https://www.dropbox.com/home/${encodeURIComponent(name)}` }, tab.session);
            tab.url = await evaluate(tab.session, 'location.href');
            return { source, id: tab.url };
          }
        }
        const exists = source === 'google_drive' && await evaluate<boolean>(tab.session, `${listing(source)}.includes(${JSON.stringify(name)})`);
        if (!exists) {
          // Dropbox's top level has its own New folder button; its "Create" names match "Create section" too
          // (run 43563949333: the seed folder was never made at the top level).
          if (source === 'google_drive') {
            await click(tab.session, ['New', 'Create new']);
            await click(tab.session, ['New folder']);
          } else {
            await click(tab.session, ['New folder', 'Create folder']);
          }
          await fill(tab.session, '[role=dialog] input[type=text], [role=dialog] input:not([type])', name);
          await click(tab.session, ['Create']);
          // Drive's dialog closes once the folder exists; Dropbox moves on to the new folder and may leave other dialogs up.
          if (source === 'google_drive') await until(() => evaluate(tab.session, `![...document.querySelectorAll('[role=dialog]')].some(${visible})`), 'Drive new folder dialog stayed open after Create');
          if (source === 'google_drive') {
            // A folder created from a search may not be in the current result yet; rerun that search.
            await driveSearch(tab.session, name);
          }
        }
        if (source === 'google_drive') {
          // A folder made a moment ago may not be in Drive's search index yet; My Drive lists it at once.
          let opened = await openDriveFolderRow(tab.session, name, 60_000);
          if (opened === 'none') {
            await send('Page.navigate', { url: 'https://drive.google.com/drive/u/0/my-drive' }, tab.session);
            opened = await openDriveFolderRow(tab.session, name, 90_000);
          }
          if (opened !== 'opened') {
            const shown = await evaluate<Record<string, unknown>>(tab.session, drivePageSnapshot(name)).catch(() => undefined);
            throw new Error(`${opened === 'many' ? 'duplicate Drive seed folders' : 'Drive seed folder not listed in search or My Drive'}${shown ? ` (${JSON.stringify(shown)})` : ''}`);
          }
          // A new, empty folder shows Drive's empty state, not a grid: the address and a settled page are enough.
          try {
            await until(() => evaluate(tab.session, `location.pathname.includes('/folders/') && (!!document.querySelector('[role=grid]') || !(${BUSY}))`), 'Drive seed folder did not open');
          } catch (error) {
            const shown = await evaluate<Record<string, unknown>>(tab.session, drivePageSnapshot(name)).catch(() => undefined);
            throw new Error(`Drive seed folder did not open${shown ? ` (${JSON.stringify(shown)})` : ''}`, { cause: error });
          }
        } else {
          try {
            // A row, not just the name somewhere on the page (a toast, the rename box): the folder must be listed.
            // Dropbox opens a folder it has just made, so being inside it counts too (run 43574832678).
            await until(() => evaluate<boolean>(tab.session, `decodeURIComponent(location.pathname) === ${JSON.stringify(`/home/${name}`)} || ${dropboxRowShows(name)}`), 'Dropbox seed folder was not created');
          } catch (error) {
            // Test-account folder names and UI labels only: what the top level listed and where the name appears.
            const shown = await evaluate<Record<string, unknown>>(tab.session, `(() => {const name=${JSON.stringify(name)};const v=${visible};return {path: location.pathname, rows: [...document.querySelectorAll('[role=row],tr')].map(r=>(r.innerText||'').trim().split('\\n')[0].slice(0,60)).slice(0,12), nameAt: [...document.querySelectorAll('body *')].filter(e=>e.children.length===0&&(e.textContent||'').includes(name)).map(e=>[e.tagName,e.getAttribute('role'),e.closest('[role=row],tr,[role=dialog],[role=alert],[role=status],nav,header')?.tagName+'/'+(e.closest('[role]')?.getAttribute('role')||'')].join(':')).slice(0,6), inputs: [...document.querySelectorAll('input')].filter(v).map(e=>e.getAttribute('aria-label')||e.placeholder||e.type).slice(0,6), buttons: [...document.querySelectorAll('button,[role=button]')].filter(v).map(e=>(e.getAttribute('aria-label')||e.textContent||'').trim().slice(0,30)).filter(Boolean).slice(0,25), dialogs: [...document.querySelectorAll('[role=dialog],[aria-modal=true]')].filter(v).length};})()`).catch(() => undefined);
            throw new Error(`Dropbox seed folder was not created${shown ? ` (${JSON.stringify(shown)})` : ''}`, { cause: error });
          }
          await send('Page.navigate', { url: `https://www.dropbox.com/home/${encodeURIComponent(name)}` }, tab.session);
        }
        tab.url = await evaluate(tab.session, 'location.href');
        return { source, id: tab.url };
      },
      names,
      upload: async (folder, file, bytes) => {
        const tab = folders.get(folder.source)!;
        const local = join(scratch, file.name);
        writeFileSync(local, bytes);
        const made = await machine.exec(`mkdir -p ${quote(remote)}`, { timeoutMs: 30_000 });
        if (made.code !== 0) throw new Error('could not prepare browser upload scratch');
        const path = `${remote}/${file.name}`;
        await machine.put(local, path);
        choosers.delete(tab.session);
        await send('Page.setInterceptFileChooserDialog', { enabled: true }, tab.session);
        try {
          await click(tab.session, folder.source === 'google_drive' ? ['New', 'Create new'] : ['Upload', 'Upload or drop']);
          await click(tab.session, folder.source === 'google_drive' ? ['File upload'] : ['Files', 'File']);
          await until(async () => choosers.has(tab.session), 'provider file upload chooser unavailable');
          await send('DOM.setFileInputFiles', { backendNodeId: choosers.get(tab.session), files: [path] }, tab.session);
          await until(async () => (await names(folder)).includes(file.name), `upload did not appear: ${file.name}`);
        } finally { await send('Page.setInterceptFileChooserDialog', { enabled: false }, tab.session); }
      },
      native: async (folder, file) => {
        const tab = folders.get(folder.source)!;
        const baseline = new Set((await send('Target.getTargets')).targetInfos.map((t: any) => t.targetId));
        await click(tab.session, ['New', 'Create new']);
        await click(tab.session, ['Google Docs', 'Google Docs document']);
        let doc: any;
        let blankOffered = false;
        await until(async () => {
          doc = (await send('Target.getTargets')).targetInfos.find((t: any) => !baseline.has(t.targetId) && /^https:\/\/docs.google.com\/document\//.test(t.url) && (!t.openerId || t.openerId === tab.id));
          if (!doc && !blankOffered) blankOffered = await evaluate(tab.session, providerClickExpression(['Blank document']));
          return !!doc;
        }, 'native Google Doc did not open from the seed folder');
        tabs.add(doc.targetId);
        const session = await attach(doc.targetId);
        await fill(session, '.docs-title-input', file.name);
        await enter(session);
        await until(() => evaluate(session, `!!document.querySelector('.kix-appview-editor')`), 'native Docs editor unavailable');
        const box = await evaluate<{ x: number; y: number }>(session, `(() => {const r=document.querySelector('.kix-page-paginated')?.getBoundingClientRect();if(!r)throw Error();return {x:r.x+100,y:r.y+100};})()`);
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...box, button: 'left', clickCount: 1 }, session);
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...box, button: 'left', clickCount: 1 }, session);
        for (const key of file.sentence) {
          await send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key, unmodifiedText: key }, session);
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key }, session);
        }
        await until(() => evaluate(session, `[...document.querySelectorAll('[aria-label],[data-tooltip],[title]')].some(e=>/saved to drive|all changes saved/i.test([e.getAttribute('aria-label'),e.getAttribute('data-tooltip'),e.getAttribute('title')].join(' ')))`), 'native Google Doc save was not confirmed');
        await send('Target.closeTarget', { targetId: doc.targetId }); tabs.delete(doc.targetId);
        await send('Page.navigate', { url: tab.url }, tab.session);
        await until(async () => (await names(folder)).includes(file.name), 'native Google Doc did not appear in the seed folder');
      },
      close,
    };
    return browserTimingSeeds(ui, sources);
  } catch (error) { await close(); throw error; }
}
