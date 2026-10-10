"""PII detector bake-off, step 2: run each candidate model over the exported
questions (eval/consult-pii/out/items.jsonl) and record its spans, mapped to
one category set, plus load time, per-question latency and memory.

Evaluation only. Runs on CPU by default (the engine's llama-server owns the
GPU). See eval/consult-pii/README.md for the environment.

    python eval/consult-pii/run_models.py --candidate openai-privacy-filter
    python eval/consult-pii/run_models.py --all

Writes eval/consult-pii/out/pred-<candidate>.jsonl and
eval/consult-pii/out/perf-<candidate>.json.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import resource
import statistics
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"

# --- Category mapping ---------------------------------------------------------
# Every model's labels map onto one set. Hard identifiers (the owner's ruling
# for the unnamed level): person, org (a named business is a name), location
# finer than a country, address, date, amount, id, email, phone, url, handle,
# secret. "country" and "other" are never hard.

HARD = {"person", "org", "location", "address", "date", "amount", "id", "email", "phone", "url", "handle", "secret"}

_RULES = [
    (r"^(age|gender|sex|eyecolor|height|title|prefix|occupation|jobtitle|jobdepartment|useragent|ordinaldirection|time)$", "other"),
    (r"country|nationality|nrp", "country"),
    (r"^(vin|vrm|imei|pin|macaddress|bitcoinaddress|ethereumaddress|litecoinaddress|other_pii)$", "id"),
    (r"gps", "address"),
    (r"^state$", "location"),
    (r"email", "email"),
    (r"phone|telephone|fax|mobile", "phone"),
    (r"url|website|ip_address|ipaddress", "url"),
    (r"user ?name|handle|path_user", "handle"),
    (r"password|secret|api_key|key$|token|otp|jwt|credential|recovery|cvv", "secret"),
    (r"street|address|zip|postcode|postal|building|secondaryaddress", "address"),
    (r"city|location|place|region|state_or|town|gpe|loc$|county", "location"),
    (r"money|amount|currency|price|salary|monetary", "amount"),
    (r"date|dob|birth|time|age$", "date"),
    (r"org|company|business|employer", "org"),
    (r"person|name|given|surname|first|last|middle|private_person|per$", "person"),
    (r"account|iban|bank|card|ssn|social|passport|licen|tax|id_|_id|idcard|gov|national|routing|plate|vehicle|number|socialnum|creditcard|bic|swift", "id"),
]


def category(label: str) -> str:
    clean = re.sub(r"^[BIESLU]-", "", label).lower().replace(" ", "_")
    clean = clean.replace("private_", "") if clean.startswith("private_") and clean != "private_person" else clean
    for pattern, cat in _RULES:
        if re.search(pattern, clean):
            return cat
    return "other"


# --- Adapters ---------------------------------------------------------------------
# Each returns (detect(text) -> list[{start, end, label}], repo ids for size).

GLINER_LABELS = [
    "person", "organization", "city", "location", "street address", "date", "date of birth",
    "money amount", "account number", "id number", "phone number", "email", "username",
]


def merge_token_predictions(text: str, tokens: list[dict]) -> list[dict]:
    """Token-level BIO/BIOES predictions to character spans: adjacent tokens of
    one category, joined by at most whitespace or a hyphen, merge."""
    spans: list[dict] = []
    for tok in tokens:
        label = tok["entity"]
        if label == "O":
            continue
        cat = category(label)
        start, end = tok["start"], tok["end"]
        if start is None or end is None:
            continue
        while start < end and text[start].isspace():
            start += 1
        prefix = label[:2] if re.match(r"^[BIESLU]-", label) else ""
        if spans and spans[-1]["cat"] == cat and prefix not in ("B-", "S-", "U-") and re.fullmatch(r"[\s\-'.]*", text[spans[-1]["end"]:start] or ""):
            spans[-1]["end"] = end
        else:
            spans.append({"start": start, "end": end, "label": re.sub(r"^[BIESLU]-", "", label), "cat": cat})
    return spans


def token_classifier(repo: str, **kwargs):
    from transformers import AutoModelForTokenClassification, AutoTokenizer, pipeline

    tok = AutoTokenizer.from_pretrained(repo, **kwargs)
    model = AutoModelForTokenClassification.from_pretrained(repo, **kwargs)
    model.eval()
    pipe = pipeline("token-classification", model=model, tokenizer=tok, aggregation_strategy="none", device="cpu")

    def detect(text: str):
        return merge_token_predictions(text, [{"entity": p["entity"], "start": p.get("start"), "end": p.get("end")} for p in pipe(text)])

    return detect, [repo]


def bioes_viterbi(log_probs, labels: list[str]) -> list[int]:
    """Constrained BIOES decoding (no transition scores, only the allowed
    boundary transitions), as OpenAI's opf runtime decodes Privacy Filter.
    The transformers pipeline takes a per-token argmax instead."""
    import torch

    n = len(labels)
    kind = [lab[:2] if re.match(r"^[BIES]-", lab) else "O" for lab in labels]
    ent = [lab[2:] if kind[i] != "O" else "" for i, lab in enumerate(labels)]

    def allowed(a: int, b: int) -> bool:
        ka, kb = kind[a], kind[b]
        if ka in ("B-", "I-"):
            return kb in ("I-", "E-") and ent[a] == ent[b]
        return kb in ("O", "B-", "S-")

    trans = torch.full((n, n), float("-inf"))
    for a in range(n):
        for b in range(n):
            if allowed(a, b):
                trans[a, b] = 0.0
    start = torch.tensor([0.0 if kind[i] in ("O", "B-", "S-") else float("-inf") for i in range(n)])
    end = torch.tensor([0.0 if kind[i] in ("O", "E-", "S-") else float("-inf") for i in range(n)])
    score = start + log_probs[0]
    back = []
    for t in range(1, log_probs.shape[0]):
        total = score.unsqueeze(1) + trans
        best, idx = total.max(dim=0)
        back.append(idx)
        score = best + log_probs[t]
    score = score + end
    path = [int(score.argmax())]
    for idx in reversed(back):
        path.append(int(idx[path[-1]]))
    return list(reversed(path))


def bioes_classifier(repo: str):
    """Privacy Filter family: logits, then constrained BIOES Viterbi."""
    import torch
    from transformers import AutoModelForTokenClassification, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(repo)
    model = AutoModelForTokenClassification.from_pretrained(repo)
    model.eval()
    labels = [model.config.id2label[i] for i in range(len(model.config.id2label))]

    def detect(text: str):
        enc = tok(text, return_offsets_mapping=True, return_tensors="pt")
        offsets = enc.pop("offset_mapping")[0].tolist()
        with torch.no_grad():
            logits = model(**enc).logits[0]
        path = bioes_viterbi(torch.log_softmax(logits.float(), dim=-1), labels)
        tokens = [{"entity": labels[k], "start": a, "end": b} for k, (a, b) in zip(path, offsets) if b > a]
        return merge_token_predictions(text, tokens)

    return detect, [repo]


def adapter_openai_privacy_filter():
    return bioes_classifier("openai/privacy-filter")


def adapter_openmed_multilingual():
    return bioes_classifier("OpenMed/privacy-filter-multilingual-v2")


def adapter_ai4privacy_multilingual():
    return token_classifier("ai4privacy/llama-ai4privacy-multilingual-categorical-anonymiser-openpii")


def adapter_pii_tracer():
    from transformers import AutoModel

    repo = "perplexity-ai/PII-Tracer"
    model = AutoModel.from_pretrained(repo, trust_remote_code=True)
    model.eval()

    def detect(text: str):
        spans, _sensitivity = model.predict(text)
        return [{"start": s.start, "end": s.end, "label": s.label, "cat": category(s.label)} for s in spans]

    return detect, [repo]


def _gliner(repo: str, labels=GLINER_LABELS, threshold=0.5):
    from gliner import GLiNER

    model = GLiNER.from_pretrained(repo)
    model.eval()

    def detect(text: str):
        return [{"start": e["start"], "end": e["end"], "label": e["label"], "cat": category(e["label"]), "score": round(float(e["score"]), 3)}
                for e in model.predict_entities(text, labels, threshold=threshold)]

    return detect, [repo]


def adapter_gliner_multi_pii():
    return _gliner("urchade/gliner_multi_pii-v1")


def adapter_gliner_multi_pii_onnx_fp16():
    """urchade/gliner_multi_pii-v1 exported to ONNX and converted to fp16 (no
    official ONNX exists), run with onnxruntime: the form Olympus would ship.
    Exported once into out/onnx/. Dynamic int8 quantization (onnxruntime
    quantize_dynamic, full or MatMul-only) was tried and rejected: it pushed
    every entity score under the 0.5 threshold (recall 0%)."""
    from gliner import GLiNER

    repo = "urchade/gliner_multi_pii-v1"
    target = OUT / "onnx" / "gliner_multi_pii-v1"
    fp16 = target / "model_fp16.onnx"
    if not fp16.exists():
        import onnx
        from onnxruntime.transformers.float16 import convert_float_to_float16

        GLiNER.from_pretrained(repo).export_to_onnx(target, quantize=False)
        onnx.save(convert_float_to_float16(onnx.load(str(target / "model.onnx")), keep_io_types=True), str(fp16))
    model = GLiNER.from_pretrained(str(target), load_onnx_model=True, onnx_model_file="model_fp16.onnx")

    def detect(text: str):
        return [{"start": e["start"], "end": e["end"], "label": e["label"], "cat": category(e["label"]), "score": round(float(e["score"]), 3)}
                for e in model.predict_entities(text, GLINER_LABELS, threshold=0.5)]

    return detect, []


def adapter_gliner_multi_pii_onnx_q4f16():
    """The onnx-community build of the same model, 4-bit weights with fp16
    (onnx-community/gliner_multi_pii-v1, onnx/model_q4f16.onnx, 472 MB), run
    with the exported config and tokenizer from the fp16 adapter."""
    import shutil

    from gliner import GLiNER
    from huggingface_hub import hf_hub_download

    adapter_gliner_multi_pii_onnx_fp16()  # ensures out/onnx/gliner_multi_pii-v1 holds config and tokenizer
    target = OUT / "onnx" / "gliner_multi_pii-v1"
    q4 = target / "model_q4f16.onnx"
    if not q4.exists():
        shutil.copy(hf_hub_download("onnx-community/gliner_multi_pii-v1", "onnx/model_q4f16.onnx"), q4)
    model = GLiNER.from_pretrained(str(target), load_onnx_model=True, onnx_model_file="model_q4f16.onnx")

    def detect(text: str):
        return [{"start": e["start"], "end": e["end"], "label": e["label"], "cat": category(e["label"]), "score": round(float(e["score"]), 3)}
                for e in model.predict_entities(text, GLINER_LABELS, threshold=0.5)]

    return detect, []


def adapter_knowledgator_gliner_pii_base():
    return _gliner("knowledgator/gliner-pii-base-v1.0")


def adapter_knowledgator_gliner_pii_edge():
    return _gliner("knowledgator/gliner-pii-edge-v1.0")


GLINER2_LABELS = ["person", "city", "state_or_region", "street_address", "sensitive_date", "date_of_birth", "account_number",
                  "government_id", "phone_number", "email", "username", "iban", "payment_card", "postal_code"]


def adapter_gliner2_pii():
    from gliner2 import GLiNER2

    repo = "fastino/gliner2-privacy-filter-PII-multi"
    model = GLiNER2.from_pretrained(repo)

    def detect(text: str):
        result = model.extract_entities(text, GLINER2_LABELS, threshold=0.5, include_confidence=True, include_spans=True)
        spans = []
        for label, found in (result.get("entities") or {}).items():
            for entry in found:
                if isinstance(entry, dict) and "start" in entry:
                    spans.append({"start": entry["start"], "end": entry["end"], "label": label, "cat": category(label), "score": round(float(entry.get("confidence", 0)), 3)})
        return spans

    return detect, [repo]


def adapter_scrub():
    from sporelabs_scrub import Scrub

    scrub = Scrub()

    def detect(text: str):
        return [{"start": e["start"], "end": e["end"], "label": e["type"], "cat": category(e["type"])} for e in scrub.find(text)]

    return detect, ["SporeLabs/scrub"]


def adapter_presidio():
    from presidio_analyzer import AnalyzerEngine

    engine = AnalyzerEngine()  # default: spaCy en_core_web_lg, English recognisers

    def detect(text: str):
        return [{"start": r.start, "end": r.end, "label": r.entity_type, "cat": category(r.entity_type), "score": round(float(r.score), 3)}
                for r in engine.analyze(text=text, language="en")]

    return detect, []


CANDIDATES = {
    "presidio": adapter_presidio,
    "openai-privacy-filter": adapter_openai_privacy_filter,
    "openmed-privacy-filter-multilingual": adapter_openmed_multilingual,
    "pii-tracer": adapter_pii_tracer,
    "gliner2-pii": adapter_gliner2_pii,
    "gliner-multi-pii": adapter_gliner_multi_pii,
    "gliner-multi-pii-onnx-fp16": adapter_gliner_multi_pii_onnx_fp16,
    "gliner-multi-pii-onnx-q4f16": adapter_gliner_multi_pii_onnx_q4f16,
    "knowledgator-gliner-pii-base": adapter_knowledgator_gliner_pii_base,
    "knowledgator-gliner-pii-edge": adapter_knowledgator_gliner_pii_edge,
    "ai4privacy-multilingual": adapter_ai4privacy_multilingual,
    "scrub": adapter_scrub,
}


def repo_size_mb(repos: list[str]) -> float | None:
    """Bytes the HF cache holds for these repos (the download)."""
    if not repos:
        return None
    from huggingface_hub import scan_cache_dir

    total = 0
    for repo in scan_cache_dir().repos:
        if repo.repo_id in repos:
            total += repo.size_on_disk
    return round(total / 1e6, 1)


def rss_mb() -> float:
    import psutil

    return round(psutil.Process().memory_info().rss / 1e6, 1)


def run(name: str, threads: int) -> None:
    import torch

    torch.set_num_threads(threads)
    items = [json.loads(line) for line in (OUT / "items.jsonl").read_text().splitlines() if line.strip()]
    rss_before = rss_mb()
    t0 = time.perf_counter()
    detect, repos = CANDIDATES[name]()
    load_s = time.perf_counter() - t0
    for text in ["A tenant gave short notice. Can the landlord keep the deposit?"] * 3:
        detect(text)
    times: list[float] = []
    rows = []
    for entry in items:
        start = time.perf_counter()
        spans = detect(entry["text"])
        times.append((time.perf_counter() - start) * 1000)
        rows.append({"id": entry["id"], "spans": [{**s, "text": entry["text"][s["start"]:s["end"]]} for s in spans]})
    (OUT / f"pred-{name}.jsonl").write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n")
    times_sorted = sorted(times)
    perf = {
        "candidate": name,
        "items": len(items),
        "threads": threads,
        "device": "cpu",
        "machine": "Apple M3, 24 GB (Xanthos)",
        "load_s": round(load_s, 2),
        "p50_ms": round(statistics.median(times), 1),
        "p95_ms": round(times_sorted[int(0.95 * (len(times_sorted) - 1))], 1),
        "mean_ms": round(statistics.fmean(times), 1),
        "rss_mb_loaded": rss_mb(),
        "rss_mb_before_load": rss_before,
        "peak_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6, 1),  # macOS reports bytes
        "download_mb": repo_size_mb(repos),
        "repos": repos,
    }
    (OUT / f"perf-{name}.json").write_text(json.dumps(perf, indent=2) + "\n")
    print(json.dumps(perf))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", action="append", default=[])
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--recategorize", action="store_true", help="re-map every pred file's labels after a mapping change, without rerunning models")
    args = parser.parse_args()
    if args.recategorize:
        for path in sorted(OUT.glob("pred-*.jsonl")):
            rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
            for row in rows:
                for span in row["spans"]:
                    span["cat"] = category(span["label"])
            path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n")
            print(f"recategorized {path.name}")
        return
    names = list(CANDIDATES) if args.all else args.candidate
    for name in names:
        if name not in CANDIDATES:
            sys.exit(f"unknown candidate {name}; one of {', '.join(CANDIDATES)}")
    for name in names:
        # One process per candidate keeps memory figures honest.
        if len(names) > 1:
            code = os.spawnv(os.P_WAIT, sys.executable, [sys.executable, __file__, "--candidate", name, "--threads", str(args.threads)])
            if code != 0:
                print(f"{name}: exit {code}", file=sys.stderr)
        else:
            run(name, args.threads)


if __name__ == "__main__":
    main()
