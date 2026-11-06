import numpy as np,json,sys
from load import load
from sklearn.linear_model import LogisticRegression
X,M=load()
judged=np.array([m['judged']=='1' and m['t35'] in('private','secure') for m in M])
y=np.array([1 if m['t35']=='secure' else 0 for m in M])
src=np.array([m['src'] for m in M])
L=np.load('label_vec.npy'); L=L/np.linalg.norm(L,axis=1,keepdims=True)
# near-duplicate exclusion vs labelled
S=X@L.T  # N x nl
mx=S.max(1)
for t in (0.999,0.99,0.98,0.97,0.95): print('judged items with cos>=%.3f to a label: %d'%(t,int((judged&(mx>=t)).sum())))
excl=mx>=0.98
tr=judged&~excl
print('train n',tr.sum(),'private',y[tr].sum(),'by src',{s:(int((tr&(src==s)).sum()),int(y[tr&(src==s)].sum())) for s in set(src)})
np.save('excl_mask.npy',excl)
rng=np.random.RandomState(0); idx=np.where(tr)[0]; rng.shuffle(idx); cut=int(len(idx)*.9)
a,b=idx[:cut],idx[cut:]
from sklearn.metrics import roc_auc_score
for C in (1,10,100):
    clf=LogisticRegression(C=C,class_weight='balanced',max_iter=300)
    clf.fit(X[a],y[a]); p=clf.predict_proba(X[b])[:,1]
    print('LR C',C,'holdout AUC vs 35B (sanity only)',round(roc_auc_score(y[b],p),4))
    import pickle; pickle.dump(clf,open(f'lr_C{C}.pkl','wb'))
