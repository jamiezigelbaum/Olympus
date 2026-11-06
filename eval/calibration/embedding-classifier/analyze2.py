import numpy as np,json,pickle,os
from load import load
X,M=load()
meta=json.load(open('label_meta.json'))
lab=np.array([1 if m['label']=='private' else 0 if m['label']=='personal' else -1 for m in meta])
rnd=np.array([m['rnd'] for m in meta]); lsrc=np.array([m['src'] for m in meta])
L=np.load('label_vec.npy'); L/=np.linalg.norm(L,axis=1,keepdims=True)
A=(lab>=0)&(rnd!='r3'); AR=(lab>=0)
print('label sources in A:',{s:(int((A&(lsrc==s)&(lab==0)).sum()),int((A&(lsrc==s)&(lab==1)).sum())) for s in set(lsrc)})
PV=np.load('probe_vec.npy'); PV/=np.linalg.norm(PV,axis=1,keepdims=True); pn=np.array(open('probe_names.txt').read().split('\n'))
T=sorted(set(pn)); sens=['health','money','legal','receipts','identity']; mund=['chitchat','links_news','logistics']
def topics(V):
    S=V@PV.T; sim=np.stack([S[:,pn==t].max(1) for t in T],1); return sim,np.array(T)[sim.argmax(1)]
simL,tL=topics(L)
# Judge-verdict set (coverage check only)
t35=np.array([m['t35'] for m in M]); jd=np.array([m['judged']=='1' for m in M]); srcs=np.array([m['src'] for m in M])
J=jd&np.isin(t35,['private','secure']); yJ=(t35=='secure')
simX,tX=topics(X[J])
print('\nTOPIC TABLE: topic | labels A n, Private n, rate | labels A+r3 n, Private | 35B-verdict set n, 35B-Private rate [coverage check] | telegram-only 35B n,rate')
yj=yJ[J]; sj=srcs[J]
for t in T:
    a=A&(tL==t); b=AR&(tL==t); x=tX==t; xt=x&(sj=='telegram')
    f=lambda n,k: f'{n:5d} {100*k/max(n,1):5.1f}%'
    print(f'{t:10s} | {f(int(a.sum()),int((lab[a]==1).sum()))} | {int(b.sum()):3d} {int((lab[b]==1).sum()):3d} | {f(int(x.sum()),int(yj[x].sum()))} | {f(int(xt.sum()),int(yj[xt].sum()))}')
print('overall    |',int(A.sum()),int((lab[A]==1).sum()),'|',len(yj),round(100*yj.mean(),1))
# mundane clearing: classifiers within mundane topics
for kind in ('lr','mlp'):
    clf=pickle.load(open(f'clf_{kind}.pkl','rb')); p=clf.predict_proba(L)[:,1]
    mm=A&np.isin(tL,mund); ss=A&np.isin(tL,sens)
    print(kind,'mundane items A:',int(mm.sum()),'Private among',int((lab[mm]==1).sum()),'| sensitive:',int(ss.sum()),'Private among',int((lab[ss]==1).sum()))
    for lo in (0.001,0.01,0.05,0.2):
        s=mm&(p<lo); print(f'   mundane settled at lo={lo}: {int(s.sum())} of {int(mm.sum())}, P->Pe {int((lab[s]==1).sum())}')
# ordering
sc_sens=simL[:,[T.index(t) for t in sens]].max(1)-simL[:,[T.index(t) for t in mund]].max(1)
def share(order_score,S,target):  # order_score desc first
    idx=np.where(S)[0]; o=idx[np.argsort(-order_score[idx])]; n=int(round(0.2*len(o))); first=o[:n]
    return int((lab[first]==target).sum()),int((lab[idx]==target).sum())
P={k:pickle.load(open(f'clf_{k}.pkl','rb')).predict_proba(L)[:,1] for k in ('lr','mlp')}
for name,S in (('A r1+r2',A),('A+r3',AR)):
    print('\nORDERING',name,'n',int(S.sum()),'first20%=',int(round(.2*S.sum())))
    k,n=share(sc_sens,S,1); print(f' sensitive-topics-first: Private in first 20% {k}/{n} = {100*k/n:.1f}%  (random 20%)')
    k,n=share(-sc_sens,S,0); print(f' mundane-topics-first (topic score only): Personal in first 20% {k}/{n} = {100*k/n:.1f}%')
    for kind in P:
        k,n=share(P[kind],S,1); print(f' {kind} Private-likely-first: Private in first 20% {k}/{n} = {100*k/n:.1f}%')
        k,n=share(-P[kind],S,0); print(f' {kind} Personal-likely-first: Personal in first 20% {k}/{n} = {100*k/n:.1f}%')
# same ordering on the 35B set (coverage check), telegram only
pj={k:pickle.load(open(f'clf_{k}.pkl','rb')).predict_proba(X[J])[:,1] for k in ('lr','mlp')}
sc=simX[:,[T.index(t) for t in sens]].max(1)-simX[:,[T.index(t) for t in mund]].max(1)
for nm,mask in (('all 35B set',np.ones(len(yj),bool)),('telegram 35B set',sj=='telegram')):
    idx=np.where(mask)[0]; n=int(.2*len(idx)); base=yj[idx].mean()
    o=idx[np.argsort(-sc[idx])][:n]; o2=idx[np.argsort(sc[idx])][:n]
    out=f'35B {nm}: n={len(idx)} Private base {100*base:.1f}%; topic sensitive-first: Private share in first 20% = {100*yj[o].sum()/yj[idx].sum():.1f}%; topic mundane-first: Personal share = {100*(~yj[o2]).sum()/(~yj[idx]).sum():.1f}%'
    for k in pj:
        o3=idx[np.argsort(-pj[k][idx])][:n]; o4=idx[np.argsort(pj[k][idx])][:n]
        out+=f' | {k}: Priv-first {100*yj[o3].sum()/yj[idx].sum():.1f}%, Pers-first {100*(~yj[o4]).sum()/(~yj[idx]).sum():.1f}%'
    print(out)
