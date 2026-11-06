import sys,json,os,hashlib,numpy as np
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import embed_lib as e
C=os.path.expanduser('~/.local/share/olympus-calibration/')
rounds=[('r1',C+'sample.json',C+'labels.json'),('r2',C+'round2/sample.json',C+'round2/labels.json'),('r3',C+'round3/sample.json',C+'round3/labels.final.json')]
rows=[]
for r,sp,lp in rounds:
    S={i['id']:i for i in json.load(open(sp))['items']}
    L=json.load(open(lp))['labels']
    for k,v in L.items():
        it=S[k]; rows.append(dict(rnd=r,id=k,label=v['label'],src=it.get('source','dropbox'),text=it['text'],name=it.get('name','')))
imp={}
for p in [C+'importance.json',C+'round2/importance.json',C+'round3/importance.final.json']:
    if os.path.exists(p):
        for k,v in json.load(open(p))['labels'].items(): imp[k]=v['label']
meta=[dict(rnd=r['rnd'],id=r['id'],label=r['label'],src=r['src'],imp=imp.get(r['id']),nchar=len(r['text']),
   sha=hashlib.sha256(r['text'].encode()).hexdigest()) for r in rows]
json.dump(meta,open('label_meta.json','w'))
m=e.local_embedder(threads=8)
pieces=[]  # (row, text)
for ri,r in enumerate(rows):
    t=r['text']; ch=[t[j:j+4000] for j in range(0,max(len(t),1),4000)][:3]
    for c in ch: pieces.append((ri,c))
order=sorted(range(len(pieces)),key=lambda i:len(pieces[i][1]))
vec={}
B=4
for k in range(0,len(order),B):
    idx=order[k:k+B]
    out=m.embed([e.doc(None,pieces[i][1]) for i in idx])
    for i,v in zip(idx,out): vec[i]=v
    if k%40==0: print(k,len(order),flush=True)
acc=np.zeros((len(rows),768),dtype=np.float64); n=np.zeros(len(rows))
for i,(ri,_) in enumerate(pieces): acc[ri]+=vec[i]; n[ri]+=1
acc/=n[:,None]
np.save('label_vec.npy',acc.astype(np.float32)); print('done')
