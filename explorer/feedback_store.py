"""
Storage, access keys, validation, results and research exports for the INPACT consultation.

Responses are validated against the questionnaire in ``feedback_survey.py`` (each
respondent group has its own, with the routing of Section 13.1 of the instrument) and
appended, one JSON object per line, to ``responses.jsonl`` in ``FEEDBACK_DIR`` (default
``data/feedback/`` in the project, kept out of Git; on the AWS server
``/var/lib/inpact/feedback``). An append-only JSON Lines file is simple, safe with
several gunicorn workers (each line is written under a file lock), easy to back up, and
keeps every answer exactly as given.

Stored with each response (Section 13.6): the answers, the submission date (no time),
the questionnaire version, the completion time, the device type, the group, the public
form (A/B), the random survey code kept in the browser and the reference code shown to
the respondent (for withdrawal). Not stored: IP address, precise timestamps, user agent.

The survey code and the reference code are deleted one week after submission
(``CONFIRM["code_days"]``): respondents can withdraw within that week, and their answers
are anonymised from then on. ``purge_expired_codes`` runs whenever responses are saved
or read, so no code is kept longer than promised.

The research export (Excel and CSV) follows the codebook conventions of Appendix A:

    README     version, export time, counts, coding conventions
    Data       one row per response of the current version, one column per variable:
               grids one column per row, multiple choice one 0/1 column per option,
               the policy module as C*_[p] with p = 1-3 in presentation order;
               substantive codes 1..n, non-substantive codes 92-99, -1 = not shown,
               -2 = shown but not answered (I1: 91 and 90)
    Codebook   every column: item, wording, groups shown, codes
    Earlier    responses to earlier questionnaire versions (raw answers as JSON)

Environment variables
---------------------
FEEDBACK_DIR                folder for responses.jsonl (created if missing)
FEEDBACK_ADMIN_KEY          research-team key for the downloads (disabled while unset)
FEEDBACK_KEY_STAKEHOLDER    access keys of the four keyed groups. A group whose key is
FEEDBACK_KEY_RESEARCHER     unset cannot be chosen.
FEEDBACK_KEY_EXPERT
FEEDBACK_KEY_POLICYMAKER
FEEDBACK_MIN_CELL           a group's answers are shown in the results only from this many
                            responses (default 5, Section 14.2)
FEEDBACK_RESULTS_OPEN       "1" once fieldwork has closed: only then are the aggregated
                            results shown to the professional groups (Section 11.3)
"""
from __future__ import annotations

import csv
import hmac
import io
import json
import os
import re
import secrets
import threading
import time
import uuid
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill

from . import feedback_survey as survey

try:                                    # Linux (the server): a real cross-process lock
    import fcntl
except ImportError:                     # Windows (local development)
    fcntl = None

BASE_DIR = Path(__file__).resolve().parent.parent
POLICIES_CSV = BASE_DIR / "data" / "policies.csv"
_LOCK = threading.Lock()
OTHER_MAX = 200
REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"       # no 0/O, 1/I: easy to read back


# ---------------------------------------------------------------------------
# Configuration and files
# ---------------------------------------------------------------------------
def feedback_dir() -> Path:
    d = Path(os.environ.get("FEEDBACK_DIR", BASE_DIR / "data" / "feedback"))
    d.mkdir(parents=True, exist_ok=True)
    return d


def responses_path() -> Path:
    return feedback_dir() / "responses.jsonl"


def admin_key() -> str:
    return os.environ.get("FEEDBACK_ADMIN_KEY", "").strip()


def min_cell() -> int:
    try:
        return max(1, int(os.environ.get("FEEDBACK_MIN_CELL", "5")))
    except ValueError:
        return 5


def results_open() -> bool:
    return os.environ.get("FEEDBACK_RESULTS_OPEN", "").strip().lower() in ("1", "true", "yes", "on")


def _norm_key(k) -> str:
    return re.sub(r"[^A-Z0-9]", "", str(k or "").upper())


def group_key(group: str) -> str:
    return _norm_key(os.environ.get(f"FEEDBACK_KEY_{group.upper()}", ""))


def check_group_key(group: str, given) -> bool:
    """True when ``given`` is the access key of ``group`` (case, spaces and dashes ignored)."""
    if group not in survey.KEYED_GROUPS:
        return False
    key = group_key(group)
    return bool(key) and hmac.compare_digest(_norm_key(given).encode(), key.encode())


def find_group_for_key(given):
    """The keyed group whose key this is, or None."""
    return next((g for g in survey.KEYED_GROUPS if check_group_key(g, given)), None)


def _policy_index() -> dict:
    """The dashboard's policies (data/policies.csv) by name."""
    out = {}
    try:
        with POLICIES_CSV.open(newline="", encoding="utf-8-sig") as fh:
            for row in csv.DictReader(fh):
                name = (row.get("name") or "").strip()
                year = (row.get("year") or "").strip()
                if name and year and not year.startswith("#"):
                    out[name] = {"year": year, "level": (row.get("level") or "").strip(),
                                 "sector": (row.get("sector") or "").strip()}
    except FileNotFoundError:
        pass
    return out


# ---------------------------------------------------------------------------
# Validation: keep only answers that match the group's questionnaire and routing
# ---------------------------------------------------------------------------
class InvalidResponse(ValueError):
    pass


def _clean_text(v, max_len) -> str:
    s = str(v or "").replace("\r\n", "\n").strip()
    s = "".join(ch for ch in s if ch == "\n" or ch == "\t" or ord(ch) >= 32)
    return s[:max_len]


def _clean_scale(v, q):
    if v in (None, ""):
        return None
    if isinstance(v, str) and v in (q.get("na") or []):
        return v
    if isinstance(v, bool):
        return None
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None
    s = q["scale"]
    return n if s["min"] <= n <= s["max"] else None


def _clean_multi(v, codes, q):
    if not isinstance(v, list):
        return None
    seen = []
    for c in v:
        if c in codes and c not in seen:
            seen.append(c)
    excl = [c for c in seen if c in q.get("exclusive", [])]
    if excl and len(seen) > 1:                      # an exclusive answer stands alone
        seen = excl[:1]
    return seen[: q.get("max", len(codes))] or None


def _clean_matrix(v, q, rows):
    if not isinstance(v, dict):
        return None
    out = {}
    for code, _ in rows:
        s = _clean_scale(v.get(code), q)
        if s is not None:
            out[code] = s
    return out or None


def _perm(v, codes):
    """A stored presentation order: a permutation of ``codes``, else None."""
    return list(v) if isinstance(v, list) and sorted(map(str, v)) == sorted(codes) else None


def _clean_value(q, v, answers, group, raw_answers):
    """Clean one answer of a simple question type; returns (value, extra answers)."""
    t, extra = q["type"], {}
    if t == "single":
        codes = [c for c, _ in survey.options_for(q, answers, group)]
        val = v if v in codes else None
        if val is not None and q.get("other") == val:
            txt = _clean_text(raw_answers.get(q["id"] + "_other"), OTHER_MAX)
            if txt:
                extra[q["id"] + "_other"] = txt
        return val, extra
    if t == "multi":
        codes = [c for c, _ in survey.options_for(q, answers, group)]
        val = _clean_multi(v, codes, q)
        if val and q.get("other") in val:
            txt = _clean_text(raw_answers.get(q["id"] + "_other"), OTHER_MAX)
            if txt:
                extra[q["id"] + "_other"] = txt
        return val, extra
    if t == "scale":
        return _clean_scale(v, q), extra
    if t == "matrix":
        return _clean_matrix(v, q, survey.dynamic_rows(q, answers)), extra
    if t == "consents":
        if not isinstance(v, list):
            return None, extra
        codes = [c for c, _ in q["rows"]]
        val = [c for c in codes if c in v]
        return val or None, extra
    if t == "text":
        return _clean_text(v, q.get("max_len", 1000)) or None, extra
    return None, extra


def _clean_pickgrid(q, v):
    if not isinstance(v, dict):
        return None
    codes = [c for c, _ in q["options"]]
    picked = []
    for c in v.get("picked") or []:
        if c in codes and c not in picked:
            picked.append(c)
    picked = picked[: q.get("max", 3)]
    ratings = {}
    for c in picked:
        m = _clean_matrix((v.get("ratings") or {}).get(c), q, q["rows"])
        if m:
            ratings[c] = m
    return {"picked": picked, "ratings": ratings} if picked else None


def _clean_policy_items(q, entry, missing, title):
    """The C1-C12 answers for one policy. C1 is required; "not at all familiar" skips the rest."""
    out = {}
    fam_q = q["items"][0]
    fam = _clean_scale(entry.get(fam_q["id"]), fam_q)
    if fam is None:
        missing.append(f"C1 ({title})")
        return out
    out[fam_q["id"]] = fam
    if fam == fam_q["scale"]["min"]:
        return out
    for it in q["items"][1:]:
        val, _ = _clean_value(it, entry.get(it["id"]), {}, None, {})
        if val is not None:
            out[it["id"]] = val
    return out


def _clean_policies3(q, v, missing):
    refs = {r["code"]: r for r in q["refs"]}
    entries = v if isinstance(v, list) else []
    order = [e.get("ref") for e in entries[:2] if isinstance(e, dict)]
    if sorted(o for o in order if o) != sorted(refs):
        order = [r["code"] for r in q["refs"]]           # no valid order sent: keep the listed order
        entries = [next((e for e in entries if isinstance(e, dict) and e.get("ref") == c), {}) for c in order] + \
            [e for e in entries if isinstance(e, dict) and not e.get("ref")]
    out = []
    for p, code in enumerate(order):
        entry = entries[p] if p < len(entries) and isinstance(entries[p], dict) else {}
        item = {"ref": code, "policy": refs[code]["title"]}
        item.update(_clean_policy_items(q, entry, missing, refs[code]["title"]))
        out.append(item)
    own = None if q.get("own") is False else \
        next((e for e in entries[2:] if isinstance(e, dict) and e.get("policy")), None)
    if own:
        index = _policy_index()
        prefixes = tuple(r.get("exclude_prefix") or r["timeline"] for r in q["refs"])
        name = str(own.get("policy"))
        if name in index and not name.startswith(prefixes):       # the reference policies cannot be chosen again
            item = {"ref": None, "policy": name}
            item.update(_clean_policy_items(q, own, missing, name))
            out.append(item)
    return out


def clean_response(raw: dict) -> dict:
    """Validate a submission. Returns {"answers", "form", "orders"}. Raises InvalidResponse."""
    if not isinstance(raw, dict):
        raise InvalidResponse("The submission is not in the expected format.")
    answers_in = raw.get("answers") if isinstance(raw.get("answers"), dict) else {}
    group = answers_in.get("group")
    if group not in survey.GROUP_CODES:
        raise InvalidResponse("Please choose the perspective you are answering from.")
    form = raw.get("form") if group == "public" else None
    if group == "public" and form not in survey.FORMS:
        raise InvalidResponse("The survey form is missing. Please reload the page and try again.")
    orders_in = raw.get("orders") if isinstance(raw.get("orders"), dict) else {}
    answers, missing, orders = {"group": group}, [], {}
    for _, q in survey.questions(group):
        qid, t = q["id"], q["type"]
        if t == "group" or not survey.visible(q, answers, form):
            if qid == "S3b_main_sector" and len(answers.get("S3_sector") or []) == 1:
                answers[qid] = answers["S3_sector"][0]              # filled in automatically (Section 13.1)
            continue
        v = answers_in.get(qid)
        if t == "pickgrid":
            val = _clean_pickgrid(q, v)
        elif t == "policies3":
            val = _clean_policies3(q, v, missing)
        else:
            val, extra = _clean_value(q, v, answers, group, answers_in)
            answers.update(extra)
        if val not in (None, False, []):
            answers[qid] = val
        if t == "consents" and q.get("required"):
            if len(answers.get(qid) or []) < len(q["rows"]):
                missing.append(q["label"].split(".")[0] + " (all statements)")
        elif q.get("required") and val in (None, False, []):
            missing.append(q["label"].split(".")[0])
        if q.get("randomize"):
            orders[qid] = _perm(orders_in.get(qid), [c for c, _ in q["rows"]])
        if q.get("randomize_first"):
            first = [c for c, _ in q["options"][: q["randomize_first"]]]
            orders[qid] = _perm(orders_in.get(qid), first)
    if missing:
        raise InvalidResponse("Please answer the required questions: " + "; ".join(missing[:4]))
    return {"answers": answers, "form": form, "orders": orders}


# ---------------------------------------------------------------------------
# Saving
# ---------------------------------------------------------------------------
def new_reference() -> str:
    code = "".join(secrets.choice(REF_ALPHABET) for _ in range(8))
    return code[:4] + "-" + code[4:]


class _FileLock:
    """Serialises writers of responses.jsonl, across threads and gunicorn workers. A separate
    lock file is used, because purging codes replaces responses.jsonl with a new file."""

    def __enter__(self):
        _LOCK.acquire()
        self.fh = (feedback_dir() / "responses.lock").open("a")
        if fcntl:
            fcntl.flock(self.fh, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        try:
            if fcntl:
                fcntl.flock(self.fh, fcntl.LOCK_UN)
            self.fh.close()
        finally:
            _LOCK.release()


def _code_expired(rec, today) -> bool:
    try:
        d = datetime.strptime(str(rec.get("submitted_date") or rec.get("submitted_utc") or "")[:10], "%Y-%m-%d")
    except ValueError:
        return True                                  # no usable date: do not keep the codes
    return (today - d.date()).days >= int(survey.CONFIRM.get("code_days", 7))


def purge_expired_codes() -> int:
    """Delete the survey and reference codes of responses submitted a week or more ago. Returns how many."""
    path = responses_path()
    if not path.exists():
        return 0
    today = datetime.now(timezone.utc).date()
    with _FileLock():
        lines = path.read_text(encoding="utf-8").splitlines()
        changed, out = 0, []
        for line in lines:
            try:
                rec = json.loads(line) if line.strip() else None
            except ValueError:
                rec = None
            if rec and (rec.get("client_id") or rec.get("reference_code")) and _code_expired(rec, today):
                rec["client_id"] = None
                rec["reference_code"] = None
                rec["codes_deleted"] = today.isoformat()
                line = json.dumps(rec, ensure_ascii=False)
                changed += 1
            out.append(line)
        if changed:
            tmp = path.with_suffix(".tmp")
            with tmp.open("w", encoding="utf-8") as fh:
                fh.write("\n".join(out) + "\n")
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, path)
    return changed


def save_response(raw: dict, meta: dict) -> dict:
    """Validate and store one response. Returns {"ok": True, "response_id", "reference"}."""
    clean = clean_response(raw)
    answers = clean["answers"]
    now = datetime.now(timezone.utc)
    try:
        started_dt = datetime.fromisoformat(str(raw.get("started_at")).replace("Z", "+00:00"))
        duration = max(0, int((now - started_dt).total_seconds()))
    except (TypeError, ValueError):
        duration = None
    client = re.sub(r"[^A-Za-z0-9-]", "", str(raw.get("client_id") or ""))[:40]
    record = {
        "response_id": uuid.uuid4().hex[:12],
        "reference_code": new_reference(),     # shown once to the respondent; used only to withdraw
        "survey_version": survey.SURVEY_VERSION,
        "group": answers["group"],
        "form": clean["form"],
        "key_verified": answers["group"] in survey.KEYED_GROUPS,
        "submitted_date": now.strftime("%Y-%m-%d"),
        "duration_s": duration,
        "client_id": client or None,          # random survey code kept in the browser: flags repeat submissions
        "device": meta.get("device"),
        "orders": clean["orders"],
        "answers": answers,
    }
    line = json.dumps(record, ensure_ascii=False) + "\n"
    purge_expired_codes()
    with _FileLock():
        with responses_path().open("a", encoding="utf-8") as fh:
            fh.write(line)
            fh.flush()
            os.fsync(fh.fileno())
    _SUMMARY_CACHE["t"] = 0
    return {"ok": True, "response_id": record["response_id"], "reference": record["reference_code"]}


def load_responses() -> list[dict]:
    purge_expired_codes()
    path = responses_path()
    if not path.exists():
        return []
    out = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except ValueError:
                continue                        # a damaged line never blocks the rest
            r.setdefault("group", (r.get("answers") or {}).get("group") or "public")
            r.setdefault("submitted_date", (r.get("submitted_utc") or "")[:10] or None)
            out.append(r)
    return out


# ---------------------------------------------------------------------------
# Results (professional groups, once fieldwork has closed): counts by group, never single answers
# ---------------------------------------------------------------------------
_SUMMARY_CACHE = {"t": 0, "data": None}


def _counts(vals):
    """{c: substantive counts, ns: non-substantive counts, a: answered}"""
    c, ns = Counter(), Counter()
    for v in vals:
        if isinstance(v, str) and v in survey.NS:
            ns[v] += 1
        else:
            c[str(v)] += 1
    out = {"c": dict(c), "a": len(vals)}
    if ns:
        out["ns"] = dict(ns)
    return out


def _agg(q, values):
    """Counts for one question over a list of answers (None = not answered)."""
    t = q["type"]
    vals = [v for v in values if v not in (None, [], {})]
    if t in ("scale", "single"):
        return _counts(vals)
    if t == "multi":
        return {"c": dict(Counter(code for v in vals for code in v)), "a": len(vals)}
    if t == "matrix":
        rows = {}
        for code, _ in q["rows"]:
            rv = [v[code] for v in vals if code in v]
            if rv:
                rows[code] = _counts(rv)
        return {"rows": rows, "a": len(vals)}
    if t == "pickgrid":
        tech = {}
        for v in vals:
            for code in v.get("picked", []):
                x = tech.setdefault(code, {"n": 0, "rows": defaultdict(list)})
                x["n"] += 1
                for row, s in (v.get("ratings", {}).get(code) or {}).items():
                    x["rows"][row].append(s)
        return {"t": {k: {"n": x["n"], "rows": {r: _counts(s) for r, s in x["rows"].items()}} for k, x in tech.items()},
                "a": len(vals)}
    if t == "policies3":
        pol = {}
        for v in vals:
            for it in v:
                key = it.get("ref") or it.get("policy")
                p = pol.setdefault(key, {"n": 0, "ref": bool(it.get("ref")), "name": it.get("policy"),
                                         "items": defaultdict(list)})
                p["n"] += 1
                for item in q["items"]:
                    if item["type"] == "scale" and item["id"] in it:
                        p["items"][item["id"]].append(it[item["id"]])
        return {"p": {k: {"n": x["n"], "ref": x["ref"], "name": x["name"],
                          "items": {i: _counts(s) for i, s in x["items"].items()}} for k, x in pol.items()},
                "a": len(vals)}
    return None


def _median(xs):
    xs = sorted(xs)
    return xs[len(xs) // 2] if xs else None


def summary() -> dict:
    if time.time() - _SUMMARY_CACHE["t"] < 60 and _SUMMARY_CACHE["data"]:
        return _SUMMARY_CACHE["data"]
    rows = [r for r in load_responses() if r.get("survey_version") == survey.SURVEY_VERSION]
    by_group = defaultdict(list)
    for r in rows:
        by_group[r["group"]].append(r)
    need = min_cell()
    timeline = defaultdict(Counter)
    for r in rows:
        timeline[r.get("submitted_date") or ""][r["group"]] += 1
    data = {
        "n": len(rows), "min_cell": need, "version": survey.SURVEY_VERSION,
        "updated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "groups": {g: len(by_group.get(g, [])) for g in survey.GROUP_CODES},
        "timeline": {d: dict(c) for d, c in sorted(timeline.items()) if d},
        "median_duration_s": _median([r["duration_s"] for r in rows if isinstance(r.get("duration_s"), int)]),
        "q": {},
    }
    for g in survey.GROUP_CODES:
        grs = by_group.get(g, [])
        if len(grs) < need:                     # too few to show without identifying anyone
            continue
        A = [r.get("answers", {}) for r in grs]
        for _, q in survey.questions(g):
            if q["type"] in ("text", "consents", "group"):
                continue
            agg = _agg(q, [a.get(q["id"]) for a in A])
            if agg is not None and agg.get("a"):
                data["q"].setdefault(q["id"], {})[g] = agg
    _SUMMARY_CACHE.update(t=time.time(), data=data)
    return data


# ---------------------------------------------------------------------------
# Research export (Appendix A)
# ---------------------------------------------------------------------------
def _num(n, width):
    return str(n).zfill(width)


def _w(seq):
    return 2 if len(seq) > 9 else 1


def _code_single(q, v):
    """Numeric code of a single-choice answer: 1..n for substantive options, 92-99 for the others."""
    if v in survey.NS_NUM:
        return survey.NS_NUM[v]
    subst = [c for c, _ in q["options"] if c not in survey.NS_NUM]
    return subst.index(v) + 1 if v in subst else None


def _code_scale(v):
    return survey.NS_NUM.get(v, v) if isinstance(v, str) else v


def _single_labels(q):
    subst = [(c, l) for c, l in q["options"] if c not in survey.NS_NUM]
    out = [f"{i + 1} = {l}" for i, (_, l) in enumerate(subst)]
    out += [f"{survey.NS_NUM[c]} = {l}" for c, l in q["options"] if c in survey.NS_NUM]
    return "; ".join(out)


def _scale_labels(q):
    s = q["scale"]
    pts = [f"{k} = {v}" if v else str(k) for k, v in s["labels"].items()]
    pts += [f"{survey.NS_NUM[c]} = {survey.NS[c]}" for c in q.get("na") or []]
    return "; ".join(pts)


class _Col:
    __slots__ = ("name", "item", "label", "codes", "get", "groups")

    def __init__(self, name, item, label, codes, get, groups):
        self.name, self.item, self.label, self.codes, self.get, self.groups = name, item, label, codes, get, groups


def _columns():
    """Every export column, in questionnaire order (Appendix A)."""
    cols, done = [], set()

    def add(name, item, label, codes, get, groups):
        if name not in done:
            done.add(name)
            cols.append(_Col(name, item, label, codes, get, groups))

    for _, q, groups, wordings in survey.variables():
        qid, t = q["id"], q["type"]
        item = qid.split("_")[0]
        label = " | ".join(survey.fill(w) for w in wordings)
        g = ", ".join(groups)
        miss = survey.MISSING_I1 if qid == "I1_int" else (survey.MISSING_NOT_SHOWN, survey.MISSING_NO_ANSWER)
        if t == "group":
            continue
        if t == "single":
            add(qid, item, label, _single_labels(q), lambda a, q=q: _code_single(q, a.get(q["id"])), g)
            if q.get("other"):
                add(qid + "_other", item, label + " (please specify)", "text", lambda a, q=q: a.get(q["id"] + "_other"), g)
        elif t == "multi":
            w = _w(q["options"])
            for i, (code, olab) in enumerate(q["options"], 1):
                add(f"{qid}_{_num(i, w)}", item, f"{label}: {olab}", "0 = not chosen; 1 = chosen",
                    lambda a, q=q, code=code: (1 if code in a[q["id"]] else 0) if q["id"] in a else None, g)
            if q.get("other"):
                add(qid + "_other", item, label + " (please specify)", "text", lambda a, q=q: a.get(q["id"] + "_other"), g)
        elif t == "scale":
            add(qid, item, label, _scale_labels(q), lambda a, q=q: _code_scale(a.get(q["id"])), g)
        elif t in ("matrix", "consents"):
            w = _w(q["rows"])
            for i, (code, rlab) in enumerate(q["rows"], 1):
                if t == "consents":
                    add(f"{qid}_{_num(i, w)}", item, f"{label}: {survey.fill(rlab)}", "0 = not ticked; 1 = ticked",
                        lambda a, q=q, code=code: 1 if code in (a.get(q["id"]) or []) else 0, g)
                else:
                    add(f"{qid}_{_num(i, w)}", item, f"{label}: {rlab}", _scale_labels(q),
                        lambda a, q=q, code=code: _code_scale((a.get(q["id"]) or {}).get(code)), g)
            if q.get("randomize"):
                add(qid + "_order", item, label + " (presentation order of the rows)", "row numbers, comma separated",
                    None, g)
        elif t == "text":
            add(qid, item, label, "text", lambda a, q=q: a.get(q["id"]), g)
        elif t == "pickgrid":
            for i, (tc, tl) in enumerate(q["options"], 1):
                for j, (rc, rl) in enumerate(q["rows"], 1):
                    add(f"{qid}_{i}_{j}", item, f"{label}: {tl}: {rl}", _scale_labels(q),
                        lambda a, q=q, tc=tc, rc=rc: _code_scale(((a.get(q["id"]) or {}).get("ratings", {})
                                                                  .get(tc) or {}).get(rc)), g)
        elif t == "policies3":
            for p in range(1, N_POLICIES + 1):
                add(f"C0_policyid_{p}", "C0", "Policy shown (reference code or dashboard title)", "text", None, g)
                add(f"C0_reference_{p}", "C0", "Reference policy", "1 = reference policy; 0 = own choice", None, g)
                add(f"C0_order_{p}", "C0", "Presentation order", "1-3", None, g)
                for it in _all_policy_items():
                    var = it["var"]
                    if it["type"] == "multi":
                        for i, (code, olab) in enumerate(it["options"], 1):
                            add(f"{var}_{p}_{i}", var.split("_")[0], f"{it['label']}: {olab}",
                                "0 = not chosen; 1 = chosen", None, it.get("_groups", g))
                    else:
                        codes = "text" if it["type"] == "text" else _scale_labels(it)
                        add(f"{var}_{p}", var.split("_")[0], it["label"], codes, None, it.get("_groups", g))
    return cols


def _n_policies():
    q = next(q for _, q in survey.questions("public") if q["type"] == "policies3")
    return len(q["refs"]) + (0 if q.get("own") is False else 1)


N_POLICIES = _n_policies()


def _all_policy_items():
    """The Module C items of every group, each once (the five C10 versions are separate variables)."""
    seen, out = set(), []
    for g in survey.GROUP_CODES:
        for it in next(q for _, q in survey.questions(g) if q["type"] == "policies3")["items"]:
            if it["var"] not in seen:
                seen.add(it["var"])
                it = dict(it)
                it["_groups"] = g if it["var"].startswith("C10") else (
                    ", ".join(survey.PRO_GROUPS) if it["var"] == "C9_costeff" else "all")
                out.append(it)
    return out


def _row(r, cols):
    """One export row: Appendix A codes, with -1 / -2 missing codes from the routing."""
    a, g, form = r.get("answers", {}), r.get("group"), r.get("form")
    shown = {}
    for _, q in survey.questions(g):
        shown[q["id"]] = (q, survey.visible(q, a, form))
    out = {}
    for c in cols:
        out[c.name] = None
    # simple questions
    for c in cols:
        if c.get is None:
            continue
        qid = re.sub(r"(_\d+){1,2}$|_other$", "", c.name)
        q, vis = shown.get(qid, (None, False))
        if q is None:
            q2 = next((q for _, q, _, _ in survey.variables() if q["id"] == qid), None)
        miss = survey.MISSING_I1 if qid == "I1_int" else (survey.MISSING_NOT_SHOWN, survey.MISSING_NO_ANSWER)
        if q is None or not vis:
            out[c.name] = None if c.name.endswith("_other") or c.codes == "text" else miss[0]
            continue
        if q["type"] == "matrix" and q.get("rows_from"):
            m = re.search(r"_(\d+)$", c.name)
            idx = int(m.group(1)) - 1
            if q["rows"][idx][0] not in [x for x, _ in survey.dynamic_rows(q, a)]:
                out[c.name] = miss[0]
                continue
        if q["type"] == "pickgrid":
            m = re.search(r"_(\d+)_(\d+)$", c.name)
            tc = q["options"][int(m.group(1)) - 1][0]
            picked = (a.get(qid) or {}).get("picked", [])
            if tc not in picked:
                out[c.name] = miss[0]
                continue
        v = c.get(a)
        if v is None and not (c.name.endswith("_other") or c.codes == "text"):
            v = miss[1]
        out[c.name] = v
    # presentation orders
    for qid, order in (r.get("orders") or {}).items():
        if qid + "_order" in out and order:
            q = shown.get(qid, (None,))[0]
            codes = [c for c, _ in q["rows"]] if q else []
            out[qid + "_order"] = ",".join(str(codes.index(x) + 1) for x in order if x in codes)
    # Module C
    pol = a.get("C_policies") or []
    for p in range(1, N_POLICIES + 1):
        it = pol[p - 1] if p - 1 < len(pol) else None
        items = _all_policy_items()
        if not it:
            out[f"C0_policyid_{p}"] = None
            out[f"C0_reference_{p}"] = survey.MISSING_NOT_SHOWN
            out[f"C0_order_{p}"] = survey.MISSING_NOT_SHOWN
        else:
            out[f"C0_policyid_{p}"] = it.get("ref") or it.get("policy")
            out[f"C0_reference_{p}"] = 1 if it.get("ref") else 0
            out[f"C0_order_{p}"] = p
        mine = {x["var"]: x for x in next(q for _, q in survey.questions(g) if q["type"] == "policies3")["items"]} \
            if g in survey.GROUP_CODES else {}
        fam = it.get("fam") if it else None
        for item in items:
            var, key = item["var"], item["id"]
            asked = bool(it) and var in mine and (key == "fam" or (fam is not None and fam != 1))
            if item["type"] == "multi":
                for i, (code, _) in enumerate(item["options"], 1):
                    name = f"{var}_{p}_{i}"
                    if not asked:
                        out[name] = survey.MISSING_NOT_SHOWN
                    elif key in it:
                        out[name] = 1 if code in it[key] else 0
                    else:
                        out[name] = survey.MISSING_NO_ANSWER
            elif item["type"] == "text":
                out[f"{var}_{p}"] = it.get(key) if asked else None
            else:
                out[f"{var}_{p}"] = (_code_scale(it[key]) if key in it else survey.MISSING_NO_ANSWER) if asked \
                    else survey.MISSING_NOT_SHOWN
    return out


META = [
    ("response_id", "Random id of the response"),
    ("survey_version", "Questionnaire version answered"),
    ("submitted_date", "Date of submission (no time is stored)"),
    ("duration_s", "Completion time in seconds"),
    ("device", "mobile / desktop (from screen width)"),
    ("group", "Respondent group (W1): " + "; ".join(f"{c} = {l}" for c, l, *_ in survey.GROUPS)),
    ("FORM", "Public split-ballot form: A = Module G, B = K2 (empty for the other groups)"),
    ("key_verified", "1 = the group's access key was checked before the response was accepted"),
    ("survey_code", "Random code stored in the respondent's browser (duplicate check); deleted one week after submission"),
    ("reference_code", "Code shown to the respondent for withdrawal; deleted one week after submission"),
]


def _tables(rows: list[dict]):
    cols = _columns()
    current = [r for r in rows if r.get("survey_version") == survey.SURVEY_VERSION]
    earlier = [r for r in rows if r.get("survey_version") != survey.SURVEY_VERSION]
    head = [m for m, _ in META] + [c.name for c in cols]
    data = []
    for r in current:
        vals = _row(r, cols)
        data.append([r.get("response_id"), r.get("survey_version"), r.get("submitted_date"), r.get("duration_s"),
                     r.get("device"), r.get("group"), r.get("form"), 1 if r.get("key_verified") else 0,
                     r.get("client_id"), r.get("reference_code")] + [vals.get(c.name) for c in cols])
    cb = [["metadata", m, "", txt, "all", ""] for m, txt in META]
    for c in cols:
        cb.append([c.item, c.name, c.label, "", c.groups, c.codes])
    for row in cb:
        if row[0] == "metadata":
            row[2], row[3] = row[3], ""
    T = {
        "Data": (head, data),
        "Codebook": (["item", "variable", "question / label", "", "shown to", "codes"], cb),
        "Earlier": (["response_id", "survey_version", "group", "submitted", "answers (JSON)"],
                    [[r.get("response_id"), r.get("survey_version"), r.get("group"),
                      r.get("submitted_date") or r.get("submitted_utc"),
                      json.dumps(r.get("answers", {}), ensure_ascii=False)] for r in earlier]),
    }
    T["Codebook"] = (["item", "variable", "question / label", "shown to", "codes"],
                     [[x[0], x[1], x[2], x[4], x[5]] for x in cb])
    return T, len(current), len(earlier)


SHEETS = ["Data", "Codebook", "Earlier"]


def export_xlsx() -> bytes:
    rows = load_responses()
    T, n_cur, n_old = _tables(rows)
    wb = Workbook()
    ws = wb.active
    ws.title = "README"
    counts = Counter(r["group"] for r in rows if r.get("survey_version") == survey.SURVEY_VERSION)
    info = [
        [survey.SURVEY_TITLE],
        [],
        ["Questionnaire version", survey.SURVEY_VERSION],
        ["Exported (UTC)", datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")],
        ["Responses (this version)", n_cur],
    ] + [[f"  {label}", counts.get(code, 0)] for code, label, *_ in survey.GROUPS] + [
        ["Responses to earlier versions", f"{n_old} (sheet Earlier, raw answers)"],
        [],
        ["Sheets"],
        ["Data", "One row per response, one column per variable (Appendix A of the instrument)."],
        ["Codebook", "Each column: item, wording (per group where it differs), groups shown and codes."],
        ["Earlier", "Responses to earlier questionnaire versions, with their raw answers."],
        [],
        ["Codes", "Substantive answers 1..n from the lowest or least favourable category (I1: -3..+3). "
                  "92 = Not sure; 93 = Outside my expertise; 94 = Not applicable to me; 95 = Insufficient "
                  "information; 96 = Cannot judge; 97 = Too early to assess; 98 = Don't know; 99 = Prefer not "
                  "to say. -1 = not shown (routing or form); -2 = shown, not answered. I1 uses 91 and 90 for "
                  "these, since negative values are valid scores."],
        ["Policies", "C*_[p]: p = 1-2 in presentation order: the two reference policies, in random order "
                     "(short form v4.3: no policy of the respondent's own choice)."],
        ["Code deletion", "survey_code and reference_code are deleted automatically one week after submission (the "
                  "withdrawal period); the data are anonymised from then on."],
        ["Scope", "Survey responses record how participants understand and assess policies. They cannot, on "
                  "their own, show that a policy caused a change in greenhouse gas emissions."],
    ]
    for line in info:
        ws.append(line)
    ws["A1"].font = Font(bold=True, size=13)
    ws.column_dimensions["A"].width = 28
    ws.column_dimensions["B"].width = 120
    for row in ws.iter_rows(min_row=2):
        for cell in row:
            cell.alignment = Alignment(wrap_text=True, vertical="top")
    head_fill = PatternFill("solid", fgColor="16324F")
    for name in SHEETS:
        header, data = T[name]
        s = wb.create_sheet(name)
        s.append(header)
        for r in data:
            s.append(r)
        for cell in s[1]:
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = head_fill
        s.freeze_panes = "B2" if name == "Data" else "A2"
        for i, h in enumerate(header):
            width = max([len(str(h))] + [len(str(r[i])) for r in data[:200] if r[i] is not None])
            s.column_dimensions[s.cell(1, i + 1).column_letter].width = min(max(width + 2, 8), 70)
        if name == "Codebook":
            for row in s.iter_rows(min_row=2):
                for cell in row:
                    cell.alignment = Alignment(wrap_text=True, vertical="top")
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def export_csv_zip() -> bytes:
    T, _, _ = _tables(load_responses())
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, (header, data) in T.items():
            s = io.StringIO()
            w = csv.writer(s)
            w.writerow(header)
            w.writerows(data)
            z.writestr(f"{name}.csv", "﻿" + s.getvalue())       # BOM: opens cleanly in Excel
        z.writestr("responses_raw.jsonl", responses_path().read_text(encoding="utf-8")
                   if responses_path().exists() else "")
    return buf.getvalue()
