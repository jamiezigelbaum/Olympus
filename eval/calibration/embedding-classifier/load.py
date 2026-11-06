import numpy as np,csv,os
DATA=os.path.expanduser('~/bbtmp')  # where extract.py writes
def load():
    X=[];M=[]
    for s in ['telegram.messages','gmail.email','dropbox.files']:
        a=np.fromfile(f'{DATA}/{s}.f32',dtype='<f4').reshape(-1,768)
        rows=list(csv.DictReader(open(f'{DATA}/{s}.csv')))
        assert len(rows)==len(a),(s,len(rows),len(a))
        for r in rows: r['src']=s.split('.')[0]
        X.append(a);M+=rows
    X=np.vstack(X); X/=np.linalg.norm(X,axis=1,keepdims=True)+1e-9
    return X,M
