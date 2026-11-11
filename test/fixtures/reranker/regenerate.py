"""Regenerate expected ids with Python tokenizers==0.22.1; no downloads.

python regenerate.py unigram unigram.json
python regenerate.py mmarco /tmp/path/to/pinned/tokenizer.json
Run from any directory; relative tokenizer paths are relative to the caller.
"""
import hashlib
import json
from pathlib import Path
import sys
import tokenizers

assert tokenizers.__version__ == '0.22.1', 'Use the reference version: tokenizers==0.22.1'
name, tokenizer_path = sys.argv[1:]
reference_path = Path(__file__).parent / f'{name}-reference.json'
reference = json.loads(reference_path.read_text())
tokenizer_bytes = Path(tokenizer_path).read_bytes()
tokenizer = tokenizers.Tokenizer.from_str(tokenizer_bytes.decode())
for case in reference['cases']:
    tokenizer.no_padding()
    tokenizer.no_truncation()
    full = tokenizer.encode(case['first'], case['second'])
    tokenizer.enable_truncation(case['maxLength'], strategy='longest_first', direction='right')
    encoding = tokenizer.encode(case['first'], case['second'])
    case.update(ids=encoding.ids, typeIds=encoding.type_ids, truncated=len(full.ids) > case['maxLength'])
reference['tokenizerSha256'] = hashlib.sha256(tokenizer_bytes).hexdigest()
reference_path.write_text(json.dumps(reference, ensure_ascii=False, indent=2) + '\n')
