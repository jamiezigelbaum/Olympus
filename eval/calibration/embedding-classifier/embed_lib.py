import subprocess, json, base64, numpy as np, os, sys
M=os.path.expanduser('~/Code/olympus-egemma-work/models-litert')
class Emb:
    def __init__(s, helper, library, model, cache, threads=4):
        st=dict(library=library, model=model, cacheDir=cache, threads=threads, device='cpu', maxInputTokens=2048)
        s.p=subprocess.Popen(['bun',helper,json.dumps(st)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,bufsize=1)
        r=json.loads(s.p.stdout.readline()); assert r.get('ready'), 'helper not ready'
        s.n=0
    def embed(s, texts):
        s.n+=1
        s.p.stdin.write(json.dumps({'id':s.n,'texts':texts})+'\n'); s.p.stdin.flush()
        r=json.loads(s.p.stdout.readline())
        if 'error' in r: raise RuntimeError('embed error')
        d=r['dimension']; return np.frombuffer(base64.b64decode(r['vectors']),dtype='<f4').reshape(-1,d)
def doc(title,text):
    t=(title or '').replace('\n',' ').strip() or 'none'
    return f'title: {t} | text: {text}'
def local_embedder(threads=4):
    return Emb(os.path.join(os.path.dirname(os.path.abspath(__file__)),'../../../src/workers/source-index/built-in-embedding/litert-helper.ts'), M+'/litert-lm-0.18.0-darwin-arm64/liblitert-lm.dylib', M+'/embeddinggemma-2-litert-24d962e/embeddinggemma-2-740m.litertlm', '/private/tmp/claude-501/bb-cache', threads)
