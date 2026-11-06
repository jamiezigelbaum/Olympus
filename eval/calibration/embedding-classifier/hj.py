import sqlite3,os
H=set(open(os.path.expanduser('~/bbtmp/label_hashes.txt')).read().split())
for s in ['telegram.messages','gmail.email','dropbox.files']:
    base=os.path.expanduser(f'~/.local/share/openclaw/olympus/sources/{s}/1/stores/')
    n=0
    for f in ['internal.sqlite','secure_local.sqlite']:
        c=sqlite3.connect('file:'+base+f+'?mode=ro',uri=True)
        for (h,) in c.execute("select content_hash from items where content_hash is not null"):
            if h in H: n+=1
        for (h,) in c.execute("select content_hash from chunks"):
            if h in H: n+=1
    print(s,'hash matches',n)
