import sqlite3,os,sys,random,time,array,json
MODEL='embeddinggemma-2-litert-24d962e'; J=os.environ['OLYMPUS_CALIBRATION_JUDGE_MODEL']
OUT=os.path.expanduser('~/bbtmp'); os.makedirs(OUT,mode=0o700,exist_ok=True)
def wait():
    while os.getloadavg()[0]>8: time.sleep(20)
random.seed(7)
stats={}
for src in ['telegram.messages','gmail.email','dropbox.files']:
    base=os.path.expanduser(f'~/.local/share/openclaw/olympus/sources/{src}/1/stores/')
    ro=lambda f: sqlite3.connect('file:'+base+f+'?mode=ro',uri=True)
    led=ro('secure_local.tier-ledger.sqlite')
    tier={}
    for k,c,t,st in led.execute("select provider_item_id,conversation_key,content_tier,decided_by from tier_items where model_id=? and state='current'",(J,)):
        tier[(k,c)]=(t,st)
    allled=set()
    stats[src]={'ledger35':len(tier)}
    f=open(f'{OUT}/{src}.f32','wb'); m=open(f'{OUT}/{src}.csv','w'); m.write('idx,store,t35,decby,nch,chash,judged\n')
    idx=0; cnt={}
    for store in ['internal.sqlite','secure_local.sqlite']:
        db=ro(store); cur=db.cursor(); n=0
        cur.execute("select i.item_pk,i.provider_item_id,i.normalized_conversation,i.content_hash,e.embedding from chunk_embeddings e join items i on i.item_pk=e.item_pk where e.model_id=? and i.tombstoned=0 order by i.item_pk,e.chunk_pk",(MODEL,))
        def flush(cur_item):
            global idx
            pk,pid,conv,ch,blobs=cur_item
            t=tier.get((pid,conv))
            judged = t is not None
            if not judged and src=='telegram.messages' and random.random()>0.12: return
            if not judged and src!='telegram.messages': pass
            if len(blobs)==1: raw=blobs[0]
            else:
                a=array.array('f'); a.frombytes(blobs[0])
                for b in blobs[1:]:
                    x=array.array('f'); x.frombytes(b)
                    for j in range(len(a)): a[j]+=x[j]
                nb=len(blobs)
                for j in range(len(a)): a[j]/=nb
                raw=a.tobytes()
            if len(raw)!=768*4: return
            f.write(raw)
            m.write(f"{idx},{store[:4]},{t[0] if t else ''},{t[1] if t else ''},{len(blobs)},{ch or ''},{int(judged)}\n"); idx+=1
            key=(store[:4],t[0] if t else 'none'); cnt[key]=cnt.get(key,0)+1
        curitem=None; rows=0
        for pk,pid,conv,ch,blob in cur:
            rows+=1
            if rows%20000==0: wait()
            if curitem and curitem[0]==pk: curitem[4].append(blob)
            else:
                if curitem: flush(curitem)
                curitem=[pk,pid,conv,ch,[blob]]
        if curitem: flush(curitem)
    f.close(); m.close()
    stats[src]['written']=idx; stats[src]['counts']={f'{a}/{b}':c for (a,b),c in cnt.items()}
    print(src,stats[src],flush=True)
