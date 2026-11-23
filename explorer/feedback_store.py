"""
Storage, access keys, validation, results and research exports for the INPACT consultation.

Responses are validated against the questionnaire in ``feedback_survey.py`` (each
respondent group has its own) and appended, one JSON object per line, to
``responses.jsonl`` in ``FEEDBACK_DIR`` (default ``data/feedback/`` in the project,
kept out of Git; on the AWS server ``/var/lib/inpact/feedback``). An append-only
JSON Lines file is simple, safe with several gunicorn workers (each line is written
under a file lock), easy to back up, and keeps every answer exactly as given.

The research exports (Excel and CSV) are built from that file on demand:

    README          survey version, export time, notes
    Responses       one row per response: metadata, group and every single-answer question
    MultiSelect     long format: response_id, group, question, option code / label
    MatrixRatings   long format: response_id, group, question, row, score / don't know
    PolicyRatings   long format: response_id, group, policy, criterion, score
    PolicyComments  response_id, group, policy, comment
    Codebook        every variable: question wording, groups asked, answer codes
    Contacts        e-mail addresses of people who agreed to a follow-up interview,
                    kept apart from the anonymous answers

Environment variables
---------------------
FEEDBACK_DIR                folder for responses.jsonl (created if missing)
FEEDBACK_ADMIN_KEY          research-team key for the downloads (disabled while unset)
FEEDBACK_KEY_STAKEHOLDER    access keys of the four keyed groups: they open that group's
FEEDBACK_KEY_RESEARCHER     questionnaire and the results dashboard. A group whose key is
FEEDBACK_KEY_EXPERT         unset cannot be chosen.
FEEDBACK_KEY_POLICYMAKER
FEEDBACK_MIN_CELL           a group's answers are shown in the results only from this many
                            responses (default 3), so no individual can be recognised
"""
from __future__ import annotations

import csv
import hmac
import io
import json
import os
import re
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
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}\.[A-Za-z]{2,24}$")


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
        return max(1, int(os.environ.get("FEEDBACK_MIN_CELL", "3")))
    except ValueError:
        return 3


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
    """The keyed group whose key this is, or None (used by the results unlock form)."""
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
# Validation: keep only answers that match the group's questionnaire
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
    if q.get("dk") and v == "dk":
        return "dk"
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None
    s = q["scale"]
    return n if s["min"] <= n <= s["max"] else None


def clean_response(raw: dict) -> dict:
    """Validate a submission; returns the cleaned answers (with "group"). Raises InvalidResponse."""
    if not isinstance(raw, dict):
        raise InvalidResponse("The submission is not in the expected format.")
    answers_in = raw.get("answers") if isinstance(raw.get("answers"), dict) else {}
    group = answers_in.get("group")
    if group not in survey.GROUP_CODES:
        raise InvalidResponse("Please choose the group you are answering as.")
    answers, missing = {}, []
    policies = None
    for step_id, q in survey.questions(group):
        qid, t, v = q["id"], q["type"], answers_in.get(q["id"])
        codes = [c for c, _ in q.get("options", [])]
        val = None
        if t == "group":
            val = group
        elif t == "single":
            val = v if v in codes else None
        elif t == "multi":
            if isinstance(v, list):
                seen = []
                for c in v:
                    if c in codes and c not in seen:
                        seen.append(c)
                val = seen[: q.get("max", len(codes))] or None
        elif t == "scale":
            val = _clean_scale(v, q)
        elif t == "matrix":
            if isinstance(v, dict):
                rows = {}
                for code, _ in q["rows"]:
                    s = _clean_scale(v.get(code), q)
                    if s is not None:
                        rows[code] = s
                val = rows or None
        elif t == "text":
            val = _clean_text(v, q.get("max_len", 1000)) or None
        elif t == "check":
            val = v is True
        elif t == "email":
            e = _clean_text(v, 254)
            val = e if e and EMAIL_RE.match(e) else None
        elif t == "policies":
            if policies is None:
                policies = _policy_index()
            crit = [c for c, _, _ in q["criteria"]]
            items = []
            for item in (v if isinstance(v, list) else [])[: q.get("max", 6)]:
                if not isinstance(item, dict) or item.get("policy") not in policies:
                    continue
                if any(i["policy"] == item["policy"] for i in items):
                    continue
                ratings = {}
                for c in crit:
                    s = _clean_scale((item.get("ratings") or {}).get(c), {**q, "dk": False})
                    if s is not None:
                        ratings[c] = s
                comment = _clean_text(item.get("comment"), q.get("comment_max_len", 400))
                if ratings or comment:
                    items.append({"policy": item["policy"], "ratings": ratings, "comment": comment})
            val = items or None
        if val not in (None, False):
            answers[qid] = val
        if q.get("required") and val in (None, False):
            missing.append(q["label"])
    # The e-mail is kept only with the matching consent
    for _, q in survey.questions(group):
        dep = q.get("depends_on")
        if dep and not answers.get(dep):
            answers.pop(q["id"], None)
    if missing:
        raise InvalidResponse("Please answer the required questions: " + "; ".join(missing[:3]))
    return answers


# ---------------------------------------------------------------------------
# Saving
# ---------------------------------------------------------------------------
def save_response(raw: dict, meta: dict) -> dict:
    """Validate and store one response. Returns {"ok": True, "response_id": ...}."""
    answers = clean_response(raw)
    now = datetime.now(timezone.utc)
    started = raw.get("started_at")
    try:
        started_dt = datetime.fromisoformat(str(started).replace("Z", "+00:00"))
        duration = max(0, int((now - started_dt).total_seconds()))
    except (TypeError, ValueError):
        started_dt, duration = None, None
    client = re.sub(r"[^A-Za-z0-9-]", "", str(raw.get("client_id") or ""))[:40]
    record = {
        "response_id": uuid.uuid4().hex[:12],
        "survey_version": survey.SURVEY_VERSION,
        "group": answers["group"],
        "key_verified": answers["group"] in survey.KEYED_GROUPS,
        "submitted_utc": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "started_utc": started_dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if started_dt else None,
        "duration_s": duration,
        "client_id": client or None,          # random id kept in the browser: flags repeat submissions
        "device": meta.get("device"),
        "answers": answers,
    }
    line = json.dumps(record, ensure_ascii=False) + "\n"
    path = responses_path()
    with _LOCK:
        with path.open("a", encoding="utf-8") as fh:
            if fcntl:
                fcntl.flock(fh, fcntl.LOCK_EX)
            try:
                fh.write(line)
                fh.flush()
                os.fsync(fh.fileno())
            finally:
                if fcntl:
                    fcntl.flock(fh, fcntl.LOCK_UN)
    _SUMMARY_CACHE["t"] = 0
    return {"ok": True, "response_id": record["response_id"]}


def load_responses() -> list[dict]:
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
            out.append(r)
    return out


# ---------------------------------------------------------------------------
# Results for the dashboard (keyed groups only): counts by group, never single answers
# ---------------------------------------------------------------------------
_SUMMARY_CACHE = {"t": 0, "data": None}


def _agg(q, values):
    """Counts for one question over a list of answers (None = not answered)."""
    t = q["type"]
    vals = [v for v in values if v is not None]
    if t in ("scale", "single"):
        c = Counter(str(v) for v in vals)
        out = {"c": {k: n for k, n in c.items() if k != "dk"}, "a": len(vals)}
        if c.get("dk"):
            out["dk"] = c["dk"]
        return out
    if t == "multi":
        return {"c": dict(Counter(code for v in vals for code in v)), "a": len(vals)}
    if t == "matrix":
        rows = {}
        for code, _ in q["rows"]:
            c = Counter(str(v[code]) for v in vals if code in v)
            if c:
                rows[code] = {"c": {k: n for k, n in c.items() if k != "dk"}, "dk": c.get("dk", 0)}
        return {"rows": rows, "a": len(vals)}
    if t == "policies":
        pol = {}
        for items in vals:
            for it in items:
                p = pol.setdefault(it["policy"], {"n": 0, "crit": {}})
                p["n"] += 1
                for crit, s in (it.get("ratings") or {}).items():
                    cell = p["crit"].setdefault(crit, {"s": 0, "n": 0})
                    cell["s"] += s
                    cell["n"] += 1
        return {"p": pol, "a": len(vals)}
    return None


def _median(xs):
    xs = sorted(xs)
    return xs[len(xs) // 2] if xs else None


def summary() -> dict:
    if time.time() - _SUMMARY_CACHE["t"] < 60 and _SUMMARY_CACHE["data"]:
        return _SUMMARY_CACHE["data"]
    rows = load_responses()
    by_group = defaultdict(list)
    for r in rows:
        by_group[r["group"]].append(r)
    need = min_cell()
    timeline = defaultdict(Counter)
    for r in rows:
        timeline[(r.get("submitted_utc") or "")[:10]][r["group"]] += 1
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
            if q["type"] in ("text", "email", "check", "group"):
                continue
            agg = _agg(q, [a.get(q["id"]) for a in A])
            if agg is not None:
                data["q"].setdefault(q["id"], {})[g] = agg
    _SUMMARY_CACHE.update(t=time.time(), data=data)
    return data


# ---------------------------------------------------------------------------
# Research exports
# ---------------------------------------------------------------------------
def _labels() -> dict:
    """question id -> {code: label}"""
    out = {}
    for _, q, _, _ in survey.variables():
        m = dict(q.get("options", []))
        m.update(dict(q.get("rows", [])))
        if "scale" in q:
            m.update({str(k): v for k, v in q["scale"]["labels"].items()})
        if q.get("dk"):
            m["dk"] = "Don't know"
        out[q["id"]] = m
    for g in survey.GROUP_CODES:             # options can differ between groups (e.g. sectors_known)
        for _, q in survey.questions(g):
            out[q["id"]].update(dict(q.get("options", [])))
    return out


def _tables(rows: list[dict]) -> dict[str, tuple[list, list]]:
    """Every export table as (header, rows)."""
    variables = survey.variables()
    labels = _labels()
    policies = _policy_index()
    meta_cols = ["response_id", "survey_version", "group", "key_verified", "submitted_utc", "started_utc",
                 "duration_s", "client_id", "device"]
    wide_q = [q for _, q, _, _ in variables if q["type"] in ("single", "scale", "text", "check")]
    multi_q = [q for _, q, _, _ in variables if q["type"] == "multi"]
    matrix_q = [q for _, q, _, _ in variables if q["type"] == "matrix"]
    head = meta_cols + [q["id"] for q in wide_q] + [f"{q['id']}_count" for q in multi_q] + \
        ["policies_rated", "followup_email_given"]
    T = {"Responses": (head, []),
         "MultiSelect": (["response_id", "group", "question", "option_code", "option_label"], []),
         "MatrixRatings": (["response_id", "group", "question", "row_code", "row_label", "score", "dont_know"], []),
         "PolicyRatings": (["response_id", "group", "policy", "policy_year", "policy_level", "policy_sector",
                            "criterion", "score"], []),
         "PolicyComments": (["response_id", "group", "policy", "comment"], []),
         "Contacts": (["response_id", "group", "submitted_utc", "email"], [])}
    crit_by_group = {g: next((q["criteria"] for _, q in survey.questions(g) if q["type"] == "policies"), [])
                     for g in survey.GROUP_CODES}
    for r in rows:
        a, rid, g = r.get("answers", {}), r.get("response_id"), r.get("group")
        line = [("yes" if r.get(c) else "no") if c == "key_verified" else r.get(c) for c in meta_cols]
        for q in wide_q:
            v = a.get(q["id"])
            line.append(("yes" if v else "no") if q["type"] == "check" else v)
        line += [len(a.get(q["id"]) or []) if q["id"] in a else None for q in multi_q]
        line += [len(a.get("policy_ratings") or []), "yes" if a.get("followup_email") else "no"]
        T["Responses"][1].append(line)
        for q in multi_q:
            for code in a.get(q["id"]) or []:
                T["MultiSelect"][1].append([rid, g, q["id"], code, labels[q["id"]].get(code, code)])
        for q in matrix_q:
            for code, v in (a.get(q["id"]) or {}).items():
                T["MatrixRatings"][1].append([rid, g, q["id"], code, labels[q["id"]].get(code, code),
                                              v if isinstance(v, int) else None, "yes" if v == "dk" else "no"])
        for item in a.get("policy_ratings") or []:
            p = policies.get(item["policy"], {})
            for c, _, _ in crit_by_group.get(g, []):
                T["PolicyRatings"][1].append([rid, g, item["policy"], p.get("year"), p.get("level"), p.get("sector"),
                                              c, item.get("ratings", {}).get(c)])
            if item.get("comment"):
                T["PolicyComments"][1].append([rid, g, item["policy"], item["comment"]])
        if a.get("followup_email"):
            T["Contacts"][1].append([rid, g, r.get("submitted_utc"), a["followup_email"]])
    # Codebook
    meta_text = {"response_id": "Random id of the response",
                 "survey_version": "Questionnaire version answered",
                 "group": "Respondent group: " + "; ".join(f"{c} = {l}" for c, l, *_ in survey.GROUPS),
                 "key_verified": "yes = the group's access key was checked before the response was accepted",
                 "submitted_utc": "Submission time (UTC)",
                 "started_utc": "Time the respondent started the questionnaire (UTC)",
                 "duration_s": "Seconds from start to submission",
                 "client_id": "Random id stored in the respondent's browser (flags repeat submissions)",
                 "device": "mobile / desktop (from screen width)"}
    cb = [["metadata", c, meta_text[c], "all", "", ""] for c in meta_cols]
    for step_id, q, groups, wordings in survey.variables():
        if q["type"] == "group":
            continue
        codes = ""
        opts = {}
        for g in survey.GROUP_CODES:
            for _, q2 in survey.questions(g):
                if q2["id"] == q["id"]:
                    opts.update(dict(q2.get("options", [])))
        if opts:
            codes = "; ".join(f"{c} = {l}" for c, l in opts.items())
        elif q.get("rows"):
            codes = "rows: " + "; ".join(f"{c} = {l}" for c, l in q["rows"])
        if "scale" in q:
            sc = "; ".join(f"{k} = {v}" for k, v in q["scale"]["labels"].items())
            codes = (codes + " | " if codes else "") + "scale: " + sc + ("; dk = Don't know" if q.get("dk") else "")
        if q["type"] == "policies":
            codes += " | criteria: " + "; ".join(f"{c} = {l} ({h})" for c, l, h in q["criteria"])
        cb.append([step_id, q["id"], "\n".join(wordings), ", ".join(groups),
                   q["type"] + (f" (max {q['max']})" if q.get("max") else ""), codes])
    T["Codebook"] = (["section", "variable", "question", "asked_to", "type", "codes"], cb)
    return T


SHEETS = ["Responses", "MultiSelect", "MatrixRatings", "PolicyRatings", "PolicyComments", "Codebook", "Contacts"]


def export_xlsx() -> bytes:
    rows = load_responses()
    T = _tables(rows)
    wb = Workbook()
    ws = wb.active
    ws.title = "README"
    counts = Counter(r["group"] for r in rows)
    info = [
        [survey.SURVEY_TITLE],
        [],
        ["Questionnaire version", survey.SURVEY_VERSION],
        ["Exported (UTC)", datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")],
        ["Responses", len(rows)],
    ] + [[f"  {label}", counts.get(code, 0)] for code, label, *_ in survey.GROUPS] + [
        [],
        ["Sheets"],
        ["Responses", "One row per response: metadata, group and single-answer questions (codes; see Codebook). "
                      "Empty = not asked to this group or not answered."],
        ["MultiSelect", "Long format: one row per option chosen in a multiple-choice question."],
        ["MatrixRatings", "Long format: one row per rated row of a grid question (score, or don't know)."],
        ["PolicyRatings", "Long format: one row per policy x criterion (score 1-5; empty = not rated). "
                          "Criteria differ by group."],
        ["PolicyComments", "Free-text comments on individual policies."],
        ["Codebook", "Question wording (per group where it differs), groups asked, and answer codes."],
        ["Contacts", "Follow-up e-mails. Personal data: keep separate from the analysis files and delete after use."],
        [],
        ["Notes", "Answers are self-reported perceptions, not measured outcomes. Respondents are self-selected, "
                  "so results are not a representative sample. Stakeholder, researcher, expert and policy-maker "
                  "responses were accepted only with that group's access key. client_id identifies a browser, "
                  "not a person."],
    ]
    for line in info:
        ws.append(line)
    ws["A1"].font = Font(bold=True, size=13)
    ws.column_dimensions["A"].width = 24
    ws.column_dimensions["B"].width = 110
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
        s.freeze_panes = "A2"
        for i, h in enumerate(header):
            width = max([len(str(h))] + [len(str(r[i])) for r in data[:300] if r[i] is not None])
            s.column_dimensions[s.cell(1, i + 1).column_letter].width = min(max(width + 2, 10), 70)
        if name in ("Codebook", "PolicyComments"):
            for row in s.iter_rows(min_row=2):
                for cell in row:
                    cell.alignment = Alignment(wrap_text=True, vertical="top")
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def export_csv_zip() -> bytes:
    T = _tables(load_responses())
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
