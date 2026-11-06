import numpy as np,json,pickle,glob,os
from load import load
X,M=load()
C=os.path.expanduser('~/.local/share/olympus-calibration/')
meta=json.load(open('label_meta.json'))
lab=np.array([1 if m['label']=='private' else 0 if m['label']=='personal' else -1 for m in meta])
rnd=np.array([m['rnd'] for m in meta]); imp=np.array([m['imp'] or '' for m in meta]); ids=[m['id'] for m in meta]
L=np.load('label_vec.npy'); L/=np.linalg.norm(L,axis=1,keepdims=True)
# 35B verdicts
j35={}
for p in [C+'judge-decision-2026-11-05T15-39-10-635Z.json',C+'round2/judge-decision-2026-11-05T15-40-42-529Z.json']:
    for r in json.load(open(p))['rows']: j35[r['id']]=1 if r['judge']=='private' else 0
has35=np.array([i in j35 for i in ids]); v35=np.array([j35.get(i,-1) for i in ids])
A=(lab>=0)&(rnd!='r3'); R3=(lab>=0)&(rnd=='r3')
print('A n',A.sum(),'priv',lab[A].sum(),'| r3 n',R3.sum(),'priv',lab[R3].sum(),'| A with 35B',(A&has35).sum())
def cm(y,pred): # rows true personal/private ; cols called personal/private
    return [[int(((y==0)&(pred==0)).sum()),int(((y==0)&(pred==1)).sum())],[int(((y==1)&(pred==0)).sum()),int(((y==1)&(pred==1)).sum())]]
print('35B vs labels, A&has35: [[Pe->Pe,Pe->P],[P->Pe,P->P]]',cm(lab[A&has35],v35[A&has35]))
for r in ('r1','r2'):
    k=(rnd==r)&(lab>=0)&has35; print('  35B',r,cm(lab[k],v35[k]),'n',k.sum())
k=A&has35&(lab==1)&(v35==0); print('  35B important misses',int((imp[k]=='important').sum()),'minor',int((imp[k]=='minor').sum()),'unsure/other',int(((imp[k]!='important')&(imp[k]!='minor')).sum()))
for kind in ('lr','mlp'):
    p=pickle.load(open(f'clf_{kind}.pkl','rb')).predict_proba(L)[:,1]
    print('\n==',kind)
    for name,S in (('A r1+r2',A),('r3',R3)):
        pred=(p>=0.5).astype(int)
        print(name,'@0.5 [[Pe->Pe,Pe->P],[P->Pe,P->P]]',cm(lab[S],pred[S]))
        k=S&(lab==1)&(pred==0); print('   P->Pe important',int((imp[k]=='important').sum()),'minor',int((imp[k]=='minor').sum()),'other',int(k.sum()-(imp[k]=='important').sum()-(imp[k]=='minor').sum()))
    # threshold table, set A, lo = settle Personal if p<lo ; hi = settle Private if p>=hi
    print('lo-threshold table (set A; settle Personal if p<lo). cols: lo, settled, cov%all, cov%Personal, P->Pe (imp/minor), Pe->Pe | 35B on same settled: matrix(Pe true: [Pe,P], P true:[Pe,P]) [only items with 35B]')
    for lo in (0.001,0.003,0.01,0.02,0.05,0.1,0.2,0.3,0.5):
        s=A&(p<lo); e=s&(lab==1)
        s35=s&has35
        print(f' {lo:<6} settled {int(s.sum()):3d} cov {100*s.sum()/A.sum():5.1f}% covPe {100*(s&(lab==0)).sum()/(A&(lab==0)).sum():5.1f}% P->Pe {int(e.sum())} (imp {int((e&(imp=="important")).sum())}/min {int((e&(imp=="minor")).sum())}) | 35B on settled: {cm(lab[s35],v35[s35])} n={int(s35.sum())}')
    print('hi-threshold table (settle Private if p>=hi): hi, called, Pe->P errors, true P, 35B on same')
    for hi in (0.5,0.7,0.8,0.9,0.95,0.99):
        s=A&(p>=hi); s35=s&has35
        print(f' {hi:<5} called {int(s.sum()):3d} Pe->P {int((s&(lab==0)).sum())} P ok {int((s&(lab==1)).sum())} | 35B same: {cm(lab[s35],v35[s35])}')
    # r3
    print('r3 lo table:',[(lo,int((R3&(p<lo)).sum()),int((R3&(p<lo)&(lab==1)).sum())) for lo in (0.01,0.05,0.1,0.2,0.3,0.5)])
    # cross-validated threshold choice (repeat)
    for kerr in (0,1):
        cov=[];errs=[]
        idxs=np.where(A)[0]
        for rep in range(200):
            rs=np.random.RandomState(rep); rs.shuffle(idxs); folds=np.array_split(idxs,5); c=0;e=0
            for f in range(5):
                te=folds[f]; trn=np.concatenate([folds[g] for g in range(5) if g!=f])
                best=0.0
                for lo in np.unique(p[trn]):
                    if lo<=0: continue
                    s=trn[p[trn]<lo]
                    if (lab[s]==1).sum()<=kerr*0.8 : best=max(best,lo)  # scaled allowance on 4/5 data
                    else: break
                s=te[p[te]<best]; c+=len(s); e+=int((lab[s]==1).sum())
            cov.append(c/len(idxs)); errs.append(e)
        print(f'CV (5-fold x200, train-fold budget {kerr*0.8} errors, i.e. 0 for k=0/1): coverage mean {100*np.mean(cov):.1f}% (range {100*min(cov):.1f}-{100*max(cov):.1f}), held-out P->Pe mean {np.mean(errs):.2f}')
    # Telegram: p over embedded telegram vectors
    clf=pickle.load(open(f'clf_{kind}.pkl','rb'))
    tel=np.array([m['src']=='telegram' for m in M]); jd=np.array([m['judged']=='1' for m in M]); t35=np.array([m['t35'] for m in M])
    pt=clf.predict_proba(X[tel])[:,1]; jt=jd[tel]; tt=t35[tel]
    for lo in (0.003,0.01,0.05,0.1,0.2):
        print(f' telegram lo={lo}: unjudged-embedded sample n={int((~jt).sum())} settled {100*(pt[~jt]<lo).mean():.1f}% | judged n={int(jt.sum())} settled {100*(pt[jt]<lo).mean():.1f}% (of which 35B-Private among settled: {int(((pt<lo)&jt&(tt=="secure")).sum())} of {int(((pt<lo)&jt).sum())}) ')
