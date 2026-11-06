import numpy as np,json,pickle
meta=json.load(open('label_meta.json'))
lab=np.array([1 if m['label']=='private' else 0 if m['label']=='personal' else -1 for m in meta]); rnd=np.array([m['rnd'] for m in meta]); lsrc=np.array([m['src'].split('.')[0] for m in meta])
L=np.load('label_vec.npy'); L/=np.linalg.norm(L,axis=1,keepdims=True)
A=(lab>=0)&(rnd!='r3')
for kind in ('lr','mlp'):
    p=pickle.load(open(f'clf_{kind}.pkl','rb')).predict_proba(L)[:,1]
    print(kind)
    for kerr in (0,1):
        cov=[];errs=[];idxs=np.where(A)[0]
        for rep in range(300):
            rs=np.random.RandomState(rep); rs.shuffle(idxs); folds=np.array_split(idxs,5); c=0;e=0
            for f in range(5):
                te=folds[f]; trn=np.concatenate([folds[g] for g in range(5) if g!=f]); best=0.0
                for lo in np.sort(np.unique(p[trn])):
                    if (lab[trn][:0]).size==0 and (lab[trn[p[trn]<lo]]==1).sum()<=kerr: best=lo
                    else: break
                s=te[p[te]<best]; c+=len(s); e+=int((lab[s]==1).sum())
            cov.append(c/len(idxs)); errs.append(e)
        print(f' CV allowed {kerr} Private-called-Personal on train folds: held-out coverage {100*np.mean(cov):.1f}% (min {100*min(cov):.1f} max {100*max(cov):.1f}), held-out errors per full pass mean {np.mean(errs):.2f}')
    for s in ('telegram','gmail','dropbox','whatsapp'):
        S=A&(lsrc==s); print(' ',s,'n',int(S.sum()),'priv',int((lab[S]==1).sum()),[(lo,int((S&(p<lo)).sum()),int((S&(p<lo)&(lab==1)).sum())) for lo in (0.001,0.01,0.05,0.2)])
