import numpy as np,json,pickle,sys
from load import load
from sklearn.linear_model import LogisticRegression
from sklearn.neural_network import MLPClassifier
X,M=load()
judged=np.array([m['judged']=='1' and m['t35'] in('private','secure') for m in M])
y=np.array([1 if m['t35']=='secure' else 0 for m in M]); src=np.array([m['src'] for m in M])
excl=np.load('excl_mask.npy'); tr=judged&~excl
meta=json.load(open('label_meta.json'))
L=np.load('label_vec.npy'); L/=np.linalg.norm(L,axis=1,keepdims=True)
lab=np.array([1 if m['label']=='private' else 0 if m['label']=='personal' else -1 for m in meta])
rnd=np.array([m['rnd'] for m in meta]); imp=np.array([m['imp'] or '' for m in meta]); lsrc=np.array([m['src'] for m in meta])
print('label counts per round (personal,private,unsure):',{r:(int(((rnd==r)&(lab==0)).sum()),int(((rnd==r)&(lab==1)).sum()),int(((rnd==r)&(lab==-1)).sum())) for r in ('r1','r2','r3')})
print('importance among private labels:',{r:{k:int(((rnd==r)&(lab==1)&(imp==k)).sum()) for k in ('important','minor','unsure','')} for r in ('r1','r2','r3')})
rng=np.random.RandomState(1)
def fit(kind):
    a=np.where(tr)[0]
    if kind=='lr': return LogisticRegression(C=10,class_weight='balanced',max_iter=400).fit(X[a],y[a])
    # MLP: oversample minority to balance
    pos=a[y[a]==1]; neg=a[y[a]==0]; negs=rng.choice(neg,size=min(len(neg),3*len(pos)),replace=False)
    pos=rng.choice(pos,size=len(negs),replace=True); b=np.concatenate([pos,negs]); rng.shuffle(b)
    return MLPClassifier((256,),early_stopping=True,max_iter=60,random_state=0).fit(X[b],y[b])
res={}
for kind in ('lr','mlp'):
    clf=fit(kind); pickle.dump(clf,open(f'clf_{kind}.pkl','wb'))
    p=clf.predict_proba(L)[:,1]; res[kind]=p; np.save(f'pL_{kind}.npy',p)
print('trained')
